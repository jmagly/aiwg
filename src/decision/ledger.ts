/**
 * Decision ask ledger — append-only call record for `aiwg decision ask`.
 *
 * Extends the existing decision CLI surface (#2946) rather than adding a new
 * subsystem: the ledger is one JSON-lines file under the project AIWG
 * artifact root (`.aiwg/decision/ledger.jsonl`, resolved the same way as
 * `aiwg artifacts path`).
 *
 * Writing the ledger is intentionally decoupled from `askDecision()` itself
 * (`./ask.js`): `recordDecisionAsk` is a small wrapper the CLI `ask` handler
 * and the MCP `decision-ask` tool both call after they already have a
 * `DecisionAskResult`, tagged with their transport. This keeps `askDecision`
 * free of I/O and keeps internal reuse (e.g. `setupJev`'s `--verify` probe)
 * out of the ledger: only completed `ask` calls — `answered` or `fallback` —
 * are recorded. CLI/MCP usage errors (bad flags, oversized context) never
 * reach a `DecisionAskResult` and are never recorded.
 *
 * Trust boundary (review r1/r2 #2946): this file defends against an
 * ACCIDENTAL hazard — a stray symlink, a hard link, loose permissions left
 * by another tool, a previous crash's partial write — all under the
 * assumption that the artifact root is owned and written by the SAME local
 * user running `aiwg`. It does not and cannot defend against a HOSTILE
 * process running as that same user: such a process already has read/write
 * access to everything the ledger could protect. Appenders, rotation and
 * readers share the existing cross-process directory-lock helper. There is
 * no privilege boundary here. Every filesystem
 * check below uses only portable Node primitives (no `/proc`, no handle
 * anchoring): `mkdir`/`lstat` for the directory, `open`+`fstat` for the
 * file, with `O_NOFOLLOW` applied when the platform defines it (POSIX; not
 * Windows). On a POSIX platform a small TOCTOU window exists between the
 * directory `lstat` and the file `open`; on Windows the symlink check is a
 * plain `lstat` pre-check with no kernel-enforced equivalent to
 * `O_NOFOLLOW`. Both are accepted given the trust boundary above. An
 * existing file or directory that fails a safety check is never modified —
 * recording is skipped and reported once via `warn`, never "fixed" by
 * chmod or truncation.
 *
 * Record size is capped at a level that stays below the conservative
 * single-write atomicity boundary most platforms also honor for `PIPE_BUF`
 * (4096 bytes on Linux): this makes a single, non-interleaved write the
 * overwhelmingly likely outcome for one record, but it is not a guarantee.
 * The lock covers opening, checking the trailing newline, writing every
 * byte and closing. Rotation holds that same lock through live-file
 * replacement. `history`/`stats` count malformed lines as skipped; retention
 * preserves their original bytes.
 *
 * Recording — attribution resolution and the write — is bounded by a short
 * deadline (`DECISION_LEDGER_RECORD_TIMEOUT_MS`). On timeout, the in-flight
 * attempt is not cancelled (Node has no way to abort an in-flight `open`),
 * so its outcome is genuinely unknown: the record may or may not eventually
 * land. The warning says exactly that ("completion unknown"), and no
 * attribution-to-append stage starts once the deadline has fired. An append
 * already waiting for the ledger lock can still complete after that deadline.
 */

import { randomUUID, createHash } from 'node:crypto';
import { constants as fsConstants, createReadStream, existsSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { acquireDirectoryLock } from '../artifacts/prebuilt-build-lock.js';
import { syncDirectory } from '../storage/protected-files.js';
import { projectAiwgPath, projectAiwgWritePath } from '../config/project-artifacts.js';
import { redactText } from '../governance/redaction.js';
import { CanonicalJsonByteEstimator } from './context-plan.js';
import { resolveActiveProvider, type ProviderResolution } from '../cli/provider-resolution.js';
import type { DecisionAskInput, DecisionAskResult } from './ask.js';
import { validateDecisionConfig } from '../config/decision-config.js';
import { readAiwgConfig } from '../config/aiwg-config.js';
import { decisionSavingsWeights, estimateDecisionSavings, type DecisionSavingsMethod, type DecisionSavingsWeights } from './savings.js';

export const DECISION_LEDGER_SCHEMA = 'aiwg-decision-ledger-record/v2';
export const DECISION_LEDGER_SCHEMA_V1 = 'aiwg-decision-ledger-record/v1';
const DECISION_LEDGER_DIR_NAME = 'decision';
const DECISION_LEDGER_FILE_NAME = 'ledger.jsonl';

export type DecisionLedgerTransport = 'cli' | 'mcp';
export type DecisionLedgerKind = 'yes-no' | 'choices' | 'scale';
const DECISION_LEDGER_KINDS: readonly DecisionLedgerKind[] = ['yes-no', 'choices', 'scale'];
const DECISION_LEDGER_STATUSES: readonly DecisionAskResult['status'][] = ['answered', 'fallback'];

export interface DecisionLedgerRecord {
  schema: typeof DECISION_LEDGER_SCHEMA | typeof DECISION_LEDGER_SCHEMA_V1;
  id: string;
  timestamp: string;
  transport: DecisionLedgerTransport;
  provider: string;
  sessionId: string;
  sessionSource?: string;
  projectRoot: string;
  decisionKind: DecisionLedgerKind;
  choiceIds: string[] | null;
  /** Index of the selected option within the caller's full (un-truncated) choice/scale list, or null (yes-no, or no match). */
  answerIndex: number | null;
  /** Total choice/scale option count before the MAX_RECORDED_CHOICE_IDS cap; null for yes-no. */
  choiceCount: number | null;
  /** True when `choiceIds` is a truncated prefix of the full list (choiceCount > MAX_RECORDED_CHOICE_IDS). */
  choiceIdsTruncated: boolean;
  questionDigest: string;
  contextDigest: string | null;
  questionText?: string;
  contextText?: string;
  /** Present (and true) only when `--record-text` truncated a text field to fit the record-size cap. */
  textTruncated?: boolean;
  status: DecisionAskResult['status'];
  answer: DecisionAskResult['answer'];
  confidence: DecisionAskResult['confidence'];
  answeredBy?: DecisionAskResult['answeredBy'];
  threshold: number;
  fallbackReason: string | null;
  model: DecisionAskResult['model'];
  usage: DecisionAskResult['usage'];
  latencyMs: number;
  passesRequested?: number;
  escalationPasses?: number;
  passesRun?: number;
  escalated?: boolean;
  earlyStop?: 'certain-failure' | 'timeout' | null;
  agreementRatio?: number;
  minAgreement?: number | null;
  agreementConfidenceFloor?: number;
  passConfidenceSummary?: NonNullable<DecisionAskResult['aggregate']>['confidenceSummary'];
  estimatedLlmTokensAvoided: number;
  /** Legacy v1 figure above is retained for comparison only. */
  estimationMethodV1?: string;
  llm_tokens_avoided?: number;
  jev_tokens?: number;
  cost_weighted_net_usd?: number;
  estimationMethod: string | DecisionSavingsMethod;
  caller: string | null;
}

/**
 * Legacy v1 per-kind allowance, retained only for comparison and replay.
 * Named and recorded with
 * every estimate (not just referenced) so the figure can be recomputed
 * later per the issue's proposal item 3.
 */
export const DECISION_SAVINGS_REASONING_ALLOWANCE_TOKENS: Readonly<Record<DecisionLedgerKind, number>> = {
  'yes-no': 50,
  choices: 120,
  scale: 80,
};

export const DECISION_SAVINGS_ESTIMATION_METHOD =
  'aiwg-decision-savings/v1: answered = d06-canonical-json-utf8-ceil(question+context) + per-kind reasoning allowance; '
  + 'fallback = -(jev usage.inputTokens + usage.outputTokens), 0 when no Jev call was attempted (e.g. not-configured)';

// ---------------------------------------------------------------------------
// Attribution identifiers — `--caller`/`--session` use a conservative
// identifier shape that still covers documented forms like
// `address-issues:worker-pick` (colon-separated namespacing) and
// `flow/step@host` (review r2 finding 11). The CLI rejects a value outside
// this shape with exit 2; the MCP tool drops it to `null` instead (there is
// no CLI exit code to report through MCP). Either way the value is also
// redacted before being persisted — the shape restricts delimiters, not
// content.
// ---------------------------------------------------------------------------

export const MAX_ATTRIBUTION_FIELD_LENGTH = 96;
export const ATTRIBUTION_FIELD_PATTERN = /^[A-Za-z0-9_.:/@-]{1,96}$/;

// ---------------------------------------------------------------------------
// Record-size and metadata-field caps. Every persisted string is redacted
// (never just the two opt-in text fields) and capped, so neither a
// secret-shaped attribution tag nor a long path/choice list can grow a
// record past the atomicity-safe size ceiling below.
// ---------------------------------------------------------------------------

/** Post-redaction cap for provider/sessionId/projectRoot/caller/model/answer-as-string. */
const MAX_METADATA_FIELD_BYTES = 256;
/** The ledger records at most this many choice ids, regardless of how many the `ask` call itself allowed (up to 255); see `choiceCount`/`choiceIdsTruncated`. */
export const MAX_RECORDED_CHOICE_IDS = 10;
/** Post-redaction cap per recorded choice id. */
const MAX_CHOICE_ID_BYTES = 80;
/** Post-redaction, post-truncation cap per opt-in text field (`--record-text`). */
export const MAX_RECORD_TEXT_BYTES = 600;
/**
 * Hard cap on one serialized record line. Kept below 4096 (`PIPE_BUF` on
 * Linux) as a conservative single-write-atomicity margin — see the module
 * doc comment. Not a guarantee: see the module doc comment on concurrent
 * writers.
 */
export const MAX_LEDGER_RECORD_BYTES = 4000;

/** Bounds how long `recordDecisionAsk` waits on attribution resolution and the write. On timeout the outcome is reported as unknown, not "abandoned" — see the module doc comment. */
export const DECISION_LEDGER_RECORD_TIMEOUT_MS = 250;

const LEDGER_DIR_MODE = 0o700;
const LEDGER_FILE_MODE = 0o600;
const LEDGER_LOCK_TIMEOUT_MS = 30_000;
const IS_WINDOWS = process.platform === 'win32';
const HAS_O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1; // back out of a multi-byte UTF-8 sequence
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

/** Redact, then cap to `maxBytes`. Applied to EVERY persisted string field, not only opt-in text. */
function sanitizeField(value: string | null | undefined, maxBytes = MAX_METADATA_FIELD_BYTES): string | null {
  if (value === null || value === undefined) return null;
  const redacted = redactText(value, { limits: { maxInputBytes: 64 * 1024 } }).text;
  return truncateUtf8(redacted, maxBytes).text;
}

/** A choice is `id` or `id=description`; only the id is recorded (see parseChoice in ./ask.ts). */
function choiceId(entry: string): string {
  const separator = entry.indexOf('=');
  return (separator < 0 ? entry : entry.slice(0, separator)).trim();
}

function fullChoiceIds(mode: DecisionAskInput['mode']): string[] | null {
  if (mode.kind === 'yes-no') return null;
  return mode.kind === 'choices'
    ? mode.choices.map(choiceId)
    : Array.from({ length: mode.high - mode.low + 1 }, (_, index) => String(mode.low + index));
}

function choiceCountFor(mode: DecisionAskInput['mode']): number | null {
  const ids = fullChoiceIds(mode);
  return ids === null ? null : ids.length;
}

/** Index of the selected answer in the caller's full choice/scale list — identity that survives redaction (review r2 finding 7). */
function answerIndexFor(mode: DecisionAskInput['mode'], rawAnswer: DecisionAskResult['answer']): number | null {
  if (mode.kind === 'yes-no') return null;
  if (mode.kind === 'choices') {
    if (typeof rawAnswer !== 'string') return null;
    const index = mode.choices.map(choiceId).indexOf(rawAnswer);
    return index < 0 ? null : index;
  }
  if (typeof rawAnswer !== 'number' || !Number.isInteger(rawAnswer) || rawAnswer < mode.low || rawAnswer > mode.high) return null;
  return rawAnswer - mode.low;
}

/** Mirrors ask.ts's private contextMessage(): what is actually sent to Jev as input. */
function contextMessageForEstimate(input: DecisionAskInput): string {
  return input.context === undefined || input.context === '' ? input.question : `${input.question}\n\nContext:\n${input.context}`;
}

function estimateSavingsV1(input: DecisionAskInput, result: DecisionAskResult): { estimatedLlmTokensAvoided: number; estimationMethod: string } {
  if (result.status === 'answered') {
    const inputTokens = new CanonicalJsonByteEstimator().estimate(contextMessageForEstimate(input)).tokens;
    const allowance = DECISION_SAVINGS_REASONING_ALLOWANCE_TOKENS[input.mode.kind];
    return { estimatedLlmTokensAvoided: inputTokens + allowance, estimationMethod: DECISION_SAVINGS_ESTIMATION_METHOD };
  }
  const jevCost = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
  // Avoid signed zero (`-0`): a fallback that never called Jev (e.g. not-configured) costs nothing.
  return { estimatedLlmTokensAvoided: jevCost === 0 ? 0 : -jevCost, estimationMethod: DECISION_SAVINGS_ESTIMATION_METHOD };
}

/** Ordered harness session markers; never substitute provider/process ids. */
export const DECISION_SESSION_ENV_VARS = [
  'AIWG_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID',
  'HERMES_SESSION_ID', 'OPENCODE_SESSION_ID', 'MUSE_SESSION_ID', 'GROK_SESSION_ID', 'WARP_SESSION_ID',
] as const;

export function resolveDecisionSession(explicitSessionId: string | undefined, env: NodeJS.ProcessEnv): { sessionId: string; sessionSource: string } {
  const explicit = explicitSessionId?.trim();
  if (explicit && ATTRIBUTION_FIELD_PATTERN.test(explicit)) return { sessionId: explicit, sessionSource: '--session' };
  for (const key of DECISION_SESSION_ENV_VARS) {
    const value = env[key]?.trim();
    if (value && ATTRIBUTION_FIELD_PATTERN.test(value)) return { sessionId: value, sessionSource: key };
  }
  return { sessionId: 'unknown', sessionSource: 'unknown' };
}

export function resolveDecisionSessionId(explicitSessionId: string | undefined, env: NodeJS.ProcessEnv): string {
  return resolveDecisionSession(explicitSessionId, env).sessionId;
}

export interface DecisionLedgerBuildContext {
  transport: DecisionLedgerTransport;
  provider: string;
  sessionId: string;
  sessionSource?: string;
  savingsWeights?: DecisionSavingsWeights;
  /** Project root; stored (redacted) as the record's own `projectRoot` field. */
  projectRoot: string;
  caller?: string | null;
  /** Opt-in: include redacted, length-capped question/context text. Never on by default. */
  recordText?: boolean;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable id generator for tests. */
  id?: () => string;
}

function withinRecordBudget(record: DecisionLedgerRecord): boolean {
  return Buffer.byteLength(JSON.stringify(record), 'utf8') <= MAX_LEDGER_RECORD_BYTES;
}

/** Drops optional text fields (context first, then question) until the record fits the hard size cap. */
function enforceRecordBudget(record: DecisionLedgerRecord): DecisionLedgerRecord {
  if (withinRecordBudget(record)) return record;
  if (record.contextText !== undefined) {
    const { contextText, ...rest } = record;
    record = { ...(rest as DecisionLedgerRecord), textTruncated: true };
    if (withinRecordBudget(record)) return record;
  }
  if (record.questionText !== undefined) {
    const { questionText, ...rest } = record;
    record = { ...(rest as DecisionLedgerRecord), textTruncated: true };
  }
  return record;
}

/** Pure, synchronous and side-effect free: builds the record this call would append, fully sanitized. */
export function buildDecisionLedgerRecord(
  input: DecisionAskInput,
  result: DecisionAskResult,
  context: DecisionLedgerBuildContext,
): DecisionLedgerRecord {
  const timestamp = new Date((context.now ?? Date.now)()).toISOString();
  const legacy = estimateSavingsV1(input, result);
  const inputTokens = new CanonicalJsonByteEstimator().estimate(contextMessageForEstimate(input)).tokens;
  const savings = estimateDecisionSavings(inputTokens, result.status === 'answered',
    (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0), context.savingsWeights ?? decisionSavingsWeights(), result.usage);
  const caller = context.caller && ATTRIBUTION_FIELD_PATTERN.test(context.caller) ? context.caller : null;
  const rawAnswer = result.answer;
  const answer = typeof rawAnswer === 'string' ? sanitizeField(rawAnswer) : rawAnswer;
  const fullIds = fullChoiceIds(input.mode);
  const choiceCount = choiceCountFor(input.mode);
  const choiceIdsTruncated = choiceCount !== null && choiceCount > MAX_RECORDED_CHOICE_IDS;
  const choiceIds = fullIds === null ? null : fullIds.slice(0, MAX_RECORDED_CHOICE_IDS).map(id => sanitizeField(id, MAX_CHOICE_ID_BYTES) ?? '');
  let record: DecisionLedgerRecord = {
    schema: DECISION_LEDGER_SCHEMA,
    id: (context.id ?? randomUUID)(),
    timestamp,
    transport: context.transport,
    provider: sanitizeField(context.provider) ?? 'unknown',
    sessionId: sanitizeField(context.sessionId) ?? 'unknown',
    sessionSource: sanitizeField(context.sessionSource) ?? 'unknown',
    projectRoot: sanitizeField(context.projectRoot) ?? '',
    decisionKind: input.mode.kind,
    choiceIds,
    answerIndex: answerIndexFor(input.mode, rawAnswer),
    choiceCount,
    choiceIdsTruncated,
    questionDigest: sha256Hex(input.question),
    contextDigest: input.context === undefined ? null : sha256Hex(input.context),
    status: result.status,
    answer,
    confidence: result.confidence,
    ...(result.answeredBy === undefined ? {} : { answeredBy: result.answeredBy }),
    threshold: input.threshold ?? 0.8,
    fallbackReason: result.status === 'fallback' ? result.reason : null,
    model: typeof result.model === 'string' ? sanitizeField(result.model) : result.model,
    usage: result.usage,
    latencyMs: result.latencyMs,
    ...(result.aggregate ? {
      passesRequested: result.aggregate.passesRequested, escalationPasses: result.aggregate.escalationPasses,
      passesRun: result.aggregate.passesRun, escalated: result.aggregate.escalated,
      earlyStop: result.aggregate.earlyStop, agreementRatio: result.aggregate.agreementRatio,
      minAgreement: result.aggregate.minAgreement, agreementConfidenceFloor: result.aggregate.agreementConfidenceFloor,
      passConfidenceSummary: result.aggregate.confidenceSummary,
    } : {}),
    estimatedLlmTokensAvoided: legacy.estimatedLlmTokensAvoided,
    estimationMethodV1: legacy.estimationMethod,
    ...savings,
    caller: sanitizeField(caller, MAX_METADATA_FIELD_BYTES),
  };
  if (context.recordText) {
    const question = truncateUtf8(redactText(input.question).text, MAX_RECORD_TEXT_BYTES);
    record = { ...record, questionText: question.text, textTruncated: question.truncated };
    if (input.context !== undefined) {
      const contextField = truncateUtf8(redactText(input.context).text, MAX_RECORD_TEXT_BYTES);
      record = { ...record, contextText: contextField.text, textTruncated: record.textTruncated || contextField.truncated };
    }
  }
  return enforceRecordBudget(record);
}

function ledgerReadPath(projectRoot: string): string {
  return projectAiwgPath(projectRoot, DECISION_LEDGER_DIR_NAME, DECISION_LEDGER_FILE_NAME);
}

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** At most one warning per call; the emitter itself never throws. */
function makeOnceWarn(custom: ((message: string) => void) | undefined): (message: string) => void {
  let warned = false;
  return (message: string) => {
    if (warned) return;
    warned = true;
    try {
      (custom ?? defaultWarn)(message);
    } catch {
      // Warning emission must never escape — a throwing warn callback must not change the result.
    }
  };
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/**
 * Create (if needed) the owner-only `decision` directory and verify it is
 * safe to use: a real directory (not a symlink), and on POSIX owned by the
 * current user. An existing directory that fails either check is never
 * modified (no chmod) — recording is skipped.
 */
async function ensurePrivateDecisionDir(projectRoot: string, warn: (message: string) => void): Promise<string | null> {
  const artifactRoot = projectAiwgWritePath(projectRoot);
  const decisionDir = join(artifactRoot, DECISION_LEDGER_DIR_NAME);
  try {
    await mkdir(decisionDir, { recursive: true, mode: LEDGER_DIR_MODE });
  } catch (error) {
    warn(`warning: cannot create decision ledger directory: ${errorMessage(error)}`);
    return null;
  }
  let stat;
  try {
    stat = await lstat(decisionDir);
  } catch (error) {
    warn(`warning: cannot stat decision ledger directory: ${errorMessage(error)}`);
    return null;
  }
  if (!stat.isDirectory()) {
    warn('warning: decision ledger directory is not a real directory (possibly a symlink); skipping record');
    return null;
  }
  if (!IS_WINDOWS) {
    const uid = currentUid();
    if (uid !== null && stat.uid !== uid) {
      warn('warning: decision ledger directory is not owned by the current user; skipping record');
      return null;
    }
  }
  return decisionDir;
}

/**
 * Open a private ledger/archive file (append by default, read-only for
 * retention) and verify it is a regular file with exactly one hard link (rejects a
 * pre-planted hard link to an unrelated file, which `O_NOFOLLOW` alone does
 * not catch), and on POSIX owned by the current user with no group/other
 * permission bits. `O_NOFOLLOW` is applied when the platform defines it
 * (refusing a pre-planted symlink at open time on POSIX); on platforms
 * without it (Windows) a prior plain `lstat` is the only symlink check —
 * see the module doc comment on the trust boundary. A file that fails any
 * check is closed untouched (no chmod, no write) and recording is skipped
 * with exactly one warning naming the reason.
 */
async function openPrivateLedgerFile(ledgerPath: string, warn: (message: string) => void,
  flags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY): Promise<FileHandle | null> {
  try {
    const pre = await lstat(ledgerPath);
    if (pre.isSymbolicLink()) {
      warn('warning: decision ledger file is a symlink; skipping record');
      return null;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`warning: cannot stat decision ledger file: ${errorMessage(error)}`);
      return null;
    }
  }
  let handle: FileHandle;
  try {
    handle = await open(ledgerPath, flags | (HAS_O_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0), LEDGER_FILE_MODE);
  } catch (error) {
    warn(`warning: cannot open decision ledger file: ${errorMessage(error)}`);
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      warn('warning: decision ledger path is not a regular file; skipping record');
      await handle.close();
      return null;
    }
    if (stat.nlink !== 1) {
      warn('warning: decision ledger file has more than one hard link; skipping record');
      await handle.close();
      return null;
    }
    if (!IS_WINDOWS) {
      const uid = currentUid();
      if (uid !== null && stat.uid !== uid) {
        warn('warning: decision ledger file is not owned by the current user; skipping record');
        await handle.close();
        return null;
      }
      if ((stat.mode & 0o077) !== 0) {
        warn('warning: decision ledger file has group or other permission bits set; skipping record');
        await handle.close();
        return null;
      }
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    warn(`warning: cannot verify decision ledger file safety: ${errorMessage(error)}`);
    return null;
  }
}

/** True when the ledger's last byte is not `\n` (so a prior partial/crashed write cannot absorb the next record). Read through a separate read-only handle; best-effort — any failure here means "do not prepend", never a hard error. */
async function needsLeadingNewline(ledgerPath: string): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(ledgerPath, fsConstants.O_RDONLY | (HAS_O_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0));
    const stat = await handle.stat();
    if (stat.size === 0) return false;
    const buffer = Buffer.alloc(1);
    const { bytesRead } = await handle.read({ buffer, position: stat.size - 1, length: 1 });
    return bytesRead !== 1 || buffer[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export type LedgerWriteChunk = (handle: FileHandle, buffer: Buffer) => Promise<number>;

async function defaultWriteChunk(handle: FileHandle, buffer: Buffer): Promise<number> {
  const { bytesWritten } = await handle.write(buffer);
  return bytesWritten;
}

/** Writes every byte of `buffer`, looping on a short write rather than assuming one `write()` call finishes the job. */
async function writeFully(handle: FileHandle, buffer: Buffer, writeChunk: LedgerWriteChunk = defaultWriteChunk): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const written = await writeChunk(handle, buffer.subarray(offset));
    if (!Number.isFinite(written) || written <= 0) throw new Error('decision ledger: write made no progress (short write)');
    offset += written;
  }
}

export interface AppendDecisionLedgerOptions {
  projectRoot: string;
  warn?: (message: string) => void;
  /** Test-only: override the low-level write primitive to simulate short writes. */
  writeChunk?: LedgerWriteChunk;
}

/**
 * Best-effort append. A failure here must never change the decision result
 * or exit code — every failure is caught and reported through `warn` (at
 * most once; see `makeOnceWarn`), never thrown. Returns `true` once the
 * record is durably appended, `false` on a handled (warned) failure.
 */
export async function appendDecisionLedgerRecord(record: DecisionLedgerRecord, options: AppendDecisionLedgerOptions): Promise<boolean> {
  const warn = makeOnceWarn(options.warn);
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_LEDGER_RECORD_BYTES) {
    warn(`warning: decision ledger record exceeds the ${MAX_LEDGER_RECORD_BYTES}-byte size cap and was not written`);
    return false;
  }
  const decisionDir = await ensurePrivateDecisionDir(options.projectRoot, warn);
  if (!decisionDir) return false;
  const ledgerPath = join(decisionDir, DECISION_LEDGER_FILE_NAME);
  let release: (() => Promise<void>) | undefined;
  let handle: FileHandle | null = null;
  try {
    release = await lockDecisionLedger(decisionDir);
    handle = await openPrivateLedgerFile(ledgerPath, warn);
    if (!handle) return false;
    const prefix = (await needsLeadingNewline(ledgerPath)) ? '\n' : '';
    await writeFully(handle, Buffer.from(prefix + line, 'utf8'), options.writeChunk);
    return true;
  } catch (error) {
    warn(`warning: failed to append decision ledger record: ${errorMessage(error)}`);
    return false;
  } finally {
    await handle?.close().catch(() => {});
    await release?.().catch(error => warn(`warning: cannot release decision ledger lock: ${errorMessage(error)}`));
  }
}

function lockDecisionLedger(decisionDir: string): Promise<() => Promise<void>> {
  return acquireDirectoryLock(join(decisionDir, 'ledger.lock'), {
    timeoutMs: LEDGER_LOCK_TIMEOUT_MS, pollMs: 10, reclaimDeadOwner: true,
  });
}

export interface RotateDecisionLedgerOptions {
  projectRoot: string;
  /** Activity-log syntax: positive entry count or duration in days. Default: 90d. */
  keepLast?: string;
  /** Explicit authorization to archive everything, including malformed lines. */
  all?: boolean;
  /** Artifact-relative or absolute .jsonl path beneath archive/decision/. */
  to?: string;
  now?: () => number;
}

export function parseDecisionLedgerRetention(keepLast?: string, all = false): { count?: number; ms?: number } {
  if (all) {
    if (keepLast !== undefined) throw new Error('--all cannot be combined with --keep-last');
    return {};
  }
  const match = /^(\d+)(d?)$/.exec(keepLast ?? '90d');
  const n = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0 || !Number.isSafeInteger(n * (match?.[2] ? 86_400_000 : 1))) {
    throw new Error('--keep-last must be a positive count or <N>d; rotating everything requires --all');
  }
  return match?.[2] ? { ms: n * 86_400_000 } : { count: n };
}

function isBeneath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Walk before mkdir: recursive mkdir alone could write through a symlinked ancestor. */
async function privateArchiveDirectory(root: string, target: string, create: boolean): Promise<boolean> {
  let current = root;
  for (const part of relative(root, target).split(sep)) {
    current = join(current, part);
    if (create) {
      try {
        await mkdir(current, { mode: LEDGER_DIR_MODE });
        if (!IS_WINDOWS) await syncDirectory(dirname(current));
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    let info;
    try { info = await lstat(current); }
    catch (error) { if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    // archive/ is shared with the activity log and may already be readable.
    // Its decision/ subtree (and any nested directories) must be private.
    const modeMask = current === join(root, 'archive') ? 0o022 : 0o077;
    if (!info.isDirectory() || (!IS_WINDOWS && (info.uid !== currentUid() || (info.mode & modeMask) !== 0))) {
      throw new Error(`Unsafe decision archive directory (requires a private, owned real directory): ${current}`);
    }
  }
  return true;
}

/** Retention preserves each raw line, including invalid UTF-8, CRLF and an unterminated final line. */
export async function rotateDecisionLedger(options: RotateDecisionLedgerOptions): Promise<{
  archived: number; retained: number; malformed: number; archivePath: string | null;
}> {
  const retention = parseDecisionLedgerRetention(options.keepLast, options.all);
  const now = (options.now ?? Date.now)();
  const artifactRoot = projectAiwgWritePath(options.projectRoot);
  const archiveRoot = join(artifactRoot, 'archive', 'decision');
  const archivePath = resolve(artifactRoot, options.to ?? join('archive', 'decision',
    `${new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.\d{3}Z$/, '')}-${randomUUID()}.jsonl`));
  if (!isBeneath(artifactRoot, archivePath)) throw new Error('Archive path must stay inside the resolved artifact root');
  if (!isBeneath(archiveRoot, archivePath) || !archivePath.endsWith('.jsonl')) {
    throw new Error('Archive path must be a .jsonl file beneath archive/decision/ in the resolved artifact root');
  }
  const fail = (message: string): never => { throw new Error(message); };
  const decisionDir = await ensurePrivateDecisionDir(options.projectRoot, fail);
  if (!decisionDir) throw new Error('Cannot access decision ledger directory');
  const release = await lockDecisionLedger(decisionDir);
  const ledgerPath = join(decisionDir, DECISION_LEDGER_FILE_NAME);
  const tempPath = join(decisionDir, `.ledger-${randomUUID()}.tmp`);
  let archiveCreated = false;
  try {
    const live = await openPrivateLedgerFile(ledgerPath, fail, fsConstants.O_RDONLY | fsConstants.O_CREAT);
    if (!live) throw new Error('Cannot read decision ledger');
    let content: Buffer;
    try { content = await live.readFile(); } finally { await live.close(); }
    const lines: Array<{ bytes: Buffer; timestamp: number | null }> = [];
    for (let start = 0; start < content.length;) {
      const newline = content.indexOf(0x0a, start);
      const end = newline < 0 ? content.length : newline + 1;
      const bytes = content.subarray(start, end);
      let timestamp: number | null = null;
      try {
        const record: unknown = JSON.parse(bytes.toString('utf8'));
        if (isDecisionLedgerRecord(record)) timestamp = Date.parse(record.timestamp);
      } catch { /* preserve malformed bytes */ }
      lines.push({ bytes, timestamp });
      start = end;
    }
    const valid = lines.filter(line => line.timestamp !== null).sort((a, b) => a.timestamp! - b.timestamp!);
    const recent = new Set(retention.count === undefined ? [] : valid.slice(-retention.count));
    const kept: Buffer[] = [], archived: Buffer[] = [];
    for (const line of lines) {
      const keep = !options.all && (line.timestamp === null || (retention.count !== undefined
        ? recent.has(line) : line.timestamp >= now - retention.ms!));
      (keep ? kept : archived).push(line.bytes);
    }
    const result = { archived: archived.length, retained: kept.length,
      malformed: lines.length - valid.length, archivePath: archived.length ? archivePath : null };
    if (!archived.length) return result;
    await privateArchiveDirectory(artifactRoot, dirname(archivePath), true);
    const archive = await open(archivePath, 'wx', LEDGER_FILE_MODE);
    archiveCreated = true;
    try { await writeFully(archive, Buffer.concat(archived)); await archive.sync(); } finally { await archive.close(); }
    if (!IS_WINDOWS) await syncDirectory(dirname(archivePath));
    const replacement = await open(tempPath, 'wx', LEDGER_FILE_MODE);
    try { await writeFully(replacement, Buffer.concat(kept)); await replacement.sync(); } finally { await replacement.close(); }
    await rename(tempPath, ledgerPath);
    archiveCreated = false; // Both files now own their respective records.
    if (!IS_WINDOWS) await syncDirectory(decisionDir);
    return result;
  } catch (error) {
    if (archiveCreated) await rm(archivePath, { force: true }); // Live file is still intact.
    throw error;
  } finally {
    try { await rm(tempPath, { force: true }); } finally { await release(); }
  }
}

export interface RecordDecisionAskOptions {
  transport: DecisionLedgerTransport;
  /** Project root; used both to resolve the ledger location and to resolve the active provider. */
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  /** `--provider` override. */
  explicitProvider?: string;
  /** `--session` override; both transports also resolve harness environment ids. */
  explicitSessionId?: string;
  /** Pre-validated attribution tag; an invalid shape is coerced to `null` defensively. */
  caller?: string | null;
  recordText?: boolean;
  now?: () => number;
  id?: () => string;
  warn?: (message: string) => void;
  /** Overrides `DECISION_LEDGER_RECORD_TIMEOUT_MS`; test-only. */
  timeoutMs?: number;
  /** Test injection point for provider resolution; defaults to `resolveActiveProvider`. */
  resolveProvider?: (options: { cwd: string; explicitProvider?: string; env?: NodeJS.ProcessEnv }) => Promise<ProviderResolution>;
  /** Test-only: forwarded to `appendDecisionLedgerRecord` to simulate short writes. */
  writeChunk?: LedgerWriteChunk;
}

/** Never throws: a provider-detection failure (missing config, unreadable capability matrix, …) degrades to "unknown". */
async function resolveProviderSafely(options: RecordDecisionAskOptions): Promise<string> {
  try {
    const resolve = options.resolveProvider ?? resolveActiveProvider;
    const resolution = await resolve({ cwd: options.projectRoot, explicitProvider: options.explicitProvider, env: options.env ?? process.env });
    return resolution.provider ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

interface CancellationFlag {
  cancelled: boolean;
}

async function performRecord(
  input: DecisionAskInput,
  result: DecisionAskResult,
  options: RecordDecisionAskOptions,
  warn: (message: string) => void,
  flag: CancellationFlag,
): Promise<DecisionLedgerRecord | null> {
  try {
    const provider = await resolveProviderSafely(options);
    if (flag.cancelled) return null;
    const session = resolveDecisionSession(options.explicitSessionId, options.env ?? process.env);
    const config = await readAiwgConfig(options.projectRoot);
    const record = buildDecisionLedgerRecord(input, result, {
      transport: options.transport,
      provider,
      ...session,
      savingsWeights: decisionSavingsWeights(config?.decision?.ask),
      projectRoot: options.projectRoot,
      caller: options.caller,
      recordText: options.recordText,
      now: options.now,
      id: options.id,
    });
    if (flag.cancelled) return null;
    const appended = await appendDecisionLedgerRecord(record, { projectRoot: options.projectRoot, warn, writeChunk: options.writeChunk });
    return appended ? record : null;
  } catch (error) {
    warn(`warning: failed to record decision ledger entry: ${errorMessage(error)}`);
    return null;
  }
}

const TIMED_OUT = Symbol('decision-ledger-record-timeout');

/**
 * Build and append exactly one ledger record for one `askDecision()` call.
 * Called by the CLI `ask` handler and the MCP `decision-ask` tool — the
 * "same function" referenced in the issue's MCP-parity requirement — each
 * tagging its own `transport`. Attribution resolution (provider/session) and
 * the write both happen inside this one bounded step: never throws, warns at
 * most once, and never waits longer than `timeoutMs` (default
 * `DECISION_LEDGER_RECORD_TIMEOUT_MS`) before returning `null` to the
 * caller. The in-flight attempt itself is not cancelled on timeout (Node
 * cannot abort an in-flight filesystem call); its own later stages simply
 * never start (checked via a cancellation flag before each one), and its
 * eventual settlement — successful or not — is swallowed rather than
 * reported. The caller's own decision result and exit code are therefore
 * always untouched, whether this returns the appended record or `null`.
 */
export async function recordDecisionAsk(
  input: DecisionAskInput,
  result: DecisionAskResult,
  options: RecordDecisionAskOptions,
): Promise<DecisionLedgerRecord | null> {
  const warn = makeOnceWarn(options.warn);
  const timeoutMs = options.timeoutMs ?? DECISION_LEDGER_RECORD_TIMEOUT_MS;
  const flag: CancellationFlag = { cancelled: false };
  const work = performRecord(input, result, options, warn, flag);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([work, timedOut]);
    if (outcome === TIMED_OUT) {
      flag.cancelled = true;
      warn(`warning: decision ledger recording exceeded ${timeoutMs}ms; completion unknown`);
      work.catch(() => {}); // let the background attempt settle without an unhandled rejection
      return null;
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Read-back: history and stats. Both stream the ledger line-by-line rather
// than loading and splitting the whole file, validate each record strictly
// (reporting a `skipped` count rather than trusting a malformed line), and
// aggregate incrementally (no array spread into Math.min/max).
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidCalendarComponents(year: number, month1: number, day: number, hour: number, minute: number, second: number): boolean {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return false;
  const date = new Date(Date.UTC(year, month1 - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month1 - 1 && date.getUTCDate() === day;
}

// Our own writer always emits exactly this shape via Date#toISOString().
const RECORD_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/;

/** Strict: the exact `toISOString()` shape, with calendar/time components validated (review r2 finding 10/12). */
function isStrictRecordTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = RECORD_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const [, y, mo, d, h, mi, s] = match;
  return isValidCalendarComponents(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s));
}

function isUnitIntervalOrNull(value: unknown): boolean {
  return value === null || (isFiniteNumber(value) && value >= 0 && value <= 1);
}

function isNonNegativeOrNull(value: unknown): boolean {
  return value === null || (isFiniteNumber(value) && value >= 0);
}

function isUsageShape(value: unknown): value is DecisionAskResult['usage'] {
  if (value === null) return true;
  if (typeof value !== 'object') return false;
  const usage = value as Record<string, unknown>;
  return isNonNegativeOrNull(usage.inputTokens) && isNonNegativeOrNull(usage.outputTokens);
}

/** Validates required fields, enums, the timestamp and every numeric field (with meaningful ranges) before a record is trusted. */
function isDecisionLedgerRecord(value: unknown): value is DecisionLedgerRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.schema !== DECISION_LEDGER_SCHEMA && record.schema !== DECISION_LEDGER_SCHEMA_V1) return false;
  if (typeof record.id !== 'string' || record.id.length === 0) return false;
  if (!isStrictRecordTimestamp(record.timestamp)) return false;
  if (record.transport !== 'cli' && record.transport !== 'mcp') return false;
  if (typeof record.provider !== 'string') return false;
  if (typeof record.sessionId !== 'string') return false;
  if (typeof record.projectRoot !== 'string') return false;
  if (!(DECISION_LEDGER_KINDS as readonly string[]).includes(record.decisionKind as string)) return false;
  if (record.choiceIds !== null && !(Array.isArray(record.choiceIds) && record.choiceIds.every(id => typeof id === 'string'))) return false;
  if (record.answerIndex !== null && !(Number.isInteger(record.answerIndex) && (record.answerIndex as number) >= 0)) return false;
  if (record.choiceCount !== null && !(Number.isInteger(record.choiceCount) && (record.choiceCount as number) >= 0)) return false;
  if (typeof record.choiceIdsTruncated !== 'boolean') return false;
  if (!/^[a-f0-9]{64}$/.test(record.questionDigest as string)) return false;
  if (record.contextDigest !== null && !/^[a-f0-9]{64}$/.test(record.contextDigest as string)) return false;
  if (!(DECISION_LEDGER_STATUSES as readonly string[]).includes(record.status as string)) return false;
  if (!['string', 'boolean', 'number'].includes(typeof record.answer) && record.answer !== null) return false;
  if (!isUnitIntervalOrNull(record.confidence)) return false;
  if (record.answeredBy !== undefined && record.answeredBy !== null && record.answeredBy !== 'confidence' && record.answeredBy !== 'agreement') return false;
  if (!isUnitIntervalOrNull(record.threshold) || record.threshold === null) return false;
  if (record.fallbackReason !== null && typeof record.fallbackReason !== 'string') return false;
  if (record.model !== null && typeof record.model !== 'string') return false;
  if (!isUsageShape(record.usage)) return false;
  if (!isNonNegativeOrNull(record.latencyMs) || record.latencyMs === null) return false;
  if (!isFiniteNumber(record.estimatedLlmTokensAvoided)) return false; // may be negative
  if (record.schema === DECISION_LEDGER_SCHEMA_V1) {
    if (typeof record.estimationMethod !== 'string') return false;
  } else {
    const method = record.estimationMethod as Record<string, unknown> | null;
    if (!method || typeof method !== 'object' || method.version !== 'aiwg-decision-savings/v2') return false;
    if (!['standard', 'reasoning'].includes(method.caller_model_class as string)) return false;
    for (const key of ['input_tokens', 'reasoning_tokens', 'output_tokens', 'llm_per_mtok', 'jev_per_mtok']) {
      if (!isFiniteNumber(method[key]) || (method[key] as number) < 0 || (method[key] as number) > 1_000_000) return false;
    }
    if (validateDecisionConfig({ ask: { cost: Object.fromEntries(
      ['llm_per_mtok', 'jev_per_mtok', 'jev_input_per_mtok', 'jev_output_per_mtok', 'source', 'checked_at', 'jev_model']
        .filter(key => method[key] !== undefined).map(key => [key, method[key]])) } }).length) return false;
    if (method.jev_rate_basis !== undefined && !['split', 'blended'].includes(method.jev_rate_basis as string)) return false;
    if (typeof record.sessionSource !== 'string') return false;
    for (const key of ['llm_tokens_avoided', 'jev_tokens']) {
      if (!isFiniteNumber(record[key]) || (record[key] as number) < 0) return false;
    }
    if (!isFiniteNumber(record.cost_weighted_net_usd)) return false;
  }
  if (record.caller !== null && typeof record.caller !== 'string') return false;
  for (const key of ['passesRequested', 'escalationPasses', 'passesRun'] as const) {
    if (record[key] !== undefined && (!Number.isSafeInteger(record[key]) || (record[key] as number) < (key === 'passesRun' ? 0 : 1))) return false;
  }
  if (record.escalated !== undefined && typeof record.escalated !== 'boolean') return false;
  if (record.agreementRatio !== undefined && (record.agreementRatio === null || !isUnitIntervalOrNull(record.agreementRatio))) return false;
  if (record.minAgreement !== undefined && !isUnitIntervalOrNull(record.minAgreement)) return false;
  if (record.agreementConfidenceFloor !== undefined && (record.agreementConfidenceFloor === null || !isUnitIntervalOrNull(record.agreementConfidenceFloor))) return false;
  if (record.earlyStop !== undefined && record.earlyStop !== null && record.earlyStop !== 'certain-failure' && record.earlyStop !== 'timeout') return false;
  if (record.passConfidenceSummary !== undefined) {
    const summary = record.passConfidenceSummary as Record<string, unknown> | null;
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return false;
    if (![summary.count, summary.missing].every(value => Number.isSafeInteger(value) && (value as number) >= 0)) return false;
    if (![summary.mean, summary.min, summary.max].every(isUnitIntervalOrNull)) return false;
  }
  return true;
}

async function* streamDecisionLedgerLines(path: string): AsyncGenerator<string> {
  if (!existsSync(path)) return;
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
  }
}

async function archiveLedgerPaths(artifactRoot: string, directory = join(artifactRoot, 'archive', 'decision')): Promise<string[]> {
  if (!await privateArchiveDirectory(artifactRoot, directory, false)) return [];
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unsafe decision archive symlink: ${target}`);
    if (entry.isDirectory()) paths.push(...await archiveLedgerPaths(artifactRoot, target));
    else if (entry.name.endsWith('.jsonl')) {
      const handle = await openPrivateLedgerFile(target, message => { throw new Error(message); }, fsConstants.O_RDONLY);
      if (!handle) throw new Error(`Unsafe decision archive: ${target}`);
      await handle.close();
      paths.push(target);
    }
  }
  return paths.sort();
}

/** Streams validated records under the rotation lock; invalid lines yield null. */
async function* streamDecisionLedgerRecords(projectRoot: string, includeArchives = false): AsyncGenerator<DecisionLedgerRecord | null> {
  const livePath = ledgerReadPath(projectRoot);
  const decisionDir = dirname(livePath);
  if (!existsSync(decisionDir)) return;
  if (!(await lstat(decisionDir)).isDirectory()) throw new Error('Decision ledger directory must be a real directory');
  // A single lock also prevents readers from observing the archive and live
  // replacement at different points in a rotation (duplicates or omissions).
  const release = await lockDecisionLedger(decisionDir);
  try {
    const paths = includeArchives ? [...await archiveLedgerPaths(projectAiwgPath(projectRoot)), livePath] : [livePath];
    for (const path of paths) {
      for await (const line of streamDecisionLedgerLines(path)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          yield isDecisionLedgerRecord(parsed) ? parsed : null;
        } catch {
          yield null;
        }
      }
    }
  } finally { await release(); }
}

export interface DecisionLedgerFilters {
  includeArchives?: boolean;
  since?: Date;
  provider?: string;
  sessionId?: string;
  kind?: DecisionLedgerKind;
  status?: DecisionAskResult['status'];
  /** Exact caller-tag match (`--caller <tag>`). Mutually exclusive with `callerPrefix`/`noCaller`. */
  caller?: string;
  /** Prefix match: `--caller '<prefix>*'` with the trailing `*` stripped. Mutually exclusive with `caller`/`noCaller`. */
  callerPrefix?: string;
  /** Select only records with no caller tag (`--no-caller`). Mutually exclusive with `caller`/`callerPrefix`. */
  noCaller?: boolean;
}

function matchesFilters(record: DecisionLedgerRecord, filters: DecisionLedgerFilters): boolean {
  if (filters.since && new Date(record.timestamp).getTime() < filters.since.getTime()) return false;
  if (filters.provider !== undefined && record.provider !== filters.provider) return false;
  if (filters.sessionId !== undefined && record.sessionId !== filters.sessionId) return false;
  if (filters.kind !== undefined && record.decisionKind !== filters.kind) return false;
  if (filters.status !== undefined && record.status !== filters.status) return false;
  if (filters.noCaller) return record.caller === null;
  if (filters.caller !== undefined && record.caller !== filters.caller) return false;
  if (filters.callerPrefix !== undefined && (record.caller === null || !record.caller.startsWith(filters.callerPrefix))) return false;
  return true;
}

/** Exposed for direct unit testing; `decisionLedgerHistory`/`decisionLedgerStats` apply this per streamed record instead. */
export function filterDecisionLedgerRecords(records: readonly DecisionLedgerRecord[], filters: DecisionLedgerFilters): DecisionLedgerRecord[] {
  return records.filter(record => matchesFilters(record, filters));
}

export interface DecisionLedgerHistoryResult {
  schema: 'aiwg-decision-ledger-history/v1';
  count: number;
  /** Lines that failed JSON parsing or record validation and were excluded. */
  skipped: number;
  records: DecisionLedgerRecord[];
  /** The filters applied to produce this result, so a `--json` consumer can see what was selected. */
  filters: DecisionLedgerFilters;
}

/** Reads, validates and filters the ledger offline, streaming line-by-line; no network, no Jev call. Tolerates a missing ledger file (empty result). */
export async function decisionLedgerHistory(projectRoot: string, filters: DecisionLedgerFilters = {}): Promise<DecisionLedgerHistoryResult> {
  const records: DecisionLedgerRecord[] = [];
  let skipped = 0;
  for await (const record of streamDecisionLedgerRecords(projectRoot, filters.includeArchives)) {
    if (!record) { skipped += 1; continue; }
    if (matchesFilters(record, filters)) records.push(record);
  }
  records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { schema: 'aiwg-decision-ledger-history/v1', count: records.length, skipped, records, filters: { ...filters } };
}

export type DecisionLedgerGroupBy = 'provider' | 'session' | 'kind' | 'caller' | 'passes' | 'escalation';

export interface DecisionLedgerStatsFilters extends DecisionLedgerFilters {
  groupBy?: DecisionLedgerGroupBy;
}

export interface DecisionLedgerStatsGroup {
  llm_tokens_avoided: number;
  jev_tokens: number;
  cost_weighted_net_usd: number;
  /** v1 inputs recovered from the legacy credit, using the current config. */
  legacyReestimatedCalls: number;
  ratesUsed: Array<{ calls: number; method: Omit<DecisionSavingsMethod, 'input_tokens'> }>;
  /** `null` only for the caller group when no record in the group carries a `--caller` tag — distinct from the literal string "unattributed". */
  key: string | null;
  totalCalls: number;
  answered: number;
  fallback: number;
  /** Fraction of this group's calls that fell back; denominator is `totalCalls`. */
  fallbackRate: number;
  hitRate: number;
  agreement: { count: number; mean: number | null };
  escalatedCalls: number;
  passesRun: number;
  /** Raw per-reason fallback counts. */
  fallbackCountByReason: Record<string, number>;
  /** Per-reason fallback counts as a fraction of `totalCalls` (same denominator as `fallbackRate`). */
  fallbackRateByReason: Record<string, number>;
  confidence: { count: number; mean: number | null; min: number | null; max: number | null };
  jevUsage: { inputTokens: number; outputTokens: number };
  /** All recorded Jev tokens, including fallbacks, divided by answered calls; null with no answers. */
  tokensPerAnsweredDecision: number | null;
  estimatedLlmTokensAvoidedTotal: number;
  /**
   * `estimatedLlmTokensAvoidedTotal` minus the Jev usage actually spent on
   * ANSWERED calls only: each fallback record's own estimate already
   * subtracts that call's Jev usage, so re-subtracting all usage here would
   * double-count it.
   */
  netSavingsTokens: number;
}

export interface DecisionLedgerStatsResult {
  schema: 'aiwg-decision-ledger-stats/v1';
  groupBy: DecisionLedgerGroupBy | null;
  skipped: number;
  groups: DecisionLedgerStatsGroup[];
  /** The filters applied to produce this result, so a `--json` consumer can see what was selected. */
  filters: DecisionLedgerStatsFilters;
  /** Applied only to v1 records; v2 records retain their recorded weights. */
  legacyEstimationWeights: DecisionSavingsWeights;
}

function groupKeyFor(record: DecisionLedgerRecord, groupBy: DecisionLedgerGroupBy | undefined): string | null {
  if (!groupBy) return 'all';
  if (groupBy === 'provider') return record.provider;
  if (groupBy === 'session') return record.sessionId;
  if (groupBy === 'kind') return record.decisionKind;
  if (groupBy === 'passes') return `${record.passesRequested ?? 1}/${record.escalationPasses ?? record.passesRequested ?? 1}`;
  if (groupBy === 'escalation') return String(record.escalated ?? false);
  return record.caller; // may be null; kept distinct from the literal string "unattributed"
}

interface StatsAccumulator {
  llmTokensAvoided: number;
  costWeightedNetUsd: number;
  legacyReestimatedCalls: number;
  ratesUsed: Array<{ calls: number; method: Omit<DecisionSavingsMethod, 'input_tokens'> }>;
  agreementCount: number;
  agreementSum: number;
  escalatedCalls: number;
  passesRun: number;
  totalCalls: number;
  answered: number;
  fallback: number;
  fallbackCountByReason: Record<string, number>;
  confidenceCount: number;
  confidenceSum: number;
  confidenceMin: number | null;
  confidenceMax: number | null;
  jevInputTokens: number;
  jevOutputTokens: number;
  answeredJevInputTokens: number;
  answeredJevOutputTokens: number;
  estimatedLlmTokensAvoidedTotal: number;
}

function newAccumulator(): StatsAccumulator {
  return {
    llmTokensAvoided: 0, costWeightedNetUsd: 0, legacyReestimatedCalls: 0, ratesUsed: [],
    totalCalls: 0, answered: 0, fallback: 0, fallbackCountByReason: {},
    agreementCount: 0, agreementSum: 0, escalatedCalls: 0, passesRun: 0,
    confidenceCount: 0, confidenceSum: 0, confidenceMin: null, confidenceMax: null,
    jevInputTokens: 0, jevOutputTokens: 0, answeredJevInputTokens: 0, answeredJevOutputTokens: 0,
    estimatedLlmTokensAvoidedTotal: 0,
  };
}

function accumulate(acc: StatsAccumulator, record: DecisionLedgerRecord, weights: DecisionSavingsWeights): void {
  acc.totalCalls += 1;
  if (record.agreementRatio !== undefined) { acc.agreementCount += 1; acc.agreementSum += record.agreementRatio; }
  if (record.escalated) acc.escalatedCalls += 1;
  acc.passesRun += record.passesRun ?? (record.fallbackReason === 'not-configured' ? 0 : 1);
  const inputTokens = record.usage?.inputTokens ?? 0;
  const outputTokens = record.usage?.outputTokens ?? 0;
  const method = record.schema === DECISION_LEDGER_SCHEMA
    ? record.estimationMethod as DecisionSavingsMethod
    : estimateDecisionSavings(0, false, inputTokens + outputTokens, weights, record.usage).estimationMethod;
  // Input estimates vary per call; group only the recorded rates and provenance.
  const { input_tokens: _input, ...rateMethod } = method;
  const canonicalRates = (rates: typeof rateMethod) => JSON.stringify(Object.entries(rates).sort(([a], [b]) => a.localeCompare(b)));
  const rateKey = canonicalRates(rateMethod);
  const prior = acc.ratesUsed.find(item => canonicalRates(item.method) === rateKey);
  if (prior) prior.calls++;
  else acc.ratesUsed.push({ calls: 1, method: rateMethod });
  if (record.schema === DECISION_LEDGER_SCHEMA) {
    acc.llmTokensAvoided += record.llm_tokens_avoided!;
    acc.costWeightedNetUsd += record.cost_weighted_net_usd!;
  } else {
    // v1 answered credit contains the original input estimate plus the known
    // per-kind allowance. Digests alone cannot reconstruct caller text.
    const recoveredInput = record.status === 'answered'
      ? Math.max(0, record.estimatedLlmTokensAvoided - DECISION_SAVINGS_REASONING_ALLOWANCE_TOKENS[record.decisionKind]) : 0;
    const estimate = estimateDecisionSavings(recoveredInput, record.status === 'answered', inputTokens + outputTokens, weights, record.usage);
    acc.llmTokensAvoided += estimate.llm_tokens_avoided;
    acc.costWeightedNetUsd += estimate.cost_weighted_net_usd;
    acc.legacyReestimatedCalls += 1;
  }
  if (record.status === 'answered') {
    acc.answered += 1;
    if (record.confidence !== null) {
      acc.confidenceCount += 1;
      acc.confidenceSum += record.confidence;
      acc.confidenceMin = acc.confidenceMin === null ? record.confidence : Math.min(acc.confidenceMin, record.confidence);
      acc.confidenceMax = acc.confidenceMax === null ? record.confidence : Math.max(acc.confidenceMax, record.confidence);
    }
    acc.answeredJevInputTokens += inputTokens;
    acc.answeredJevOutputTokens += outputTokens;
  } else {
    acc.fallback += 1;
    const reason = record.fallbackReason ?? 'unknown';
    acc.fallbackCountByReason[reason] = (acc.fallbackCountByReason[reason] ?? 0) + 1;
  }
  acc.jevInputTokens += inputTokens;
  acc.jevOutputTokens += outputTokens;
  acc.estimatedLlmTokensAvoidedTotal += record.estimatedLlmTokensAvoided;
}

function finalizeGroup(key: string | null, acc: StatsAccumulator): DecisionLedgerStatsGroup {
  const fallbackRateByReason: Record<string, number> = {};
  for (const [reason, count] of Object.entries(acc.fallbackCountByReason)) {
    fallbackRateByReason[reason] = acc.totalCalls ? count / acc.totalCalls : 0;
  }
  return {
    key,
    llm_tokens_avoided: acc.llmTokensAvoided,
    jev_tokens: acc.jevInputTokens + acc.jevOutputTokens,
    cost_weighted_net_usd: acc.costWeightedNetUsd,
    legacyReestimatedCalls: acc.legacyReestimatedCalls,
    ratesUsed: acc.ratesUsed,
    totalCalls: acc.totalCalls,
    answered: acc.answered,
    fallback: acc.fallback,
    fallbackRate: acc.totalCalls ? acc.fallback / acc.totalCalls : 0,
    hitRate: acc.totalCalls ? acc.answered / acc.totalCalls : 0,
    agreement: { count: acc.agreementCount, mean: acc.agreementCount ? acc.agreementSum / acc.agreementCount : null },
    escalatedCalls: acc.escalatedCalls, passesRun: acc.passesRun,
    fallbackCountByReason: acc.fallbackCountByReason,
    fallbackRateByReason,
    confidence: {
      count: acc.confidenceCount,
      mean: acc.confidenceCount ? acc.confidenceSum / acc.confidenceCount : null,
      min: acc.confidenceMin,
      max: acc.confidenceMax,
    },
    jevUsage: { inputTokens: acc.jevInputTokens, outputTokens: acc.jevOutputTokens },
    tokensPerAnsweredDecision: acc.answered ? (acc.jevInputTokens + acc.jevOutputTokens) / acc.answered : null,
    estimatedLlmTokensAvoidedTotal: acc.estimatedLlmTokensAvoidedTotal,
    netSavingsTokens: acc.estimatedLlmTokensAvoidedTotal - (acc.answeredJevInputTokens + acc.answeredJevOutputTokens),
  };
}

/** Reads, validates, filters and aggregates the ledger offline, streaming line-by-line with incremental min/max; no network, no Jev call. Tolerates a missing ledger file (empty result). */
export async function decisionLedgerStats(projectRoot: string, filters: DecisionLedgerStatsFilters = {}): Promise<DecisionLedgerStatsResult> {
  const config = await readAiwgConfig(projectRoot);
  const weights = decisionSavingsWeights(config?.decision?.ask);
  const groups = new Map<string | null, StatsAccumulator>();
  let skipped = 0;
  for await (const record of streamDecisionLedgerRecords(projectRoot, filters.includeArchives)) {
    if (!record) { skipped += 1; continue; }
    if (!matchesFilters(record, filters)) continue;
    const key = groupKeyFor(record, filters.groupBy);
    let acc = groups.get(key);
    if (!acc) { acc = newAccumulator(); groups.set(key, acc); }
    accumulate(acc, record, weights);
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => (a ?? '').localeCompare(b ?? ''));
  return {
    schema: 'aiwg-decision-ledger-stats/v1',
    groupBy: filters.groupBy ?? null,
    skipped,
    groups: sortedKeys.map(key => finalizeGroup(key, groups.get(key) as StatsAccumulator)),
    filters: { ...filters },
    legacyEstimationWeights: weights,
  };
}

// ---------------------------------------------------------------------------
// Since-date parsing — strict ISO-8601, offsetless timestamps and bare dates
// both interpreted as UTC, invalid calendar dates rejected (including when
// an explicit offset is present: the LOCAL calendar/time components are
// validated before the offset is applied).
// ---------------------------------------------------------------------------

export class DecisionLedgerSinceError extends Error {
  constructor(message: string) { super(message); this.name = 'DecisionLedgerSinceError'; }
}

const BARE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Strict `--since` parser: bare `YYYY-MM-DD` and offsetless timestamps are UTC; invalid calendar dates are rejected regardless of whether an offset is present. */
export function parseDecisionLedgerSince(raw: string): Date {
  const bare = BARE_DATE_PATTERN.exec(raw);
  if (bare) {
    const [, y, mo, d] = bare.map(Number) as unknown as [number, number, number, number];
    if (!isValidCalendarComponents(y, mo, d, 0, 0, 0)) throw new DecisionLedgerSinceError(`--since is not a valid calendar date: ${raw}`);
    return new Date(Date.UTC(y, mo - 1, d));
  }
  const timestamp = TIMESTAMP_PATTERN.exec(raw);
  if (timestamp) {
    const [, y, mo, d, h, mi, s, frac, offset] = timestamp;
    // Validate the LOCAL calendar/time components as written, before any offset is applied —
    // an explicit offset must not let an impossible date (e.g. 2026-02-30) through.
    if (!isValidCalendarComponents(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s))) {
      throw new DecisionLedgerSinceError(`--since is not a valid calendar date: ${raw}`);
    }
    const normalized = `${y}-${mo}-${d}T${h}:${mi}:${s}${frac ?? ''}${offset ?? 'Z'}`;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) throw new DecisionLedgerSinceError(`--since is not a valid timestamp: ${raw}`);
    return date;
  }
  throw new DecisionLedgerSinceError(`--since must be an ISO-8601 date (YYYY-MM-DD) or timestamp: ${raw}`);
}
