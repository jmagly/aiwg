/**
 * Grok Build model/config discovery.
 *
 * `grok inspect --json` is authoritative for active config sources. We read only
 * model-selection fields from those reported files because current InspectReport
 * versions do not expose effective model values. Secret-bearing fields are reduced
 * to credential availability or header names and never leave this module.
 *
 * @issue #2579
 */
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolveGrokHomeResult } from '../providers/grok-build-paths.js';
import type {
  DiscoveredModel,
  ModelDiscoveryCommandRunner,
  ModelValueProvenance,
  ProviderModelDiscovery,
  ProviderModelPolicyReport,
} from './model-discovery.js';
import { classifyDiscoveryError, runModelDiscoveryCommand } from './model-discovery.js';

type Layer = { role: string; path: string; note?: string; precedence: number };
type ParsedLayer = {
  defaultModel?: string;
  allowedModels?: string[];
  disabledModels?: string[];
  models: Map<string, ParsedModel>;
  projectModelFields: boolean;
};
type ParsedModel = {
  alias: string;
  model?: string;
  name?: string;
  baseUrl?: string;
  envKeys: string[];
  hasInlineCredential: boolean;
  headerNames: string[];
  hidden?: boolean;
  contextWindow?: number;
  supportsBackendSearch?: boolean;
  reasoningEfforts?: string[];
};

export interface DiscoverGrokBuildOptions {
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runner?: ModelDiscoveryCommandRunner;
  /** Used by tests and callers with an already captured report. */
  inspectReport?: Record<string, unknown>;
}

export interface GrokBuildRoleResolution {
  role: string;
  model?: string;
  source: 'explicit' | 'project-policy' | 'single-model-fallback' | 'unresolved';
  diagnostic?: string;
}

const MAX_CONFIG_BYTES = 1024 * 1024;
const PROJECT_ALLOWED = new Set(['mcp_servers', 'plugins', 'permission', 'mcp']);

function unquote(value: string): string | undefined {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { return undefined; }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return undefined;
}

function stringArray(value: string): string[] | undefined {
  const text = value.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return undefined;
  const matches = [...text.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'/g)];
  return matches.map(match => match[1] !== undefined
    ? JSON.parse(`"${match[1]}"`) as string
    : match[2]!);
}

function tableName(line: string): string | undefined {
  const match = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
  return match?.[1]?.trim();
}

function modelAlias(table: string): string | undefined {
  const match = table.match(/^model\.(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([A-Za-z0-9_.-]+))$/);
  if (!match) return undefined;
  return match[1] !== undefined ? JSON.parse(`"${match[1]}"`) : (match[2] ?? match[3]);
}

function mapKeys(value: string): string[] {
  const body = value.trim().replace(/^\{/, '').replace(/}$/, '');
  return [...body.matchAll(/(?:^|,)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=/g)]
    .map(match => match[1] ?? match[2] ?? match[3]!)
    .filter(Boolean);
}

/** Parse only non-secret fields needed for model discovery. */
export function parseGrokBuildModelConfig(text: string, scope: string): ParsedLayer {
  const parsed: ParsedLayer = { models: new Map(), projectModelFields: false };
  let table = '';
  for (const raw of text.split(/\r?\n/)) {
    const nextTable = tableName(raw);
    if (nextTable !== undefined) { table = nextTable; continue; }
    const match = raw.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (!match) continue;
    const [, key, value] = match;
    const top = table.split('.', 1)[0];
    if (scope === 'project' && !PROJECT_ALLOWED.has(top)) {
      if (top === 'models' || top === 'model') parsed.projectModelFields = true;
      continue;
    }
    if (table === 'models') {
      if (key === 'default') parsed.defaultModel = unquote(value);
      else if (key === 'allowed_models') parsed.allowedModels = stringArray(value);
      else if (key === 'disabled_models') parsed.disabledModels = stringArray(value);
      continue;
    }
    const alias = modelAlias(table);
    if (!alias) continue;
    const model = parsed.models.get(alias) ?? {
      alias, envKeys: [], hasInlineCredential: false, headerNames: [],
    };
    if (key === 'model') model.model = unquote(value);
    else if (key === 'name') model.name = unquote(value);
    else if (key === 'base_url' || key === 'api_base_url') model.baseUrl = unquote(value);
    else if (key === 'env_key') model.envKeys = unquote(value) ? [unquote(value)!] : (stringArray(value) ?? []);
    else if (key === 'api_key') model.hasInlineCredential = Boolean(unquote(value));
    else if (key === 'extra_headers' || key === 'env_http_headers') model.headerNames.push(...mapKeys(value));
    else if (key === 'hidden') model.hidden = value.trim() === 'true';
    else if (key === 'context_window') model.contextWindow = Number(value.trim()) || undefined;
    else if (key === 'supports_backend_search') model.supportsBackendSearch = value.trim() === 'true';
    else if (key === 'reasoning_efforts') model.reasoningEfforts = stringArray(value);
    parsed.models.set(alias, model);
  }
  return parsed;
}

function inspectLayers(report: Record<string, unknown>): Layer[] {
  const sources = (report.configSources ?? report.config_sources) as Record<string, unknown> | undefined;
  if (!sources || !Array.isArray(sources.layers)) return [];
  return sources.layers.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    return typeof item.role === 'string' && typeof item.path === 'string'
      ? [{ role: item.role, path: item.path, ...(typeof item.note === 'string' ? { note: item.note } : {}), precedence: index + 1 }]
      : [];
  });
}

function inspectModels(report: Record<string, unknown>): DiscoveredModel[] {
  const candidates = [report.models, report.modelCatalog, report.model_catalog]
    .find(Array.isArray) as unknown[] | undefined;
  if (!candidates) return [];
  return candidates.flatMap(entry => {
    if (typeof entry === 'string') return [{ id: entry, alias: entry }];
    if (!entry || typeof entry !== 'object') return [];
    const model = entry as Record<string, unknown>;
    const alias = [model.alias, model.key, model.id].find(value => typeof value === 'string') as string | undefined;
    if (!alias) return [];
    return [{
      id: alias,
      alias,
      ...(typeof model.name === 'string' ? { displayName: model.name } : {}),
      ...(model.default === true || model.isDefault === true ? { isDefault: true } : {}),
      ...(model.hidden === true ? { hidden: true } : {}),
      ...(Array.isArray(model.reasoningEfforts)
        ? { reasoningEfforts: model.reasoningEfforts.filter((item): item is string => typeof item === 'string') }
        : {}),
    }];
  });
}

function setSelected(
  selected: Record<string, ModelValueProvenance>,
  key: string,
  value: ModelValueProvenance['value'] | undefined,
  layer: Layer,
  constraint?: ModelValueProvenance['constraint'],
): void {
  if (value === undefined) return;
  selected[key] = { value, source: layer.path, scope: layer.role, precedence: layer.precedence, ...(constraint ? { constraint } : {}) };
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}

function dedupe(models: DiscoveredModel[]): DiscoveredModel[] {
  return [...new Map(models.map(model => [model.alias ?? model.id, model])).values()];
}

function parseEnvOverlay(env: NodeJS.ProcessEnv): ParsedLayer | null {
  let content: unknown;
  try { content = JSON.parse(env.GROK_CONFIG ?? ''); } catch { return null; }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const value = content as Record<string, unknown>;
  const parsed: ParsedLayer = { models: new Map(), projectModelFields: false };
  const settings = value.models;
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const table = settings as Record<string, unknown>;
    if (typeof table.default === 'string') parsed.defaultModel = table.default;
    if (Array.isArray(table.allowed_models) && table.allowed_models.every(entry => typeof entry === 'string')) parsed.allowedModels = table.allowed_models;
    if (Array.isArray(table.disabled_models) && table.disabled_models.every(entry => typeof entry === 'string')) parsed.disabledModels = table.disabled_models;
  }
  // The host allowlists env-overlay sections; per-model secrets and model definitions
  // are intentionally not imported from arbitrary JSON here.
  return parsed;
}

async function readLayer(layer: Layer): Promise<ParsedLayer | null> {
  if (layer.path.startsWith('$') || layer.path.includes('(inline)')) return null;
  try {
    const text = await readFile(layer.path, 'utf8');
    if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) return null;
    return parseGrokBuildModelConfig(text, layer.role === 'project' ? 'project' : layer.role);
  } catch { return null; }
}

export async function discoverGrokBuildModels(
  options: DiscoverGrokBuildOptions = {},
): Promise<ProviderModelDiscovery> {
  const command = options.command ?? 'grok';
  const runner = options.runner ?? runModelDiscoveryCommand;
  const cwd = options.cwd ?? tmpdir();
  const env = options.env ?? process.env;
  const observedAt = new Date().toISOString();
  const base = {
    provider: 'grok-build', source: 'native' as const, observedAt,
    accountScope: 'local-runtime' as const, models: [] as DiscoveredModel[],
  };
  let report = options.inspectReport;
  let runtimeVersion: string | undefined;
  if (!report) {
    const [version, result] = await Promise.all([
      runner(command, ['--version'], { cwd, timeoutMs: 5_000, env }),
      runner(command, ['inspect', '--json'], { cwd, timeoutMs: 15_000, env }),
    ]);
    runtimeVersion = version.exitCode === 0 ? version.stdout.trim().split(/\r?\n/, 1)[0] : undefined;
    if (result.exitCode !== 0) {
      // Native stderr can include arbitrary headers, API keys and endpoint URLs.
      // Classify it, but never echo untrusted command output into audit/receipts.
      const detail = result.stderr || result.stdout;
      return { ...base, ...(runtimeVersion ? { runtimeVersion } : {}),
        errorKind: result.exitCode === 124 ? 'timeout' : classifyDiscoveryError(detail),
        error: `Grok Build inspect failed (exit ${result.exitCode}); check CLI version, config layers and credentials locally.` };
    }
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object expected');
      report = parsed as Record<string, unknown>;
    } catch {
      return { ...base, ...(runtimeVersion ? { runtimeVersion } : {}), errorKind: 'invalid-output',
        error: 'Grok Build inspect returned an unsupported JSON shape; update Grok Build or AIWG.' };
    }
  }

  const layers = inspectLayers(report);
  if (layers.length === 0 && !Object.keys(report).some(key => ['models', 'modelCatalog', 'model_catalog'].includes(key))) {
    return { ...base, ...(runtimeVersion ? { runtimeVersion } : {}), errorKind: 'invalid-output',
      error: 'Grok Build inspect JSON omitted configSources; update Grok Build or AIWG.' };
  }
  const diagnostics: string[] = [];
  const selected: Record<string, ModelValueProvenance> = {};
  const constraints: ProviderModelPolicyReport['constraints'] = [];
  const discovered = inspectModels(report);
  const parsedByLayer = await Promise.all(layers.map(layer => layer.role === 'env_overlay'
    && layer.path.includes('(inline)') ? parseEnvOverlay(env) : readLayer(layer)));
  let requirementsDefault: ModelValueProvenance | undefined;
  let requirementsAllowed: ModelValueProvenance | undefined;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    const parsed = parsedByLayer[i];
    if (!parsed) continue;
    if (parsed.projectModelFields) diagnostics.push(`${layer.path}: ignored model settings because Grok Build project scope does not allow them`);
    const requirement = /requirements|mdm/i.test(layer.role);
    setSelected(selected, 'models.default', parsed.defaultModel, layer, requirement ? 'pin' : undefined);
    setSelected(selected, 'models.allowed_models', parsed.allowedModels, layer, requirement ? 'allowlist' : undefined);
    setSelected(selected, 'models.disabled_models', parsed.disabledModels, layer);
    if (requirement && parsed.defaultModel) requirementsDefault = selected['models.default'];
    if (requirement && parsed.allowedModels) requirementsAllowed = selected['models.allowed_models'];
    if (requirement && parsed.defaultModel) constraints.push({ key: 'models.default', source: layer.path, precedence: layer.precedence, kind: 'pin' });
    if (requirement && parsed.allowedModels) constraints.push({ key: 'models.allowed_models', source: layer.path, precedence: layer.precedence, kind: 'allowlist' });
    for (const model of parsed.models.values()) {
      setSelected(selected, `model.${model.alias}.alias`, model.alias, layer);
      setSelected(selected, `model.${model.alias}.model`, model.model, layer);
      setSelected(selected, `model.${model.alias}.name`, model.name, layer);
      setSelected(selected, `model.${model.alias}.context_window`, model.contextWindow, layer);
      setSelected(selected, `model.${model.alias}.supports_backend_search`, model.supportsBackendSearch, layer);
      const credentialState: DiscoveredModel['credentialState'] = model.hasInlineCredential
        || model.envKeys.some(key => Boolean(env[key])) ? 'available'
          : model.envKeys.length > 0 ? 'unavailable' : 'session';
      discovered.push({
        id: model.alias,
        alias: model.alias,
        ...(model.model ? { apiModelId: model.model } : {}),
        ...(model.name ? { displayName: model.name } : {}),
        ...(model.hidden !== undefined ? { hidden: model.hidden } : {}),
        ...(model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts } : {}),
        capabilities: [
          ...(model.contextWindow ? [`context:${model.contextWindow}`] : []),
          ...(model.supportsBackendSearch ? ['backend-search'] : []),
          ...(model.baseUrl ? ['custom-endpoint'] : []),
          ...model.headerNames.map(name => `header:${name}`),
        ],
        credentialState,
      });
    }
  }

  const homeResult = resolveGrokHomeResult(env, env.HOME ?? env.USERPROFILE ?? homedir());
  if (!homeResult.ok) diagnostics.push(homeResult.message);
  const envDefault = env.GROK_DEFAULT_MODEL?.trim();
  if (envDefault && !requirementsDefault) {
    const layer: Layer = { role: 'environment', path: 'GROK_DEFAULT_MODEL', precedence: layers.length + 1 };
    setSelected(selected, 'models.default', envDefault, layer);
  }
  if (requirementsDefault) selected['models.default'] = requirementsDefault;
  if (requirementsAllowed) selected['models.allowed_models'] = requirementsAllowed;

  let models = dedupe(discovered);
  const defaultAlias = selected['models.default']?.value;
  if (typeof defaultAlias === 'string' && !models.some(model => (model.alias ?? model.id) === defaultAlias)) {
    models.push({ id: defaultAlias, alias: defaultAlias, credentialState: 'session' });
  }
  const disabled = selected['models.disabled_models']?.value;
  if (Array.isArray(disabled)) models = models.filter(model => !disabled.includes(model.alias ?? model.id));
  const allowed = selected['models.allowed_models']?.value;
  if (Array.isArray(allowed) && allowed.length > 0) {
    models = models.filter(model => allowed.some(pattern => globMatches(pattern, model.alias ?? model.id)));
  }
  models = models.map(model => ({ ...model, isDefault: (model.alias ?? model.id) === defaultAlias }));
  if (models.some(model => model.credentialState === 'unavailable')) {
    diagnostics.push('One or more configured models lack their named credential environment variable; secret values were not read into output.');
  }
  return {
    ...base,
    ...(runtimeVersion ? { runtimeVersion } : {}),
    models,
    policy: {
      layers: layers.map(layer => ({ scope: layer.role, source: layer.path, precedence: layer.precedence,
        policyConstraint: /requirements|mdm/i.test(layer.role) })),
      selected,
      constraints,
      diagnostics,
    },
    ...(models.length === 0 ? { errorKind: 'invalid-output' as const,
      error: 'Grok Build exposed no model aliases. Configure [models].default or [model.<alias>] in $GROK_HOME/config.toml; AIWG will not fabricate an xAI model ID.' } : {}),
  };
}

/** Resolve aliases only from the observed catalog. Exact API model ids are never synthesized. */
export function resolveGrokBuildRoleModel(
  catalog: ProviderModelDiscovery,
  role: string,
  mappings: Record<string, string> = {},
  explicit?: string,
): GrokBuildRoleResolution {
  const available = new Set(catalog.models.map(model => model.alias ?? model.id));
  const requested = explicit ?? mappings[role];
  if (requested) {
    if (available.has(requested)) return { role, model: requested, source: explicit ? 'explicit' : 'project-policy' };
    return { role, source: 'unresolved', diagnostic: `Grok Build model alias "${requested}" is unavailable for ${role}; choose an alias reported by grok inspect/config discovery. No xAI model ID was substituted.` };
  }
  if (available.size === 1) return { role, model: [...available][0], source: 'single-model-fallback' };
  return { role, source: 'unresolved', diagnostic: `Grok Build ${role} role has no mapping and ${available.size} models are available; configure an explicit alias in models.json. No xAI model ID was guessed.` };
}
