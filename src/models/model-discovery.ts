import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
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
    interface: 'codex app-server model/list',
    reason: 'The app-server JSON-RPC model/list method returns models available to the current Codex account without running a model turn.',
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
    status: 'unsupported',
    interface: null,
    reason: 'Droid exposes model selection through policy and interactive surfaces, but no documented non-interactive model-list command.',
    documentation: 'https://docs.factory.ai/cli/configuration/models',
  },
  grokbot: {
    provider: 'grokbot',
    status: 'unsupported',
    interface: null,
    reason: 'Grok Bot is a desktop multi-agent runtime with no verified non-interactive model-list command; AIWG does not invent xAI/Grok API enumeration as Grok Bot entitlement.',
    documentation: 'https://github.com/jmagly/aiwg/blob/main/docs/architecture/adr-grokbot-provider-target.md',
  },
  hermes: {
    provider: 'hermes',
    status: 'unsupported',
    interface: null,
    reason: 'hermes model is interactive; the optional API server /v1/models endpoint requires a separately running service and represents that service rather than local CLI entitlement.',
    documentation: 'https://hermes-agent.nousresearch.com/docs/reference/cli-commands',
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
  id: string;
  displayName?: string;
  llmProvider?: string;
  hidden?: boolean;
  isDefault?: boolean;
  reasoningEfforts?: string[];
}

export interface ProviderModelDiscovery {
  provider: string;
  source: ModelCatalogSource;
  observedAt: string;
  runtimeVersion?: string;
  accountScope: 'local-account' | 'local-runtime' | 'public-feed' | 'static';
  models: DiscoveredModel[];
  errorKind?: 'authentication' | 'rate-limit' | 'timeout' | 'unsupported' | 'invalid-output' | 'command';
  error?: string;
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
  omp?: { profile?: string; config?: string[]; extensions?: boolean; cwd?: string };
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
  if (/(?:401|403|unauth|forbidden|credential|login|required auth)/i.test(message)) {
    return 'authentication';
  }
  if (/(?:429|rate.?limit|too many requests|quota)/i.test(message)) return 'rate-limit';
  if (/(?:timed? out|timeout)/i.test(message)) return 'timeout';
  return 'command';
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
  child.stdout.on('data', chunk => { stdout += String(chunk); if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) { stdout = ''; stderr = 'Model catalog exceeded 8 MiB limit'; child.kill('SIGKILL'); finish(1); } });
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
  child.on('error', error => {
    stderr = `${stderr}${stderr ? '\n' : ''}${error.message}`;
    finish(127);
  });
  child.on('close', code => finish(code ?? 1));
  const timer = setTimeout(() => {
    stderr = `${stderr}${stderr ? '\n' : ''}${command} timed out`;
    child.kill();
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
    const error = result.stderr.trim() || `OpenCode models exited ${result.exitCode}`;
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
  const models = [...new Set(result.stdout.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^[a-z0-9][a-z0-9._-]*\/\S+$/i.test(line)))]
    .map(id => ({ id }));
  return {
    provider: 'opencode',
    source: 'native',
    observedAt,
    ...(version ? { runtimeVersion: version } : {}),
    accountScope: 'local-runtime',
    models,
    ...(models.length === 0
      ? { errorKind: 'invalid-output' as const, error: 'OpenCode returned no normalized provider/model rows.' }
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
    const error = result.stderr.trim() || `Pi --list-models exited ${result.exitCode}`;
    return { provider: 'pi', source: 'native', observedAt,
      ...(version ? { runtimeVersion: version } : {}), accountScope: 'local-runtime',
      models: [], errorKind: classifyDiscoveryError(error), error };
  }
  const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const models = lines.slice(1).flatMap(line => {
    const columns = line.split(/\s{2,}/);
    if (columns.length < 2 || !/^[a-z0-9][a-z0-9._-]*$/i.test(columns[0])) return [];
    return [{ id: `${columns[0]}/${columns[1]}` }];
  });
  return { provider: 'pi', source: 'native', observedAt,
    ...(version ? { runtimeVersion: version } : {}), accountScope: 'local-runtime', models,
    ...(models.length === 0 ? { errorKind: 'invalid-output' as const,
      error: 'Pi returned no parseable provider/model rows.' } : {}) };
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
    const error = result.stderr.trim() || `OpenClaw models list exited ${result.exitCode}`;
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
    const payload = JSON.parse(result.stdout) as {
      models?: Array<{ key?: unknown; name?: unknown; tags?: unknown; available?: unknown }>;
    };
    const models = (payload.models ?? []).flatMap(model =>
      typeof model.key === 'string' && model.key.includes('/') && model.available !== false
        ? [{
          id: model.key,
          ...(typeof model.name === 'string' ? { displayName: model.name } : {}),
          isDefault: Array.isArray(model.tags) && model.tags.includes('default'),
        }]
        : []);
    return {
      provider: 'openclaw',
      source: 'native',
      observedAt,
      ...(version ? { runtimeVersion: version } : {}),
      accountScope: 'local-runtime',
      models,
      ...(models.length === 0
        ? { errorKind: 'invalid-output' as const, error: 'OpenClaw returned no normalized model keys.' }
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

export function selectRoleModels(models: DiscoveredModel[]): {
  reasoning?: DiscoveredModel;
  coding?: DiscoveredModel;
  efficiency?: DiscoveredModel;
} {
  const visible = models.filter(model => !model.hidden);
  if (visible.length === 0) return {};
  const coding = visible.find(model => model.isDefault)
    ?? visible.find(model => /(?:codex|code|sonnet|gpt)/i.test(model.id))
    ?? visible[0];
  const efficiency = visible.find(model => /(?:mini|spark|haiku|light|flash)/i.test(model.id))
    ?? [...visible].sort(
      (a, b) => (a.reasoningEfforts?.length ?? 0) - (b.reasoningEfforts?.length ?? 0),
    )[0];
  const reasoningCandidates = visible.filter(model =>
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
    let detectedRuntimeVersion = version;
    let timer: NodeJS.Timeout;
    const finish = (result: ProviderModelDiscovery) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      resolveDiscovery(result);
    };
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => finish({
      provider: 'codex',
      source: 'native',
      observedAt,
      accountScope: 'local-account',
      models: [],
      errorKind: classifyDiscoveryError(error.message),
      error: error.message,
    }));
    lines.on('line', line => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
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
        const models = Array.isArray(message.result?.data)
          ? message.result.data.map((model: any) => ({
            id: String(model.model ?? model.id),
            displayName: typeof model.displayName === 'string' ? model.displayName : undefined,
            hidden: Boolean(model.hidden),
            isDefault: Boolean(model.isDefault),
            reasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
              ? model.supportedReasoningEfforts.map((effort: any) =>
                typeof effort === 'string' ? effort : String(effort.reasoningEffort ?? effort.effort ?? effort)
              )
              : undefined,
          }))
          : [];
        finish({
          provider: 'codex',
          source: 'native',
          observedAt,
          ...(detectedRuntimeVersion ? { runtimeVersion: detectedRuntimeVersion } : {}),
          accountScope: 'local-account',
          models,
          ...(message.error ? { error: JSON.stringify(message.error) } : {}),
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
      error: `Codex app-server model/list timed out${stderr ? `: ${stderr.trim()}` : ''}`,
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
  const signature = inventorySignature(options.inventory) + JSON.stringify({ omp: options.omp, profile: process.env.OMP_PROFILE ?? process.env.PI_PROFILE, config: process.env.PI_CONFIG_DIR, data: process.env.XDG_DATA_HOME, cache: process.env.XDG_CACHE_HOME, agent: process.env.PI_CODING_AGENT_DIR });
  const staticCatalog = await readCatalog(staticFile);
  if (!staticCatalog) throw new Error(`Invalid or missing static model catalog: ${staticFile}`);
  const useCache = !process.env.VITEST || options.cacheFile !== undefined || options.homeDir !== undefined;
  const cached = useCache ? await readCatalog(cacheFile) : null;
  if (
    !options.forceRefresh
    && cached
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

  if (!options.allowNetwork) {
    return {
      ...staticCatalog,
      discovery: {
        source: 'static',
        fetchedAt: now.toISOString(),
        inventorySignature: signature,
        providers: {},
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
      if (!remote.version || !remote.providers) throw new Error('invalid catalog shape');
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
    codex: () => discoverCodexModels(),
    opencode: () => discoverOpenCodeModels(),
    openclaw: () => discoverOpenClawModels(),
    pi: () => discoverPiModels(),
    omp: () => discoverOmpModels(process.env.AIWG_OMP_BIN || 'omp', runModelDiscoveryCommand, options.omp),
  };
  const providerDiscovery: Record<string, ProviderModelDiscovery> = {};
  for (const provider of available) {
    const discoverer = nativeDiscoverers[provider];
    if (discoverer) {
      try {
        providerDiscovery[provider] = await discoverer();
        const selected = provider === 'omp' ? {} : selectRoleModels(providerDiscovery[provider].models);
        const providerCatalog = catalog.providers[provider];
        if (providerCatalog) {
          for (const role of ['reasoning', 'coding', 'efficiency'] as const) {
            if (!selected[role]) continue;
            providerCatalog.roles[role] = {
              ...(providerCatalog.roles[role] ?? {}),
              id: selected[role]!.id,
              status: 'active',
              observed: true,
            };
          }
          providerCatalog.verifiedAt = providerDiscovery[provider].observedAt.slice(0, 10);
        }
      } catch (error) {
        providerDiscovery[provider] = {
          provider,
          source: 'native',
          observedAt: now.toISOString(),
          accountScope: 'local-account',
          models: [],
          errorKind: classifyDiscoveryError((error as Error).message),
          error: (error as Error).message,
        };
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

  const resolved: DynamicModelCatalog = {
    ...catalog,
    discovery: {
      source,
      fetchedAt: now.toISOString(),
      ...(source === 'remote' && remoteUrl ? { remoteUrl } : {}),
      ...(remoteError ? { remoteError } : {}),
      inventorySignature: signature,
      providers: providerDiscovery,
    },
  };
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
    if (!Array.isArray(payload.models) || payload.models.some((m: any) => !m || typeof m.id !== 'string' || !m.id || typeof m.provider !== 'string' || !m.provider)) throw new Error('shape');
    base.models = payload.models.map((m: any) => ({ id: `${m.provider}/${m.id}`, llmProvider: m.provider, displayName: m.name, reasoningEfforts: Array.isArray(m.thinking) ? m.thinking : undefined }));
    return base;
  } catch { return { ...base, errorKind: 'invalid-output', error: 'OMP returned invalid model catalog JSON or discovery could not run.' }; }
}

/** Never guess an unrelated model when a requested mapping is unavailable. */
export function resolveOmpRoleModel(catalog: ProviderModelDiscovery, role: string, mappings: Record<string, string>, explicit?: string): string {
  if (explicit) return explicit;
  const id = mappings[role];
  if (!id || !catalog.models.some(model => model.id === id)) throw new Error(`OMP ${role} model unavailable; configure a model from omp models --json or supply an explicit model.`);
  return id;
}
