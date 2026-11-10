/** Discover Droid's configured BYOK selectors without retaining credential fields. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAiwgConfig } from '../config/aiwg-config.js';
import { buildWorkerObservation, discoveryDigest, runModelDiscoveryCommand,
  type ModelDiscoveryCommandRunner, type ProviderModelDiscovery } from './model-discovery.js';

export interface DiscoverFactoryOptions {
  homeDir?: string;
  command?: string;
  cliId?: string;
  accountBinding?: string;
  runtimeVersion?: string;
  runner?: ModelDiscoveryCommandRunner;
  now?: () => Date;
}
const MAX_CONFIG_BYTES = 1024 * 1024;
const MODEL_FIELDS = new Set(['', 'customModels', 'model', 'displayName', 'baseUrl', 'provider', 'maxOutputTokens']);

async function readSettings(filename: string): Promise<unknown> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error('Config exceeds bounds');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONFIG_BYTES) throw new Error('Config exceeds bounds');
    // Drop every unneeded field at parse time, including apiKey/api_key. Never
    // inspect, interpolate or hash their values; parser errors are never echoed.
    return JSON.parse(buffer.toString('utf8', 0, bytesRead), (key, value: unknown) =>
      MODEL_FIELDS.has(key) || /^\d+$/.test(key) ? value : undefined);
  } finally { await file.close(); }
}

function inferenceProvider(provider: string, baseUrl: unknown): string | undefined {
  if (typeof baseUrl === 'string') {
    try {
      const url = new URL(baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) return undefined;
      const host = url.hostname.toLowerCase();
      return ({ 'openrouter.ai': 'openrouter', 'api.openai.com': 'openai',
        'api.anthropic.com': 'anthropic' } as Record<string, string>)[host] ?? host;
    } catch { return undefined; }
  }
  // These are backend identities. Generic protocol names are not providers.
  return ['anthropic', 'openai'].includes(provider) ? provider : undefined;
}

export async function discoverFactoryModels(options: DiscoverFactoryOptions = {}): Promise<ProviderModelDiscovery> {
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  const source = join(options.homeDir ?? homedir(), '.factory/settings.json');
  const result: ProviderModelDiscovery = { provider: 'factory', source: 'native', observedAt,
    accountScope: 'local-account', ...(options.accountBinding ? { accountBinding: options.accountBinding } : {}), models: [] };
  let version = options.runtimeVersion;
  if (!version) {
    try {
      const probe = await (options.runner ?? runModelDiscoveryCommand)(options.command ?? 'droid', ['--version'],
        { cwd: tmpdir(), timeoutMs: 5000 });
      // Accept the known plain and droid-cli banners, never retain arbitrary CLI output.
      if (probe.exitCode === 0) version = /^(?:droid-cli\s+)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/.exec(probe.stdout.trim())?.[1];
    } catch { /* A missing runtime cannot establish a current worker observation. */ }
  }
  if (!version) return { ...result, errorKind: 'command', error: 'Factory version probe failed; no current custom model observations.' };
  result.runtimeVersion = version;
  let settings: unknown;
  try { settings = await readSettings(source); }
  catch (error) {
    return { ...result, errorKind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unsupported' : 'invalid-output',
      error: 'Factory settings.json could not be read or parsed within bounds; built-in plan models have no non-interactive model-list command.' };
  }
  const rows = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? (settings as Record<string, unknown>).customModels : undefined;
  if (rows === undefined && settings && typeof settings === 'object' && !Array.isArray(settings)) return result;
  if (!Array.isArray(rows) || rows.length > 1024) return { ...result, errorKind: 'invalid-output', error: 'Factory /customModels: expected bounded array.' };
  const diagnostics: string[] = [];
  for (const [index, entry] of rows.entries()) {
    const invalid = () => diagnostics.push(`Factory /customModels/${index}: malformed model fields or unknown inference provider.`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { invalid(); continue; }
    const row = entry as Record<string, unknown>;
    const { model, displayName, provider, baseUrl, maxOutputTokens } = row;
    if (typeof model !== 'string' || !model.trim() || /\s/.test(model)
      || typeof displayName !== 'string' || !displayName.trim() || displayName !== displayName.trim()
      || /[\x00-\x1f\x7f]/.test(displayName) || typeof provider !== 'string'
      || (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || (maxOutputTokens as number) < 1))) { invalid(); continue; }
    const llmProvider = inferenceProvider(provider, baseUrl);
    if (!llmProvider) { invalid(); continue; }
    const id = `custom:${displayName.replace(/ /g, '-')}`;
    const facts = { id, model, displayName, llmProvider, maxOutputTokens: maxOutputTokens ?? null };
    const worker = buildWorkerObservation({ cliId: options.cliId ?? 'factory', source,
      pointer: `/customModels/${index}`, runtimeVersion: version, observedAt,
      accountScope: 'local-account', accountBinding: options.accountBinding,
      contentDigest: discoveryDigest(JSON.stringify(facts)) }, {
      modelId: id, family: 'unknown', visibility: 'listed', lifecycle: 'active',
      maxOutputTokens: maxOutputTokens as number | undefined, effortSupport: 'not-applicable',
      provenanceFields: ['/apiModelId', '/llmProvider', '/displayName'],
    });
    // apiModelId is the executable Droid selector required by qualification and
    // invocation, not the upstream API id. Preserve the latter as config provenance.
    result.models.push({ id, apiModelId: id, displayName, llmProvider, worker });
    result.policy ??= { layers: [{ source, scope: 'user', precedence: 1, policyConstraint: false }],
      selected: {}, constraints: [], diagnostics: [] };
    result.policy.selected[`customModels.${index}.model`] = { value: model, source, scope: 'user', precedence: 1 };
  }
  const duplicates = new Set(result.models.filter((row, index, all) => all.findIndex(other => other.id === row.id) !== index).map(row => row.id));
  if (duplicates.size) {
    diagnostics.push('Factory custom model display names produce ambiguous selectors.');
    result.models = result.models.filter(row => !duplicates.has(row.id));
  }
  if (diagnostics.length) { result.errorKind = 'invalid-output'; result.error = diagnostics.join('; '); }
  return result;
}

/** Bind refresh to a single configured Factory installation; doctor binds each target separately. */
export async function discoverProjectFactoryModels(projectDir: string, options: DiscoverFactoryOptions = {}): Promise<ProviderModelDiscovery> {
  const config = await readAiwgConfig(projectDir);
  const clis = Object.entries(config?.parallelism?.clis ?? {}).filter(([id, cli]) =>
    cli.enabled !== false && (cli.adapter ?? `providers:${id}`) === 'providers:factory');
  const [cliId, cli] = clis.length === 1 ? clis[0] : [];
  return discoverFactoryModels({ cliId, command: cli?.executable, accountBinding: cli?.accountScope, ...options });
}
