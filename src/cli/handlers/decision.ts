import { resolveSensitiveInput, sensitiveInputOptions } from '../../auth/sensitive-input.js';
import { decisionPricing } from '../../decision/pricing.js';
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import {
  ATTRIBUTION_FIELD_PATTERN,
  DecisionAskUsageError,
  decisionCapabilities,
  DecisionLedgerSinceError,
  decisionLedgerHistory,
  decisionLedgerStats,
  rotateDecisionLedger,
  parseDecisionLedgerRetention,
  evaluateRequestPath,
  listPatterns,
  livePlan,
  MAX_ATTRIBUTION_FIELD_LENGTH,
  materializeSyntheticClassificationSetup,
  parseDecisionLedgerSince,
  readDecisionContextFile,
  runDecisionOffloadCheckpoint,
  runOfflinePattern,
  setupJev,
  showPattern,
  syntheticClassificationSetup,
  validateDecisionInput,
  type DecisionLedgerGroupBy,
  type DecisionLedgerKind,
} from '../../decision/driver.js';
import type { DecisionPatternId } from '../../decision/index.js';

function jsonResult(value: unknown, exitCode = 0): HandlerResult {
  return { exitCode, message: JSON.stringify(value, null, 2), rawOutput: true };
}

function usage(): string {
  return [
    'Usage: aiwg decision <capabilities|status|patterns|validate|evaluate|setup|history|stats|rotate|pricing> [options]',
    '       aiwg decision ask --question "<q>" (--yes-no | --choices a,b,c | --scale 1-5) [--context <text> | --context-file <path> | --context-stdin] [--threshold 0.8] [--timeout-ms 15000] [--passes N] [--escalation-passes N] [--provider <id>] [--session <id>] [--caller <tag>] [--record-text] [--json]',
    '',
    'Commands:',
    '  capabilities|status                 Show offline readiness, primitives, config and feature availability',
    '  patterns list                       List governed decision pattern packs',
    '  patterns show <id>                  Show one pattern pack and schemas',
    '  patterns offline-run <id> [fixture] Run a recorded offline fixture through the decision runtime',
    '  patterns live-plan <id> [--opt-in] [--credential-resolved] [--egress-approved]',
    '  validate <request|definition|ruleset|binding> <path>',
    '  evaluate --request <path> [--host-policy-module <path>]',
    '  setup synthetic-classification [--output-dir <dir>]',
    '  setup jev [--token-interactive | --token-stdin | --token-file <path> | --token-store <name> | --token-env <name>] [--region <r>] [--endpoint <url>] [--verify] [--remove]',
    '  ask --question "<q>" (--yes-no | --choices a,b,c | --scale 1-5) [--provider <id>] [--session <id>] [--caller <tag>] [--record-text]',
    '  history [--since <date>] [--provider <id>] [--session <id>] [--kind yes-no|choices|scale] [--status answered|fallback] [--caller <tag>|<prefix>* | --no-caller] [--include-archives] [--json]',
    '  pricing [--refresh --model jev-X.Y.Z] [--dry-run] [--offline | --allow-snapshot] [--json]',
    '  stats [--since <date>] [--provider <id>] [--session <id>] [--kind yes-no|choices|scale] [--status answered|fallback] [--caller <tag>|<prefix>* | --no-caller] [--group-by provider|session|kind|caller|passes|escalation] [--include-archives] [--json]',
    '  rotate [--keep-last <Nd|N> | --all] [--to <path>] [--json]',
    '',
    'Notes:',
    '  Every COMPLETED `ask` call (CLI and MCP) appends one record to the decision',
    '  ledger (.aiwg/decision/ledger.jsonl, resolved like `aiwg artifacts path`).',
    '  Usage errors (bad flags, oversized context) are never recorded. Question',
    '  and context text are never written unless --record-text is passed, and even',
    '  then only after redaction and truncation to a documented size cap. Every',
    '  other persisted field (session, caller, choice ids, answer, model, provider,',
    '  project root) is also redacted before being written. `questionDigest` and',
    '  `contextDigest` are plain SHA-256 over the raw text: a short, predictable',
    '  question can still be matched by hashing candidate guesses, so a digest is',
    '  not a confidentiality guarantee on its own.',
    '  `history` and `stats` read that ledger offline — no network, no Jev call.',
    '  `--since` is strict ISO-8601: a bare date or an offsetless timestamp is',
    '  interpreted as UTC; invalid calendar dates (e.g. 2026-02-30) are rejected,',
    '  including when an explicit offset is present.',
    `  --session and --caller must match ${ATTRIBUTION_FIELD_PATTERN.source} (<= ${MAX_ATTRIBUTION_FIELD_LENGTH} characters).`,
    '  `history`/`stats` accept `--caller <tag>` (exact), `--caller \'<prefix>*\'` (prefix; the only wildcard), or `--no-caller` (records with no tag; not combinable with `--caller`).',
    '  `history`/`stats` reject unknown flags and positional arguments with exit 2.',
    '  `rotate` keeps the last 90 days by default; --keep-last accepts days or a',
    '  positive count. Rotating everything requires --all. Malformed lines stay',
    '  inline unless --all is used. Archives are private .jsonl files beneath',
    '  archive/decision/ in the resolved artifact root; --to must stay there.',
    '  `history`/`stats` optionally read archives with --include-archives, offline.',
    '  Appenders, rotation and readers share one cross-process lock.',
    '  The ledger trusts only the local filesystem under the project',
    '  artifact root, owned by the same user running aiwg — it is not a defense',
    '  against a hostile process already running as that user.',
  ].join('\n');
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function takeRequiredOption(args: string[], name: string): string {
  const value = takeOption(args, name);
  if (!value || value.startsWith('--')) throw new DecisionAskUsageError(`missing-${name.slice(2)}`, `${name} requires a value`);
  return value;
}

function patternId(value: string | undefined): DecisionPatternId {
  if (!value) throw new Error('Pattern id is required');
  return value as DecisionPatternId;
}

function flagCount(args: string[], names: string[]): number {
  return args.filter(arg => names.includes(arg)).length;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

function parseNumber(value: string | undefined, name: string): number {
  if (value === undefined) throw new DecisionAskUsageError(`missing-${name.slice(2)}`, `${name} requires a value`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new DecisionAskUsageError(`invalid-${name.slice(2)}`, `${name} must be numeric`);
  return parsed;
}

function parseScale(value: string | undefined): { low: number; high: number } {
  if (!value) throw new DecisionAskUsageError('invalid-scale', '--scale requires a range like 1-5');
  const match = /^(-?\d+)-(-?\d+)$/.exec(value);
  if (!match) throw new DecisionAskUsageError('invalid-scale', '--scale requires a range like 1-5');
  return { low: Number(match[1]), high: Number(match[2]) };
}

/** Shared by --session and --caller (review r1 finding 1): a conservative identifier shape, rejected with exit 2. */
function takeAttributionOption(args: string[], name: '--session' | '--caller', reason: 'invalid-session' | 'invalid-caller'): string | undefined {
  const value = takeOption(args, name);
  if (value === undefined) return undefined;
  if (!ATTRIBUTION_FIELD_PATTERN.test(value)) {
    throw new DecisionAskUsageError(reason, `${name} must match ${ATTRIBUTION_FIELD_PATTERN.source} (<= ${MAX_ATTRIBUTION_FIELD_LENGTH} characters)`);
  }
  return value;
}

async function decisionSetupJev(rest: string[]): Promise<HandlerResult> {
  const token = rest.includes('--remove') ? undefined : await resolveSensitiveInput(sensitiveInputOptions(rest, 'token'));
  const result = await setupJev({
    token,
    region: takeOption(rest, '--region'),
    endpoint: takeOption(rest, '--endpoint'),
    verify: rest.includes('--verify'),
    remove: rest.includes('--remove'),
  }, { env: process.env });
  return jsonResult(result);
}

async function decisionAsk(ctx: HandlerContext): Promise<HandlerResult> {
  const args = ctx.args.slice(1);
  const modeCount = flagCount(args, ['--yes-no']) + (args.includes('--choices') ? 1 : 0) + (args.includes('--scale') ? 1 : 0);
  if (modeCount !== 1) throw new DecisionAskUsageError('invalid-mode', 'Select exactly one of --yes-no, --choices, or --scale');
  const contextModes = flagCount(args, ['--context', '--context-file', '--context-stdin']);
  if (contextModes > 1) throw new DecisionAskUsageError('invalid-context', 'Select at most one context source');
  // Validated before any Jev call, so a malformed attribution flag never wastes one.
  const explicitSessionId = takeAttributionOption(args, '--session', 'invalid-session');
  const caller = takeAttributionOption(args, '--caller', 'invalid-caller');
  const question = args.includes('--question') ? takeRequiredOption(args, '--question') : '';
  let context: string | undefined = takeOption(args, '--context');
  if (args.includes('--context') && (context === undefined || context.startsWith('--'))) {
    throw new DecisionAskUsageError('missing-context', '--context requires text');
  }
  if (args.includes('--context-file')) {
    const filePath = takeRequiredOption(args, '--context-file');
    context = await readDecisionContextFile(filePath);
  }
  if (args.includes('--context-stdin')) context = await readStdin();
  const choices = args.includes('--choices') ? takeRequiredOption(args, '--choices') : undefined;
  const scale = args.includes('--scale') ? parseScale(takeOption(args, '--scale')) : null;
  const input = {
    question,
    mode: args.includes('--yes-no') ? { kind: 'yes-no' as const }
      : choices !== undefined ? { kind: 'choices' as const, choices: choices.split(',').map(value => value.trim()).filter(Boolean) }
        : { kind: 'scale' as const, ...scale! },
    ...(context === undefined ? {} : { context }),
    ...(args.includes('--passes') ? { passes: parseNumber(takeRequiredOption(args, '--passes'), '--passes') } : {}),
    ...(args.includes('--escalation-passes') ? { escalationPasses: parseNumber(takeRequiredOption(args, '--escalation-passes'), '--escalation-passes') } : {}),
    ...(args.includes('--threshold') ? { threshold: parseNumber(takeOption(args, '--threshold'), '--threshold') } : {}),
    ...(args.includes('--timeout-ms') ? { timeoutMs: parseNumber(takeOption(args, '--timeout-ms'), '--timeout-ms') } : {}),
  };
  const invocation = await runDecisionOffloadCheckpoint(input, {
    transport: 'cli',
    projectRoot: ctx.cwd,
    env: process.env,
    explicitProvider: takeOption(args, '--provider'),
    explicitSessionId,
    caller: caller ?? 'decision-cli:ask',
    ledgerCaller: caller ?? null,
    category: caller ? undefined : 'unattributed',
    recordText: args.includes('--record-text'),
  });
  if (!invocation.result) throw invocation.outcome === 'unknown' ? invocation.error : new Error('Decision ask was skipped');
  const result = invocation.result;
  if (args.includes('--json')) return jsonResult({ ...result, ledgerRecorded: invocation.opportunity.ledgerRecorded });
  if (result.status === 'fallback') return { exitCode: 0, message: `FALLBACK to LLM: ${result.reason}`, rawOutput: true };
  return { exitCode: 0, message: `${String(result.answer)} (confidence ${result.confidence?.toFixed(2) ?? 'unknown'}, ${result.model ?? 'unknown-model'})`, rawOutput: true };
}

function parseSince(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  try {
    return parseDecisionLedgerSince(value);
  } catch (error) {
    if (error instanceof DecisionLedgerSinceError) throw new DecisionAskUsageError('invalid-since', error.message);
    throw error;
  }
}

const DECISION_LEDGER_KINDS: readonly DecisionLedgerKind[] = ['yes-no', 'choices', 'scale'];
const DECISION_LEDGER_STATUSES = ['answered', 'fallback'] as const;
const DECISION_LEDGER_GROUP_BYS: readonly DecisionLedgerGroupBy[] = ['provider', 'session', 'kind', 'caller', 'passes', 'escalation'];

function parseKindFilter(value: string | undefined): DecisionLedgerKind | undefined {
  if (value === undefined) return undefined;
  if (!(DECISION_LEDGER_KINDS as readonly string[]).includes(value)) {
    throw new DecisionAskUsageError('invalid-kind', `--kind must be one of ${DECISION_LEDGER_KINDS.join(', ')}`);
  }
  return value as DecisionLedgerKind;
}

function parseStatusFilter(value: string | undefined): 'answered' | 'fallback' | undefined {
  if (value === undefined) return undefined;
  if (!(DECISION_LEDGER_STATUSES as readonly string[]).includes(value)) {
    throw new DecisionAskUsageError('invalid-status', `--status must be one of ${DECISION_LEDGER_STATUSES.join(', ')}`);
  }
  return value as 'answered' | 'fallback';
}

function parseGroupBy(value: string | undefined): DecisionLedgerGroupBy | undefined {
  if (value === undefined) return undefined;
  if (!(DECISION_LEDGER_GROUP_BYS as readonly string[]).includes(value)) {
    throw new DecisionAskUsageError('invalid-group-by', `--group-by must be one of ${DECISION_LEDGER_GROUP_BYS.join(', ')}`);
  }
  return value as DecisionLedgerGroupBy;
}

const HISTORY_VALUE_FLAGS = ['--since', '--provider', '--session', '--kind', '--status', '--caller'] as const;
const HISTORY_BOOL_FLAGS = ['--json', '--no-caller', '--include-archives'] as const;
const STATS_VALUE_FLAGS = [...HISTORY_VALUE_FLAGS, '--group-by'] as const;
const STATS_BOOL_FLAGS = HISTORY_BOOL_FLAGS;

/**
 * Strict allow-list for `history`/`stats`: unknown `--flags` and positional
 * arguments are usage errors (exit 2) naming the offending token, instead of
 * being silently ignored. `ask`/`setup` parsing is intentionally untouched.
 */
function assertLedgerArgs(args: string[], valueFlags: readonly string[], boolFlags: readonly string[]): void {
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (valueFlags.includes(token)) {
      if (args[index + 1] === undefined) throw new DecisionAskUsageError(`missing-${token.slice(2)}`, `${token} requires a value`);
      index += 2;
      continue;
    }
    if (boolFlags.includes(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('--')) throw new DecisionAskUsageError('unknown-flag', `unknown flag ${token}`);
    throw new DecisionAskUsageError('unexpected-argument', `unexpected argument ${token}`);
  }
}

/**
 * Parses `--caller <tag>` for `history`/`stats`: an exact match, except a
 * single trailing `*` means prefix match (`--caller 'address-issues:*'`).
 * The tag itself must match the attribution shape; `--no-caller` (records
 * with no caller tag) is parsed separately and cannot be combined with it.
 */
function parseCallerFilter(args: string[]): { caller?: string; callerPrefix?: string; noCaller?: boolean } {
  const raw = takeOption(args, '--caller');
  const noCaller = args.includes('--no-caller');
  if (raw !== undefined && noCaller) {
    throw new DecisionAskUsageError('invalid-caller-filter', '--caller and --no-caller cannot be used together');
  }
  if (noCaller) return { noCaller: true };
  if (raw === undefined) return {};
  if (raw === '' || raw.startsWith('--')) {
    throw new DecisionAskUsageError('invalid-caller', '--caller requires a non-empty value');
  }
  const prefix = raw.endsWith('*');
  const tag = prefix ? raw.slice(0, -1) : raw;
  if (tag === '' || !ATTRIBUTION_FIELD_PATTERN.test(tag)) {
    throw new DecisionAskUsageError('invalid-caller', `--caller must match ${ATTRIBUTION_FIELD_PATTERN.source} (<= ${MAX_ATTRIBUTION_FIELD_LENGTH} characters), allowing one trailing *`);
  }
  return prefix ? { callerPrefix: tag } : { caller: tag };
}

/** Shared by `history` and `stats` (review r1 finding 9): the same filters, parsed the same way. */
function parseLedgerFilters(args: string[]) {
  return {
    since: parseSince(takeOption(args, '--since')),
    provider: takeOption(args, '--provider'),
    sessionId: takeOption(args, '--session'),
    kind: parseKindFilter(takeOption(args, '--kind')),
    status: parseStatusFilter(takeOption(args, '--status')),
    ...parseCallerFilter(args),
    ...(args.includes('--include-archives') ? { includeArchives: true } : {}),
  };
}

/** One header line stating the caller filter, shown only when one is set. */
function callerFilterHeader(filters: { caller?: string; callerPrefix?: string; noCaller?: boolean }): string | null {
  if (filters.noCaller) return 'Caller filter: no caller (records with no caller tag)';
  if (filters.caller !== undefined) return `Caller filter: ${filters.caller}`;
  if (filters.callerPrefix !== undefined) return `Caller filter: ${filters.callerPrefix}*`;
  return null;
}

async function decisionHistory(ctx: HandlerContext): Promise<HandlerResult> {
  const args = ctx.args.slice(1);
  assertLedgerArgs(args, HISTORY_VALUE_FLAGS, HISTORY_BOOL_FLAGS);
  const filters = parseLedgerFilters(args);
  const result = await decisionLedgerHistory(ctx.cwd, filters);
  if (args.includes('--json')) return jsonResult(result);
  const header = result.skipped > 0 ? [`(${result.skipped} invalid line(s) skipped)`] : [];
  const callerHeader = callerFilterHeader(filters);
  if (callerHeader) header.push(callerHeader);
  if (result.count === 0) return { exitCode: 0, message: [...header, 'No decision ledger records match the filters.'].join('\n'), rawOutput: true };
  const lines = result.records.map(record => `${record.timestamp}  ${record.status.padEnd(8)} provider=${record.provider} kind=${record.decisionKind} confidence=${record.confidence ?? '-'} caller=${record.caller ?? '-'} id=${record.id}`);
  return { exitCode: 0, message: [...header, ...lines].join('\n'), rawOutput: true };
}

async function decisionStats(ctx: HandlerContext): Promise<HandlerResult> {
  const args = ctx.args.slice(1);
  assertLedgerArgs(args, STATS_VALUE_FLAGS, STATS_BOOL_FLAGS);
  const filters = { ...parseLedgerFilters(args), groupBy: parseGroupBy(takeOption(args, '--group-by')) };
  const result = await decisionLedgerStats(ctx.cwd, filters);
  if (args.includes('--json')) return jsonResult(result);
  const header = result.skipped > 0 ? [`(${result.skipped} invalid line(s) skipped)`] : [];
  const callerHeader = callerFilterHeader(filters);
  if (callerHeader) header.push(callerHeader);
  if (result.groups.length === 0) return { exitCode: 0, message: [...header, 'No decision ledger records match the filters.'].join('\n'), rawOutput: true };
  const lines = result.groups.flatMap(group => [
    `${result.groupBy ?? 'all'}=${group.key ?? 'null'}: ${group.totalCalls} calls (${group.answered} answered, ${group.fallback} fallback, hit rate=${group.hitRate.toFixed(2)}, fallback rate=${group.fallbackRate.toFixed(2)})`,
    `  confidence: mean=${group.confidence.mean?.toFixed(2) ?? '-'} min=${group.confidence.min?.toFixed(2) ?? '-'} max=${group.confidence.max?.toFixed(2) ?? '-'} (n=${group.confidence.count})`,
    `  agreement: mean=${group.agreement.mean?.toFixed(2) ?? '-'} escalated=${group.escalatedCalls} passes run=${group.passesRun}`,
    `  jev usage: input=${group.jevUsage.inputTokens} output=${group.jevUsage.outputTokens}`,
    `  tokens per answered decision=${group.tokensPerAnsweredDecision?.toFixed(2) ?? '-'}`,
    `  llm_tokens_avoided=${group.llm_tokens_avoided} jev_tokens=${group.jev_tokens} cost_weighted_net_usd=${group.cost_weighted_net_usd.toFixed(6)}`,
    ...group.ratesUsed.map(rate => `  rates used (${rate.calls} calls): ${JSON.stringify(rate.method)} source=${rate.method.source ?? 'manual'} checked_at=${rate.method.checked_at ?? 'unknown'}`),
    `  v1 comparison only: estimated LLM tokens avoided=${group.estimatedLlmTokensAvoidedTotal} net savings=${group.netSavingsTokens}`,
    ...(group.legacyReestimatedCalls ? [`  v1 records re-estimated=${group.legacyReestimatedCalls} weights=${JSON.stringify(result.legacyEstimationWeights)}`] : []),
  ]);
  return { exitCode: 0, message: [...header, ...lines].join('\n'), rawOutput: true };
}

async function decisionRotate(ctx: HandlerContext): Promise<HandlerResult> {
  const args = ctx.args.slice(1);
  assertLedgerArgs(args, ['--keep-last', '--to'], ['--all', '--json']);
  const keepLast = args.includes('--keep-last') ? takeRequiredOption(args, '--keep-last') : undefined;
  const all = args.includes('--all');
  try {
    parseDecisionLedgerRetention(keepLast, all);
  } catch (error) {
    throw new DecisionAskUsageError('invalid-retention', error instanceof Error ? error.message : String(error));
  }
  const result = await rotateDecisionLedger({ projectRoot: ctx.cwd, keepLast, all,
    to: args.includes('--to') ? takeRequiredOption(args, '--to') : undefined });
  if (args.includes('--json')) return jsonResult(result);
  return { exitCode: 0, rawOutput: true, message:
    `Archived ${result.archived} line(s)${result.archivePath ? ` to ${result.archivePath}` : ''}; retained ${result.retained} line(s) inline (${result.malformed} malformed).` };
}

async function executeDecision(ctx: HandlerContext): Promise<HandlerResult> {
  const [command, subcommand, ...rest] = ctx.args;
  const options = { cwd: ctx.cwd, frameworkRoot: ctx.frameworkRoot, env: process.env };
  try {
    if (!command || command === '--help' || command === '-h') return { exitCode: 0, message: usage(), rawOutput: true };
    if (command === 'capabilities' || command === 'status') return jsonResult(decisionCapabilities(options));
    if (command === 'ask') return await decisionAsk(ctx);
    if (command === 'history') return await decisionHistory(ctx);
    if (command === 'rotate') return await decisionRotate(ctx);
    if (command === 'pricing') {
      const args = ctx.args.slice(1);
      assertLedgerArgs(args, ['--model'], ['--refresh', '--dry-run', '--offline', '--allow-snapshot', '--json']);
      const result = await decisionPricing({ cwd: ctx.cwd, refresh: args.includes('--refresh'), dryRun: args.includes('--dry-run'),
        offline: args.includes('--offline'), allowSnapshot: args.includes('--allow-snapshot'), model: args.includes('--model') ? takeRequiredOption(args, '--model') : undefined });
      if (args.includes('--json')) return jsonResult(result);
      return { exitCode: 0, rawOutput: true, message: [
        `decision.ask.cost: ${JSON.stringify(result.current)}`,
        `Source URL: ${result.sourceUrl}`,
        ...('snapshotDate' in result && result.snapshotDate ? [`Bundled snapshot dated ${result.snapshotDate}`] : []),
        ...('warning' in result && result.warning ? [`Warning: ${result.warning}`] : []),
        ...('diff' in result ? [`${result.written ? 'Written' : 'Dry run; config unchanged'}: ${JSON.stringify(result.diff)}`] : []),
      ].join('\n') };
    }
    if (command === 'stats') return await decisionStats(ctx);
    if (command === 'patterns') {
      if (subcommand === 'list') return jsonResult(listPatterns());
      if (subcommand === 'show') return jsonResult(showPattern(patternId(rest[0])));
      if (subcommand === 'offline-run') return jsonResult(await runOfflinePattern(patternId(rest[0]), rest[1]));
      if (subcommand === 'live-plan') return jsonResult(livePlan(patternId(rest[0]), {
        explicitOptIn: rest.includes('--opt-in'),
        credentialResolved: rest.includes('--credential-resolved'),
        egressApproved: rest.includes('--egress-approved'),
      }));
    }
    if (command === 'validate') {
      const target = subcommand as 'request' | 'definition' | 'ruleset' | 'binding';
      const result = await validateDecisionInput(target, rest[0] ?? '', options);
      return jsonResult(result, result.valid ? 0 : 2);
    }
    if (command === 'evaluate') {
      const request = takeOption(ctx.args, '--request');
      if (!request) return { exitCode: 2, message: 'decision evaluate requires --request <path>' };
      const result = await evaluateRequestPath(request, options, {
        hostPolicyModulePath: takeOption(ctx.args, '--host-policy-module'),
      });
      return jsonResult(result, result.exitCode);
    }
    if (command === 'setup' && subcommand === 'synthetic-classification') {
      const outputDir = takeOption(ctx.args, '--output-dir');
      if (outputDir) return jsonResult(await materializeSyntheticClassificationSetup(outputDir, {}, options));
      return jsonResult(syntheticClassificationSetup({}, options));
    }
    if (command === 'setup' && subcommand === 'jev') return await decisionSetupJev(rest);
    return { exitCode: 2, message: usage(), rawOutput: true };
  } catch (error) {
    if (error instanceof DecisionAskUsageError) {
      return { exitCode: 2, message: JSON.stringify({ schema: 'aiwg-decision-error/v1', reason: error.reason, message: error.message }, null, 2), rawOutput: true };
    }
    return { exitCode: 1, message: error instanceof Error ? error.message : String(error) };
  }
}

export const decisionHandler: CommandHandler = {
  id: 'decision',
  name: 'Decision Driver',
  description: 'Inspect, validate and run governed decision classification workflows',
  category: 'utility',
  aliases: [],
  help: async () => ({ exitCode: 0, message: usage(), rawOutput: true }),
  execute: executeDecision,
};
