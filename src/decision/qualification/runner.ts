import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { evaluateQualification } from './gates.js';
import {
  deriveGateEvidence, DERIVED_GATE_EVIDENCE, GATE_ARTIFACT_FLAGS, GATE_ARTIFACT_SCHEMAS, validateGateArtifact,
  type GateArtifactContext, type QualificationGateArtifactFlag,
} from './gate-evidence.js';
import { scanQualificationPrivacy, type QualificationPrivacyCapture } from './privacy.js';
import type {
  EvidenceOutcome,
  QualificationCase,
  QualificationEvidence,
  QualificationEvidenceManifest,
  QualificationGateArtifactRef,
  QualificationReport,
  QualificationRunManifest,
} from './types.js';

export interface QualificationExecutionResult {
  outcome: Exclude<EvidenceOutcome, 'skip'>;
  details?: unknown;
}

export interface QualificationExecutionContext {
  caseId: string;
  runId: string;
  signal: AbortSignal;
}

export type QualificationCaseExecutor = (
  context: QualificationExecutionContext,
) => QualificationExecutionResult | Promise<QualificationExecutionResult>;

export type QualificationEvidenceCheck = (
  context: Omit<QualificationExecutionContext, 'caseId'>,
) => boolean | Promise<boolean>;

export interface QualificationExecutionPlan {
  manifest: Omit<QualificationRunManifest, 'evidence' | 'evidenceFlags'>;
  artifactRoot: string;
  executors: Readonly<Record<string, QualificationCaseExecutor>>;
  /**
   * Checks for auxiliary flags and blocking findings only. A check named after
   * a derived gate flag (see `DERIVED_GATE_EVIDENCE`) is never invoked.
   */
  evidenceChecks?: Readonly<Record<string, QualificationEvidenceCheck>>;
  /**
   * Source files for artifact-backed gate flags (G3 split plan and calibration,
   * G5 load result, G6 reviewer decision). Each is validated, copied into the
   * run directory and digest-pinned; a flag without a valid artifact is false.
   */
  gateArtifacts?: Readonly<Partial<Record<QualificationGateArtifactFlag, string>>>;
  timeoutMs?: number;
  concurrency?: number;
  maxArtifactBytes?: number;
  /** Explicitly select public aggregate fields for persistence. Raw executor details are private by default. */
  sanitizeDetails?: (details: unknown, caseId: string) => unknown;
  /** Synthetic canaries never leave the process, including through selected public details. */
  privacyCanaries?: readonly string[];
  /** Captured output surfaces; required for the G2 privacy flag. Empty observations must be explicit. */
  privacyCaptures?: readonly QualificationPrivacyCapture[];
}

export interface ArtifactVerification {
  caseId: string;
  verified: boolean;
  reason?: 'missing' | 'unsafe-path' | 'not-file' | 'too-large' | 'digest-mismatch' | 'invalid-artifact';
}

export interface GateArtifactVerification {
  flag: string;
  verified: boolean;
  reason?: 'unknown-flag' | 'unsafe-path' | 'not-file' | 'too-large' | 'digest-mismatch' | 'invalid-artifact' | 'missing';
}

export interface ExecutedQualification {
  manifest: QualificationRunManifest;
  verification: ArtifactVerification[];
  gateVerification: GateArtifactVerification[];
  report: QualificationReport;
}

export type QualificationGoldenSources = Readonly<Record<string, readonly string[]>>;

interface QualificationArtifact {
  schemaVersion: 'decision-qualification-artifact/v1';
  runId: string;
  caseId: string;
  outcome: EvidenceOutcome;
  durationMs: number;
  testEvidenceIds: string[];
  details?: unknown;
  error?: string;
}

/** Named master-test-plan suites plus the M01-M11 amendment IDs. */
export const QUALIFICATION_EVIDENCE_ID = /^(?:CON|POL|BCH|CTX|CNC|CAN|RTY|REC|SEC|PRV|CAL|DRF|M(?:0[1-9]|1[01]))-[A-Z0-9][A-Z0-9._-]*$/;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024;
const DEFAULT_CONCURRENCY = 4;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`qualification bound must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`unsafe ${label}: ${value}`);
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    return item;
  })}\n`;
}

function digest(bytes: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`qualification execution exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeArtifact(
  root: string,
  runId: string,
  artifact: QualificationArtifact,
  maxBytes: number,
): Promise<QualificationEvidence> {
  const relative = `${safeSegment(runId, 'run id')}/${safeSegment(artifact.caseId, 'case id')}.json`;
  const target = resolve(root, relative);
  const bytes = canonicalJson(artifact);
  if (Buffer.byteLength(bytes) > maxBytes) throw new Error(`qualification artifact exceeds ${maxBytes} bytes`);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporary, target);
  return {
    caseId: artifact.caseId,
    executable: artifact.outcome !== 'skip',
    outcome: artifact.outcome,
    artifact: relative,
    digest: digest(bytes),
    testEvidenceIds: [...artifact.testEvidenceIds],
  };
}

async function executeCase(
  item: QualificationCase,
  plan: QualificationExecutionPlan,
  timeoutMs: number,
  maxBytes: number,
): Promise<QualificationEvidence> {
  const started = Date.now();
  const testEvidenceIds = [...(item.evidenceIds ?? [])];
  if (testEvidenceIds.some(id => !QUALIFICATION_EVIDENCE_ID.test(id))
    || new Set(testEvidenceIds).size !== testEvidenceIds.length) throw new Error(`invalid named qualification evidence for ${item.id}`);
  testEvidenceIds.sort();
  const executor = plan.executors[item.id];
  let result: QualificationExecutionResult = { outcome: 'fail' };
  let error: string | undefined;
  // A generic callback carries no authenticated provider or served-model proof.
  // Never let an offline/mock executor manufacture an artifact labelled live.
  if (!executor || plan.manifest.mode === 'live') {
    return writeArtifact(plan.artifactRoot, plan.manifest.runId, {
      schemaVersion: 'decision-qualification-artifact/v1', runId: plan.manifest.runId,
      caseId: item.id, outcome: 'skip', durationMs: 0, testEvidenceIds,
      error: plan.manifest.mode === 'live' ? 'live-evidence-unavailable' : 'executor-not-registered',
    }, maxBytes);
  }
  try {
    result = await withTimeout(timeoutMs, signal => executor({ caseId: item.id, runId: plan.manifest.runId, signal }));
    if (result.outcome !== 'pass' && result.outcome !== 'fail') throw new Error('executor returned an invalid outcome');
  } catch {
    result = { outcome: 'fail' };
    // Executor exceptions can include private provider bodies or input state.
    // Keep diagnostic text out of persistent artifacts and exported reports.
    error = 'executor-failed';
  }
  let publicDetails: unknown;
  if (result.details !== undefined && plan.sanitizeDetails) {
    try {
      publicDetails = plan.sanitizeDetails(result.details, item.id);
    } catch {
      // A broken sanitizer cannot convert a private payload into release evidence.
      result = { outcome: 'fail' };
      error = 'details-sanitization-failed';
    }
  }
  // Check the serialized representation (not just string-valued leaves): JSON
  // escaping must not let a canary bypass the privacy gate. Do not include the
  // offending value or its index in the artifact or any thrown diagnostic.
  const canaries = plan.privacyCanaries ?? [];
  if (canaries.some(value => typeof value !== 'string' || value.length === 0)) {
    throw new Error('privacy canaries must be nonempty strings');
  }
  if (publicDetails !== undefined && canaries.length) {
    try {
      const serialized = JSON.stringify(publicDetails);
      if (canaries.some(value => serialized.includes(value) || serialized.includes(JSON.stringify(value).slice(1, -1)))) {
        result = { outcome: 'fail' };
        publicDetails = undefined;
        error = 'privacy-canary-detected';
      }
    } catch {
      result = { outcome: 'fail' };
      publicDetails = undefined;
      error = 'details-sanitization-failed';
    }
  }
  return writeArtifact(plan.artifactRoot, plan.manifest.runId, {
    schemaVersion: 'decision-qualification-artifact/v1', runId: plan.manifest.runId,
    caseId: item.id, outcome: result.outcome, durationMs: Math.max(0, Date.now() - started), testEvidenceIds,
    ...(publicDetails === undefined ? {} : { details: publicDetails }), ...(error ? { error } : {}),
  }, maxBytes);
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await work(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}

/** Executes cases and gate checks; neither evidence outcomes nor flags are accepted from the caller. */
export async function executeQualificationPlan(plan: QualificationExecutionPlan): Promise<QualificationRunManifest> {
  const timeoutMs = boundedInteger(plan.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 10 * 60_000);
  const concurrency = boundedInteger(plan.concurrency, DEFAULT_CONCURRENCY, 1, 32);
  const maxBytes = boundedInteger(plan.maxArtifactBytes, DEFAULT_MAX_ARTIFACT_BYTES, 256, 4 * 1024 * 1024);
  const evidence = await mapConcurrent(plan.manifest.cases, concurrency, item => executeCase(item, plan, timeoutMs, maxBytes));
  const derivedNames = new Set(DERIVED_GATE_EVIDENCE);
  const checkEntries = Object.entries(plan.evidenceChecks ?? {})
    .filter(([name]) => !derivedNames.has(name))
    .sort(([left], [right]) => left.localeCompare(right));
  const flagValues = await mapConcurrent(checkEntries, concurrency, async ([name, check]) => {
    try {
      const passed = await withTimeout(timeoutMs, signal => check({ runId: plan.manifest.runId, signal }));
      return [name, passed === true] as const;
    } catch {
      return [name, false] as const;
    }
  });
  const evidenceFlags = Object.fromEntries(flagValues);
  // Caller-provided positive flags cannot impersonate a complete privacy scan.
  // Missing captures or canaries remain false, even if a callback returns true.
  try {
    evidenceFlags['privacy-scan-clean'] = plan.privacyCaptures && plan.privacyCanaries
      ? scanQualificationPrivacy(plan.privacyCaptures, plan.privacyCanaries).clean : false;
  } catch {
    evidenceFlags['privacy-scan-clean'] = false;
  }
  const gateArtifacts = await attachGateArtifacts(plan, evidence, maxBytes);
  const manifest: QualificationRunManifest = { ...plan.manifest, evidence, evidenceFlags,
    ...(Object.keys(gateArtifacts).length ? { gateArtifacts } : {}) };
  // Record the derived values for readers; the evaluator recomputes them and
  // never trusts these entries. Hash verification is only known after re-reading.
  for (const [name, value] of Object.entries(deriveGateEvidence(manifest))) {
    if (name !== 'evidence-hashes-verified') evidenceFlags[name] = value;
  }
  return manifest;
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer | 'not-file' | 'too-large' | 'missing'> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return 'not-file';
    if (stat.size > maxBytes) return 'too-large';
    return await readFile(path);
  } catch {
    return 'missing';
  }
}

function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString('utf8')) as unknown; } catch { return undefined; }
}

async function attachGateArtifacts(
  plan: QualificationExecutionPlan,
  evidence: QualificationEvidence[],
  maxBytes: number,
): Promise<Record<string, QualificationGateArtifactRef>> {
  const refs: Record<string, QualificationGateArtifactRef> = {};
  const context: GateArtifactContext = { manifest: { ...plan.manifest, evidence }, accepted: {} };
  // Fixed order: calibration evidence binds to the accepted split plan.
  for (const flag of GATE_ARTIFACT_FLAGS) {
    const source = plan.gateArtifacts?.[flag];
    if (!source) continue;
    const bytes = await readBoundedFile(resolve(source), maxBytes);
    if (!Buffer.isBuffer(bytes)) continue;
    const parsed = parseJson(bytes);
    if (!validateGateArtifact(flag, parsed, context)) continue;
    const relative = `${safeSegment(plan.manifest.runId, 'run id')}/gates/${flag}.json`;
    const target = resolve(plan.artifactRoot, relative);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
    refs[flag] = { artifact: relative, digest: digest(bytes), schemaVersion: GATE_ARTIFACT_SCHEMAS[flag] };
    context.accepted[flag] = parsed;
  }
  return refs;
}

/** Re-reads gate artifacts from the artifact root and re-validates their content against the run. */
export async function verifyQualificationGateArtifacts(
  manifest: QualificationRunManifest,
  artifactRoot: string,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
): Promise<GateArtifactVerification[]> {
  const maxBytes = boundedInteger(maxArtifactBytes, DEFAULT_MAX_ARTIFACT_BYTES, 256, 4 * 1024 * 1024);
  const refs = manifest.gateArtifacts ?? {};
  const known = new Set<string>(GATE_ARTIFACT_FLAGS);
  const results: GateArtifactVerification[] = [];
  const context: GateArtifactContext = { manifest, accepted: {} };
  for (const flag of Object.keys(refs).filter(name => !known.has(name)).sort()) {
    results.push({ flag, verified: false, reason: 'unknown-flag' });
  }
  for (const flag of GATE_ARTIFACT_FLAGS) {
    const ref = refs[flag];
    if (!ref) continue;
    const path = containedArtifactPath(artifactRoot, ref.artifact);
    if (!path || !ref.artifact.startsWith(`${manifest.runId}/gates/`)) { results.push({ flag, verified: false, reason: 'unsafe-path' }); continue; }
    const bytes = await readBoundedFile(path, maxBytes);
    if (!Buffer.isBuffer(bytes)) { results.push({ flag, verified: false, reason: bytes }); continue; }
    if (digest(bytes) !== ref.digest) { results.push({ flag, verified: false, reason: 'digest-mismatch' }); continue; }
    const parsed = parseJson(bytes);
    if (ref.schemaVersion !== GATE_ARTIFACT_SCHEMAS[flag] || !validateGateArtifact(flag, parsed, context)) {
      results.push({ flag, verified: false, reason: 'invalid-artifact' });
      continue;
    }
    context.accepted[flag] = parsed;
    results.push({ flag, verified: true });
  }
  return results;
}

/**
 * Derives `privacy-scan-clean` for an executed run from surfaces captured
 * around the whole run (see `captureQualificationLifetime`). The value comes
 * from the scanner, as with `privacyCaptures`; it is never taken from the caller.
 */
export function withQualificationPrivacyScan(
  manifest: QualificationRunManifest,
  captures: readonly QualificationPrivacyCapture[],
  canaries: readonly string[],
): QualificationRunManifest {
  let clean = false;
  try { clean = scanQualificationPrivacy(captures, canaries).clean; } catch { clean = false; }
  return { ...manifest, evidenceFlags: { ...manifest.evidenceFlags, 'privacy-scan-clean': clean } };
}

function containedArtifactPath(root: string, relative: string): string | null {
  if (relative.startsWith('/') || relative.includes('\\')) return null;
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, relative);
  return candidate.startsWith(`${rootPath}${sep}`) ? candidate : null;
}

async function verifiedSource(root: string, relative: string): Promise<{ path: string; digest: `sha256:${string}` }> {
  const path = containedArtifactPath(root, relative);
  if (!path) throw new Error(`unsafe qualification evidence source: ${relative}`);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`qualification evidence source is not a regular file: ${relative}`);
  return { path: relative, digest: digest(await readFile(path)) };
}

/**
 * Builds D11's evidence linkage only from runner-produced artifacts that still
 * verify and checked-in source goldens that can be independently hashed.
 */
export async function createQualificationEvidenceManifest(
  manifest: QualificationRunManifest,
  artifactRoot: string,
  sourceRoot: string,
  sources: QualificationGoldenSources,
): Promise<QualificationEvidenceManifest> {
  const verification = await verifyQualificationArtifacts(manifest, artifactRoot);
  const verified = new Map(verification.map(item => [item.caseId, item.verified]));
  const evidence = await Promise.all(manifest.evidence.map(async item => {
    if (!item.executable || !item.artifact || !item.digest || verified.get(item.caseId) !== true) {
      throw new Error(`qualification evidence is not executable and verified: ${item.caseId}`);
    }
    const sourcePaths = sources[item.caseId];
    if (!sourcePaths?.length) throw new Error(`qualification evidence has no source golden: ${item.caseId}`);
    return {
      caseId: item.caseId,
      testEvidenceIds: [...(item.testEvidenceIds ?? [])],
      executable: true,
      outcome: item.outcome,
      artifact: { path: item.artifact, digest: item.digest },
      sourceGoldens: await Promise.all(sourcePaths.map(path => verifiedSource(sourceRoot, path))),
    };
  }));
  return {
    schemaVersion: 'decision-qualification-evidence-manifest/v1',
    runId: manifest.runId,
    sourceCommit: manifest.sourceCommit,
    evidence,
  };
}

/** Persists the evidence linkage beside the runner artifacts for CI/release collection. */
export async function writeQualificationEvidenceManifest(
  manifest: QualificationRunManifest,
  artifactRoot: string,
  sourceRoot: string,
  sources: QualificationGoldenSources,
): Promise<{ manifest: QualificationEvidenceManifest; artifact: string; digest: `sha256:${string}` }> {
  const evidenceManifest = await createQualificationEvidenceManifest(manifest, artifactRoot, sourceRoot, sources);
  const relative = `${safeSegment(manifest.runId, 'run id')}/evidence-manifest.json`;
  const target = resolve(artifactRoot, relative);
  const bytes = canonicalJson(evidenceManifest);
  if (Buffer.byteLength(bytes) > DEFAULT_MAX_ARTIFACT_BYTES) {
    throw new Error(`qualification evidence manifest exceeds ${DEFAULT_MAX_ARTIFACT_BYTES} bytes`);
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporary, target);
  return { manifest: evidenceManifest, artifact: relative, digest: digest(bytes) };
}

/** Re-reads artifacts and verifies containment, file type, content, and exact SHA-256. */
export async function verifyQualificationArtifacts(
  manifest: QualificationRunManifest,
  artifactRoot: string,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
): Promise<ArtifactVerification[]> {
  const maxBytes = boundedInteger(maxArtifactBytes, DEFAULT_MAX_ARTIFACT_BYTES, 256, 4 * 1024 * 1024);
  return Promise.all(manifest.evidence.map(async item => {
    if (!item.artifact || !item.digest) return { caseId: item.caseId, verified: false, reason: 'missing' } as const;
    const path = containedArtifactPath(artifactRoot, item.artifact);
    if (!path) return { caseId: item.caseId, verified: false, reason: 'unsafe-path' } as const;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return { caseId: item.caseId, verified: false, reason: 'not-file' } as const;
      if (stat.size > maxBytes) return { caseId: item.caseId, verified: false, reason: 'too-large' } as const;
      const bytes = await readFile(path);
      if (digest(bytes) !== item.digest) return { caseId: item.caseId, verified: false, reason: 'digest-mismatch' } as const;
      const parsed = JSON.parse(bytes.toString('utf8')) as Partial<QualificationArtifact>;
      if (parsed.schemaVersion !== 'decision-qualification-artifact/v1' || parsed.runId !== manifest.runId
        || parsed.caseId !== item.caseId || parsed.outcome !== item.outcome
        || JSON.stringify(parsed.testEvidenceIds) !== JSON.stringify(item.testEvidenceIds ?? [])) {
        return { caseId: item.caseId, verified: false, reason: 'invalid-artifact' } as const;
      }
      return { caseId: item.caseId, verified: true } as const;
    } catch (error) {
      return { caseId: item.caseId, verified: false, reason: error instanceof SyntaxError ? 'invalid-artifact' : 'missing' } as const;
    }
  }));
}

/** Promotion-capable evaluation that fails closed when any artifact cannot be independently verified. */
export async function evaluateExecutedQualification(
  manifest: QualificationRunManifest,
  artifactRoot: string,
  maxArtifactBytes?: number,
): Promise<ExecutedQualification> {
  const verification = await verifyQualificationArtifacts(manifest, artifactRoot, maxArtifactBytes);
  const gateVerification = await verifyQualificationGateArtifacts(manifest, artifactRoot, maxArtifactBytes);
  const verified = new Map(verification.map(item => [item.caseId, item.verified]));
  const gateVerified = new Set(gateVerification.filter(item => item.verified).map(item => item.flag));
  const hardened: QualificationRunManifest = {
    ...manifest,
    evidence: manifest.evidence.map(item => verified.get(item.caseId) === true ? item : { ...item, executable: false }),
    gateArtifacts: Object.fromEntries(Object.entries(manifest.gateArtifacts ?? {}).filter(([flag]) => gateVerified.has(flag))),
  };
  const caseIds = new Set(manifest.cases.map(item => item.id));
  const artifactsVerified = verification.length > 0 && verification.length === caseIds.size
    && verification.every(item => item.verified && caseIds.has(item.caseId))
    && gateVerification.every(item => item.verified);
  return { manifest, verification, gateVerification,
    report: evaluateQualification(hardened, undefined, { artifactsVerified }) };
}

/** Executes, persists, verifies, and evaluates in one promotion-capable pipeline. */
export async function executeAndEvaluateQualification(plan: QualificationExecutionPlan): Promise<ExecutedQualification> {
  const manifest = await executeQualificationPlan(plan);
  return evaluateExecutedQualification(manifest, plan.artifactRoot, plan.maxArtifactBytes);
}
