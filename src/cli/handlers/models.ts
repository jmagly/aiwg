import { MODELS_HELP } from './models-help.js';
import { shellRefusalDiagnostics } from './models-refusal.js';
import { updateJson } from '../../models/config-writer.js';
import { atomicConfigWrite as atomicWrite } from '../../config/worker-write.js';
import { handleWorkerAdoptionArgs } from '../../config/worker-adoption-cli.js';
import type { HostResourceReaders } from '../../config/host-resource-runtime.mjs';
import { sampleWorkerHostResources } from './models-resource-sample.js';
import { resolveParallelism } from '../../config/aiwg-config.js';
/**
 * Safe model-policy audit, resolution, and mutation commands.
 * @implements #1804
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { glob } from 'glob';
import { load as loadYaml } from 'js-yaml';
import {
  compileModelPolicy, validateCanonicalModelPolicy,
  loadProviderModelCapabilities, WorkerPolicyError, assertWorkerRoleEffort,
  type ProviderModelCatalog,
} from '../../models/provider-policy.js';
import type { CanonicalModelPolicy, ModelTier } from '../../models/types.js';
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import type { DiscoveredModel, DynamicModelCatalog } from '../../models/model-discovery.js';
import { resolveGrokBuildRoleModel } from '../../models/grok-build-models.js';
import { readAiwgConfig, emptyConfig } from '../../config/aiwg-config.js';
import { ConfigLoader } from '../../models/config-loader.js';
import { loadRecordedWorkerInstallations, normalizeWorkerVersionBanner } from '../../models/worker-installation.mjs';
import type { WorkerPlanSnapshot } from '../../models/resolver.js';
import { parseWorkerCommandArgs, resolveWorkerInvocation, workerInvocationDiagnostic, type WorkerInvocationDriver } from '../../serve/worker-invocation.js';
/** Compare selection facts without observation times or approval/provenance metadata. */
function approvalFacts(row: DiscoveredModel) {
  if (!row.worker) return null;
  const { observedAt, verifiedAt, firstObservedAt, fetchedAt, retiredAt,
    evidenceDigest, provenance, qualification, ...facts } = row.worker;
  return { id: row.id, apiModelId: row.apiModelId, llmProvider: row.llmProvider,
    hidden: row.hidden, reasoningEfforts: row.reasoningEfforts, facts };
}
/** #2885's trusted installation owner supplies qualified bindings and installed drivers.
 * This is an in-process dependency, never a CLI flag or project-config module path. */
export interface ModelsWorkerServices {
  load(ctx: HandlerContext): Promise<{ snapshot: WorkerPlanSnapshot; drivers: Record<string, WorkerInvocationDriver> }>;
  now?(): string;
}
/**
 * #2892: exported so the MCP worker-invoke bridge can resolve a direct worker
 * plan in-process (same snapshot/driver construction as `aiwg models resolve`),
 * without shelling out to the CLI. No new loader is introduced; this is the
 * CLI's own existing default `ModelsWorkerServices.load`.
 */
export async function loadWorkerInputs(ctx: HandlerContext, resourceReaders?: HostResourceReaders) {
  const config = await readAiwgConfig(ctx.cwd) ?? emptyConfig();
  const loader = new ConfigLoader(ctx.cwd);
  const models = await loader.load(config.parallelism);
  const catalog = await effectiveCatalog(ctx, ctx.cwd, false, parseArgs(['resolve']));
  const registry = loadProviderModelCapabilities();
  if (!config.parallelism?.worker_dispatch) {
    return { snapshot: { config, models, modelDigests: loader.getInputDigests()!, catalog,
      registry, installations: {} }, drivers: {} };
  }
  // Explain missing policy before a recorded approval's digest check can
  // mask it. The host owner first preserves its missing-installation errors.
  const parallelism = resolveParallelism(config.parallelism, config.providers[0]);
  const precheckPolicy = () => {
    if (!ctx.args.some(arg => arg === '--role' || arg.startsWith('--role='))) return;
    const request = parseWorkerCommandArgs(ctx.args.slice(1));
    const members = Object.entries(parallelism.groups ?? {})
      .filter(([id]) => !request.group || request.group === id)
      .flatMap(([, group]) => group.members ?? []).filter(member => member.enabled !== false
        && parallelism.clis?.[member.cli]?.enabled !== false && member.roles.includes((models.defaults.workerSelection?.roleGuidance?.[request.role]?.baseRole ?? request.role) as 'coding' | 'reasoning' | 'efficiency'));
    const requiresExplicit = members.length > 0 && members.every(member => {
      // Health metadata can identify the provider before an operator has
      // qualified its dispatch adapter. It grants no dispatch authority.
      const [namespace, id] = (parallelism.clis?.[member.cli]?.adapter ?? `providers:${member.cli}`).split(':');
      const provider = namespace === 'providers' ? registry.providers[id as keyof typeof registry.providers] : undefined;
      const adapter = namespace === 'workerAdapters' ? registry.workerAdapters?.[id]
        : provider?.workerAdapter ?? provider?.workerHealthAdapter;
      const observation = (catalog.discovery?.instances?.[member.cli]
        ?? catalog.discovery?.providers?.[adapter?.provider ?? id])?.models.find(row => row.id === member.model)?.worker;
      if (observation?.effortSupport === 'explicit') return true;
      if (observation?.effortSupport === 'not-applicable') return false;
      return adapter?.capabilities.effort === 'explicit';
    });
    // With no matching worker, do not invent policy needs.
    if (members.length) assertWorkerRoleEffort(models.defaults.workerSelection, request.role, requiresExplicit);
  };
  const { registry: qualifiedRegistry, installations, drivers, observations } = await loadRecordedWorkerInstallations({
    registry, cwd: ctx.cwd, policy: models.defaults.workerSelection, parallelism: config.parallelism, precheckPolicy,
  });
  catalog.discovery ??= { source: 'static', fetchedAt: new Date().toISOString(), providers: {} };
  catalog.discovery.instances = { ...catalog.discovery.instances };
  for (const [cli, approved] of Object.entries(observations)) {
    const cached = catalog.discovery.instances[cli] ?? catalog.discovery.providers[approved.provider];
    // Discovery stores the CLI banner; qualification stores its parsed version.
    const invocation = drivers[cli]?.qualification.adapter.invocation;
    const versionPattern = invocation?.kind === 'process' ? invocation.versionPattern : undefined;
    const version = (value: string | undefined) => {
      if (value === undefined) return value;
      try { return normalizeWorkerVersionBanner(value, versionPattern); }
      catch { return value; } // A changed or invalid banner must still fail closed.
    };
    const current = cached ? { ...cached, runtimeVersion: version(cached.runtimeVersion),
      accountBinding: cached.accountBinding ?? cached.accountScope,
      models: cached.models.map(row => row.worker ? { ...row,
        worker: { ...row.worker, runtimeVersion: version(row.worker.runtimeVersion)! } } : row) } : undefined;
    // Stale discovery must not replace a newer approved observation.
    if (!current || Date.parse(approved.observedAt) > Date.parse(current.observedAt)) {
      catalog.discovery.instances[cli] = approved;
      continue;
    }
    catalog.discovery.instances[cli] = { ...current, models: current.models.map(row => {
      const prior = approved.models.find(model => model.id === row.id);
      if (!row.worker || !prior?.worker) return row;
      if (Date.parse(prior.worker.observedAt) > Date.parse(row.worker.observedAt)) return prior;
      // New retirement/conflict/visibility evidence always requires requalification.
      const safe = !row.hidden && row.worker.visibility !== 'hidden'
        && row.worker.lifecycle !== 'retired' && !row.worker.conflicts?.length;
      return safe && isDeepStrictEqual(approvalFacts(row), approvalFacts(prior))
        ? { ...row, worker: { ...row.worker, qualification: prior.worker.qualification } } : row;
    }) };
  }
  return { snapshot: { config, models, modelDigests: loader.getInputDigests()!, catalog,
    registry: qualifiedRegistry, installations, hostResources: sampleWorkerHostResources(ctx, { ...resourceReaders, groupNames: Object.keys(config.parallelism?.groups ?? {}) }) }, drivers };
}

async function resolveDirect(ctx: HandlerContext, services: ModelsWorkerServices): Promise<HandlerResult> {
  let shell = false;
  try {
    const request = parseWorkerCommandArgs(ctx.args.slice(1));
    shell = request.format === 'shell';
    const { snapshot, drivers } = await services.load(ctx);
    const plan = await resolveWorkerInvocation(snapshot, request, drivers, services.now?.());
    const runnable = plan.invocation?.readiness === 'launchable';
    if (shell && !runnable) console.error(JSON.stringify({ status: 'blocked', diagnostics: shellRefusalDiagnostics(plan) }, null, 2));
    else if (shell && plan.invocation?.transport === 'shell') print(plan.invocation.shellCommand, false);
    else print(plan, true);
    return { exitCode: runnable ? 0 : 2 };
  } catch (error) {
    const diagnostic = { status: 'blocked', diagnostics: [workerInvocationDiagnostic(error, error instanceof WorkerPolicyError
      && error.code === 'OG_ADAPTER_UNQUALIFIED' ? '/parallelism/clis' : '/request')] };
    if (shell) console.error(JSON.stringify(diagnostic, null, 2));
    else print(diagnostic, true);
    return { exitCode: 2 };
  }
}

type ArtifactKind = 'agent' | 'skill';
interface Artifact {
  kind: ArtifactKind;
  name: string;
  file: string;
  relative: string;
  framework?: string;
  role?: CanonicalModelPolicy['role'];
  tier?: ModelTier;
  effort?: CanonicalModelPolicy['effort'];
  legacyModel?: string;
}
interface ParsedArgs {
  subcommand: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}
const TIERS = new Set(['economy', 'standard', 'premium', 'flagship', 'max-quality']);
const PROVIDERS = new Set(Object.keys(loadProviderModelCapabilities().providers));

function parseArgs(args: string[]): ParsedArgs {
  const [subcommand = 'help', ...rest] = args;
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const [key, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) flags.set(key, inline);
    else if (rest[i + 1] && !rest[i + 1].startsWith('--')) flags.set(key, rest[++i]);
    else flags.set(key, true);
  }
  return { subcommand, positionals, flags };
}
function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}
function legacyPolicy(model?: string): Pick<Artifact, 'role' | 'tier'> {
  const value = model?.toLowerCase() ?? '';
  if (value === 'opus' || value.includes('opus')) return { role: 'reasoning', tier: 'premium' };
  if (value === 'haiku' || value.includes('haiku') || value.includes('mini')) {
    return { role: 'efficiency', tier: 'economy' };
  }
  return { role: 'coding', tier: 'standard' };
}
function readFrontmatter(raw: string): { metadata: Record<string, any>; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;
  const metadata = loadYaml(match[1]);
  return metadata && typeof metadata === 'object'
    ? { metadata: metadata as Record<string, any>, body: match[2] } : null;
}
async function discover(target: string): Promise<Artifact[]> {
  const patterns = [
    'agentic/code/{frameworks,addons,plugins}/**/agents/*.md',
    'agentic/code/{frameworks,addons,plugins}/**/skills/*/SKILL.md',
    '.aiwg/{agents,skills}/**/*.md',
  ];
  const files = await glob(patterns, { cwd: target, absolute: true, nodir: true, dot: true });
  const artifacts: Artifact[] = [];
  for (const file of files.sort()) {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = readFrontmatter(raw);
    if (!parsed) continue;
    const kind: ArtifactKind = path.basename(file) === 'SKILL.md' ? 'skill' : 'agent';
    const hint = kind === 'skill' ? parsed.metadata.commandHint ?? {} : parsed.metadata;
    const legacyModel = hint.model;
    const fallback = legacyPolicy(legacyModel);
    const relative = path.relative(target, file);
    artifacts.push({
      kind,
      name: kind === 'skill' ? path.basename(path.dirname(file)) : path.basename(file, '.md'),
      file,
      relative,
      framework: relative.match(/agentic\/code\/(?:frameworks|addons|plugins)\/([^/]+)/)?.[1],
      role: hint.modelRole ?? hint['model-role'] ?? fallback.role,
      tier: hint.modelTier ?? hint['model-tier'] ?? fallback.tier,
      effort: hint.modelEffort ?? hint['model-effort'],
      legacyModel,
    });
  }
  return artifacts;
}
function wildcard(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}
function select(artifacts: Artifact[], parsed: ParsedArgs, useTierSelector = true): Artifact[] {
  const exactAgent = flagString(parsed, 'agent');
  const exactSkill = flagString(parsed, 'skill');
  const globPattern = flagString(parsed, 'glob');
  const role = flagString(parsed, 'role');
  const tier = flagString(parsed, 'tier');
  const framework = flagString(parsed, 'framework');
  if (!parsed.flags.has('all') && !exactAgent && !exactSkill && !globPattern && !role && !tier && !framework) {
    return artifacts;
  }
  return artifacts.filter(item => (
    (!exactAgent || (item.kind === 'agent' && item.name === exactAgent))
    && (!exactSkill || (item.kind === 'skill' && item.name === exactSkill))
    && (!globPattern || wildcard(globPattern, item.name))
    && (!role || item.role === role)
    && (!useTierSelector || !tier || item.tier === tier)
    && (!framework || item.framework === framework)
  ));
}
function normalizedTier(tier: ModelTier | undefined): CanonicalModelPolicy['tier'] {
  return tier === 'max-quality' ? 'flagship' : tier ?? 'standard';
}
function resolved(item: Artifact, provider: string, catalog?: ProviderModelCatalog) {
  const policy: CanonicalModelPolicy = {
    role: item.role ?? 'coding',
    tier: normalizedTier(item.tier),
    ...(item.effort ? { effort: item.effort } : {}),
  };
  return { ...item, policy, compiled: compileModelPolicy({
    provider: provider as Parameters<typeof compileModelPolicy>[0]['provider'],
    artifact: item.kind,
    policy,
    ...(catalog ? { catalog } : {}),
  }) };
}
function print(value: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (Array.isArray(value) && value.every(item => item?.kind && item?.relative)) {
    for (const item of value as any[]) {
      const outcome = item.compiled?.outcome ? `\t${item.compiled.outcome}` : '';
      console.log(`${item.kind}\t${item.name}\t${item.role}/${item.tier}${outcome}\t${item.relative}`);
      for (const diagnostic of item.compiled?.diagnostics ?? []) {
        console.log(`  ${diagnostic.code}: ${diagnostic.message}`);
      }
    }
  } else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}
async function effectiveCatalog(
  ctx: HandlerContext,
  target: string,
  allowNetwork: boolean,
  parsed: ParsedArgs,
  provider?: string,
): Promise<DynamicModelCatalog> {
  const { collectProviderInventory } = await import('../../providers/provider-inventory.js');
  const { resolveDynamicModelCatalog } = await import('../../models/model-discovery.js');
  const inventory = await collectProviderInventory(target);
  const aiwgRoot = await fs.access(path.join(ctx.frameworkRoot, 'agentic/code/providers/model-catalog.v1.json'))
    .then(() => ctx.frameworkRoot)
    .catch(() => process.cwd());
  const nativeDiscoverers = provider === 'grok-build' ? {
    'grok-build': async () => {
      const { discoverGrokBuildModels } = await import('../../models/grok-build-models.js');
      return discoverGrokBuildModels({ cwd: target, env: process.env });
    },
  } : undefined;
  return resolveDynamicModelCatalog({
    aiwgRoot,
    inventory,
    allowNetwork,
    forceRefresh: allowNetwork,
    ...(nativeDiscoverers ? { nativeDiscoverers } : {}),
    ...(flagString(parsed, 'url') ? { remoteUrl: flagString(parsed, 'url') } : {}),
  });
}
function replaceFrontmatter(raw: string, item: Artifact, tier: string): string {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`${item.relative}: missing YAML frontmatter`);
  let frontmatter = match[1];
  if (item.kind === 'agent') {
    if (/^model-tier:/m.test(frontmatter)) {
      frontmatter = frontmatter.replace(/^model-tier:\s*.*$/m, `model-tier: ${tier}`);
    } else frontmatter += `\nmodel-tier: ${tier}`;
  } else {
    if (!/^commandHint:\s*$/m.test(frontmatter)) frontmatter += '\ncommandHint:';
    if (/^\s+modelTier:/m.test(frontmatter)) {
      frontmatter = frontmatter.replace(/^\s+modelTier:\s*.*$/m, `  modelTier: ${tier}`);
    } else {
      const lines = frontmatter.split('\n');
      const index = lines.findIndex(line => /^commandHint:\s*$/.test(line));
      let end = index + 1;
      while (end < lines.length && /^\s+/.test(lines[end])) end++;
      lines.splice(end, 0, `  modelTier: ${tier}`);
      frontmatter = lines.join('\n');
    }
  }
  return `---\n${frontmatter}\n---\n${match[2]}`;
}

async function execute(ctx: HandlerContext, services: ModelsWorkerServices = { load: loadWorkerInputs }): Promise<HandlerResult> {
  if (ctx.args.length === 0 || ctx.args[0] === 'help' || ctx.args.includes('--help') || ctx.args.includes('-h')) {
    print(MODELS_HELP, false);
    return { exitCode: 0 };
  }
  // Preserve artifact/native resolve when direct-only flags are absent.
  if (ctx.args[0] === 'resolve' && ctx.args.slice(1).some(arg =>
    /^--(?:task|group|brief|workdir|final-output|transport|format|authorize-premium|max-attempts|timeout-ms|max-output-tokens|max-usd)(?:=|$)/.test(arg))) {
    return resolveDirect(ctx, services);
  }
  if (await handleWorkerAdoptionArgs(ctx.args, ctx.cwd, 'models', ctx.signal, ctx.dryRun)) return { exitCode: 0 };
  const parsed = parseArgs(ctx.args);
  if (parsed.subcommand === 'resolve') {
    const supported = new Set(['agent', 'skill', 'glob', 'role', 'tier', 'framework', 'all', 'target', 'provider', 'model', 'json', 'help', 'dry-run']);
    for (const key of parsed.flags.keys()) if (!supported.has(key)) return { exitCode: 2, message: `Unsupported models resolve flag: --${key}` };
  }
  const json = parsed.flags.has('json');
  const dryRun = parsed.flags.has('dry-run') || ctx.dryRun === true;
  const target = path.resolve(flagString(parsed, 'target') ?? ctx.cwd);
  const provider = flagString(parsed, 'provider') ?? 'claude';
  if (!PROVIDERS.has(provider)) return { exitCode: 2, message: `Unknown provider: ${provider}` };
  if (parsed.subcommand === 'sources' || parsed.subcommand === 'refresh') {
    const { diffModelCatalog } = await import('../../models/model-discovery.js');
    const catalog = await effectiveCatalog(ctx, target, parsed.subcommand === 'refresh', parsed, provider);
    if (parsed.flags.has('drift')) {
      const staticCatalog = JSON.parse(await fs.readFile(
        path.join(ctx.frameworkRoot, 'agentic/code/providers/model-catalog.v1.json'),
        'utf8',
      ));
      print({ catalog, drift: diffModelCatalog(staticCatalog, catalog) }, json);
    } else {
      print(catalog, json);
    }
    return { exitCode: 0 };
  }
  if (parsed.subcommand === 'set-default') {
    const tier = parsed.positionals[0];
    if (!tier || !TIERS.has(tier)) return { exitCode: 2, message: 'set-default requires a valid TIER' };
    const scope = flagString(parsed, 'scope') ?? 'project';
    const file = scope === 'user'
      ? path.join(os.homedir(), '.config', 'aiwg', 'models.json')
      : path.join(target, 'models.json');
    const result = await updateJson(file, value => {
      value.defaults = { ...(value.defaults ?? {}), tier };
    }, dryRun);
    print(result, json);
    return { exitCode: 0 };
  }
  const discovered = await discover(target);
  const artifacts = select(discovered, parsed, parsed.subcommand !== 'set');
  if (parsed.subcommand === 'list') { print(artifacts, json); return { exitCode: 0 }; }
  if (parsed.subcommand === 'audit' || parsed.subcommand === 'resolve') {
    const catalog = await effectiveCatalog(ctx, target, false, parsed, provider);
    const catalogSource = catalog.discovery?.source ?? 'static';
    let roleMappings: Record<string, string> = {};
    if (provider === 'grok-build') {
      try {
        const projectConfig = JSON.parse(await fs.readFile(path.join(target, 'models.json'), 'utf8'));
        const candidate = projectConfig?.providers?.['grok-build'];
        if (candidate && typeof candidate === 'object') roleMappings = candidate;
      } catch { /* optional project policy */ }
    }
    const output = artifacts.map(item => {
      const base = {
        ...resolved(item, provider, catalog as ProviderModelCatalog),
        catalogSource,
        catalogFetchedAt: catalog.discovery?.fetchedAt ?? null,
      };
      if (provider !== 'grok-build') return base;
      const discovery = catalog.discovery?.providers['grok-build'];
      if (!discovery) return base;
      const providerResolution = resolveGrokBuildRoleModel(discovery, base.policy.role, roleMappings,
        flagString(parsed, 'model'));
      return { ...base,
        compiled: { ...base.compiled, effectiveModel: providerResolution.model, fields: {},
          source: 'inheritance' as const },
        providerPolicy: discovery.policy, providerResolution };
    });
    print(output, json);
    return { exitCode: output.some(item => item.compiled.diagnostics.some(d => d.severity === 'error')
      || ('providerResolution' in item && item.providerResolution?.source === 'unresolved')) ? 2 : 0 };
  }
  if (parsed.subcommand === 'validate') {
    const invalid = artifacts.filter(item => !validateCanonicalModelPolicy({
      role: item.role,
      tier: normalizedTier(item.tier),
      ...(item.effort ? { effort: item.effort } : {}),
    }).valid);
    print({ valid: invalid.length === 0, checked: artifacts.length, invalid }, json);
    return { exitCode: invalid.length ? 2 : 0 };
  }
  if (parsed.subcommand === 'set') {
    const tier = flagString(parsed, 'tier');
    if (!tier || !TIERS.has(tier)) return { exitCode: 2, message: 'set requires --tier TIER' };
    if (!parsed.flags.has('all') && !flagString(parsed, 'agent') && !flagString(parsed, 'skill')
      && !flagString(parsed, 'glob') && !flagString(parsed, 'role') && !flagString(parsed, 'framework')) {
      return { exitCode: 2, message: 'set requires a typed selector or --all' };
    }
    const plans: { item: Artifact; before: string; after: string }[] = [];
    for (const item of artifacts) {
      const before = await fs.readFile(item.file, 'utf8');
      const after = replaceFrontmatter(before, item, tier);
      if (before === after) continue;
      plans.push({ item, before, after });
    }
    if (!dryRun) await Promise.all(plans.map(plan => atomicWrite(plan.item.file, plan.after)));
    const changes = plans.map(plan => ({
      kind: plan.item.kind,
      name: plan.item.name,
      relative: plan.item.relative,
      role: plan.item.role,
      tier,
      before: plan.item.tier,
      after: tier,
      dryRun,
      compiled: resolved({ ...plan.item, tier: tier as ModelTier }, provider).compiled,
    }));
    print(changes, json);
    return { exitCode: 0 };
  }
  if (parsed.subcommand === 'migrate') {
    const plans: { item: Artifact; after: string; role: CanonicalModelPolicy['role'] }[] = [];
    for (const item of artifacts.filter(value => value.kind === 'skill' && value.legacyModel)) {
      const before = await fs.readFile(item.file, 'utf8');
      let after = replaceFrontmatter(before, item, normalizedTier(item.tier));
      const role = item.role ?? 'coding';
      if (!/^\s+modelRole:/m.test(after)) {
        after = after.replace(/^(\s+modelTier:.*)$/m, `  modelRole: ${role}\n$1`);
      }
      if (after === before) continue;
      plans.push({ item, after, role });
    }
    if (!dryRun) await Promise.all(plans.map(plan => atomicWrite(plan.item.file, plan.after)));
    const changes = plans.map(plan => ({
      artifact: plan.item.relative,
      kind: plan.item.kind,
      name: plan.item.name,
      relative: plan.item.relative,
      legacy: plan.item.legacyModel,
      role: plan.role,
      tier: normalizedTier(plan.item.tier),
      dryRun,
      compiled: resolved(plan.item, provider).compiled,
    }));
    print(changes, json);
    return { exitCode: 0 };
  }
  return { exitCode: 2, message: `Unknown models subcommand: ${parsed.subcommand}` };
}

export const modelsHandler: CommandHandler = {
  id: 'models',
  name: 'Models',
  description: 'Audit, resolve, validate, and safely update model policy',
  category: 'catalog',
  aliases: [],
  help: async () => ({ exitCode: 0, message: MODELS_HELP, rawOutput: true }),
  execute,
};

export function createModelsHandler(services: ModelsWorkerServices): CommandHandler {
  return { ...modelsHandler, execute: ctx => execute(ctx, services) };
}
