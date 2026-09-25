/**
 * `aiwg effect`: record, look up, reconcile and verify side effects in the
 * signed effect ledger (#2720, epic #2714).
 *
 * The ledger proves what AIWG recorded and what a verifier observed. It never
 * authorizes or replays an effect. Output is JSON by default, and every JSON
 * document carries a `schema` member. Exit codes are pinned by
 * docs/contracts/effect-ledger.v1.md ("CLI and exit codes"):
 *
 *   0 present or recorded   3 absent     5 conflict           7 artifact root unavailable
 *   1 internal error        4 unknown    6 integrity failure
 *   2 usage error
 *
 * Scope (tenant and project) and the key provider come from host
 * configuration (`effects` in aiwg.config), never from model input. The ledger
 * signing key lives in the host secret service; only key IDs and public keys
 * are ever printed.
 *
 * @see docs/contracts/effect-ledger.v1.md
 */

import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createSecretStore, type SecretStore } from '../../auth/credential-store.js';
import { readAiwgConfig } from '../../config/aiwg-config.js';
import {
  CORE_EFFECT_KINDS,
  DEFAULT_LEDGER_KEY_SERVICE,
  EFFECT_EXIT_CODES,
  EFFECT_SUBSYSTEMS,
  EffectLedgerError,
  LEDGER_TEST_KEY_ENV,
  LedgerSigningKey,
  activeKey,
  containsRestrictedMaterial,
  createBuiltinVerifierRegistry,
  createTrackerVerifiers,
  credentialStoreKeyProvider,
  effectId as deriveEffectId,
  effectOutputJson,
  environmentTestKeyProvider,
  generateLedgerKeySecret,
  initLedgerKeyring,
  inspectLedgerLocks,
  isValidEffectId,
  ledgerLockRecoveryVerifier,
  lookupEffect,
  openEffectLedger,
  payloadDigest,
  readLedgerKeyring,
  reconcileEffect,
  recordIntent,
  recordOutcome,
  recordReconciled,
  recoverStaleLedgerLock,
  rotateKey,
  runVerifier,
  staticKeyProvider,
  verifyDecisionLinks,
  verifyLedger,
  writeCheckpoint,
  type CheckpointSink,
  type EffectContext,
  type EffectKeyring,
  type EffectLedger,
  type EffectLinks,
  type EffectReceipt,
  type EffectScope,
  type EffectSubsystem,
  type EffectVerification,
  type EffectVerifier,
  type EffectVerifierExpectation,
  type EffectVerifierRegistry,
  type LedgerKeyProvider,
  type TrackerVerifierOptions,
} from '../../effects/index.js';
import { parseLedgerPrivateKey } from '../../effects/keys.js';
import { JsonlOperatorDecisionStore, verifyDecisionChain, type OperatorDecisionRecord } from '../../audit/operator-decision.js';
import { readConfig, readGitRemoteUrls } from '../../tracker/project-inputs.js';
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export const EFFECT_SUBCOMMANDS = ['id', 'intent', 'record', 'lookup', 'reconcile', 'probe', 'verify', 'checkpoint', 'kinds', 'keys', 'recover-lock'] as const;
type Subcommand = typeof EFFECT_SUBCOMMANDS[number];

export function effectUsage(): string {
  return [
    'aiwg effect — Record, look up, reconcile and verify side effects in the signed effect ledger',
    '',
    'Usage:',
    '  aiwg effect id         <identity>',
    '  aiwg effect intent     <identity> <payload> [--link k=v]',
    '  aiwg effect record     <identity> <payload> [--unverified] [expectations] [--link k=v]',
    '  aiwg effect lookup     <effect-id> | <identity>',
    '  aiwg effect reconcile  <effect-id> | <identity> [expectations] [--link k=v]',
    '  aiwg effect probe      <identity> [--effect-id <id>] [--since <iso>] [expectations]',
    '  aiwg effect verify     [--trusted-keyid <keyid>]... [--with-decisions <audit.jsonl>]',
    '  aiwg effect checkpoint',
    '  aiwg effect kinds',
    '  aiwg effect keys       list | init | rotate [--reason scheduled|custody-change|compromise]',
    '  aiwg effect recover-lock [--lock <name> --authorize]',
    '',
    'Identity:',
    '  --kind <kind> --target <scheme:ref> [--context <json>] [--ctx key=value]...',
    '  --issue <n> --action <name> --cycle <n>          tracker context members',
    '  --review <id> --continuation <id> --proposal-version <n>   D13 review continuation',
    '',
    'Payload (intent, record):',
    '  --payload-file <path|->   digest the exact bytes the effect sends',
    '  --payload-digest sha256:<hex>',
    '',
    'Expectations (record, reconcile):',
    '  --expect-digest sha256:<hex>  --expect-object <oid>  --signed',
    '  --timeout-ms <n>  --verifier-version <semver>',
    '',
    'Common options:',
    '  --subsystem review|job|delivery|custom   (default delivery; review for D13 identities)',
    '  --project-dir <dir>   --format json|text (default json)',
    '',
    'record performs intent, verify and completed in one command.',
    'probe runs the kind verifier once and writes no records (ad-hoc checks such',
    'as "did this PR merge"); it has the same exit codes 0, 3 and 4.',
    'verify --with-decisions also checks the #1567 operator-decision chain and that',
    'every linked operatorDecisionEventId (and record hash) exists in it.',
    'recover-lock removes a stale ledger lock only with --authorize, refuses live,',
    'reused or unverifiable owners, and records the recovery in the ledger.',
    '',
    'Exit codes:',
    '  0 present or recorded   1 internal error   2 usage error   3 absent',
    '  4 unknown               5 conflict         6 integrity failure',
    '  7 artifact root unavailable',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set(['json', 'unverified', 'verify', 'signed', 'authorize']);
const REPEATABLE_FLAGS = new Set(['ctx', 'link', 'trusted-keyid']);

const COMMON = ['project-dir', 'subsystem', 'format', 'json'];
const IDENTITY = ['kind', 'target', 'context', 'ctx', 'issue', 'action', 'cycle', 'review', 'continuation', 'proposal-version'];
const PAYLOAD = ['payload-file', 'payload-digest'];
const EXPECT = ['expect-digest', 'expect-object', 'signed', 'timeout-ms', 'verifier-version'];

const ALLOWED: Record<Subcommand, Set<string>> = {
  id: new Set([...COMMON, ...IDENTITY]),
  intent: new Set([...COMMON, ...IDENTITY, ...PAYLOAD, 'link']),
  record: new Set([...COMMON, ...IDENTITY, ...PAYLOAD, ...EXPECT, 'link', 'unverified', 'verify']),
  lookup: new Set([...COMMON, ...IDENTITY]),
  reconcile: new Set([...COMMON, ...IDENTITY, ...EXPECT, 'link']),
  probe: new Set([...COMMON, ...IDENTITY, ...PAYLOAD, ...EXPECT, 'effect-id', 'since']),
  verify: new Set([...COMMON, 'trusted-keyid', 'with-decisions']),
  checkpoint: new Set(COMMON),
  kinds: new Set(COMMON),
  keys: new Set([...COMMON, 'reason']),
  'recover-lock': new Set([...COMMON, 'lock', 'authorize', 'link']),
};

const LINK_NAMES = new Set(['operatorDecisionEventId', 'operatorDecisionRecordHash', 'traceId', 'spanId', 'toolCallId']);
/** Link forms from the record schema: #1567 references are sha256 digests (D13 event IDs come from `reviewOperatorEventId`). */
const LINK_PATTERNS: Record<string, RegExp> = {
  operatorDecisionEventId: /^sha256:[a-f0-9]{64}$/,
  operatorDecisionRecordHash: /^sha256:[a-f0-9]{64}$/,
  traceId: /^[a-f0-9]{32}$/,
  spanId: /^[a-f0-9]{16}$/,
};

interface ParsedArgs {
  positionals: string[];
  values: Map<string, string[]>;
  booleans: Set<string>;
}

const usage = (message: string, reason: string) => new EffectLedgerError('usage', message, reason);

function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], values: new Map(), booleans: new Set() };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--') || arg === '--') { parsed.positionals.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq >= 0) throw usage(`--${name} does not take a value`, 'invalid-flag');
      parsed.booleans.add(name);
      continue;
    }
    const value: string | undefined = eq < 0 ? args[++index] : arg.slice(eq + 1);
    if (value === undefined) throw usage(`--${name} needs a value`, 'missing-flag-value');
    const existing = parsed.values.get(name) ?? [];
    if (existing.length && !REPEATABLE_FLAGS.has(name)) throw usage(`--${name} may be given once`, 'duplicate-flag');
    existing.push(value);
    parsed.values.set(name, existing);
  }
  return parsed;
}

function checkFlags(sub: Subcommand, parsed: ParsedArgs): void {
  for (const name of [...parsed.values.keys(), ...parsed.booleans]) {
    if (!ALLOWED[sub].has(name)) throw usage(`Unknown option for aiwg effect ${sub}: --${name}`, 'unknown-flag');
  }
}

const one = (parsed: ParsedArgs, name: string) => parsed.values.get(name)?.[0];

function integerFlag(parsed: ParsedArgs, name: string, min = 0): number | undefined {
  const raw = one(parsed, name);
  if (raw === undefined) return undefined;
  if (!/^-?[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min) throw usage(`--${name} must be an integer ≥ ${min}`, 'invalid-integer');
  return Number(raw);
}

function scalar(raw: string): string | number | boolean {
  if (/^-?(?:0|[1-9][0-9]*)$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

function keyValue(entry: string, flag: string): [string, string] {
  const eq = entry.indexOf('=');
  if (eq <= 0) throw usage(`--${flag} expects key=value`, 'invalid-key-value');
  return [entry.slice(0, eq), entry.slice(eq + 1)];
}

// ---------------------------------------------------------------------------
// Host configuration
// ---------------------------------------------------------------------------

export interface EffectKeyProviderConfig {
  /** `credential-store` (default): the host secret service. `file`: an explicit mode-0600 file fallback. */
  type?: 'credential-store' | 'file';
  service?: string;
  /** Defaults to `ledger/<tenant>/<project>/<subsystem>`. */
  account?: string;
  /** Required for `file`. */
  path?: string;
}

export interface EffectHostConfig {
  tenant?: string;
  project?: string;
  writer?: string;
  keyProvider?: EffectKeyProviderConfig;
}

/** Test and embedding seams. Production uses host configuration only. */
export interface EffectCliDeps {
  /** Replace the configured key store. `role` is `current` or `next` (the staged successor during rotation). */
  keyStore?: (role: 'current' | 'next', account: string) => SecretStore;
  sink?: CheckpointSink;
  clock?: () => number;
  env?: NodeJS.ProcessEnv;
  /**
   * Extra verifiers registered after the built-ins. An extension whose kind is
   * a tracker kind replaces the configured tracker verifier of that kind.
   */
  verifiers?: EffectVerifier[];
  /** Overrides for the tracker verifiers (transport, clock, config and remotes). */
  tracker?: Partial<TrackerVerifierOptions>;
  lockTimeoutMs?: number;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;

function defaultProject(projectDir: string): string {
  const cleaned = basename(resolve(projectDir)).replace(/[^A-Za-z0-9._:/@-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  return cleaned && IDENTIFIER.test(cleaned) ? cleaned : 'project';
}

async function hostConfig(projectDir: string): Promise<EffectHostConfig> {
  let config: unknown;
  try { config = await readAiwgConfig(projectDir); }
  catch { throw new EffectLedgerError('usage', 'aiwg.config could not be read', 'config-unreadable'); }
  const effects = (config as { effects?: unknown } | null)?.effects;
  if (effects === undefined || effects === null) return {};
  if (typeof effects !== 'object' || Array.isArray(effects)) throw usage('aiwg.config effects must be an object', 'config-invalid');
  return effects as EffectHostConfig;
}

function testContext(env: NodeJS.ProcessEnv): boolean {
  return env.VITEST === 'true' || env.NODE_ENV === 'test' || env.CI === 'true' || env.CI === '1';
}

interface Session {
  projectDir: string;
  scope: EffectScope;
  config: EffectHostConfig;
  account: string;
  deps: EffectCliDeps;
  env: NodeJS.ProcessEnv;
}

function keyStore(session: Session, role: 'current' | 'next'): SecretStore | null {
  const { deps, config, account } = session;
  if (deps.keyStore) return deps.keyStore(role, account);
  if (session.env[LEDGER_TEST_KEY_ENV] && testContext(session.env)) return null;
  const provider = config.keyProvider ?? {};
  try {
    if (provider.type === 'file') {
      if (!provider.path) throw new Error('missing path');
      const pathname = resolve(session.projectDir, provider.path);
      return createSecretStore({ useFile: true, allowFile: true, pathname: role === 'next' ? `${pathname}.next` : pathname, service: DEFAULT_LEDGER_KEY_SERVICE, account });
    }
    if (provider.type !== undefined && provider.type !== 'credential-store') throw new Error('unknown provider');
    return createSecretStore({ service: provider.service ?? DEFAULT_LEDGER_KEY_SERVICE, account: role === 'next' ? `${account}.next` : account });
  } catch {
    throw new EffectLedgerError('key-unavailable', 'Effect ledger key provider is not configured correctly on this host', 'key-provider-invalid');
  }
}

function keyProvider(session: Session): LedgerKeyProvider {
  const store = keyStore(session, 'current');
  if (!store) return environmentTestKeyProvider(session.env);
  return credentialStoreKeyProvider({ account: session.account, store });
}

function describeKeyProvider(session: Session): Record<string, string> {
  if (session.deps.keyStore) return { type: 'injected', account: session.account };
  if (session.env[LEDGER_TEST_KEY_ENV] && testContext(session.env)) return { type: 'environment-test-key' };
  const provider = session.config.keyProvider ?? {};
  if (provider.type === 'file') return { type: 'file', account: session.account };
  return { type: 'credential-store', service: provider.service ?? DEFAULT_LEDGER_KEY_SERVICE, account: session.account };
}

function openLedger(session: Session, registry?: EffectVerifierRegistry): EffectLedger {
  const writer = session.config.writer ?? 'cli';
  return openEffectLedger({
    projectDir: session.projectDir, scope: session.scope, writer, keyProvider: keyProvider(session),
    ...(session.deps.clock ? { clock: session.deps.clock } : {}),
    ...(session.deps.sink ? { sink: session.deps.sink } : {}),
    ...(registry ? { verifiers: registry } : {}),
    ...(session.deps.lockTimeoutMs ? { lockTimeoutMs: session.deps.lockTimeoutMs } : {}),
  });
}

/**
 * The one place the CLI builds its verifier registry: the built-ins, lock
 * recovery, the tracker verifiers (#2719) and any injected extensions.
 * `kinds`, `record`, `reconcile` and `probe` all use it, so `kinds` lists
 * exactly what the registry contains. Tracker authority is resolved lazily at
 * verification time, so a project without tracker configuration still lists
 * the tracker kinds and answers `unknown` / `tracker-blocked`.
 */
export function buildCliVerifierRegistry(
  projectRoot: string,
  extensions: EffectVerifier[] = [],
  tracker: TrackerVerifierOptions = { config: null, remoteUrls: {} },
): EffectVerifierRegistry {
  const injected = new Set(extensions.map(verifier => verifier.kind));
  const hostVerifiers: EffectVerifier[] = [
    ledgerLockRecoveryVerifier({ projectDir: projectRoot }),
    ...createTrackerVerifiers(tracker).filter(verifier => !injected.has(verifier.kind)),
  ];
  return createBuiltinVerifierRegistry(
    { git: { repoDir: projectRoot }, file: { root: projectRoot } },
    [...hostVerifiers, ...extensions],
  );
}

/**
 * Tracker verifier options for the CLI: the project config (`readConfig`) and
 * the git remote URLs (`readGitRemoteUrls`), with `overrides` applied last.
 */
export async function cliTrackerOptions(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  overrides: Partial<TrackerVerifierOptions> = {},
): Promise<TrackerVerifierOptions> {
  const [config, remoteUrls] = await Promise.all([
    'config' in overrides ? Promise.resolve(overrides.config ?? null) : readConfig(projectRoot),
    overrides.remoteUrls ? Promise.resolve(overrides.remoteUrls) : readGitRemoteUrls(projectRoot),
  ]);
  return { ...overrides, config, remoteUrls, env: overrides.env ?? env };
}

async function sessionRegistry(session: Session): Promise<EffectVerifierRegistry> {
  const tracker = await cliTrackerOptions(session.projectDir, session.env, session.deps.tracker);
  return buildCliVerifierRegistry(session.projectDir, session.deps.verifiers, tracker);
}

// ---------------------------------------------------------------------------
// Identity, payload, links and expectations
// ---------------------------------------------------------------------------

interface Identity {
  kind: string;
  target: string;
  context: EffectContext;
  derivation: 'aiwg.effect/v1' | 'd13.review/v1';
}

function isReviewIdentity(parsed: ParsedArgs): boolean {
  return ['review', 'continuation', 'proposal-version'].some(name => parsed.values.has(name));
}

function resolveSubsystem(parsed: ParsedArgs): EffectSubsystem {
  const raw = one(parsed, 'subsystem');
  if (raw !== undefined && !(EFFECT_SUBSYSTEMS as readonly string[]).includes(raw)) throw usage('--subsystem must be review, job, delivery or custom', 'invalid-subsystem');
  if (isReviewIdentity(parsed)) {
    if (raw !== undefined && raw !== 'review') throw usage('A D13 review identity uses the review subsystem', 'invalid-subsystem');
    return 'review';
  }
  return (raw as EffectSubsystem | undefined) ?? 'delivery';
}

function hasIdentityFlags(parsed: ParsedArgs): boolean {
  return IDENTITY.some(name => parsed.values.has(name));
}

function identityFrom(parsed: ParsedArgs, scope: EffectScope): Identity {
  if (isReviewIdentity(parsed)) {
    const reviewId = one(parsed, 'review');
    const continuationId = one(parsed, 'continuation');
    const proposalVersion = integerFlag(parsed, 'proposal-version', 1);
    if (!reviewId || !continuationId || proposalVersion === undefined) {
      throw usage('A D13 identity needs --review, --continuation and --proposal-version', 'derivation-input-invalid');
    }
    const kind = one(parsed, 'kind') ?? 'decision.review.continuation';
    if (kind !== 'decision.review.continuation') throw usage('A D13 identity has kind decision.review.continuation', 'derivation-kind-mismatch');
    for (const name of ['context', 'ctx', 'issue', 'action', 'cycle']) {
      if (parsed.values.has(name)) throw usage(`--${name} cannot be combined with a D13 review identity`, 'derivation-input-invalid');
    }
    const target = one(parsed, 'target') ?? `review:${scope.tenant}/${scope.project}/${reviewId}`;
    return { kind, target, context: { reviewId, continuationId, proposalVersion }, derivation: 'd13.review/v1' };
  }
  const kind = one(parsed, 'kind');
  const target = one(parsed, 'target');
  if (!kind || !target) throw usage('An effect identity needs --kind and --target', 'identity-incomplete');
  const context: EffectContext = {};
  const set = (key: string, value: string | number | boolean) => {
    if (Object.prototype.hasOwnProperty.call(context, key)) throw usage(`Context member ${key} is given twice`, 'invalid-context');
    context[key] = value;
  };
  const json = one(parsed, 'context');
  if (json !== undefined) {
    let value: unknown;
    try { value = JSON.parse(json); } catch { throw usage('--context must be a JSON object', 'invalid-context'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw usage('--context must be a JSON object', 'invalid-context');
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) set(key, member as string);
  }
  for (const entry of parsed.values.get('ctx') ?? []) { const [key, raw] = keyValue(entry, 'ctx'); set(key, scalar(raw)); }
  const issue = integerFlag(parsed, 'issue', 1);
  if (issue !== undefined) set('issue', issue);
  const action = one(parsed, 'action');
  if (action !== undefined) set('action', action);
  const cycle = integerFlag(parsed, 'cycle', 0);
  if (cycle !== undefined) set('cycle', cycle);
  if (kind === 'decision.review.continuation') throw usage('decision.review.continuation needs --review, --continuation and --proposal-version', 'derivation-input-invalid');
  return { kind, target, context, derivation: 'aiwg.effect/v1' };
}

function idFor(identity: Identity, scope: EffectScope): string {
  return deriveEffectId({ scope, kind: identity.kind, target: identity.target, context: identity.context }, identity.derivation);
}

/** The effect ID from a positional argument or from identity flags. */
function effectIdFrom(parsed: ParsedArgs, scope: EffectScope): string {
  const positional = parsed.positionals[0];
  if (positional !== undefined) {
    if (hasIdentityFlags(parsed)) throw usage('Give an effect ID or identity flags, not both', 'identity-ambiguous');
    if (parsed.positionals.length > 1) throw usage('Only one effect ID may be given', 'unexpected-argument');
    if (!isValidEffectId(positional)) throw usage('Malformed effect ID', 'malformed-effect-id');
    return positional;
  }
  return idFor(identityFrom(parsed, scope), scope);
}

async function payloadFrom(parsed: ParsedArgs): Promise<string> {
  const digest = one(parsed, 'payload-digest');
  const file = one(parsed, 'payload-file');
  if ((digest === undefined) === (file === undefined)) throw usage('Give exactly one of --payload-file or --payload-digest', 'payload-required');
  if (digest !== undefined) {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw usage('Payload digest must be sha256:<hex>', 'invalid-payload-digest');
    return digest;
  }
  let bytes: Buffer;
  try {
    if (file === '-') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
      bytes = Buffer.concat(chunks);
    } else {
      bytes = await readFile(file!);
    }
  } catch { throw usage('--payload-file could not be read', 'payload-unreadable'); }
  return payloadDigest(bytes);
}

function linksFrom(parsed: ParsedArgs): EffectLinks {
  const links: Record<string, string> = {};
  for (const entry of parsed.values.get('link') ?? []) {
    const [key, value] = keyValue(entry, 'link');
    if (!LINK_NAMES.has(key)) throw usage(`Unknown link name ${key}`, 'invalid-link');
    if (!value || value.length > 256 || /\s/.test(value)) throw usage('Link values are non-empty references without whitespace', 'invalid-link');
    if (LINK_PATTERNS[key] && !LINK_PATTERNS[key].test(value)) throw usage(`Link ${key} has the wrong form`, 'invalid-link');
    links[key] = value;
  }
  return links as EffectLinks;
}

function expectationsFrom(parsed: ParsedArgs): { expected: EffectVerifierExpectation; timeoutMs?: number; verifierVersion?: string } {
  const expected: EffectVerifierExpectation = {};
  const digest = one(parsed, 'expect-digest');
  if (digest !== undefined) {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw usage('--expect-digest must be sha256:<hex>', 'invalid-expectation');
    expected.digest = digest;
  }
  const object = one(parsed, 'expect-object');
  if (object !== undefined) {
    if (!/^[a-f0-9]{40,64}$/.test(object)) throw usage('--expect-object must be a full object ID', 'invalid-expectation');
    expected.object = object;
  }
  if (parsed.booleans.has('signed')) expected.signed = true;
  const timeoutMs = integerFlag(parsed, 'timeout-ms', 1);
  const verifierVersion = one(parsed, 'verifier-version');
  if (verifierVersion !== undefined && !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(verifierVersion)) throw usage('--verifier-version must be MAJOR.MINOR.PATCH', 'invalid-expectation');
  return { expected, ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(verifierVersion ? { verifierVersion } : {}) };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

type Output = { schema: string; exitCode: number } & Record<string, unknown>;

interface Rendered { output: Output; text: string }

function emit(rendered: Rendered, format: 'json' | 'text'): HandlerResult {
  const message = format === 'text' ? rendered.text : effectOutputJson(rendered.output);
  return { exitCode: rendered.output.exitCode, message, rawOutput: true };
}

function errorOutput(error: unknown): Output {
  if (error instanceof EffectLedgerError) {
    const safe = containsRestrictedMaterial(error.message) ? 'Effect command failed' : error.message;
    return { schema: 'aiwg.effect.error.v1', exitCode: error.exitCode, error: { code: error.code, ...(error.reason ? { reason: error.reason } : {}), message: safe } };
  }
  return { schema: 'aiwg.effect.error.v1', exitCode: EFFECT_EXIT_CODES.internal, error: { code: 'internal', message: 'Unexpected effect command failure' } };
}

function receiptLine(receipt: EffectReceipt): string {
  return `${receipt.phase} ${receipt.effectId} (${receipt.writer}#${receipt.seq}${receipt.idempotent ? ', idempotent' : ''})`;
}

function publicKeyring(keyring: EffectKeyring | null): Record<string, unknown> {
  if (!keyring) return { initialized: false, keys: [], rotations: [] };
  return {
    initialized: true,
    activeKeyid: activeKey(keyring).keyid,
    keys: keyring.keys.map(key => ({
      keyid: key.keyid, algorithm: key.algorithm, publicKey: key.publicKey, validFrom: key.validFrom,
      ...(key.validUntil ? { validUntil: key.validUntil } : {}), status: key.status, ...(key.revokedAt ? { revokedAt: key.revokedAt } : {}),
    })),
    rotations: keyring.rotations.map(rotation => ({
      sequence: rotation.sequence, from: rotation.from, to: rotation.to, effectiveAt: rotation.effectiveAt, reason: rotation.reason,
    })),
  };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function runId(session: Session, parsed: ParsedArgs): Promise<Rendered> {
  if (parsed.positionals.length) throw usage('aiwg effect id takes identity flags only', 'unexpected-argument');
  const identity = identityFrom(parsed, session.scope);
  const id = idFor(identity, session.scope);
  return {
    output: { schema: 'aiwg.effect.id.v1', exitCode: 0, effectId: id, idDerivation: identity.derivation, scope: session.scope, kind: identity.kind, target: identity.target, context: identity.context },
    text: id,
  };
}

async function runIntent(session: Session, parsed: ParsedArgs): Promise<Rendered> {
  if (parsed.positionals.length) throw usage('aiwg effect intent takes identity flags only', 'unexpected-argument');
  const identity = identityFrom(parsed, session.scope);
  const digest = await payloadFrom(parsed);
  const links = linksFrom(parsed);
  const ledger = openLedger(session);
  const receipt = await recordIntent(ledger, { kind: identity.kind, target: identity.target, context: identity.context, payloadDigest: digest, derivation: identity.derivation, links });
  return { output: { schema: 'aiwg.effect.intent.v1', exitCode: 0, effectId: receipt.effectId, idempotent: receipt.idempotent, receipt }, text: `recorded ${receiptLine(receipt)}` };
}

async function runRecord(session: Session, parsed: ParsedArgs): Promise<Rendered> {
  if (parsed.positionals.length) throw usage('aiwg effect record takes identity flags only', 'unexpected-argument');
  if (parsed.booleans.has('unverified') && parsed.booleans.has('verify')) throw usage('--unverified and --verify are exclusive', 'flag-conflict');
  const identity = identityFrom(parsed, session.scope);
  const digest = await payloadFrom(parsed);
  const links = linksFrom(parsed);
  const { expected, timeoutMs, verifierVersion } = expectationsFrom(parsed);
  const registry = await sessionRegistry(session);
  const ledger = openLedger(session, registry);
  const intent = await recordIntent(ledger, { kind: identity.kind, target: identity.target, context: identity.context, payloadDigest: digest, derivation: identity.derivation, links });
  const base = { schema: 'aiwg.effect.record.v1', effectId: intent.effectId, intent };
  if (parsed.booleans.has('unverified')) {
    return { output: { ...base, exitCode: 0, status: 'intent', verified: false, idempotent: intent.idempotent, completed: null }, text: `recorded ${receiptLine(intent)} (unverified)` };
  }
  const existing = await lookupEffect(ledger, intent.effectId);
  if (existing.records.some(record => record.phase === 'completed')) {
    const completed = existing.records.find(record => record.phase === 'completed')!;
    return {
      output: { ...base, exitCode: 0, status: 'completed', verified: true, idempotent: intent.idempotent, completed: { phase: 'completed', writer: completed.writer, seq: completed.seq, recordHash: completed.recordHash }, verification: completed.verification },
      text: `completed ${intent.effectId} (idempotent)`,
    };
  }
  if (existing.records.some(record => record.phase === 'failed')) {
    return { output: { ...base, exitCode: EFFECT_EXIT_CODES.absent, status: 'failed', verified: false, idempotent: intent.idempotent, completed: null }, text: `failed ${intent.effectId}` };
  }
  const intentAt = existing.records.find(record => record.phase === 'intent')?.recordedAt ?? ledger.now();
  const run = await runVerifier(registry.get(identity.kind), {
    effectId: intent.effectId, scope: structuredClone(session.scope), kind: identity.kind, target: identity.target,
    context: structuredClone(identity.context), payloadDigest: digest, intentRecordedAt: intentAt, expected,
  }, { ...(timeoutMs ? { timeoutMs } : {}), ...(verifierVersion ? { verifierVersion } : {}) });
  const verification: EffectVerification = { verifier: run.verifier, ...run.observation, checkedAt: ledger.now() };
  const evidence = run.evidence ? { evidence: run.evidence } : {};
  if (verification.result === 'present') {
    const completed = await recordOutcome(ledger, intent.effectId, { phase: 'completed', payloadDigest: digest, verification, links });
    return {
      output: { ...base, exitCode: 0, status: 'completed', verified: true, idempotent: false, completed, verification, ...evidence },
      text: `completed ${intent.effectId} (${verification.reason})`,
    };
  }
  const reconciled = await recordReconciled(ledger, intent.effectId, verification, links);
  const exitCode = verification.result === 'absent' ? EFFECT_EXIT_CODES.absent : EFFECT_EXIT_CODES.unknown;
  return {
    output: { ...base, exitCode, status: 'reconciled', verified: false, idempotent: false, completed: null, reconciled, verification, ...evidence },
    text: `${verification.result} ${intent.effectId} (${verification.reason})`,
  };
}

async function runLookup(session: Session, parsed: ParsedArgs): Promise<Rendered> {
  const id = effectIdFrom(parsed, session.scope);
  const result = await lookupEffect(openLedger(session), id);
  return { output: { schema: 'aiwg.effect.lookup.v1', ...result }, text: `${result.status} ${id}${result.result ? ` (${result.result})` : ''}` };
}

async function runReconcile(session: Session, parsed: ParsedArgs): Promise<Rendered> {
  const id = effectIdFrom(parsed, session.scope);
  const { expected, timeoutMs, verifierVersion } = expectationsFrom(parsed);
  const links = linksFrom(parsed);
  const registry = await sessionRegistry(session);
  const outcome = await reconcileEffect(openLedger(session, registry), id, {
    verifiers: registry, expected, links, ...(timeoutMs ? { timeoutMs } : {}), ...(verifierVersion ? { verifierVersion } : {}),
  });
  const verification = outcome.result.verification;
  return {
    output: {
      schema: 'aiwg.effect.reconcile.v1', exitCode: outcome.result.exitCode, effectId: id, result: outcome.result,
      receipt: outcome.receipt, completed: outcome.completed, ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
    },
    text: `${verification.result} ${id} (${verification.reason})`,
  };
}

/** The empty-payload digest a probe passes when no payload is given. */
const EMPTY_PAYLOAD_DIGEST = payloadDigest(new Uint8Array(0));

/**
 * `probe`: run the kind's verifier once and write nothing. It never opens the
 * ledger, so it needs no key and no artifact root. The effect ID is
 * `--effect-id` (for example the ID a tracker marker carries) or derived from
 * the identity; `--since` stands in for the intent time (default: the epoch,
 * so no consistency-lag window applies).
 */
async function runProbe(session: Session, parsed: ParsedArgs): Promise<Rendered> {
  if (parsed.positionals.length) throw usage('aiwg effect probe takes identity flags only', 'unexpected-argument');
  const identity = identityFrom(parsed, session.scope);
  const explicit = one(parsed, 'effect-id');
  if (explicit !== undefined && !isValidEffectId(explicit)) throw usage('Malformed effect ID', 'malformed-effect-id');
  const id = explicit ?? idFor(identity, session.scope);
  const since = one(parsed, 'since');
  if (since !== undefined && !Number.isFinite(Date.parse(since))) throw usage('--since must be an ISO 8601 time', 'invalid-since');
  const hasPayload = parsed.values.has('payload-file') || parsed.values.has('payload-digest');
  const digest = hasPayload ? await payloadFrom(parsed) : EMPTY_PAYLOAD_DIGEST;
  const { expected, timeoutMs, verifierVersion } = expectationsFrom(parsed);
  const registry = await sessionRegistry(session);
  const run = await runVerifier(registry.get(identity.kind), {
    effectId: id, scope: structuredClone(session.scope), kind: identity.kind, target: identity.target,
    context: structuredClone(identity.context), payloadDigest: digest,
    intentRecordedAt: new Date(since === undefined ? 0 : Date.parse(since)).toISOString(), expected,
  }, { ...(timeoutMs ? { timeoutMs } : {}), ...(verifierVersion ? { verifierVersion } : {}) });
  const now = session.deps.clock ? session.deps.clock() : Date.now();
  const verification: EffectVerification = { verifier: run.verifier, ...run.observation, checkedAt: new Date(now).toISOString() };
  const exitCode = verification.result === 'present' ? EFFECT_EXIT_CODES.ok
    : verification.result === 'absent' ? EFFECT_EXIT_CODES.absent : EFFECT_EXIT_CODES.unknown;
  return {
    output: {
      schema: 'aiwg.effect.probe.v1', exitCode, effectId: id, kind: identity.kind, target: identity.target, recorded: false,
      verification, ...(run.evidence ? { evidence: run.evidence } : {}),
    },
    text: `${verification.result} ${id} (${verification.reason}; not recorded)`,
  };
}

async function readDecisionAudit(path: string): Promise<OperatorDecisionRecord[]> {
  try { return await new JsonlOperatorDecisionStore(path).read(); }
  catch { throw usage('--with-decisions could not be read as an operator-decision JSONL file', 'decisions-unreadable'); }
}

async function runVerify(session: Session, parsed: ParsedArgs): Promise<Rendered> {
  const trusted = parsed.values.get('trusted-keyid');
  const decisionsPath = one(parsed, 'with-decisions');
  const ledger = openLedger(session);
  const result = await verifyLedger(ledger, trusted ? { trustedKeyids: trusted } : {});
  let decisions: Record<string, unknown> | undefined;
  let ok = result.ok;
  const failures: Array<{ reason: string }> = [...result.failures];
  if (decisionsPath !== undefined) {
    const records = await readDecisionAudit(resolve(session.projectDir, decisionsPath));
    const chain = verifyDecisionChain(records);
    const links = await verifyDecisionLinks(ledger, records);
    const chainFailure = { reason: 'decision-chain-broken', index: chain.index ?? null };
    if (!chain.ok) failures.push(chainFailure);
    failures.push(...links.failures);
    ok = ok && chain.ok && links.ok;
    decisions = {
      records: records.length, chain: chain.ok ? 'intact' : 'broken', ...(chain.ok ? {} : { chainFailureIndex: chain.index }),
      linked: links.linked, events: links.events,
    };
  }
  const text = ok
    ? `ledger intact: ${result.records} records, ${result.writers.length} writers${result.checkpoint ? `, checkpoint ${result.checkpoint.sequence}` : ''}${decisions ? `, ${decisions.linked} decision links` : ''}`
    : `ledger integrity failure: ${failures.map(failure => failure.reason).join(', ')}`;
  return {
    output: {
      schema: 'aiwg.effect.verify.v1', ...result, ok, exitCode: ok ? EFFECT_EXIT_CODES.ok : EFFECT_EXIT_CODES.integrity, failures,
      ...(decisions ? { decisions } : {}),
    },
    text,
  };
}

async function runCheckpoint(session: Session): Promise<Rendered> {
  const result = await writeCheckpoint(openLedger(session));
  return {
    output: {
      schema: 'aiwg.effect.checkpoint.v1', exitCode: 0, sequence: result.checkpoint.sequence, digest: result.digest,
      root: result.checkpoint.root, createdAt: result.checkpoint.createdAt, writers: result.checkpoint.writers, sink: result.sink,
    },
    text: `checkpoint ${result.checkpoint.sequence} ${result.digest} -> ${result.sink.reference}`,
  };
}

async function runKinds(session: Session): Promise<Rendered> {
  const registry = await sessionRegistry(session);
  const kinds = registry.listKinds();
  const registered = new Set(kinds.map(kind => kind.kind));
  const unverified = CORE_EFFECT_KINDS.filter(kind => !registered.has(kind));
  return {
    output: { schema: 'aiwg.effect.kinds.v1', exitCode: 0, kinds, coreKinds: [...CORE_EFFECT_KINDS], unverifiedCoreKinds: unverified },
    text: kinds.map(kind => `${kind.kind} ${kind.version}${kind.canReportAbsent ? '' : ' (cannot report absent)'}`).join('\n'),
  };
}

async function runKeys(session: Session, parsed: ParsedArgs): Promise<Rendered> {
  const action = parsed.positionals[0] ?? 'list';
  if (parsed.positionals.length > 1) throw usage('aiwg effect keys takes one action', 'unexpected-argument');
  if (!['list', 'init', 'rotate'].includes(action)) throw usage(`Unknown keys action: ${action}`, 'unknown-subcommand');
  if (parsed.values.has('reason') && action !== 'rotate') throw usage('--reason applies to keys rotate only', 'unknown-flag');
  const provider = describeKeyProvider(session);
  const base = { schema: 'aiwg.effect.keys.v1', action, scope: session.scope, keyProvider: provider };
  const ledger = openLedger(session);
  ledger.paths();

  if (action === 'list') {
    const keyring = publicKeyring(await readLedgerKeyring(ledger));
    return {
      output: { ...base, exitCode: 0, ...keyring },
      text: (keyring.keys as Array<{ keyid: string; status: string }>).map(key => `${key.keyid} ${key.status}`).join('\n') || 'no ledger keys',
    };
  }

  if (action === 'init') {
    const store = keyStore(session, 'current');
    let provisioned = false;
    if (store) {
      let existing: string | null;
      try { existing = await store.loadSecret(); }
      catch { throw new EffectLedgerError('key-unavailable', 'Effect ledger key could not be read from the host secret service', 'key-unavailable'); }
      if (!existing) {
        try { await store.saveSecret(generateLedgerKeySecret()); }
        catch { throw new EffectLedgerError('key-unavailable', 'Effect ledger key could not be stored in the host secret service', 'key-unavailable'); }
        provisioned = true;
      }
    }
    const initialized = openLedger(session);
    const key = await initialized.signingKey();
    const keyring = publicKeyring(await initLedgerKeyring(initialized));
    return {
      output: { ...base, exitCode: 0, provisioned, keyid: key.keyid, publicKey: key.publicKey, ...keyring },
      text: `${provisioned ? 'provisioned' : 'existing'} ledger key ${key.keyid}`,
    };
  }

  const reason = one(parsed, 'reason') ?? 'scheduled';
  if (!['scheduled', 'custody-change', 'compromise'].includes(reason)) throw usage('--reason must be scheduled, custody-change or compromise', 'invalid-reason');
  const current = keyStore(session, 'current');
  const next = keyStore(session, 'next');
  if (!current || !next) throw usage('Key rotation needs a writable key store; the test key provider cannot rotate', 'key-store-required');
  const loadKey = async (store: SecretStore): Promise<LedgerSigningKey | null> => {
    let secret: string | null;
    try { secret = await store.loadSecret(); }
    catch { throw new EffectLedgerError('key-unavailable', 'Effect ledger key could not be read from the host secret service', 'key-unavailable'); }
    return secret ? new LedgerSigningKey(parseLedgerPrivateKey(secret)) : null;
  };
  const saveSecret = async (store: SecretStore, secret: string) => {
    try { await store.saveSecret(secret); }
    catch { throw new EffectLedgerError('key-unavailable', 'Effect ledger key could not be stored in the host secret service', 'key-unavailable'); }
  };
  const prior = await loadKey(current);
  if (!prior) throw new EffectLedgerError('key-unavailable', 'Effect ledger key is not provisioned; run aiwg effect keys init', 'key-unavailable');
  await initLedgerKeyring(openLedger(session)).catch(error => {
    if (!(error instanceof EffectLedgerError && error.reason === 'key-not-active')) throw error;
  });
  const keyring = await readLedgerKeyring(ledger);
  if (!keyring) throw new EffectLedgerError('internal', 'Effect ledger keyring could not be created');
  const staged = await loadKey(next);
  if (staged && activeKey(keyring).keyid === staged.keyid) {
    // A previous rotation updated the keyring but did not promote its key.
    const secret = (await next.loadSecret())!;
    await saveSecret(current, secret);
    await next.deleteSecret().catch(() => undefined);
    return { output: { ...base, exitCode: 0, recovered: true, from: prior.keyid, to: staged.keyid, ...publicKeyring(keyring) }, text: `completed interrupted rotation to ${staged.keyid}` };
  }
  if (activeKey(keyring).keyid !== prior.keyid) {
    throw new EffectLedgerError('key-unavailable', 'The stored ledger key is not the active key; rotation refused', 'key-not-active');
  }
  const successor = generateLedgerKeySecret();
  await saveSecret(next, successor);
  const successorProvider = staticKeyProvider(successor, 'rotation-successor');
  const successorKey = await successorProvider.load();
  const rotated = await rotateKey(ledger, successorProvider, { reason: reason as 'scheduled' | 'custody-change' | 'compromise' });
  await saveSecret(current, successor);
  await next.deleteSecret().catch(() => undefined);
  const effectiveAt = rotated.rotations.at(-1)!.effectiveAt;
  return {
    output: { ...base, exitCode: 0, recovered: false, from: prior.keyid, to: successorKey.keyid, effectiveAt, ...publicKeyring(rotated) },
    text: `rotated ledger key ${prior.keyid} -> ${successorKey.keyid}`,
  };
}

async function runRecoverLock(session: Session, parsed: ParsedArgs): Promise<Rendered> {
  if (parsed.positionals.length) throw usage('aiwg effect recover-lock takes --lock <name>', 'unexpected-argument');
  const lock = one(parsed, 'lock');
  const ledger = openLedger(session);
  if (lock === undefined) {
    if (parsed.booleans.has('authorize')) throw usage('--authorize needs --lock <name>', 'lock-required');
    const locks = await inspectLedgerLocks(ledger);
    return {
      output: { schema: 'aiwg.effect.locks.v1', exitCode: 0, locks },
      text: locks.map(entry => `${entry.lock} ${entry.state ?? 'free'} (${entry.reason})`).join('\n') || 'no ledger locks held',
    };
  }
  const links = linksFrom(parsed);
  const authorized = parsed.booleans.has('authorize');
  const result = await recoverStaleLedgerLock(ledger, lock, { authorize: async () => authorized, links });
  if (result.outcome === 'not-authorized') {
    const error = usage('Stale lock recovery needs explicit operator authorization (--authorize)', 'authorization-required');
    return { output: { ...errorOutput(error), lock, inspection: result.inspection }, text: `${error.message}; ${lock} owner is ${result.inspection.state}` };
  }
  return {
    output: { schema: 'aiwg.effect.lock-recovery.v1', ...result },
    text: `${result.outcome} ${lock} (${result.inspection.reason})${result.effectId ? ` recorded as ${result.effectId}` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function execute(ctx: HandlerContext, deps: EffectCliDeps): Promise<HandlerResult> {
  const args = ctx.args ?? [];
  const wantsText = args.includes('--format') && args[args.indexOf('--format') + 1] === 'text';
  const format: 'json' | 'text' = wantsText || args.includes('--format=text') ? 'text' : 'json';
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    return { exitCode: 0, message: effectUsage(), rawOutput: true };
  }
  try {
    const sub = args[0] as Subcommand;
    if (!(EFFECT_SUBCOMMANDS as readonly string[]).includes(sub)) throw usage(`Unknown effect subcommand: ${args[0]}`, 'unknown-subcommand');
    const parsed = parseArgs(args.slice(1));
    checkFlags(sub, parsed);
    const formatValue = one(parsed, 'format');
    if (formatValue !== undefined && formatValue !== 'json' && formatValue !== 'text') throw usage('--format must be json or text', 'invalid-format');
    const projectDir = resolve(one(parsed, 'project-dir') ?? ctx.cwd ?? process.cwd());
    const subsystem = resolveSubsystem(parsed);
    const config = await hostConfig(projectDir);
    const tenant = config.tenant ?? 'local';
    const project = config.project ?? defaultProject(projectDir);
    if (!IDENTIFIER.test(tenant) || !IDENTIFIER.test(project)) throw usage('aiwg.config effects tenant and project must be identifiers', 'config-invalid');
    const scope: EffectScope = { tenant, project, subsystem };
    const env = deps.env ?? process.env;
    const account = config.keyProvider?.account ?? `ledger/${tenant}/${project}/${subsystem}`;
    const session: Session = { projectDir, scope, config, account, deps, env };
    let rendered: Rendered;
    switch (sub) {
      case 'id': rendered = await runId(session, parsed); break;
      case 'intent': rendered = await runIntent(session, parsed); break;
      case 'record': rendered = await runRecord(session, parsed); break;
      case 'lookup': rendered = await runLookup(session, parsed); break;
      case 'reconcile': rendered = await runReconcile(session, parsed); break;
      case 'probe': rendered = await runProbe(session, parsed); break;
      case 'verify': rendered = await runVerify(session, parsed); break;
      case 'checkpoint': rendered = await runCheckpoint(session); break;
      case 'kinds': rendered = await runKinds(session); break;
      case 'keys': rendered = await runKeys(session, parsed); break;
      case 'recover-lock': rendered = await runRecoverLock(session, parsed); break;
      default: throw usage(`Unknown effect subcommand: ${String(sub)}`, 'unknown-subcommand');
    }
    return emit(rendered, format);
  } catch (error) {
    const output = errorOutput(error);
    const detail = output.error as { code: string; reason?: string; message: string };
    return emit({ output, text: `error (${detail.reason ?? detail.code}): ${detail.message}` }, format);
  }
}

export function createEffectHandler(deps: EffectCliDeps = {}): CommandHandler {
  return {
    id: 'effect',
    name: 'Effect Ledger',
    description: 'Record, look up, reconcile and verify side effects in the signed effect ledger',
    category: 'utility',
    aliases: ['effects'],
    async help() { return { exitCode: 0, message: effectUsage(), rawOutput: true }; },
    execute: ctx => execute(ctx, deps),
  };
}

export const effectHandler: CommandHandler = createEffectHandler();
export const effectHandlers: CommandHandler[] = [effectHandler];
