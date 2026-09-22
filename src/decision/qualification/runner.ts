import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { evaluateQualification } from './gates.js';
import type {
  EvidenceOutcome,
  QualificationCase,
  QualificationEvidence,
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
  evidenceChecks?: Readonly<Record<string, QualificationEvidenceCheck>>;
  timeoutMs?: number;
  concurrency?: number;
  maxArtifactBytes?: number;
}

export interface ArtifactVerification {
  caseId: string;
  verified: boolean;
  reason?: 'missing' | 'unsafe-path' | 'not-file' | 'too-large' | 'digest-mismatch' | 'invalid-artifact';
}

export interface ExecutedQualification {
  manifest: QualificationRunManifest;
  verification: ArtifactVerification[];
  report: QualificationReport;
}

interface QualificationArtifact {
  schemaVersion: 'decision-qualification-artifact/v1';
  runId: string;
  caseId: string;
  outcome: EvidenceOutcome;
  durationMs: number;
  details?: unknown;
  error?: string;
}

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
  };
}

async function executeCase(
  item: QualificationCase,
  plan: QualificationExecutionPlan,
  timeoutMs: number,
  maxBytes: number,
): Promise<QualificationEvidence> {
  const started = Date.now();
  const executor = plan.executors[item.id];
  let result: QualificationExecutionResult = { outcome: 'fail' };
  let error: string | undefined;
  if (!executor) {
    return writeArtifact(plan.artifactRoot, plan.manifest.runId, {
      schemaVersion: 'decision-qualification-artifact/v1', runId: plan.manifest.runId,
      caseId: item.id, outcome: 'skip', durationMs: 0, error: 'executor-not-registered',
    }, maxBytes);
  }
  try {
    result = await withTimeout(timeoutMs, signal => executor({ caseId: item.id, runId: plan.manifest.runId, signal }));
    if (result.outcome !== 'pass' && result.outcome !== 'fail') throw new Error('executor returned an invalid outcome');
  } catch (caught) {
    result = { outcome: 'fail' };
    error = caught instanceof Error ? caught.message : 'executor failed with a non-error value';
  }
  return writeArtifact(plan.artifactRoot, plan.manifest.runId, {
    schemaVersion: 'decision-qualification-artifact/v1', runId: plan.manifest.runId,
    caseId: item.id, outcome: result.outcome, durationMs: Math.max(0, Date.now() - started),
    ...(result.details === undefined ? {} : { details: result.details }), ...(error ? { error } : {}),
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
  const checkEntries = Object.entries(plan.evidenceChecks ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const flagValues = await mapConcurrent(checkEntries, concurrency, async ([name, check]) => {
    try {
      const passed = await withTimeout(timeoutMs, signal => check({ runId: plan.manifest.runId, signal }));
      return [name, passed === true] as const;
    } catch {
      return [name, false] as const;
    }
  });
  return { ...plan.manifest, evidence, evidenceFlags: Object.fromEntries(flagValues) };
}

function containedArtifactPath(root: string, relative: string): string | null {
  if (relative.startsWith('/') || relative.includes('\\')) return null;
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, relative);
  return candidate.startsWith(`${rootPath}${sep}`) ? candidate : null;
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
        || parsed.caseId !== item.caseId || parsed.outcome !== item.outcome) {
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
  const verified = new Map(verification.map(item => [item.caseId, item.verified]));
  const hardened: QualificationRunManifest = {
    ...manifest,
    evidence: manifest.evidence.map(item => verified.get(item.caseId) === true ? item : { ...item, executable: false }),
  };
  return { manifest, verification, report: evaluateQualification(hardened) };
}

/** Executes, persists, verifies, and evaluates in one promotion-capable pipeline. */
export async function executeAndEvaluateQualification(plan: QualificationExecutionPlan): Promise<ExecutedQualification> {
  const manifest = await executeQualificationPlan(plan);
  return evaluateExecutedQualification(manifest, plan.artifactRoot, plan.maxArtifactBytes);
}
