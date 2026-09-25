/** Portable, self-verifying local evidence bundles. @issue #2039 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 'aiwg.evidence.bundle/v1';
const RESTRICTED_KEY = /(?:^|_)(?:content|terminal|prompt|environment|env|credential|secret|password|authorization|bearer|token|private_key|certificate|restricted_(?:url|uri|link))(?:$|_)/i;
/** Restricted evidence member names; the effect ledger digest-only guard applies the same pattern. */
export const EVIDENCE_RESTRICTED_KEY: RegExp = RESTRICTED_KEY;
const ALLOWED_POLICY_KEYS = new Set(['restricted_content_grants']);
const EVIDENCE_ROLES = new Set<EvidenceRole>(['activity-export', 'report', 'source', 'eval-config', 'provenance']);

export type EvidenceStatus = 'complete' | 'incomplete' | 'not-run';
export type EvidenceRole = 'activity-export' | 'report' | 'source' | 'eval-config' | 'provenance';

export interface EvidenceInput {
  file: string;
  role: EvidenceRole;
}

export interface ActivityEvidenceSummary {
  coverage_label: string | null;
  sequence_gaps: number | null;
  durable_loss: boolean | null;
  dropped_events: number | null;
  stale_collectors: string[] | null;
  clock_uncertainty: string | number | null;
  redaction_status: string | null;
  restricted_content_grants: string[] | null;
  signature_key_id: string | null;
  signed_merkle_root: string | null;
}

export interface EvidenceMember {
  path: string;
  role: EvidenceRole;
  source_name: string;
  sha256: string;
  bytes: number;
}

export interface EvidenceManifest {
  schema_version: typeof SCHEMA_VERSION;
  status: EvidenceStatus;
  incomplete_reasons: string[];
  not_run_reason: string | null;
  created_at: string;
  model_versions: Record<string, string>;
  tool_versions: Record<string, string>;
  activity: ActivityEvidenceSummary;
  members: EvidenceMember[];
  verifier: {
    algorithm: 'sha256';
    checkpoint: 'sorted-member-hash-chain';
    root: string;
    command: 'aiwg evidence verify <bundle>';
  };
}

export interface CreateEvidenceBundleOptions {
  output: string;
  inputs: EvidenceInput[];
  modelVersions?: Record<string, string>;
  toolVersions?: Record<string, string>;
  notRunReason?: string;
  checkOnly?: boolean;
  now?: Date;
}

export interface VerifyEvidenceResult {
  valid: boolean;
  status: EvidenceStatus | 'invalid';
  errors: string[];
  warnings: string[];
  root: string | null;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function containsRestricted(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRestricted);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    (!ALLOWED_POLICY_KEYS.has(key.toLowerCase()) && RESTRICTED_KEY.test(key)) || containsRestricted(child));
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? [...value].sort() : null;
}

function activitySummary(value: unknown): { summary: ActivityEvidenceSummary; reasons: string[] } {
  const reasons: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('activity export is not an object; refusing to copy unassessed activity evidence');
  }
  if (containsRestricted(value)) throw new Error('activity export contains prohibited credential or restricted-content fields');
  const envelope = value as Record<string, any>;
  const manifest = envelope.manifest ?? {};
  const completeness = envelope.completeness ?? manifest.completeness ?? {};
  const coverage = envelope.coverage ?? manifest.coverage ?? [];
  const collectors = envelope.collectors ?? manifest.collectors ?? {};
  const redaction = envelope.redaction ?? manifest.redaction ?? {};
  const grants = envelope.restricted_content_grants ?? manifest.restricted_content_grants;
  const summary: ActivityEvidenceSummary = {
    coverage_label: typeof envelope.coverage_label === 'string' ? envelope.coverage_label
      : typeof manifest.coverage_label === 'string' ? manifest.coverage_label
        : Array.isArray(coverage) && coverage.length ? coverage.map(String).sort().join(',') : null,
    sequence_gaps: numeric(completeness.sequence_gaps ?? manifest.sequence_gaps),
    durable_loss: typeof completeness.durable_loss === 'boolean' ? completeness.durable_loss
      : typeof manifest.durable_loss === 'boolean' ? manifest.durable_loss : null,
    dropped_events: numeric(completeness.dropped_events ?? manifest.dropped_events),
    stale_collectors: stringArray(collectors.stale ?? manifest.stale_collectors),
    clock_uncertainty: typeof manifest.clock_uncertainty === 'string' || typeof manifest.clock_uncertainty === 'number'
      ? manifest.clock_uncertainty : null,
    redaction_status: typeof redaction.status === 'string' ? redaction.status
      : typeof manifest.redaction_status === 'string' ? manifest.redaction_status : null,
    restricted_content_grants: stringArray(grants),
    signature_key_id: typeof manifest.key_id === 'string' ? manifest.key_id : null,
    signed_merkle_root: typeof manifest.merkle_root === 'string' ? manifest.merkle_root : null,
  };
  for (const [key, value] of Object.entries(summary)) {
    if (value === null) reasons.push(`activity evidence is missing ${key}`);
  }
  if ((summary.sequence_gaps ?? 0) > 0) reasons.push(`activity evidence reports ${summary.sequence_gaps} sequence gap(s)`);
  if (summary.durable_loss === true) reasons.push('activity evidence reports durable loss');
  if ((summary.dropped_events ?? 0) > 0) reasons.push(`activity evidence reports ${summary.dropped_events} dropped event(s)`);
  if (summary.stale_collectors?.length) reasons.push(`activity evidence reports stale collectors: ${summary.stale_collectors.join(', ')}`);
  if (summary.redaction_status && summary.redaction_status !== 'complete') reasons.push(`activity evidence redaction status is ${summary.redaction_status}`);
  return { summary, reasons };
}

function emptyActivity(): ActivityEvidenceSummary {
  return {
    coverage_label: null,
    sequence_gaps: null,
    durable_loss: null,
    dropped_events: null,
    stale_collectors: null,
    clock_uncertainty: null,
    redaction_status: null,
    restricted_content_grants: null,
    signature_key_id: null,
    signed_merkle_root: null,
  };
}

function checkpoint(members: Pick<EvidenceMember, 'path' | 'role' | 'sha256'>[]): string {
  let chain = sha256(`${SCHEMA_VERSION}\n`);
  for (const member of [...members].sort((a, b) => a.path.localeCompare(b.path))) {
    chain = sha256(`${chain}\n${member.role}\n${member.path}\n${member.sha256}\n`);
  }
  return chain;
}

function safeName(file: string, used: Set<string>): string {
  const parsed = path.parse(file);
  const base = parsed.name.replace(/[^A-Za-z0-9._-]/g, '-') || 'member';
  const extension = parsed.ext.replace(/[^A-Za-z0-9.]/g, '');
  let candidate = `${base}${extension}`;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}${extension}`;
  used.add(candidate);
  return candidate;
}

export async function createEvidenceBundle(options: CreateEvidenceBundleOptions): Promise<EvidenceManifest> {
  const output = path.resolve(options.output);
  const membersDirectory = path.join(output, 'members');
  const members: EvidenceMember[] = [];
  const used = new Set<string>();
  const incompleteReasons: string[] = [];
  let activity = emptyActivity();
  const prepared: Array<{ input: EvidenceInput; source: string; content: Buffer }> = [];

  for (const input of options.inputs) {
    const source = path.resolve(input.file);
    let content: Buffer;
    try {
      content = await fs.readFile(source);
    } catch (error) {
      incompleteReasons.push(`${input.role} member unavailable: ${path.basename(source)} (${(error as NodeJS.ErrnoException).code ?? 'read-error'})`);
      continue;
    }
    if (input.role === 'activity-export') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content.toString('utf8'));
      } catch {
        throw new Error('activity export is not valid JSON; refusing to copy unassessed activity evidence');
      }
      const assessed = activitySummary(parsed);
      activity = assessed.summary;
      incompleteReasons.push(...assessed.reasons);
    }
    prepared.push({ input, source, content });
  }

  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output);
  await fs.mkdir(membersDirectory);
  for (const { input, source, content } of prepared) {
    const name = safeName(source, used);
    const relative = path.posix.join('members', name);
    await fs.writeFile(path.join(output, relative), content, { flag: 'wx' });
    members.push({ path: relative, role: input.role, source_name: path.basename(source), sha256: sha256(content), bytes: content.length });
  }

  const roles = new Set(members.map(member => member.role));
  for (const role of ['activity-export', 'report', 'source', 'eval-config', 'provenance'] as EvidenceRole[]) {
    if (!roles.has(role)) incompleteReasons.push(`bundle has no ${role} member`);
  }
  if (!Object.keys(options.modelVersions ?? {}).length) incompleteReasons.push('model versions are missing');
  if (!Object.keys(options.toolVersions ?? {}).length) incompleteReasons.push('tool versions are missing');

  const notRunReason = options.notRunReason?.trim() || null;
  const status: EvidenceStatus = (options.checkOnly && notRunReason)
    ? 'not-run' : incompleteReasons.length ? 'incomplete' : 'complete';
  const manifest: EvidenceManifest = {
    schema_version: SCHEMA_VERSION,
    status,
    incomplete_reasons: [...new Set(incompleteReasons)].sort(),
    not_run_reason: status === 'not-run' ? notRunReason : null,
    created_at: (options.now ?? new Date()).toISOString(),
    model_versions: Object.fromEntries(Object.entries(options.modelVersions ?? {}).sort()),
    tool_versions: Object.fromEntries(Object.entries(options.toolVersions ?? {}).sort()),
    activity,
    members: members.sort((a, b) => a.path.localeCompare(b.path)),
    verifier: {
      algorithm: 'sha256',
      checkpoint: 'sorted-member-hash-chain',
      root: checkpoint(members),
      command: 'aiwg evidence verify <bundle>',
    },
  };
  await fs.writeFile(path.join(output, 'evidence-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

export async function verifyEvidenceBundle(bundle: string, expectedRoot?: string): Promise<VerifyEvidenceResult> {
  const root = path.resolve(bundle);
  const errors: string[] = [];
  const warnings: string[] = [];
  let manifest: EvidenceManifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(root, 'evidence-manifest.json'), 'utf8')) as EvidenceManifest;
  } catch {
    return { valid: false, status: 'invalid', errors: ['manifest is missing or invalid JSON'], warnings, root: null };
  }
  if (manifest.schema_version !== SCHEMA_VERSION) errors.push(`unsupported schema_version ${String(manifest.schema_version)}`);
  if (!['complete', 'incomplete', 'not-run'].includes(manifest.status)) errors.push(`unsupported status ${String(manifest.status)}`);
  if (!Array.isArray(manifest.members)) {
    errors.push('manifest members must be an array');
    manifest.members = [];
  }
  const declaredPaths = new Set<string>();
  for (const member of manifest.members) {
    if (
      !member
      || typeof member.path !== 'string'
      || !/^members\/[A-Za-z0-9._-]+$/.test(member.path)
      || !EVIDENCE_ROLES.has(member.role)
      || !/^[0-9a-f]{64}$/.test(member.sha256)
      || !Number.isInteger(member.bytes)
      || member.bytes < 0
    ) {
      errors.push('manifest contains a malformed member');
      continue;
    }
    if (declaredPaths.has(member.path)) errors.push(`member is declared more than once: ${member.path}`);
    declaredPaths.add(member.path);
    const target = path.resolve(root, member.path);
    if (!target.startsWith(`${root}${path.sep}`)) { errors.push(`member escapes bundle root: ${member.path}`); continue; }
    try {
      const metadata = await fs.lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        errors.push(`member is not a regular file: ${member.path}`);
        continue;
      }
      const content = await fs.readFile(target);
      if (content.length !== member.bytes) errors.push(`member size changed: ${member.path}`);
      if (sha256(content) !== member.sha256) errors.push(`member hash changed: ${member.path}`);
    } catch {
      errors.push(`member is missing: ${member.path}`);
    }
  }
  try {
    const actualNames = await fs.readdir(path.join(root, 'members'));
    for (const name of actualNames) {
      const relative = path.posix.join('members', name);
      if (!declaredPaths.has(relative)) errors.push(`bundle contains an undeclared member: ${relative}`);
    }
  } catch {
    if (manifest.members.length) errors.push('bundle members directory is missing');
  }
  const checkpointMembers = manifest.members.filter(member =>
    member && typeof member.path === 'string' && typeof member.role === 'string' && typeof member.sha256 === 'string');
  const computed = checkpoint(checkpointMembers);
  if (computed !== manifest.verifier?.root) errors.push('bundle checkpoint does not match manifest members');
  if (expectedRoot && computed !== expectedRoot) errors.push('bundle checkpoint does not match expected root');
  if (manifest.status === 'incomplete') warnings.push(...(manifest.incomplete_reasons ?? []));
  if (manifest.status === 'not-run') warnings.push(`NOT RUN: ${manifest.not_run_reason ?? 'reason unavailable'}`);
  return { valid: errors.length === 0, status: errors.length ? 'invalid' : manifest.status, errors, warnings, root: computed };
}
