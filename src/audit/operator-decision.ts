/**
 * Versioned, tamper-evident operator decision records for orchestration.
 *
 * Records contain correlation and digests, never raw prompts or credentials.
 * The JSONL hash chain detects modification/deletion/reordering inside an
 * exported segment; external checkpointing anchors segment heads.
 *
 * @implements #1567
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redactStructured } from '../governance/redaction.js';

export const OPERATOR_DECISION_SCHEMA = 'operator-decision.aiwg.io/v1' as const;

export type DecisionKind = 'approval' | 'denial' | 'escalation' | 'override';
export type DecisionOutcome = 'approved' | 'denied' | 'escalated' | 'overridden';
export type DataClassification = 'public' | 'internal' | 'confidential' | 'restricted';

export interface DecisionActor {
  id: string;
  type: 'human' | 'service';
  authentication: string;
  roles?: string[];
}

export interface DecisionCorrelation {
  mission_id?: string;
  flow_id?: string;
  provider_id?: string;
  sandbox_task_id?: string;
  sandbox_session_id?: string;
  issue_id?: string;
  pull_request_id?: string;
  prompt_id?: string;
  trace_id?: string;
}

export interface RuntimeEvidence {
  runtime_kind?: string;
  isolation?: string;
  session_backend?: string;
  transport_mode?: string;
  transport_trust?: string;
  evidence_refs?: string[];
}

/** Optional graph-profile correlation. Required identity fields travel together. */
export interface GraphDecisionContext {
  graph_id: string;
  graph_version: string;
  run_id: string;
  node_id: string;
  node_run_id: string;
  edge_id?: string;
  route_name?: string;
  route_reason?: string;
  checkpoint_id?: string;
  replay_parent_run_id?: string;
}

export interface OperatorDecisionInput {
  kind: DecisionKind;
  outcome: DecisionOutcome;
  actor: DecisionActor;
  reason: string;
  context: unknown;
  classification: DataClassification;
  correlation: DecisionCorrelation;
  runtime?: RuntimeEvidence;
  graph?: GraphDecisionContext;
  policy_ref?: string;
  redacted_fields?: string[];
  timestamp?: string;
  event_id?: string;
}

export interface OperatorDecisionRecord {
  schema_version: typeof OPERATOR_DECISION_SCHEMA;
  event_id: string;
  timestamp: string;
  kind: DecisionKind;
  outcome: DecisionOutcome;
  actor: DecisionActor;
  reason: string;
  context_digest: string;
  classification: DataClassification;
  correlation: DecisionCorrelation;
  runtime?: RuntimeEvidence;
  graph?: GraphDecisionContext;
  policy_ref?: string;
  redacted_fields: string[];
  previous_hash: string | null;
  record_hash: string;
}

export interface RetentionPolicy {
  maxAgeDays: Partial<Record<DataClassification, number>>;
}

export function digestDecisionContext(context: unknown): string {
  const safe = redact(context).value;
  return `sha256:${createHash('sha256').update(canonicalJson(safe)).digest('hex')}`;
}

export function createDecisionRecord(
  input: OperatorDecisionInput,
  previousHash: string | null,
): OperatorDecisionRecord {
  validateInput(input);
  const actor = redact(input.actor);
  const correlation = redact(input.correlation);
  const runtime = input.runtime ? redact(input.runtime) : undefined;
  const graph = input.graph ? redact(input.graph) : undefined;
  const reason = redact(input.reason);
  const detected = [...actor.paths, ...correlation.paths, ...(runtime?.paths ?? []), ...(graph?.paths ?? []), ...reason.paths];
  const unsigned = {
    schema_version: OPERATOR_DECISION_SCHEMA,
    event_id: input.event_id ?? randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    kind: input.kind,
    outcome: input.outcome,
    actor: actor.value as unknown as DecisionActor,
    reason: reason.value as string,
    context_digest: digestDecisionContext(input.context),
    classification: input.classification,
    correlation: correlation.value as unknown as DecisionCorrelation,
    ...(runtime ? { runtime: runtime.value as unknown as RuntimeEvidence } : {}),
    ...(graph ? { graph: graph.value as unknown as GraphDecisionContext } : {}),
    ...(input.policy_ref ? { policy_ref: input.policy_ref } : {}),
    redacted_fields: [...new Set([...(input.redacted_fields ?? []), ...detected])].sort(),
    previous_hash: previousHash,
  };
  return {
    ...unsigned,
    record_hash: hashRecord(unsigned),
  };
}

export function verifyDecisionChain(records: OperatorDecisionRecord[]): {
  ok: boolean;
  index?: number;
  reason?: string;
} {
  let previous: string | null = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.previous_hash !== previous) return { ok: false, index, reason: 'previous hash mismatch' };
    const { record_hash, ...unsigned } = record;
    if (hashRecord(unsigned) !== record_hash) return { ok: false, index, reason: 'record hash mismatch' };
    previous = record_hash;
  }
  return { ok: true };
}

export function toOpenTelemetryLog(record: OperatorDecisionRecord): Record<string, unknown> {
  return {
    timeUnixNano: String(BigInt(Date.parse(record.timestamp)) * 1_000_000n),
    severityText: record.outcome === 'denied' ? 'WARN' : 'INFO',
    body: { stringValue: `${record.kind}:${record.outcome}` },
    attributes: Object.entries({
      'aiwg.audit.schema': record.schema_version,
      'aiwg.audit.event_id': record.event_id,
      'aiwg.audit.record_hash': record.record_hash,
      'aiwg.decision.actor_id': record.actor.id,
      'aiwg.decision.context_digest': record.context_digest,
      'aiwg.mission.id': record.correlation.mission_id,
      'aiwg.flow.id': record.correlation.flow_id,
      'aiwg.provider.id': record.correlation.provider_id,
      'aiwg.sandbox.task_id': record.correlation.sandbox_task_id,
      'aiwg.prompt.id': record.correlation.prompt_id,
      'aiwg.graph.id': record.graph?.graph_id,
      'aiwg.graph.version': record.graph?.graph_version,
      'aiwg.graph.run_id': record.graph?.run_id,
      'aiwg.graph.node_id': record.graph?.node_id,
      'aiwg.graph.node_run_id': record.graph?.node_run_id,
      'aiwg.graph.edge_id': record.graph?.edge_id,
      'aiwg.graph.route_name': record.graph?.route_name,
      'aiwg.graph.checkpoint_id': record.graph?.checkpoint_id,
      'aiwg.graph.replay_parent_run_id': record.graph?.replay_parent_run_id,
    }).filter(([, value]) => value !== undefined).map(([key, value]) => ({
      key,
      value: { stringValue: String(value) },
    })),
  };
}

export class JsonlOperatorDecisionStore {
  constructor(private readonly path: string) {}

  async append(input: OperatorDecisionInput): Promise<OperatorDecisionRecord> {
    const records = await this.read();
    const verification = verifyDecisionChain(records);
    if (!verification.ok) throw new Error(`operator decision audit chain is invalid at ${verification.index}: ${verification.reason}`);
    const record = createDecisionRecord(input, records.at(-1)?.record_hash ?? null);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await chmod(this.path, 0o600);
    return record;
  }

  async read(): Promise<OperatorDecisionRecord[]> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return raw.split(/\n+/).filter(Boolean).map(line => JSON.parse(line) as OperatorDecisionRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async prune(policy: RetentionPolicy, now = Date.now()): Promise<{ retained: number; deleted: number; head_hash: string | null }> {
    const prior = await this.read();
    const retainedInputs = prior.filter(record => {
      const days = policy.maxAgeDays[record.classification];
      return days === undefined || Date.parse(record.timestamp) + days * 86_400_000 > now;
    });
    let previous: string | null = null;
    const retained = retainedInputs.map(record => {
      const { record_hash: _hash, previous_hash: _previous, ...rest } = record;
      const next = { ...rest, previous_hash: previous };
      const rebuilt = { ...next, record_hash: hashRecord(next) };
      previous = rebuilt.record_hash;
      return rebuilt;
    });
    const temporary = `${this.path}.tmp`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, retained.map(record => JSON.stringify(record)).join('\n') + (retained.length ? '\n' : ''), { mode: 0o600 });
    await rename(temporary, this.path);
    return { retained: retained.length, deleted: prior.length - retained.length, head_hash: previous };
  }
}

function validateInput(input: OperatorDecisionInput): void {
  if (!input.actor.id || !input.actor.authentication) throw new Error('actor identity and authentication are required');
  if (!input.reason.trim()) throw new Error('a non-empty operator reason is required');
  if (!Object.values(input.correlation).some(Boolean)) throw new Error('at least one correlation identifier is required');
  if (input.graph && ![input.graph.graph_id, input.graph.graph_version, input.graph.run_id, input.graph.node_id, input.graph.node_run_id].every(value => typeof value === 'string' && value.length > 0)) {
    throw new Error('graph decision context requires graph, run, node, and node-run identity');
  }
  if (input.timestamp && !Number.isFinite(Date.parse(input.timestamp))) throw new Error('timestamp must be valid ISO time');
}

function hashRecord(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

/**
 * Deterministic JSON for decision hashes. This is deliberately NOT the RFC 8785
 * canonicalizer (`security/artifact-trust.canonicalJson`): keys are ordered with
 * `localeCompare` rather than by UTF-16 code unit, and `undefined` members are
 * dropped. The two agree when no sibling keys differ in case or punctuation
 * order, but not in general (for example `{"B","_c","a"}` orders as
 * `_c,a,B` here and `B,_c,a` under RFC 8785). Existing record_hash and
 * context_digest values in stored decision chains depend on this ordering, so
 * it is kept; test/unit/security/canonical-json-parity.test.ts pins it.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function redact(value: unknown, path = '$'): { value: unknown; paths: string[] } {
  const result = redactStructured(value);
  return {
    value: result.value,
    paths: result.findings.map((finding) => {
      const suffix = finding.path?.replaceAll('/', '.').replace(/^\./, '') ?? '';
      return suffix ? `${path}.${suffix}` : path;
    }),
  };
}
