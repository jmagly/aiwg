/**
 * Safe model-policy audit, resolution, and mutation commands.
 * @implements #1804
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { glob } from 'glob';
import { load as loadYaml } from 'js-yaml';
import {
  compileModelPolicy, validateCanonicalModelPolicy, validateUserProjectModelConfig,
  type ProviderModelCatalog,
} from '../../models/provider-policy.js';
import type { CanonicalModelPolicy, ModelTier } from '../../models/types.js';
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import type { DynamicModelCatalog } from '../../models/model-discovery.js';
import { resolveGrokBuildRoleModel } from '../../models/grok-build-models.js';

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
const TIERS = new Set(['economy', 'standard', 'premium', 'max-quality']);
const PROVIDERS = new Set([
  'antigravity', 'claude', 'codex', 'copilot', 'cursor', 'deepseek-harness', 'factory', 'grok-build', 'grokbot', 'hermes',
  'opencode', 'openclaw', 'openhuman', 'omp', 'pi', 'warp', 'windsurf',
]);

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
  return tier === 'max-quality' ? 'premium' : tier ?? 'standard';
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
async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  let mode = 0o600;
  try { mode = (await fs.stat(file)).mode; } catch { /* new file */ }
  await fs.writeFile(temporary, content, { encoding: 'utf8', mode });
  await fs.rename(temporary, file);
}
async function updateJson(file: string, mutate: (value: Record<string, any>) => void, dryRun: boolean) {
  let value: Record<string, any> = {};
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  mutate(value);
  const validation = validateUserProjectModelConfig(value);
  if (!validation.valid) throw new Error(validation.diagnostics.map(item => item.message).join('; '));
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (!dryRun) await atomicWrite(file, content);
  return { file, beforeWrite: value, dryRun };
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
async function execute(ctx: HandlerContext): Promise<HandlerResult> {
  const parsed = parseArgs(ctx.args);
  const json = parsed.flags.has('json');
  const dryRun = parsed.flags.has('dry-run') || ctx.dryRun === true;
  const target = path.resolve(flagString(parsed, 'target') ?? ctx.cwd);
  const provider = flagString(parsed, 'provider') ?? 'claude';
  if (!PROVIDERS.has(provider)) return { exitCode: 2, message: `Unknown provider: ${provider}` };
  if (parsed.subcommand === 'help' || parsed.flags.has('help')) {
    print('Usage: aiwg models <audit|list|resolve|sources|refresh|set-default|set|validate|migrate> [selectors] [--provider P] [--dry-run] [--json]', json);
    return { exitCode: 0 };
  }
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
  execute,
};
