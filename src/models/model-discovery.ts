import { signalChild } from '../process/signal-child.mjs';
import { hasSelectionRelevantConflicts, validateWorkerCatalogDiscovery } from './provider-policy.js';
import type { WorkerModelObservation } from './types.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import type { ProviderInventory } from '../providers/provider-inventory.js';

export type ModelCatalogSource = 'native' | 'remote' | 'cache' | 'static';

export interface ProviderDiscoveryDecision {
  provider: string;
  status: 'native' | 'unsupported';
  interface: string | null;
  reason: string;
  documentation: string;
}

export const PROVIDER_DISCOVERY_DECISIONS: Record<string, ProviderDiscoveryDecision> = {
  claude: {
    provider: 'claude',
    status: 'unsupported',
    interface: null,
    reason: 'Claude Code documents model selection but no non-interactive model-list command; API enumeration would require separate credentials and would not prove Claude Code subscription entitlement.',
    documentation: 'https://docs.anthropic.com/en/docs/claude-code/cli-usage',
  },
  codex: {
    provider: 'codex',
    status: 'native',
    interface: 'codex app-server model/list; codex debug models (version-scoped fixture)',
    reason: 'The app-server JSON-RPC model/list method returns models available to the current Codex account without running a model turn. The version-scoped codex debug models JSON shape normalizes through the same observation contract.',
    documentation: 'https://developers.openai.com/codex/app-server/',
  },
  copilot: {
    provider: 'copilot',
    status: 'unsupported',
    interface: null,
    reason: 'Copilot CLI documents model strings in help and interactive /models, but no machine-readable account model-list command.',
    documentation: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference',
  },
  cursor: {
    provider: 'cursor',
    status: 'unsupported',
    interface: null,
    reason: 'Cursor CLI exposes editor and agent launch controls but no documented machine-readable model enumeration surface.',
    documentation: 'https://docs.cursor.com/en/cli/reference/parameters',
  },
  factory: {
    provider: 'factory',
    status: 'native',
    interface: 'bounded customModels fields from ~/.factory/settings.json; droid --version',
    reason: 'Configured BYOK custom selectors are observable locally; built-in plan models have no documented non-interactive model-list command and stay static.',
    documentation: 'https://docs.factory.ai/cli/configuration/models',
  },
  grokbot: {
    provider: 'grokbot',
    status: 'unsupported',
    interface: null,
    reason: 'Grok Bot is a desktop multi-agent runtime with no verified non-interactive model-list command; AIWG does not invent xAI/Grok API enumeration as Grok Bot entitlement.',
    documentation: 'https://github.com/jmagly/aiwg/blob/main/docs/architecture/adr-grokbot-provider-target.md',
  },
  'grok-build': {
    provider: 'grok-build',
    status: 'native',
    interface: 'grok inspect --json plus bounded model fields from reported config sources',
    reason: 'Inspect is the authority for active configuration layers; current releases require reading only model-selection fields from those files.',
    documentation: 'https://docs.x.ai/build/settings',
  },
  hermes: {
    provider: 'hermes',
    status: 'unsupported',
    interface: null,
    reason: 'hermes model is interactive; the optional API server /v1/models endpoint requires a separately running service and represents that service rather than local CLI entitlement.',
    documentation: 'https://hermes-agent.nousresearch.com/docs/reference/cli-commands',
  },
  muse: {
    provider: 'muse',
    status: 'native',
    interface: 'model-catalog JSON rows (~/.local/share/muse/model-catalog/*.json)',
    reason: 'Bounded model-catalog JSON rows report configured model facts for the current Muse installation without probing model APIs or consuming tokens. Entitlement stays account-scoped and contributor data-use facts remain config-scoped, never row-derived.',
    documentation: 'https://github.com/jmagly/aiwg/blob/main/docs/architecture/adr-muse-provider-target.md',
  },
  opencode: {
    provider: 'opencode',
    status: 'native',
    interface: 'opencode models --pure',
    reason: 'The documented non-interactive models command lists normalized provider/model identifiers from configured providers.',
    documentation: 'https://opencode.ai/docs/cli/#models',
  },
  openclaw: {
    provider: 'openclaw',
    status: 'native',
    interface: 'openclaw models list --json',
    reason: 'The documented read-only JSON command reports configured catalog rows without probing provider APIs or consuming model tokens.',
    documentation: 'https://docs.openclaw.ai/cli/models#list',
  },
  openhuman: {
    provider: 'openhuman',
    status: 'unsupported',
    interface: null,
    reason: 'OpenHuman profiles accept semantic model hints but expose no standardized local model-list command.',
    documentation: 'https://github.com/roctinam/openhuman',
  },
  ollama: {
    provider: 'ollama',
    status: 'native',
    interface: 'GET /api/tags on the configured local endpoint',
    reason: 'The read-only HTTP model-list endpoint reports the locally present models and per-model digests for the configured Ollama server without probing a remote registry or consuming inference tokens. Declared here (roctinam/aiwg#2899, B-OG-09); no fetcher is implemented against this map by this task — see the local-http worker-adapter registry entry and its adapter docstring for what is actually dispatchable today.',
    documentation: 'https://github.com/ollama/ollama/blob/main/docs/api.md#list-local-models',
  },
  omp: { provider: 'omp', status: 'native', interface: 'omp models --json --no-extensions',
    reason: 'OMP JSON catalog reports credential-available LLM models; ambient extensions are disabled by default.',
    documentation: 'https://github.com/can1357/oh-my-pi/blob/5964a0f7649275bcde818f20073193fd032451f2/packages/coding-agent/src/commands/models.ts' },
  pi: {
    provider: 'pi',
    status: 'native',
    interface: 'pi --list-models',
    reason: 'Pi exposes the configured provider/model catalog through a read-only non-interactive table.',
    documentation: 'https://github.com/earendil-works/pi/tree/main/packages/coding-agent#cli-reference',
  },
  warp: {
    provider: 'warp',
    status: 'unsupported',
    interface: null,
    reason: 'Warp model choice is profile-managed and no documented CLI command enumerates account-available models.',
    documentation: 'https://docs.warp.dev/agent-platform/agent/using-agents',
  },
  windsurf: {
    provider: 'windsurf',
    status: 'unsupported',
    interface: null,
    reason: 'The Windsurf/Devin desktop CLI exposes editor controls but no documented machine-readable model-list command.',
    documentation: 'https://docs.windsurf.com/windsurf/getting-started',
  },
};

export interface DiscoveredModel {
  worker?: WorkerModelObservation;
  id: string;
  /** Provider-local selector. For Grok Build this is the config table alias, not necessarily an API id. */
  alias?: string;
  apiModelId?: string;
  displayName?: string;
  llmProvider?: string;
  hidden?: boolean;
  isDefault?: boolean;
  reasoningEfforts?: string[];
  capabilities?: string[];
  credentialState?: 'available' | 'unavailable' | 'session' | 'unknown';
}

export interface ModelValueProvenance {
  value: string | string[] | boolean | number | null;
  source: string;
  scope: string;
  precedence: number;
  constraint?: 'pin' | 'allowlist';
}

export interface ProviderModelPolicyReport {
  layers: Array<{ scope: string; source: string; precedence: number; policyConstraint: boolean }>;
  selected: Record<string, ModelValueProvenance>;
  constraints: Array<{ key: string; source: string; precedence: number; kind: 'pin' | 'allowlist' }>;
  diagnostics: string[];
}

export interface ProviderModelDiscovery {
  accountBinding?: string;
  provider: string;
  source: ModelCatalogSource;
  observedAt: string;
  runtimeVersion?: string;
  accountScope: 'local-account' | 'local-runtime' | 'public-feed' | 'static';
  models: DiscoveredModel[];
  /** Absent only for a successful, completely parsed refresh. Invalid rows/files
   * make the refresh partial even when valid models survive normalization. */
  errorKind?: 'authentication' | 'rate-limit' | 'timeout' | 'unsupported' | 'invalid-output' | 'environment' | 'command';
  error?: string;
  policy?: ProviderModelPolicyReport;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ModelDiscoveryCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export interface DynamicModelCatalog {
  version: string;
  refreshedAt?: string;
  providers: Record<string, {
    roles: Record<string, { id: string; status?: string; observed?: boolean }>;
    sourceUrl?: string;
    verifiedAt?: string;
  }>;
  discovery?: {
    source: ModelCatalogSource;
    upstreamSource?: Exclude<ModelCatalogSource, 'cache'>;
    fetchedAt: string;
    remoteUrl?: string;
    remoteError?: string;
    inventorySignature?: string;
    providers: Record<string, ProviderModelDiscovery>;
    instances?: Record<string, ProviderModelDiscovery>;
  };
}

export interface ModelDiscoveryOptions {
  aiwgRoot: string;
  inventory: ProviderInventory;
  homeDir?: string;
  cacheFile?: string;
  remoteUrl?: string;
  ttlMs?: number;
  forceRefresh?: boolean;
  allowNetwork?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  runner?: ModelDiscoveryCommandRunner;
  codex?: { command?: string; accountBinding?: string };
  muse?: { catalogDir?: string; accountBinding?: string; runtimeVersion?: string; timeoutMs?: number };
  omp?: { profile?: string; config?: string[]; extensions?: boolean; cwd?: string };
  grokBuild?: { cwd?: string; env?: NodeJS.ProcessEnv; command?: string };
  nativeDiscoverers?: Record<string, () => Promise<ProviderModelDiscovery>>;
}

export interface ModelCatalogDrift {
  changed: boolean;
  providers: Record<string, Array<{
    role: string;
    before: string | null;
    after: string | null;
  }>>;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function classifyDiscoveryError(
  message: string,
): ProviderModelDiscovery['errorKind'] {
  message = stripVTControlCharacters(message);
  if (/\b(?:EROFS|EACCES|EPERM)\b|read-only file system/i.test(message)
    || (/FileSystem\.open|permission denied|operation not permitted/i.test(message)
      && /[\\/]opencode[\\/]log[\\/]|[\\/]\.pi[\\/]agent(?:[\\/]|$)/i.test(message))) {
    return 'environment';
  }
  if (/(?:401|403|unauth|forbidden|credential|login|required auth)/i.test(message)) {
    return 'authentication';
  }
  if (/(?:429|rate.?limit|too many requests|quota)/i.test(message)) return 'rate-limit';
  if (/(?:timed? out|timeout)/i.test(message)) return 'timeout';
  return 'command';
}

const SECRET_ASSIGNMENT = /((?:api[_-]?key|authorization|token|secret|password|cookie|extra_headers?)\s*[=:]\s*)([^\s,}\]]+)/gi;
const BEARER_SECRET = /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

/** Keep native diagnostics useful without ever echoing credential material. */
export function redactModelDiscoveryText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
    .replace(BEARER_SECRET, '$1[REDACTED]')
    .slice(0, 4096);
}

export const runModelDiscoveryCommand: ModelDiscoveryCommandRunner = (
  command,
  args,
  options = {},
) => new Promise(resolveCommand => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const finish = (exitCode: number) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveCommand({ stdout, stderr, exitCode });
  };
  child.stdout.on('data', chunk => { stdout += String(chunk); if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) { stdout = ''; stderr = 'Model catalog exceeded 8 MiB limit'; signalChild(child, 'SIGKILL'); finish(1); } });
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
  child.on('error', error => {
    stderr = `${stderr}${stderr ? '\n' : ''}${error.message}`;
    finish(127);
  });
  child.on('close', code => finish(code ?? 1));
  const timer = setTimeout(() => {
    stderr = `${stderr}${stderr ? '\n' : ''}${command} timed out`;
    signalChild(child);
    finish(124);
  }, options.timeoutMs ?? 10_000);
});

async function runtimeVersion(
  command: string,
  runner: ModelDiscoveryCommandRunner,
): Promise<string | undefined> {
  const result = await runner(command, ['--version'], { timeoutMs: 5_000 });
  return result.exitCode === 0 ? result.stdout.trim().split(/\r?\n/, 1)[0] || undefined : undefined;
}

export async function discoverOpenCodeModels(
  command = 'opencode',
  runner: ModelDiscoveryCommandRunner = runModelDiscoveryCommand,
): Promise<ProviderModelDiscovery> {
  const observedAt = new Date().toISOString();
  const [version, result] = await Promise.all([
    runtimeVersion(command, runner),
    runner(command, ['models', '--pure'], { cwd: tmpdir(), timeoutMs: 15_000 }),
  ]);
  if (result.exitCode !== 0) {
    const error = redactModelDiscoveryText(result.stderr.trim()) || `OpenCode models exited ${result.exitCode}`;
    return {
      provider: 'opencode',
      source: 'native',
      observedAt,
      ...(version ? { runtimeVersion: version } : {}),
      accountScope: 'local-runtime',
      models: [],
      errorKind: classifyDiscoveryError(error),
      error,
    };
  }
  const diagnostics: string[] = [];
  const models = [...new Set(result.stdout.split(/\r?\n/).flatMap((raw, index) => {
    const line = raw.trim();
    if (!line) return [];
    if (/^[a-z0-9][a-z0-9._-]*\/\S+$/i.test(line)) return [line];
    diagnostics.push(`OpenCode models line ${index + 1}: malformed provider/model row`);
    return [];
  }))].map(id => ({ id }));
  return {
    provider: 'opencode',
    source: 'native',
    observedAt,
    ...(version ? { runtimeVersion: version } : {}),
    accountScope: 'local-runtime',
    models,
    ...(diagnostics.length || models.length === 0
      ? { errorKind: 'invalid-output' as const, error: diagnostics.join('; ') || 'OpenCode returned no normalized provider/model rows.' }
      : {}),
  };
}

export async function discoverPiModels(
  command = 'pi',
  runner: ModelDiscoveryCommandRunner = runModelDiscoveryCommand,
): Promise<ProviderModelDiscovery> {
  const observedAt = new Date().toISOString();
  const [version, result] = await Promise.all([
    runtimeVersion(command, runner),
    runner(command, ['--list-models'], { cwd: tmpdir(), timeoutMs: 15_000 }),
  ]);
  if (result.exitCode !== 0) {
    const error = redactModelDiscoveryText(result.stderr.trim()) || `Pi --list-models exited ${result.exitCode}`;
    return { provider: 'pi', source: 'native', observedAt,
      ...(version ? { runtimeVersion: version } : {}), accountScope: 'local-runtime',
      models: [], errorKind: classifyDiscoveryError(error), error };
  }
  const diagnostics: string[] = [];
  const lines = result.stdout.split(/\r?\n/);
  let headerSeen = false;
  const models = lines.flatMap((raw, index) => {
    const line = raw.trim();
    if (!line) return [];
    if (!headerSeen && /^provider\s+model(?:\s|$)/i.test(line)) { headerSeen = true; return []; }
    const columns = line.split(/\s{2,}/);
    if (columns.length < 2 || !/^[a-z0-9][a-z0-9._-]*$/i.test(columns[0]) || !/^\S+$/.test(columns[1])) {
      diagnostics.push(`Pi --list-models line ${index + 1}: malformed provider/model row`);
      return [];
    }
    return [{ id: `${columns[0]}/${columns[1]}` }];
  });
  return { provider: 'pi', source: 'native', observedAt,
    ...(version ? { runtimeVersion: version } : {}), accountScope: 'local-runtime', models,
    ...(diagnostics.length || models.length === 0 ? { errorKind: 'invalid-output' as const,
      error: diagnostics.join('; ') || 'Pi returned no parseable provider/model rows.' } : {}) };
}

export async function discoverOpenClawModels(
  command = 'openclaw',
  runner: ModelDiscoveryCommandRunner = runModelDiscoveryCommand,
): Promise<ProviderModelDiscovery> {
  const observedAt = new Date().toISOString();
  const [version, result] = await Promise.all([
    runtimeVersion(command, runner),
    runner(command, ['models', 'list', '--json'], { timeoutMs: 15_000 }),
  ]);
  if (result.exitCode !== 0) {
    const error = redactModelDiscoveryText(result.stderr.trim()) || `OpenClaw models list exited ${result.exitCode}`;
    return {
      provider: 'openclaw',
      source: 'native',
      observedAt,
      ...(version ? { runtimeVersion: version } : {}),
      accountScope: 'local-runtime',
      models: [],
      errorKind: classifyDiscoveryError(error),
      error,
    };
  }
  try {
    const payload = JSON.parse(result.stdout);
    if (!Array.isArray(payload?.models)) throw new Error('expected /models array');
    const diagnostics: string[] = [];
    const models = payload.models.flatMap((model: any, index: number) => {
      if (!model || typeof model !== 'object' || Array.isArray(model)
        || typeof model.key !== 'string' || !/^[^\s/]+\/\S+$/.test(model.key)
        || (model.available !== undefined && typeof model.available !== 'boolean')
        || (model.name !== undefined && typeof model.name !== 'string')
        || (model.tags !== undefined && (!Array.isArray(model.tags) || model.tags.some((tag: unknown) => typeof tag !== 'string')))) {
        diagnostics.push(`OpenClaw /models/${index}: malformed model row`);
        return [];
      }
      return model.available !== false ? [{
          id: model.key,
          ...(typeof model.name === 'string' ? { displayName: model.name } : {}),
          isDefault: Array.isArray(model.tags) && model.tags.includes('default'),
        }]
        : [];
    });
    return {
      provider: 'openclaw',
      source: 'native',
      observedAt,
      ...(version ? { runtimeVersion: version } : {}),
      accountScope: 'local-runtime',
      models,
      ...(diagnostics.length || models.length === 0
        ? { errorKind: 'invalid-output' as const, error: diagnostics.join('; ') || 'OpenClaw returned no normalized model keys.' }
        : {}),
    };
  } catch (error) {
    return {
      provider: 'openclaw',
      source: 'native',
      observedAt,
      ...(version ? { runtimeVersion: version } : {}),
      accountScope: 'local-runtime',
      models: [],
      errorKind: 'invalid-output',
      error: `Invalid OpenClaw model JSON: ${(error as Error).message}`,
    };
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, file);
}

async function readCatalog(file: string): Promise<DynamicModelCatalog | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as DynamicModelCatalog;
    if (!parsed.version || !parsed.providers || typeof parsed.providers !== 'object') return null;
    if (validateWorkerCatalogDiscovery(parsed.discovery).length) return null;
    return parsed;
  } catch {
    return null;
  }
}

function inventorySignature(inventory: ProviderInventory): string {
  return inventory.providers
    .filter(provider => provider.available)
    .map(provider => `${provider.id}:${provider.evidence
      .filter(item => item.kind === 'executable' || item.kind === 'runtime-env')
      .map(item => `${item.kind}=${item.value}`)
      .sort()
      .join(',')}`)
    .sort()
    .join('|');
}

function isFresh(
  catalog: DynamicModelCatalog,
  now: Date,
  ttlMs: number,
  signature: string,
): boolean {
  const fetchedAt = catalog.discovery?.fetchedAt;
  if (!fetchedAt) return false;
  if (
    catalog.discovery?.inventorySignature
    && catalog.discovery.inventorySignature !== signature
  ) return false;
  const age = now.getTime() - Date.parse(fetchedAt);
  return Number.isFinite(age) && age >= 0 && age <= ttlMs;
}

/** Tier families by name, anchored on separators so `solution` or `lunar` do not match. */
const FLAGSHIP_FAMILY = /(?:^|[/:._-])(?:fable|astra)(?:$|[/:._[-]|\d)/i;
const PREMIUM_FAMILY = /(?:^|[/:._-])(?:opus|sol)(?:$|[/:._[-]|\d)/i;
const STANDARD_FAMILY = /(?:^|[/:._-])(?:sonnet|terra)(?:$|[/:._[-]|\d)/i;

export function selectRoleModels(models: DiscoveredModel[]): {
  reasoning?: DiscoveredModel;
  coding?: DiscoveredModel;
  efficiency?: DiscoveredModel;
} {
  // Flagship families are user-elected only (epic #2642): discovery never
  // assigns them to a role, even when the provider marks one as its default.
  const visible = models.filter(model => {
    // Keep the legacy name-based selection only for unenriched providers.
    const worker = model.worker;
    return !retirementGuard(null, model).blocked && !model.hidden && !FLAGSHIP_FAMILY.test(model.id)
      && (!worker || (worker.qualification.status === 'qualified'
        && worker.visibility === 'listed' && worker.availability === 'accessible'
        && (worker.lifecycle === 'active' || worker.lifecycle === 'deprecated')
        && worker.effortSupport !== 'unknown' && !hasSelectionRelevantConflicts(worker)));
  });
  if (visible.length === 0) return {};
  const selected: ReturnType<typeof selectRoleModels> = {};
  for (const role of ['reasoning', 'coding', 'efficiency'] as const) {
    const candidates = visible.filter(model => !model.worker || model.worker.qualification.roles.includes(role));
    const model = rankRoleModels(candidates)[role];
    if (model) selected[role] = model;
  }
  return selected;
}

function rankRoleModels(visible: DiscoveredModel[]): ReturnType<typeof selectRoleModels> {
  if (visible.length === 0) return {};
  const coding = visible.find(model => STANDARD_FAMILY.test(model.id))
    ?? visible.find(model => model.isDefault && !PREMIUM_FAMILY.test(model.id))
    ?? visible.find(model => model.isDefault)
    ?? visible.find(model => /(?:codex|code|sonnet|gpt)/i.test(model.id))
    ?? visible[0];
  const efficiency = visible.find(model => /(?:mini|spark|haiku|light|flash|luna)/i.test(model.id))
    ?? [...visible].sort(
      (a, b) => (a.reasoningEfforts?.length ?? 0) - (b.reasoningEfforts?.length ?? 0),
    )[0];
  const premium = visible.filter(model => PREMIUM_FAMILY.test(model.id));
  const reasoningCandidates = premium.length > 0 ? premium : visible.filter(model =>
    /(?:opus|reason|ultra|max|pro(?:[-_/]|$))/i.test(model.id)
);

  const reasoning = [...(reasoningCandidates.length > 0 ? reasoningCandidates : visible)].sort((a, b) => {
    const effortDelta = (b.reasoningEfforts?.length ?? 0) - (a.reasoningEfforts?.length ?? 0);
    if (effortDelta !== 0) return effortDelta;
    return Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault));
  })[0];
  return { reasoning, coding, efficiency };
}

export function diffModelCatalog(
  before: DynamicModelCatalog,
  after: DynamicModelCatalog,
): ModelCatalogDrift {
  const providers: ModelCatalogDrift['providers'] = {};
  for (const provider of new Set([
    ...Object.keys(before.providers),
    ...Object.keys(after.providers),
  ])) {
    const changes: ModelCatalogDrift['providers'][string] = [];
    const beforeRoles = before.providers[provider]?.roles ?? {};
    const afterRoles = after.providers[provider]?.roles ?? {};
    for (const role of new Set([...Object.keys(beforeRoles), ...Object.keys(afterRoles)])) {
      const previous = beforeRoles[role]?.id ?? null;
      const next = afterRoles[role]?.id ?? null;
      if (previous !== next) changes.push({ role, before: previous, after: next });
    }
    if (changes.length > 0) providers[provider] = changes;
  }
  return { changed: Object.keys(providers).length > 0, providers };
}

export async function discoverCodexModels(
  command = 'codex',
  timeoutMs = 10_000,
  runner: ModelDiscoveryCommandRunner = runModelDiscoveryCommand,
): Promise<ProviderModelDiscovery> {
  const observedAt = new Date().toISOString();
  const version = await runtimeVersion(command, runner);
  return new Promise((resolveDiscovery) => {
    const child = spawn(command, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let stderr = '';
    const diagnostics: string[] = [];
    let lineNumber = 0;
    let detectedRuntimeVersion = version;
    let timer: NodeJS.Timeout;
    const finish = (result: ProviderModelDiscovery) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      signalChild(child);
      resolveDiscovery(result);
    };
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
    child.on('error', error => finish({
      provider: 'codex',
      source: 'native',
      observedAt,
      accountScope: 'local-account',
      models: [],
      errorKind: classifyDiscoveryError(error.message),
      error: redactModelDiscoveryText(error.message),
    }));
    lines.on('line', line => {
      lineNumber++;
      let message: any;
      try { message = JSON.parse(line); } catch {
        diagnostics.push(`Codex app-server line ${lineNumber}: invalid JSON`);
        return;
      }
      if (!message || typeof message !== 'object') {
        diagnostics.push(`Codex app-server line ${lineNumber}: expected JSON-RPC object`);
        return;
      }
      if (message.id === 1 && message.result) {
        detectedRuntimeVersion = typeof message.result.serverInfo?.version === 'string'
          ? message.result.serverInfo.version
          : detectedRuntimeVersion;
        child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialized',
          params: {},
        })}\n`);
        child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'model/list',
          params: { includeHidden: false, limit: 100 },
        })}\n`);
      }
      if (message.id === 2) {
        if (!Array.isArray(message.result?.data)) diagnostics.push('Codex model/list /result/data: expected array');
        if (message.result?.nextCursor) diagnostics.push('Codex model/list /result/nextCursor: truncated catalog (more pages remain)');
        const models = Array.isArray(message.result?.data)
          ? message.result.data.flatMap((model: any, index: number) => {
            const id = model?.model ?? model?.id;
            const efforts = model?.supportedReasoningEfforts;
            if (!model || typeof model !== 'object' || Array.isArray(model) || typeof id !== 'string' || !id.trim()
              || ['hidden', 'isDefault'].some(key => model[key] !== undefined && typeof model[key] !== 'boolean')
              || (model.displayName !== undefined && typeof model.displayName !== 'string')
              || (efforts !== undefined && (!Array.isArray(efforts) || efforts.some((effort: any) => {
                const value = typeof effort === 'string' ? effort : effort?.reasoningEffort ?? effort?.effort;
                return typeof value !== 'string' || !value.trim();
              })))) {
              diagnostics.push(`Codex model/list /result/data/${index}: malformed model row`);
              return [];
            }
            return [{
              id,
              displayName: typeof model.displayName === 'string' ? model.displayName : undefined,
              hidden: Boolean(model.hidden),
              isDefault: Boolean(model.isDefault),
              reasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
                ? model.supportedReasoningEfforts.map((effort: any) =>
                  typeof effort === 'string' ? effort : String(effort.reasoningEffort ?? effort.effort ?? effort)
                )
                : undefined,
            }];
          })
          : [];
        finish({
          provider: 'codex',
          source: 'native',
          observedAt,
          ...(detectedRuntimeVersion ? { runtimeVersion: detectedRuntimeVersion } : {}),
          accountScope: 'local-account',
          models,
          ...(message.error ? { errorKind: 'command' as const, error: redactModelDiscoveryText(JSON.stringify(message.error)) }
            : diagnostics.length ? { errorKind: 'invalid-output' as const, error: diagnostics.join('; ') } : {}),
        });
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'aiwg-model-discovery', version: '1.0.0' },
        capabilities: { experimentalApi: false },
      },
    })}\n`);
    timer = setTimeout(() => finish({
      provider: 'codex',
      source: 'native',
      observedAt,
      accountScope: 'local-account',
      models: [],
      errorKind: 'timeout',
      error: `Codex app-server model/list timed out${stderr ? `: ${redactModelDiscoveryText(stderr.trim())}` : ''}`,
    }), timeoutMs);
  });
}

export async function resolveDynamicModelCatalog(
  options: ModelDiscoveryOptions,
): Promise<DynamicModelCatalog> {
  const now = (options.now ?? (() => new Date()))();
  const homeDir = options.homeDir ?? homedir();
  const cacheFile = options.cacheFile ?? join(homeDir, '.cache/aiwg/model-catalog.v1.json');
  const staticFile = join(options.aiwgRoot, 'agentic/code/providers/model-catalog.v1.json');
  const signature = inventorySignature(options.inventory) + JSON.stringify({ codex: options.codex, muse: options.muse, omp: options.omp, profile: process.env.OMP_PROFILE ?? process.env.PI_PROFILE, config: process.env.PI_CONFIG_DIR, data: process.env.XDG_DATA_HOME, cache: process.env.XDG_CACHE_HOME, agent: process.env.PI_CODING_AGENT_DIR });
  const staticCatalog = await readCatalog(staticFile);
  if (!staticCatalog) throw new Error(`Invalid or missing static model catalog: ${staticFile}`);
  const useCache = !process.env.VITEST || options.cacheFile !== undefined || options.homeDir !== undefined;
  const cached = useCache ? await readCatalog(cacheFile) : null;
  if (
    !options.forceRefresh
    && cached
    && (!options.codex?.accountBinding || cached.discovery?.providers.codex?.accountBinding === options.codex.accountBinding)
    && (!options.muse?.accountBinding || cached.discovery?.providers.muse?.accountBinding === options.muse.accountBinding)
    && isFresh(cached, now, options.ttlMs ?? DEFAULT_TTL_MS, signature)
  ) {
    return {
      ...cached,
      discovery: cached.discovery
        ? {
          ...cached.discovery,
          source: 'cache',
          upstreamSource: cached.discovery.source === 'cache'
            ? cached.discovery.upstreamSource
            : cached.discovery.source,
        }
        : undefined,
    };
  }

  if (!options.allowNetwork && !options.nativeDiscoverers) {
    return {
      ...staticCatalog,
      discovery: {
        source: 'static',
        fetchedAt: now.toISOString(),
        inventorySignature: signature,
        providers: {},
        ...(staticCatalog.discovery?.instances ? { instances: staticCatalog.discovery.instances } : {}),
      },
    };
  }

  const remoteUrl = options.remoteUrl ?? process.env.AIWG_MODEL_CATALOG_URL;
  let catalog = staticCatalog;
  let source: ModelCatalogSource = 'static';
  let remoteError: string | undefined;
  if (remoteUrl) {
    try {
      const response = await (options.fetchImpl ?? fetch)(remoteUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const remote = await response.json() as DynamicModelCatalog;
      if (!remote.version || !remote.providers || validateWorkerCatalogDiscovery(remote.discovery).length) throw new Error('invalid catalog shape');
      catalog = remote;
      source = 'remote';
    } catch (error) {
      remoteError = (error as Error).message;
      // Static catalog remains the deterministic offline fallback.
    }
  }

  const available = new Set(
    options.inventory.providers.filter(provider => provider.available).map(provider => provider.id),
  );
  const nativeDiscoverers = options.nativeDiscoverers ?? {
    codex: () => discoverCodexDebugModels(options.codex?.command ?? 'codex', options.runner, {
      accountBinding: options.codex?.accountBinding, now: options.now,
    }),
    muse: () => discoverMuseCatalogModels({
      ...options.muse, catalogDir: options.muse?.catalogDir ?? join(homeDir, MUSE_CATALOG_DIR), now: options.now,
    }),
    factory: async () => {
      const { discoverProjectFactoryModels } = await import('./factory-models.js');
      return discoverProjectFactoryModels(options.inventory.projectDir, { homeDir, runner: options.runner, now: options.now });
    },
    opencode: () => discoverOpenCodeModels(),
    openclaw: () => discoverOpenClawModels(),
    pi: () => discoverPiModels(),
    omp: () => discoverOmpModels(process.env.AIWG_OMP_BIN || 'omp', runModelDiscoveryCommand, options.omp),
    'grok-build': async () => {
      const { discoverGrokBuildModels } = await import('./grok-build-models.js');
      return discoverGrokBuildModels(options.grokBuild);
    },
  };
  const providerDiscovery: Record<string, ProviderModelDiscovery> = {};
  for (const provider of available) {
    const discoverer = nativeDiscoverers[provider];
    if (discoverer) {
      try {
        providerDiscovery[provider] = await discoverer();
      } catch (error) {
        providerDiscovery[provider] = {
          provider,
          source: 'native',
          observedAt: now.toISOString(),
          accountScope: 'local-account',
          models: [],
          errorKind: classifyDiscoveryError((error as Error).message),
          error: (error as Error).message,
          accountBinding: provider === 'codex' ? options.codex?.accountBinding : provider === 'muse' ? options.muse?.accountBinding : undefined,
        };
      }
      const next = providerDiscovery[provider];
      if (next.error) next.error = stripVTControlCharacters(next.error);
      const instanceId = discoveryInstanceId(next);
      const prior = cached?.discovery?.instances?.[instanceId]
        ?? cached?.discovery?.providers[provider];
      if (prior) providerDiscovery[provider] = mergeProviderDiscovery(prior, next);
      const entry = providerDiscovery[provider];
      if (entry.errorKind && prior && prior.accountBinding === next.accountBinding
        && cached?.providers[provider]) catalog.providers[provider] = structuredClone(cached.providers[provider]);
      const providerCatalog = catalog.providers[provider];
      const preservePins = provider === 'omp' || entry.models.some(model => model.worker)
        || prior?.models.some(model => model.worker);
      if (!next.errorKind && prior && prior.accountBinding === next.accountBinding
        && prior.accountScope === next.accountScope) {
        for (const role of Object.values(providerCatalog?.roles ?? {})) {
          const alreadyUnavailable = Object.values(cached?.providers[provider]?.roles ?? {}).some(previous =>
            previous.id === role.id && previous.status === 'unverified' && previous.observed === false);
          if (!(alreadyUnavailable || (preservePins && prior.models.some(model => model.id === role.id)))
            || entry.models.some(model => model.id === role.id)) continue;
          const guard = retirementGuard(role.id);
          role.status = 'unverified';
          role.observed = false;
          entry.policy ??= { layers: [], selected: {}, constraints: [], diagnostics: [] };
          if (!entry.policy.diagnostics.includes(guard.reason!)) entry.policy.diagnostics.push(guard.reason!);
        }
      }
      for (const model of entry.models) {
        if (!model.worker) continue;
        const pinnedRoles = Object.values(providerCatalog?.roles ?? {}).filter(role => role.id === model.id);
        const guard = retirementGuard(pinnedRoles.length ? model.id : null, model);
        if (guard.blocked) {
          for (const role of pinnedRoles) role.status = 'unverified';
          entry.policy ??= { layers: [], selected: {}, constraints: [], diagnostics: [] };
          if (!entry.policy.diagnostics.includes(guard.reason!)) entry.policy.diagnostics.push(guard.reason!);
        }
      }
      if (providerCatalog) {
        // Observations are facts, not approval to adopt a model. Preserve pins.
        const selected = preservePins || entry.errorKind ? {}
          : selectRoleModels(entry.models);
        for (const role of ['reasoning', 'coding', 'efficiency'] as const) {
          if (!selected[role]) continue;
          providerCatalog.roles[role] = {
            ...(providerCatalog.roles[role] ?? {}), id: selected[role]!.id,
            status: 'active', observed: true,
          };
        }
        if (Object.keys(selected).length) providerCatalog.verifiedAt = entry.observedAt.slice(0, 10);
      }
    } else {
      const decision = PROVIDER_DISCOVERY_DECISIONS[provider];
      providerDiscovery[provider] = {
        provider,
        source,
        observedAt: now.toISOString(),
        accountScope: source === 'remote' ? 'public-feed' : 'static',
        models: Object.values(catalog.providers[provider]?.roles ?? {}).map(role => ({ id: role.id })),
        errorKind: 'unsupported',
        error: decision?.reason
          ?? 'Provider exposes no supported machine-readable local model enumeration interface.',
      };
    }
  }

  let resolved: DynamicModelCatalog = {
    ...catalog,
    discovery: {
      source,
      fetchedAt: now.toISOString(),
      ...(source === 'remote' && remoteUrl ? { remoteUrl } : {}),
      ...(remoteError ? { remoteError } : {}),
      inventorySignature: signature,
      providers: providerDiscovery,
      instances: { ...cached?.discovery?.instances, ...catalog.discovery?.instances },
    },
  };
  for (const entry of Object.values(providerDiscovery)) {
    resolved = recordAccountInstance(resolved, discoveryInstanceId(entry), entry);
  }
  await atomicWrite(cacheFile, `${JSON.stringify(resolved, null, 2)}\n`);
  return resolved;
}

/** Explicit OMP discovery; no ambient extension execution unless requested. */
export async function discoverOmpModels(command = 'omp', runner: ModelDiscoveryCommandRunner = runModelDiscoveryCommand,
  options: { profile?: string; config?: string[]; extensions?: boolean; cwd?: string } = {}): Promise<ProviderModelDiscovery> {
  const base: ProviderModelDiscovery = { provider: 'omp', source: 'native', observedAt: new Date().toISOString(), accountScope: 'local-runtime', models: [] };
  const args = [...(options.profile ? ['--profile', options.profile] : []), 'models', '--json'];
  if (!options.extensions) args.push('--no-extensions');
  for (const config of options.config ?? []) args.push('--config', config);
  try {
    const result = await runner(command, args, { cwd: options.cwd ?? tmpdir(), timeoutMs: 15000 });
    base.runtimeVersion = await runtimeVersion(command, runner);
    if (result.exitCode !== 0) return { ...base, errorKind: result.exitCode === 124 ? 'timeout' : /unknown|unsupported|not found/i.test(result.stderr) ? 'unsupported' : classifyDiscoveryError(result.stderr), error: 'OMP model discovery failed; check CLI version, selected profile/config, and credential availability.' };
    const payload = JSON.parse(result.stdout);
    if (!Array.isArray(payload?.models)) return { ...base, errorKind: 'invalid-output', error: 'OMP /models: expected array' };
    const diagnostics: string[] = [];
    base.models = payload.models.flatMap((m: any, index: number) => {
      if (!m || typeof m.id !== 'string' || !m.id.trim() || typeof m.provider !== 'string' || !m.provider.trim()
        || (m.name !== undefined && typeof m.name !== 'string')
        || (m.thinking !== undefined && (!Array.isArray(m.thinking) || m.thinking.some((effort: unknown) => typeof effort !== 'string')))) {
        diagnostics.push(`OMP /models/${index}: malformed model row`);
        return [];
      }
      return [{ id: `${m.provider}/${m.id}`, llmProvider: m.provider, displayName: m.name, reasoningEfforts: m.thinking }];
    });
    return { ...base, ...(diagnostics.length ? { errorKind: 'invalid-output' as const, error: diagnostics.join('; ') } : {}) };
  } catch { return { ...base, errorKind: 'invalid-output', error: 'OMP returned invalid model catalog JSON or discovery could not run.' }; }
}

/** Never guess an unrelated model when a requested mapping is unavailable. */
export function resolveOmpRoleModel(catalog: ProviderModelDiscovery, role: string, mappings: Record<string, string>, explicit?: string): string {
  if (explicit) return explicit;
  const id = mappings[role];
  if (!id || !catalog.models.some(model => model.id === id)) throw new Error(`OMP ${role} model unavailable; configure a model from omp models --json or supply an explicit model.`);
  return id;
}

/**
 * B-OG-03 shared discovery refinements (S1 direct/shared checkpoint).
 *
 * Codex `debug models` JSON and Muse model-catalog rows normalize through one
 * observation contract: per-CLI sources, field provenance, coherent snapshots
 * and freshness. Native and bridged MCP use identical facts. Synthetic fixture
 * copies under test fixtures exercise these paths; synthetic seeds never ship
 * as defaults.
 */

/** Evidence dated beyond this skew past now is rejected, never trusted. */
export const MAX_DISCOVERY_CLOCK_SKEW_MS = 5 * 60 * 1000;

const MUSE_CATALOG_DIR = '.local/share/muse/model-catalog';
const MAX_MUSE_CATALOG_FILES = 64;
const MAX_MUSE_CATALOG_BYTES = 1024 * 1024;

/** Sanitized provenance digest for a normalized evidence entry. */
export function discoveryDigest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/** True when an evidence timestamp is materially in the future. Unknown/unparseable stays explicit, not future. */
export function isFutureDated(value: string | null | undefined, now: Date = new Date(), skewMs: number = MAX_DISCOVERY_CLOCK_SKEW_MS): boolean {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time - now.getTime() > skewMs;
}

export interface NormalizeDiscoveryOptions {
  cliId: string;
  /** Per-CLI evidence source label, taken from the route-feasibility inventory channel. */
  source: string;
  runtimeVersion: string;
  accountScope: ProviderModelDiscovery['accountScope'];
  accountBinding?: string;
  observedAt?: string;
  firstObservedAt?: string;
  fetchedAt?: string;
  now?: Date;
  /** Source JSON Pointer for a single row, retained separately for conflicting evidence. */
  pointer?: string;
  /** File-scoped sources and timestamps when normalizing a multi-file catalog. */
  rowOptions?: NormalizeDiscoveryOptions[];
  /** Digest of the source file bytes, including provider timestamps. */
  contentDigest?: string;
}

export interface NormalizedDiscovery {
  models: DiscoveredModel[];
  diagnostics: string[];
}

function normalizeVisibility(value: unknown): WorkerModelObservation['visibility'] {
  if (value === true || value === 'listed' || value === 'list' || value === 'visible' || value === 'shown') return 'listed';
  if (value === false || value === 'hidden') return 'hidden';
  return 'unknown';
}

function normalizeLifecycle(entry: Record<string, unknown>): Pick<WorkerModelObservation, 'lifecycle' | 'sunsetAt' | 'replacementModelId'> {
  const lifecycle = entry.lifecycle ?? entry.status ?? entry.state;
  if (lifecycle === 'retired' || entry.retired === true) {
    return {
      lifecycle: 'retired',
      sunsetAt: typeof entry.sunset_at === 'string' || entry.sunset_at === null ? (entry.sunset_at as string | null) : null,
      ...(typeof entry.replacement === 'string' && entry.replacement ? { replacementModelId: entry.replacement } : {}),
    };
  }
  if (lifecycle === 'deprecated' || entry.deprecated === true) {
    return {
      lifecycle: 'deprecated',
      sunsetAt: typeof entry.sunset_at === 'string' || entry.sunset_at === null ? (entry.sunset_at as string | null) : null,
      ...(typeof entry.replacement === 'string' && entry.replacement ? { replacementModelId: entry.replacement } : {}),
    };
  }
  return { lifecycle: 'active', sunsetAt: null };
}

function normalizePositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function observationTimestamps(options: NormalizeDiscoveryOptions): { observedAt: string; firstObservedAt: string; fetchedAt: string } {
  const observedAt = options.observedAt ?? (options.now ?? new Date()).toISOString();
  return {
    observedAt,
    firstObservedAt: options.firstObservedAt ?? observedAt,
    fetchedAt: options.fetchedAt ?? observedAt,
  };
}

/** Build one explicit observation: unknowns stay unknown, every field carries provenance. */
export function buildWorkerObservation(
  options: NormalizeDiscoveryOptions,
  input: {
    modelId: string;
    family: string;
    visibility: WorkerModelObservation['visibility'];
    lifecycle: WorkerModelObservation['lifecycle'];
    sunsetAt?: string | null;
    replacementModelId?: string;
    releaseDate?: string | null;
    releaseDateKind?: WorkerModelObservation['releaseDateKind'];
    availability?: WorkerModelObservation['availability'];
    contextTokens?: number | null;
    maxOutputTokens?: number | null;
    efforts?: Array<{ id: string; selfDelegates: boolean | null }>;
    effortSupport?: WorkerModelObservation['effortSupport'];
    dataUseNote?: string;
    provenanceFields: string[];
  },
): WorkerModelObservation {
  const { observedAt, firstObservedAt, fetchedAt } = observationTimestamps(options);
  const releaseDate = input.releaseDate ?? null;
  const efforts = input.efforts ?? [];
  const effortSupport = input.effortSupport
    ?? (efforts.length > 0 ? 'explicit' : 'unknown');
  const lifecycle = input.lifecycle;
  const availability = input.availability
    ?? (lifecycle === 'retired' ? 'unavailable' : 'accessible');

  const provenanceFields = input.dataUseNote
    ? [...input.provenanceFields, '/dataUse:unknown(config-scoped)']
    : input.provenanceFields;
  const observation: WorkerModelObservation = {
    version: 1,
    recordId: `${options.cliId}:${input.modelId}:${options.accountBinding ?? options.accountScope}`,
    cliId: options.cliId,
    family: input.family,
    runtimeVersion: options.runtimeVersion,
    accountScope: options.accountBinding ?? options.accountScope,
    endpointFingerprint: `local-cli:${options.cliId}`,
    observedAt,
    verifiedAt: observedAt,
    releaseDate,
    releaseDateKind: releaseDate === null ? 'unknown' : (input.releaseDateKind ?? 'reported'),
    visibility: input.visibility,
    availability,
    lifecycle,
    sunsetAt: input.sunsetAt ?? null,
    ...(input.replacementModelId ? { replacementModelId: input.replacementModelId } : {}),
    contextTokens: input.contextTokens ?? null,
    maxOutputTokens: input.maxOutputTokens ?? null,
    modalities: ['text'],
    efforts: effortSupport === 'explicit' ? efforts : [],
    effortSupport,
    pricing: { costClass: 'unknown', billing: 'unknown', currency: 'USD', inputPerMillion: null, outputPerMillion: null },
    dataUse: { processing: 'unknown', productImprovement: null, retentionDays: null },
    qualification: { status: 'unqualified', roles: [] },
    provenance: [],
    firstObservedAt,
    fetchedAt,
    retiredAt: lifecycle === 'retired' ? observedAt : null,
  };
  const { provenance: _provenance, observedAt: _observedAt, verifiedAt: _verifiedAt,
    firstObservedAt: _firstObservedAt, fetchedAt: _fetchedAt, retiredAt: _retiredAt, ...facts } = observation;
  observation.evidenceDigest = discoveryDigest(JSON.stringify({
    facts, modelId: input.modelId, source: options.source,
    sourceEvidence: options.contentDigest ?? observationTimestamps(options),
  }));
  observation.provenance = [{
    fields: [...new Set([...observationPointers(observation).filter(field => field !== '/provenance'),
      '/id', '/hidden', '/isDefault', '/reasoningEfforts', ...provenanceFields])],
    source: `${options.source}${options.pointer ? `#${options.pointer}` : ''}`,
    kind: 'native', observedAt,
    digest: discoveryDigest(JSON.stringify(observation)), confidence: 'reported',
  }];
  return observation;
}

/** Include container and leaf JSON Pointers so explicit unknown/default leaves stay traceable. */
function observationPointers(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    const pointer = `${prefix}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    return [pointer, ...observationPointers(entry, pointer)];
  });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap(entry => {
    if (typeof entry === 'string') return entry ? [entry] : [];
    if (entry && typeof entry === 'object' && typeof entry.effort === 'string' && entry.effort) return [entry.effort];
    return [];
  }) : [];
}

/**
 * Normalize `codex debug models` JSON (`.models[]` with slug, visibility,
 * supported_reasoning_levels, default_reasoning_level, context_window).
 * Observed on Codex 0.160.0; hidden CLI defaults are never treated as eligible.
 */
export function normalizeCodexDebugModels(payload: unknown, options: NormalizeDiscoveryOptions): NormalizedDiscovery {
  const raw = (payload as { models?: unknown } | null)?.models;
  if (!Array.isArray(raw)) return { models: [], diagnostics: [`${options.source}: expected .models[] in codex debug models JSON`] };
  return normalizeObservationRows(raw, options, 'codex');
}

export interface MuseCatalogRow {
  model_id?: unknown;
  visibility?: unknown;
  is_default?: unknown;
  is_current?: unknown;
  reasoning_effort_variants?: unknown;
  context_limit?: unknown;
  output_limit?: unknown;
  release_date?: unknown;
  deprecated?: unknown;
  retired?: unknown;
  sunset_at?: unknown;
  replacement?: unknown;
  [key: string]: unknown;
}

function museEfforts(row: MuseCatalogRow): string[] {
  const variants = row.reasoning_effort_variants;
  if (!Array.isArray(variants)) return [];
  return [...new Set(variants.flatMap(variant => {
    if (typeof variant === 'string') return variant ? [variant] : [];
    if (variant && typeof variant === 'object') {
      const tier = (variant as Record<string, unknown>).tier;
      return typeof tier === 'string' && tier ? [tier] : [];
    }
    return [];
  }))];
}

/**
 * Normalize Muse model-catalog rows (`.rows[]` with model_id, visibility,
 * is_default, is_current, reasoning_effort_variants[].tier, context_limit,
 * output_limit, release_date). Contributor data-use facts stay config-scoped
 * and are never derived from a row's name or default bit.
 */
export function normalizeMuseCatalogRows(payload: unknown, options: NormalizeDiscoveryOptions): NormalizedDiscovery {
  const rows: unknown[] = Array.isArray(payload) ? payload
    : Array.isArray((payload as { rows?: unknown } | null)?.rows) ? (payload as { rows: unknown[] }).rows : [];
  if (!rows.length) return { models: [], diagnostics: [`${options.source}: expected .rows[] in Muse model-catalog JSON`] };
  return normalizeObservationRows(rows, options, 'muse');
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

/** Use the active window, capped by the reported maximum, with native headroom. */
function codexContextTokens(row: Record<string, unknown>): number | null {
  const window = normalizePositiveInt(row.context_window);
  const maximum = normalizePositiveInt(row.max_context_window);
  const percent = row.effective_context_window_percent;
  // A malformed supplied limit must not silently enlarge the qualified window.
  if (window === null || row.max_context_window != null && maximum === null
    || percent != null && (typeof percent !== 'number' || !Number.isFinite(percent) || percent <= 0 || percent > 100)) return null;
  return normalizePositiveInt(Math.floor(Math.min(window, maximum ?? window) * (typeof percent === 'number' ? percent : 100) / 100));
}

function catalogEfforts(ids: string[], raw: unknown): WorkerModelObservation['efforts'] {
  return ids.map(id => {
    const entry = Array.isArray(raw) ? raw.find(value => value && typeof value === 'object'
      && (value.effort ?? value.tier) === id) : undefined;
    // Conductor-verified Codex/Muse catalog rule (#3083): only ultra is
    // "Maximum reasoning with automatic task delegation". Prefer that explicit
    // description when present; other listed levels do not self-delegate.
    // multi_agent_reasoning_effort/version describe child execution, not which
    // selected effort activates delegation (e.g. xhigh is not self-delegating).
    return { id, selfDelegates: id === 'ultra'
      || typeof entry?.description === 'string' && /automatic task delegation/i.test(entry.description) };
  });
}

function normalizeObservationRows(rows: unknown[], options: NormalizeDiscoveryOptions, cli: 'muse' | 'codex'): NormalizedDiscovery {
  const diagnostics: string[] = [];
  const models: DiscoveredModel[] = [];
  const sourcePointers = new Map<DiscoveredModel, Record<string, string>>();
  for (const [index, entry] of rows.entries()) {
    const rowOptions = options.rowOptions?.[index] ?? options;
    const now = rowOptions.now ?? new Date();
    const sourceOptions = { ...rowOptions, pointer: rowOptions.pointer ?? `/${cli === 'muse' ? 'rows' : 'models'}/${index}` };
    const source = `${sourceOptions.source}#${sourceOptions.pointer}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      diagnostics.push(`${source}: skipped non-object model entry`); continue;
    }
    const row = entry as Record<string, unknown>;
    const id = cli === 'muse' ? row.model_id : row.slug;
    if (typeof id !== 'string' || !id.trim()) {
      diagnostics.push(`${source}: skipped entry without a ${cli === 'muse' ? 'model_id' : 'slug'}`); continue;
    }
    const times = observationTimestamps(sourceOptions);
    for (const field of [...(cli === 'muse' ? ['context_limit'] : ['context_window', 'max_context_window']), 'output_limit']) {
      if (row[field] != null && (typeof row[field] !== 'number' || !Number.isSafeInteger(row[field]) || (row[field] as number) < 1)) {
        diagnostics.push(`${source}: malformed ${field} for ${id}; retained as unknown`);
        // Do not round or coerce malformed evidence into a valid observation.
      }
    }
    if (cli === 'codex' && row.effective_context_window_percent != null
      && (typeof row.effective_context_window_percent !== 'number' || !Number.isFinite(row.effective_context_window_percent)
        || row.effective_context_window_percent <= 0 || row.effective_context_window_percent > 100)) {
      diagnostics.push(`${source}: malformed effective_context_window_percent for ${id}; context retained as unknown`);
    }
    for (const field of ['is_default', 'is_current', 'retired', 'deprecated']) {
      if (row[field] != null && typeof row[field] !== 'boolean') diagnostics.push(`${source}: malformed ${field} for ${id}`);
    }
    const effortField = cli === 'muse' ? 'reasoning_effort_variants' : 'supported_reasoning_levels';
    const rawEfforts = row[effortField];
    if (rawEfforts != null) {
      if (!Array.isArray(rawEfforts)) diagnostics.push(`${source}/${effortField}: expected effort array`);
      else for (const [effortIndex, effort] of rawEfforts.entries()) {
        const value = typeof effort === 'string' ? effort : effort?.[cli === 'muse' ? 'tier' : 'effort'];
        if (typeof value !== 'string' || !value.trim()) diagnostics.push(`${source}/${effortField}/${effortIndex}: malformed effort`);
      }
    }
    if (row.default_reasoning_level != null && (typeof row.default_reasoning_level !== 'string' || !row.default_reasoning_level.trim())) {
      diagnostics.push(`${source}: malformed default_reasoning_level for ${id}`);
    }
    let invalidTime = false;
    for (const [field, value] of Object.entries(times)) {
      if (!validTimestamp(value) || isFutureDated(value, now)) {
        diagnostics.push(`${source}: ${field} is unknown (invalid or future-dated evidence); rejected ${id}`);
        invalidTime = true;
      }
    }
    if (invalidTime) continue;
    let releaseDate: string | null = null;
    if (row.release_date !== null && row.release_date !== undefined) {
      if (!validDate(row.release_date)) diagnostics.push(`${source}: malformed release_date for ${id}; retained as unknown`);
      else if (isFutureDated(row.release_date, now)) {
        diagnostics.push(`${source}: rejected future-dated release_date for ${id}; date is unknown`); continue;
      } else releaseDate = row.release_date;
    }
    const visibility = normalizeVisibility(row.visibility);
    const lifecycle = normalizeLifecycle(row);
    if (row.sunset_at != null && !validTimestamp(row.sunset_at)) {
      diagnostics.push(`${source}: malformed sunset_at for ${id}; retained as unknown`);
      lifecycle.sunsetAt = null;
    }
    const efforts = cli === 'muse' ? museEfforts(row) : [...new Set([...stringList(row.supported_reasoning_levels),
      ...(typeof row.default_reasoning_level === 'string' && row.default_reasoning_level ? [row.default_reasoning_level] : [])])];
    // Codex's registry provider and catalogAdapter contain no inference-provider
    // identity. Its providerless native catalog is OpenAI; never infer from a slug.
    // Muse's real local catalogs use provider_id, not provider.
    const llmProvider = typeof row.provider === 'string' && row.provider ? row.provider
      : cli === 'muse' && typeof row.provider_id === 'string' && row.provider_id ? row.provider_id
        : cli === 'codex' ? 'openai' : undefined;
    const model: DiscoveredModel = {
      id, apiModelId: typeof row.api_model_id === 'string' ? row.api_model_id : id,
      ...(llmProvider ? { llmProvider } : {}),
      ...(visibility === 'unknown' ? {} : { hidden: visibility === 'hidden' }),
      ...(cli === 'muse' ? { isDefault: row.is_default === true } : {}),
      ...(efforts.length ? { reasoningEfforts: efforts } : {}),
      worker: buildWorkerObservation(sourceOptions, {
        modelId: id, family: typeof row.family === 'string' && row.family ? row.family : cli,
        visibility, ...lifecycle, releaseDate,
        availability: lifecycle.lifecycle === 'retired' ? 'unavailable'
          : cli === 'muse' ? (row.is_current === true ? 'accessible' : 'unknown') : 'accessible',
        contextTokens: cli === 'muse' ? normalizePositiveInt(row.context_limit) : codexContextTokens(row),
        maxOutputTokens: normalizePositiveInt(row.output_limit),
        efforts: catalogEfforts(efforts, rawEfforts),
        // The native renderer passes model_reasoning_effort (Muse: --reasoning-effort).
        effortSupport: efforts.length ? 'explicit' : 'unknown',
        ...(cli === 'muse' ? { dataUseNote: 'contributor policy is config-scoped' } : {}),
        provenanceFields: cli === 'muse'
          ? ['/id:model_id', '/isDefault:is_default', '/availability:is_current', '/efforts:reasoning_effort_variants[].tier',
            '/efforts/selfDelegates:catalog-description+verified-ultra-rule', '/contextTokens:context_limit', '/maxOutputTokens:output_limit', '/releaseDate:release_date']
          : ['/id:slug', '/efforts:supported_reasoning_levels+default_reasoning_level',
            '/efforts/selfDelegates:catalog-description+verified-ultra-rule',
            '/contextTokens:context_window+max_context_window+effective_context_window_percent'],
      }),
    };
    // Bind compatibility-row values without including unrelated credential-bearing row keys.
    model.worker!.provenance[0].fields.push('/apiModelId');
    if (model.llmProvider) model.worker!.provenance[0].fields.push('/llmProvider',
      `/llmProvider:${typeof row.provider === 'string' && row.provider ? 'provider' : cli === 'muse' ? 'provider_id' : 'codex-openai-default'}`);
    const compatibility = { id: model.id, apiModelId: model.apiModelId, llmProvider: model.llmProvider, hidden: model.hidden, isDefault: model.isDefault, reasoningEfforts: model.reasoningEfforts };
    model.worker!.evidenceDigest = discoveryDigest(JSON.stringify({
      workerDigest: model.worker!.evidenceDigest, ...compatibility,
    }));
    const { provenance: _provenance, ...values } = model.worker!;
    model.worker!.provenance[0].digest = discoveryDigest(JSON.stringify({ worker: values, ...compatibility }));
    sourcePointers.set(model, {
      visibility: '/visibility', releaseDate: '/release_date', sunsetAt: '/sunset_at', replacementModelId: '/replacement',
      lifecycle: row.retired === true ? '/retired' : row.deprecated === true ? '/deprecated'
        : row.lifecycle !== undefined ? '/lifecycle' : row.status !== undefined ? '/status' : '/state',
      availability: cli === 'muse' ? '/is_current' : '/visibility',
      efforts: cli === 'muse' ? '/reasoning_effort_variants' : '/supported_reasoning_levels',
      effortSupport: cli === 'muse' ? '/reasoning_effort_variants' : '/supported_reasoning_levels',
      contextTokens: cli === 'muse' ? '/context_limit' : '/context_window', maxOutputTokens: '/output_limit', family: '/family',
    });
    models.push(model);
  }
  return { models: reconcileDuplicateObservations(models, diagnostics, sourcePointers), diagnostics };
}

/** Retain every conflicting value and source; never let the first row erase retirement. */
function reconcileDuplicateObservations(models: DiscoveredModel[], diagnostics: string[],
  sourcePointers: Map<DiscoveredModel, Record<string, string>>): DiscoveredModel[] {
  const groups = new Map<string, DiscoveredModel[]>();
  for (const model of models) groups.set(model.id, [...(groups.get(model.id) ?? []), model]);
  return [...groups.values()].map(group => {
    if (group.length === 1) return group[0];
    const model = { ...group[0], worker: { ...group[0].worker! } };
    const worker = model.worker;
    const fields = ['family', 'visibility', 'lifecycle', 'availability', 'sunsetAt', 'replacementModelId',
      'efforts', 'effortSupport', 'releaseDate', 'contextTokens', 'maxOutputTokens'] as const;
    const conflicts: NonNullable<WorkerModelObservation['conflicts']> = [];
    for (const field of fields) {
      const evidence = group.map(m => ({ value: m.worker![field] ?? null,
        source: m.worker!.provenance[0].source, pointer: sourcePointers.get(m)?.[field] ?? `/${field}`,
        observedAt: m.worker!.observedAt, digest: m.worker!.provenance[0].digest }));
      if (new Set(evidence.map(e => JSON.stringify(e.value))).size < 2) continue;
      conflicts.push({ field: `/${field}`, evidence });
      diagnostics.push(`${model.id}: conflicting ${field === 'releaseDate' ? 'release_date' : field} values; retained values with individual sources: ${evidence.map(item => item.source).join(', ')}`);
      switch (field) {
        case 'lifecycle': worker.lifecycle = group.some(m => m.worker!.lifecycle === 'retired') ? 'retired' : 'unverified'; break;
        case 'visibility': worker.visibility = group.some(m => m.worker!.visibility === 'hidden') ? 'hidden' : 'unknown'; break;
        case 'availability': worker.availability = 'unknown'; break;
        case 'efforts': case 'effortSupport': worker.efforts = []; worker.effortSupport = 'unknown'; break;
        case 'releaseDate': worker.releaseDate = null; worker.releaseDateKind = 'unknown'; break;
        case 'sunsetAt': case 'contextTokens': case 'maxOutputTokens': worker[field] = null; break;
        case 'replacementModelId': delete worker.replacementModelId; break;
        case 'family': worker.family = 'unknown'; break;
      }
    }
    // Provider/API identity is selection evidence too. Conflicting rows must
    // not acquire a qualified route merely because one row appeared first.
    for (const field of ['apiModelId', 'llmProvider'] as const) {
      if (new Set(group.map(row => row[field])).size < 2) continue;
      conflicts.push({ field: `/${field}`, evidence: group.map(row => ({ value: row[field] ?? null,
        source: row.worker!.provenance[0].source, pointer: field === 'apiModelId' ? '/api_model_id' : '/provider',
        observedAt: row.worker!.observedAt, digest: row.worker!.provenance[0].digest })) });
      diagnostics.push(`${model.id}: conflicting ${field}`);
      delete model[field];
    }
    // Compatibility defaults also remain evidence rather than silently keeping the first.
    if (new Set(group.map(m => m.isDefault)).size > 1) {
      diagnostics.push(`${model.id}: conflicting isDefault values from ${group.map(m => m.worker!.provenance[0].source).join(', ')}`);
      conflicts.push({ field: '/isDefault', evidence: group.map(m => ({ value: m.isDefault ?? null,
        source: m.worker!.provenance[0].source, pointer: '/is_default',
        observedAt: m.worker!.observedAt, digest: m.worker!.provenance[0].digest })) });
      model.isDefault = false;
    }
    if (worker.lifecycle === 'retired') {
      worker.availability = 'unavailable';
      worker.retiredAt = group.find(m => m.worker!.lifecycle === 'retired')!.worker!.retiredAt;
    }
    model.hidden = worker.visibility === 'hidden';
    if (worker.visibility === 'unknown') delete model.hidden;
    model.reasoningEfforts = worker.efforts.map(e => e.id);
    worker.provenance = group.flatMap(m => m.worker!.provenance);
    worker.evidenceDigest = discoveryDigest(JSON.stringify(group.map(m => m.worker!.evidenceDigest)));
    if (conflicts.length) worker.conflicts = conflicts;
    const { provenance: _provenance, ...resolved } = worker;
    worker.provenance.push({ fields: observationPointers(resolved), source: 'src/models/model-discovery.ts#reconcileDuplicateObservations',
      kind: 'derived', observedAt: worker.observedAt,
      digest: discoveryDigest(JSON.stringify(resolved)), confidence: 'derived' });
    return model;
  });
}

/**
 * Merge a refresh into its prior snapshot. A failed refresh never renews age:
 * prior models and prior observation time are kept while the new error and
 * fetch time stay visible. A partial success retains prior-only rows with
 * their original age; per-model firstObservedAt is the earliest evidence.
 * A complete success contains exactly the returned identities.
 */
export function mergeProviderDiscovery(
  prior: ProviderModelDiscovery,
  next: ProviderModelDiscovery,
): ProviderModelDiscovery {
  if (prior.provider !== next.provider || prior.accountBinding !== next.accountBinding
    || prior.accountScope !== next.accountScope) return next;
  if (next.errorKind && next.models.length === 0) {
    return {
      ...next,
      models: prior.models,
      observedAt: prior.observedAt,
      ...(prior.accountBinding !== undefined ? { accountBinding: prior.accountBinding } : {}),
    };
  }
  const priorById = new Map(prior.models.map(model => [model.id, model]));
  const seen = new Set<string>();
  const merged = next.models.map((model): DiscoveredModel => {
    seen.add(model.id);
    const previous = priorById.get(model.id);
    if (!previous?.worker || !model.worker) return model;
    if (next.provider === 'muse' && previous.worker.evidenceDigest
      && previous.worker.evidenceDigest === model.worker.evidenceDigest) return previous;
    const firstObservedAt = Date.parse(previous.worker.firstObservedAt) < Date.parse(model.worker.firstObservedAt)
      ? previous.worker.firstObservedAt
      : model.worker.firstObservedAt;
    if (firstObservedAt === model.worker.firstObservedAt) return model;
    return { ...model, worker: {
      ...model.worker, firstObservedAt,
      provenance: [
        ...model.worker.provenance.map(p => ({ ...p, fields: p.fields.filter(field => field !== '/firstObservedAt') })),
        { fields: ['/firstObservedAt'], source: previous.worker.provenance[0].source,
          kind: 'derived', observedAt: previous.worker.observedAt,
          digest: discoveryDigest(JSON.stringify({ firstObservedAt, evidence: previous.worker.evidenceDigest })), confidence: 'derived' },
      ],
    } };
  });
  if (next.errorKind) {
    for (const model of prior.models) {
      if (!seen.has(model.id)) merged.push(model);
    }
  }
  const observedAt = next.errorKind ? prior.observedAt
    : next.provider === 'muse' && merged.some(model => model.worker)
    ? merged.flatMap(model => model.worker ? [model.worker.observedAt] : []).sort((a, b) => Date.parse(a) - Date.parse(b))[0]
    : next.observedAt;
  return { ...next, observedAt, models: merged };
}

export interface RetirementGuard {
  blocked: boolean;
  /** The operator pin is preserved verbatim; retirement never rewrites it. */
  pin: string | null;
  reason?: string;
}

/** Retirement blocks dispatch without rewriting pins; replacement is a proposal, never substitution. */
export function retirementGuard(pinnedId: string | null, model?: DiscoveredModel): RetirementGuard {
  if (!model && pinnedId) return {
    blocked: true, pin: pinnedId,
    reason: `Unavailable model ${pinnedId} is absent from the complete catalog and blocks dispatch; pin is preserved, never rewritten.`,
  };
  if (model?.worker?.lifecycle === 'retired') {
    const replacement = model.worker.supersededBy ?? model.worker.replacementModelId;
    return {
      blocked: true,
      pin: pinnedId,
      reason: `Retired model ${model.id} blocks dispatch; pin ${pinnedId ?? '(none)'} is preserved, never rewritten`
        + `${replacement ? ` (suggested replacement ${replacement} requires operator approval)` : ''}.`,
    };
  }
  return { blocked: false, pin: pinnedId };
}

/**
 * Record an account-scoped discovery under `discovery.instances` without
 * merging account entitlements into the provider projection.
 */
function discoveryInstanceId(entry: ProviderModelDiscovery): string {
  return `${entry.provider}:${entry.accountBinding ?? entry.accountScope}`;
}

export function recordAccountInstance(
  catalog: DynamicModelCatalog,
  instanceId: string,
  entry: ProviderModelDiscovery,
): DynamicModelCatalog {
  const discovery = catalog.discovery ?? {
    source: 'static' as const,
    fetchedAt: entry.observedAt,
    providers: {} as Record<string, ProviderModelDiscovery>,
  };
  return {
    ...catalog,
    discovery: {
      ...discovery,
      instances: { ...(discovery.instances ?? {}), [instanceId]: entry },
    },
  };
}

/** Run the version-scoped `codex debug models` strategy and normalize its JSON. */
export async function discoverCodexDebugModels(
  command = 'codex',
  runner: ModelDiscoveryCommandRunner = runModelDiscoveryCommand,
  options: { runtimeVersion?: string; accountBinding?: string; now?: () => Date } = {},
): Promise<ProviderModelDiscovery> {
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const version = options.runtimeVersion ?? await runtimeVersion(command, runner);
  const base = {
    provider: 'codex',
    source: 'native' as const,
    observedAt,
    ...(version ? { runtimeVersion: version } : {}),
    accountScope: 'local-account' as const,
    ...(options.accountBinding ? { accountBinding: options.accountBinding } : {}),
    models: [] as DiscoveredModel[],
  };
  const result = await runner(command, ['debug', 'models'], { cwd: tmpdir(), timeoutMs: 10_000 });
  if (result.exitCode !== 0) {
    const error = redactModelDiscoveryText(result.stderr.trim()) || `codex debug models exited ${result.exitCode}`;
    return { ...base, errorKind: classifyDiscoveryError(error), error };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch (error) {
    return { ...base, errorKind: 'invalid-output', error: `Invalid codex debug models JSON: ${(error as Error).message}` };
  }
  const normalized = normalizeCodexDebugModels(payload, {
    cliId: 'codex',
    source: `${command} debug models`,
    runtimeVersion: version ?? 'unknown',
    accountScope: 'local-account',
    ...(options.accountBinding ? { accountBinding: options.accountBinding } : {}),
    observedAt,
    now: (options.now ?? (() => new Date()))(),
  });
  return {
    ...base,
    models: normalized.models,
    ...(normalized.diagnostics.length > 0 || normalized.models.length === 0
      ? {
        errorKind: 'invalid-output' as const,
        error: normalized.diagnostics.join('; ')
          || 'codex debug models returned no normalized model rows.',
      }
      : {}),
    policy: { layers: [], selected: {}, constraints: [], diagnostics: normalized.diagnostics },
  };
}

/** Read bounded Muse model-catalog rows. Reads only declared catalog keys, never credential files. */
export async function discoverMuseCatalogModels(
  options: { catalogDir?: string; accountBinding?: string; runtimeVersion?: string; now?: () => Date; timeoutMs?: number } = {},
): Promise<ProviderModelDiscovery> {
  const now = (options.now ?? (() => new Date()))();
  const catalogDir = options.catalogDir ?? join(homedir(), MUSE_CATALOG_DIR);
  const base: ProviderModelDiscovery = {
    provider: 'muse', source: 'native', observedAt: now.toISOString(),
    ...(options.runtimeVersion ? { runtimeVersion: options.runtimeVersion } : {}),
    accountScope: 'local-account', ...(options.accountBinding ? { accountBinding: options.accountBinding } : {}), models: [],
  };
  const diagnostics: string[] = [];
  const rows: unknown[] = [];
  const rowOptions: NormalizeDiscoveryOptions[] = [];
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Muse catalog discovery deadline exceeded')), Math.max(0, deadline - Date.now()));
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const root = await bounded(realpath(catalogDir));
    const files = (await bounded(readdir(root))).filter(file => file.endsWith('.json')).sort();
    if (!files.length) diagnostics.push(`${root}: holds no JSON rows`);
    if (files.length > MAX_MUSE_CATALOG_FILES) diagnostics.push(`${join(root, files[MAX_MUSE_CATALOG_FILES])}: exceeds bounded file count; this and remaining files skipped`);
    for (const file of files.slice(0, MAX_MUSE_CATALOG_FILES)) {
      if (Date.now() >= deadline) { diagnostics.push(`${join(root, file)}: discovery deadline exceeded; this and remaining files skipped`); break; }
      const path = join(root, file);
      try {
        const link = await bounded(lstat(path));
        let target = path;
        if (link.isSymbolicLink()) {
          target = await bounded(realpath(path));
          const subpath = relative(root, target);
          if (subpath === '..' || subpath.startsWith('../')) throw new Error('symlink escapes catalog directory; regular file required');
        } else if (!link.isFile()) throw new Error('not a regular file; skipped');
        const stat = link.isSymbolicLink() ? await bounded(lstat(target)) : link;
        if (!stat.isFile()) throw new Error('not a regular file; skipped');
        if (stat.size > MAX_MUSE_CATALOG_BYTES) throw new Error('exceeds bounded catalog size; skipped before reading');
        // O_NONBLOCK prevents a stat/open race to a FIFO from blocking. O_NOFOLLOW
        // rejects a replacement symlink; fstat rechecks the opened descriptor.
        const pending = open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        // If open itself outlives the deadline, close any late descriptor.
        let expired = false;
        let lateHandle: Awaited<typeof pending> | undefined;
        void pending.then(handle => {
          lateHandle = handle;
          if (expired) void handle.close().catch(() => {});
        }, () => {});
        const handle = await bounded(pending).catch(error => {
          expired = true;
          if (lateHandle) void lateHandle.close().catch(() => {});
          throw error;
        });
        try {
          const opened = await bounded(handle.stat());
          if (!opened.isFile()) throw new Error('not a regular file; skipped');
          if (opened.size > MAX_MUSE_CATALOG_BYTES) throw new Error('exceeds bounded catalog size; skipped before reading');
          const buffer = Buffer.alloc(MAX_MUSE_CATALOG_BYTES + 1);
          let bytes = 0;
          while (bytes < buffer.length) {
            const result = await bounded(handle.read(buffer, bytes, buffer.length - bytes, bytes));
            if (!result.bytesRead) break;
            bytes += result.bytesRead;
          }
          if (bytes > MAX_MUSE_CATALOG_BYTES) throw new Error('exceeds bounded catalog size; skipped');
          const payload = JSON.parse(buffer.subarray(0, bytes).toString('utf8')) as unknown;
          const fileRows = Array.isArray(payload) ? payload : (payload as { rows?: unknown } | null)?.rows;
          if (!Array.isArray(fileRows)) throw new Error('expected .rows[]; rejected');
          const metadata = Array.isArray(payload) ? {} : payload as Record<string, unknown>;
          // Re-reading a cache does not create new evidence. Prefer its provider
          // timestamp, falling back to the file's own modification time.
          const evidenceTime = metadata.fetchedAt ?? metadata.fetched_at ?? metadata.refreshedAt ?? metadata.refreshed_at ?? opened.mtime.toISOString();
          const normalizedOptions: NormalizeDiscoveryOptions = {
            cliId: 'muse', source: path, contentDigest: discoveryDigest(buffer.subarray(0, bytes).toString('utf8')), runtimeVersion: options.runtimeVersion ?? 'unknown',
            accountScope: 'local-account', accountBinding: options.accountBinding, now,
            observedAt: metadata.observedAt as string ?? evidenceTime as string,
            fetchedAt: evidenceTime as string,
            firstObservedAt: metadata.firstObservedAt as string ?? evidenceTime as string,
          };
          for (const [index, row] of fileRows.entries()) {
            rows.push(row);
            rowOptions.push({ ...normalizedOptions, pointer: `/${Array.isArray(payload) ? '' : 'rows/'}${index}` });
          }
        } finally { await bounded(handle.close()); }
      } catch (error) {
        diagnostics.push(`${path}: ${(error as Error).message}; rejected`);
      }
    }
  } catch (error) {
    diagnostics.push(`Muse model catalog is unavailable at ${catalogDir}: ${(error as Error).message}`);
  }
  const normalized = normalizeMuseCatalogRows(rows, {
    cliId: 'muse', source: catalogDir, runtimeVersion: options.runtimeVersion ?? 'unknown',
    accountScope: 'local-account', now, rowOptions,
  });
  diagnostics.push(...normalized.diagnostics);
  const observedAt = normalized.models.length
    ? normalized.models.map(model => model.worker!.observedAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0] : base.observedAt;
  return {
    ...base, observedAt, models: normalized.models,
    ...(diagnostics.length || normalized.models.length === 0
      ? { errorKind: 'invalid-output' as const, error: diagnostics.join('; ') || 'Muse model catalog returned no usable rows.' } : {}),
    policy: { layers: [], selected: {}, constraints: [], diagnostics },
  };
}
