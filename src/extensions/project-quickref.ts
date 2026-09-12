/**
 * Canonical project quickref generation and provider-aware deployment.
 *
 * The committed source is `.aiwg/quickref.json`. Generated and provider
 * copies are expendable and carry ownership markers so stale copies can be
 * removed without touching operator-authored skills.
 */

import { createHash } from 'crypto';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import {
  getProviderDefinition,
  normalizeProviderDefinitionId,
} from '../providers/provider-definitions.js';
import { resolveHermesHome } from '../providers/hermes-home.js';
import { OPERATIONAL_SHOW_TYPES } from '../artifacts/types.js';
import { projectAiwgPath } from '../config/project-artifacts.js';
import { appendAiwgSourceTrackBlock } from './project-local-gitignore.js';
import { discoverProjectLocalBundles } from './project-local-discovery.js';
import { enumerateBundleArtifacts } from './shadow-resolver.js';

const OWNERSHIP_MARKER = '.aiwg-project-quickref.json';

const ShowHintSchema = z.object({
  type: z.enum(OPERATIONAL_SHOW_TYPES),
  name: z.string().min(1).max(128),
}).strict();

const QuickrefEntrySchema = z.object({
  title: z.string().min(1).max(128),
  summary: z.string().min(1).max(512),
  discover: z.array(z.string().min(1).max(256)).max(10).default([]),
  show: z.array(ShowHintSchema).max(20).default([]),
}).strict().refine(
  entry => entry.discover.length > 0 || entry.show.length > 0,
  { message: 'each entry must provide at least one discover or show hint' },
);

export const ProjectQuickrefSchema = z.object({
  version: z.literal('1'),
  project: z.object({
    id: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'must be kebab-case'),
    name: z.string().min(1).max(128),
    description: z.string().min(1).max(512),
  }).strict(),
  precedence: z.string().min(1).max(1024),
  entries: z.array(QuickrefEntrySchema).min(1).max(50),
}).strict();

export type ProjectQuickref = z.infer<typeof ProjectQuickrefSchema>;

const QuickrefOverrideSchema = z.object({
  title: z.string().min(1).max(128).optional(),
  summary: z.string().min(1).max(512).optional(),
  discover: z.array(z.string().min(1).max(256)).max(10).optional(),
  show: z.array(ShowHintSchema).max(20).optional(),
  hidden: z.boolean().optional(),
  order: z.number().int().optional(),
}).strict();

export const ProjectQuickrefConfigSchema = z.object({
  version: z.literal('1'),
  project: ProjectQuickrefSchema.shape.project.optional(),
  precedence: z.string().min(1).max(1024).optional(),
  entries: z.array(QuickrefEntrySchema).max(50).default([]),
  discovery: z.object({
    enabled: z.boolean().default(true),
    excludeBundles: z.array(z.string().min(1)).max(200).default([]),
    overrides: z.record(z.string(), QuickrefOverrideSchema).default({}),
  }).strict().default({ enabled: true, excludeBundles: [], overrides: {} }),
}).strict();

export type ProjectQuickrefConfig = z.infer<typeof ProjectQuickrefConfigSchema>;

export interface ProjectQuickrefResolution {
  definition?: ProjectQuickref;
  exists: boolean;
  sourcePath: string;
  provenance: 'legacy' | 'managed';
  warnings: string[];
}

export interface ProjectQuickrefLoadResult {
  sourcePath: string;
  definition?: ProjectQuickref;
  errors: string[];
  exists: boolean;
}

export interface ProjectQuickrefGenerateResult {
  sourcePath: string;
  outputPath: string;
  skillName: string;
  content: string;
  changed: boolean;
  dryRun: boolean;
  provenance: 'legacy' | 'managed';
  warnings: string[];
}

export interface ProjectQuickrefDeployResult {
  provider: string;
  targetPath: string;
  skillName: string;
  changed: boolean;
  pruned: string[];
  emulated: boolean;
  dryRun: boolean;
}

interface OwnershipMarker {
  version: 1;
  projectId: string;
  sourceProject: string;
  sourcePath: string;
  contentHash: string;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function readIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

export function projectQuickrefSkillName(projectId: string): string {
  return `aiwg-project-${projectId}-quickref`;
}

export async function loadProjectQuickref(projectDir: string): Promise<ProjectQuickrefLoadResult> {
  const sourcePath = projectAiwgPath(projectDir, 'quickref.json');
  let raw: string;
  try {
    raw = await readFile(sourcePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      sourcePath,
      errors: code === 'ENOENT' ? [] : [`${sourcePath}: ${(error as Error).message}`],
      exists: code !== 'ENOENT',
    };
  }

  try {
    const parsed = ProjectQuickrefSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return {
        sourcePath,
        exists: true,
        errors: parsed.error.issues.map(issue =>
          `${sourcePath}: ${issue.path.join('.') || '(root)'}: ${issue.message}`
        ),
      };
    }
    return { sourcePath, definition: parsed.data, errors: [], exists: true };
  } catch (error) {
    return { sourcePath, errors: [`${sourcePath}: invalid JSON: ${(error as Error).message}`], exists: true };
  }
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'project';
}

async function inferredProject(projectDir: string): Promise<ProjectQuickref['project']> {
  let packageName = basename(resolve(projectDir));
  let description = `Managed project-specific orientation for ${packageName}.`;
  try {
    const parsed = JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8')) as {
      name?: string;
      description?: string;
    };
    if (parsed.name) packageName = parsed.name;
    if (parsed.description) description = parsed.description.slice(0, 512);
  } catch {
    // package metadata is optional
  }
  const id = slug(packageName);
  const name = packageName
    .replace(/^@[^/]+\//, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => part[0]?.toUpperCase() + part.slice(1))
    .join(' ') || 'Project';
  return { id, name, description };
}

async function loadManagedConfig(projectDir: string): Promise<{
  config?: ProjectQuickrefConfig;
  path: string;
}> {
  const path = projectAiwgPath(projectDir, 'quickref.config.json');
  const raw = await readIfPresent(path);
  if (raw === null) return { path };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path}: invalid JSON: ${(error as Error).message}`);
  }
  const parsed = ProjectQuickrefConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map(issue =>
      `${path}: ${issue.path.join('.') || '(root)'}: ${issue.message}`
    ).join('\n'));
  }
  return { path, config: parsed.data };
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeShow(values: Array<{ type: typeof OPERATIONAL_SHOW_TYPES[number]; name: string }>): ProjectQuickref['entries'][number]['show'] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = `${value.type}:${value.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Resolve legacy operator input or synthesize a managed definition from project-local bundles. */
export async function resolveProjectQuickref(projectDir: string): Promise<ProjectQuickrefResolution> {
  const legacy = await loadProjectQuickref(projectDir);
  if (legacy.exists) {
    if (!legacy.definition) throw new Error(legacy.errors.join('\n'));
    return {
      definition: legacy.definition,
      exists: true,
      sourcePath: legacy.sourcePath,
      provenance: 'legacy',
      warnings: [],
    };
  }

  const managed = await loadManagedConfig(projectDir);
  const discovery = await discoverProjectLocalBundles(projectDir);
  if (discovery.errors.length > 0) {
    throw new Error(discovery.errors.map(error =>
      `${error.path}: ${error.field}: ${error.actual}`
    ).join('\n'));
  }
  if (!managed.config && discovery.bundles.length === 0) {
    return { exists: false, sourcePath: managed.path, provenance: 'managed', warnings: [] };
  }

  const config = managed.config ?? ProjectQuickrefConfigSchema.parse({ version: '1' });
  const excluded = new Set(config.discovery.excludeBundles.map(id => id.toLowerCase()));
  const warnings: string[] = [];
  const candidates: Array<{ order: number; type: string; id: string; entry: ProjectQuickref['entries'][number] }> = [];

  if (config.discovery.enabled) {
    for (const bundle of discovery.bundles) {
      if (excluded.has(bundle.id.toLowerCase())) continue;
      const override = config.discovery.overrides[bundle.id];
      if (override?.hidden) continue;
      const artifacts = (await enumerateBundleArtifacts(bundle.artifactPath ?? bundle.bundlePath))
        .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
      const inferredShow = dedupeShow(artifacts.map(artifact => ({
        type: artifact.type,
        name: artifact.id,
      }))).slice(0, 8);
      if (artifacts.length > inferredShow.length && inferredShow.length === 8) {
        warnings.push(`${bundle.id}: show hints truncated from ${artifacts.length} artifacts to 8`);
      }
      let discover = override?.discover ?? dedupe([
        bundle.id,
        bundle.manifest.name,
        ...(bundle.manifest.keywords ?? []),
      ]).slice(0, 3);
      const show = override?.show ? dedupeShow(override.show) : inferredShow;
      if (discover.length === 0 && show.length === 0) discover = [bundle.id];
      candidates.push({
        order: override?.order ?? 0,
        type: bundle.type,
        id: bundle.id,
        entry: {
          title: override?.title ?? bundle.manifest.name,
          summary: override?.summary ?? bundle.manifest.description,
          discover,
          show,
        },
      });
    }
  }

  candidates.sort((a, b) => a.order - b.order || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  const discoveredEntries = candidates.map(candidate => candidate.entry);
  const entries = [...discoveredEntries, ...config.entries];
  if (entries.length > 50) warnings.push(`quickref entries truncated from ${entries.length} to 50`);
  const bounded = entries.slice(0, 50);
  if (bounded.length === 0) {
    return { exists: false, sourcePath: managed.path, provenance: 'managed', warnings };
  }

  return {
    definition: {
      version: '1',
      project: config.project ?? await inferredProject(projectDir),
      precedence: config.precedence ?? 'Use project-local capabilities before generic AIWG workflows when they apply.',
      entries: bounded,
    },
    exists: true,
    sourcePath: managed.path,
    provenance: 'managed',
    warnings,
  };
}

export async function hasProjectQuickref(projectDir: string): Promise<boolean> {
  return (await resolveProjectQuickref(projectDir)).exists;
}

export function renderProjectQuickref(definition: ProjectQuickref): string {
  const skillName = projectQuickrefSkillName(definition.project.id);
  const lines = [
    '---',
    `name: ${skillName}`,
    `description: ${JSON.stringify(`Project-specific orientation for ${definition.project.name}`)}`,
    // AIWG generates and deploys this skill, so it must declare AIWG ownership.
    // Without it the collision scan treats every redeploy of AIWG's own artifact
    // as an unowned overwrite and warns permanently (#2504).
    'namespace: aiwg',
    'kernel: true',
    'platforms: [all]',
    '---',
    '',
    `# ${definition.project.name} Quick Reference`,
    '',
    definition.project.description,
    '',
    '## Precedence',
    '',
    definition.precedence,
    '',
  ];

  for (const entry of definition.entries) {
    lines.push(`## ${entry.title}`, '', entry.summary, '');
    for (const phrase of entry.discover) {
      lines.push(`- Discover: \`aiwg discover ${JSON.stringify(phrase)}\``);
    }
    for (const hint of entry.show) {
      lines.push(`- Fetch: \`aiwg show ${hint.type} ${hint.name}\``);
    }
    lines.push('');
  }

  lines.push(
    'The quickref is an orientation layer. Retrieve the indexed project asset before applying its full workflow.',
    '',
  );
  return lines.join('\n');
}

export async function generateProjectQuickref(
  projectDir: string,
  options: { dryRun?: boolean } = {},
): Promise<ProjectQuickrefGenerateResult> {
  const loaded = await resolveProjectQuickref(projectDir);
  if (!loaded.exists || !loaded.definition) throw new Error(`Project quickref source not found: ${loaded.sourcePath}`);

  if (!options.dryRun) await appendAiwgSourceTrackBlock(projectDir);

  const skillName = projectQuickrefSkillName(loaded.definition.project.id);
  const outputPath = projectAiwgPath(projectDir, 'generated', 'project-quickref', skillName, 'SKILL.md');
  const content = renderProjectQuickref(loaded.definition);
  const current = await readIfPresent(outputPath);
  const changed = current !== content;

  if (!options.dryRun && changed) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, 'utf8');
  }
  if (!options.dryRun && loaded.provenance === 'managed') {
    const snapshotPath = projectAiwgPath(projectDir, 'generated', 'project-quickref', 'definition.json');
    const snapshot = JSON.stringify(loaded.definition, null, 2) + '\n';
    if (await readIfPresent(snapshotPath) !== snapshot) {
      await mkdir(dirname(snapshotPath), { recursive: true });
      await writeFile(snapshotPath, snapshot, 'utf8');
    }
  }
  if (!options.dryRun) {
    const generatedRoot = projectAiwgPath(projectDir, 'generated', 'project-quickref');
    try {
      const entries = await readdir(generatedRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== skillName) {
          await rm(join(generatedRoot, entry.name), { recursive: true });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  return {
    sourcePath: loaded.sourcePath,
    outputPath,
    skillName,
    content,
    changed,
    dryRun: options.dryRun ?? false,
    provenance: loaded.provenance,
    warnings: loaded.warnings,
  };
}

function resolveProviderSkillsRoot(provider: string, projectDir: string, homeDir: string): {
  provider: string;
  root: string;
  emulated: boolean;
  global: boolean;
} {
  const normalized = normalizeProviderDefinitionId(provider);
  if (!normalized) throw new Error(`Unknown provider '${provider}'`);
  const definition = getProviderDefinition(normalized);
  if (!definition) throw new Error(`Provider definition unavailable for '${provider}'`);

  if (normalized === 'hermes') {
    return {
      provider: normalized,
      root: resolve(resolveHermesHome(homeDir), 'skills'),
      emulated: false,
      global: true,
    };
  }

  const configured = definition.paths.kernelSkills ?? definition.paths.artifacts.skills;
  if (!configured) throw new Error(`Provider '${normalized}' has no supported skill or aggregation target`);
  const expanded = configured === '~'
    ? homeDir
    : configured.startsWith('~/')
      ? join(homeDir, configured.slice(2))
      : configured;
  return {
    provider: normalized,
    root: isAbsolute(expanded) ? expanded : resolve(projectDir, expanded),
    emulated: definition.paths.kernelSkills === null,
    global: definition.paths.deployTarget === 'home' || configured.startsWith('~/'),
  };
}

async function readOwnershipMarker(skillDir: string): Promise<OwnershipMarker | null> {
  const raw = await readIfPresent(join(skillDir, OWNERSHIP_MARKER));
  if (!raw) return null;
  try {
    const marker = JSON.parse(raw) as OwnershipMarker;
    return marker.version === 1 ? marker : null;
  } catch {
    return null;
  }
}

async function findStaleOwnedQuickrefs(
  root: string,
  projectDir: string,
  keepName: string,
  global: boolean,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const stale: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepName) continue;
    const candidate = join(root, entry.name);
    const marker = await readOwnershipMarker(candidate);
    if (marker && (!global || marker.sourceProject === resolve(projectDir))) stale.push(candidate);
  }
  return stale;
}

export async function deployProjectQuickref(
  projectDir: string,
  provider: string,
  options: { dryRun?: boolean; homeDir?: string } = {},
): Promise<ProjectQuickrefDeployResult> {
  const generated = await generateProjectQuickref(projectDir, { dryRun: options.dryRun });
  const loaded = await resolveProjectQuickref(projectDir);
  if (!loaded.definition) throw new Error(`Project quickref source not found: ${loaded.sourcePath}`);
  const target = resolveProviderSkillsRoot(provider, projectDir, options.homeDir ?? homedir());
  const targetDir = join(target.root, generated.skillName);
  const targetPath = join(targetDir, 'SKILL.md');
  const existingMarker = await readOwnershipMarker(targetDir);
  try {
    await access(targetDir);
    if (!existingMarker) {
      throw new Error(`Refusing to replace operator-owned skill directory: ${targetDir}`);
    }
    if (existingMarker.projectId !== loaded.definition.project.id ||
        (target.global && existingMarker.sourceProject !== resolve(projectDir))) {
      throw new Error(
        `Project quickref collision at ${targetDir}; project id '${loaded.definition.project.id}' is already owned by ${existingMarker.sourceProject}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const marker: OwnershipMarker = {
    version: 1,
    projectId: loaded.definition.project.id,
    sourceProject: resolve(projectDir),
    sourcePath: loaded.sourcePath,
    contentHash: sha256(generated.content),
  };
  const markerContent = JSON.stringify(marker, null, 2) + '\n';
  const currentContent = await readIfPresent(targetPath);
  const currentMarker = await readIfPresent(join(targetDir, OWNERSHIP_MARKER));
  const changed = currentContent !== generated.content || currentMarker !== markerContent;
  const stale = await findStaleOwnedQuickrefs(target.root, projectDir, generated.skillName, target.global);

  if (!options.dryRun) {
    for (const stalePath of stale) await rm(stalePath, { recursive: true });
    if (changed) {
      await mkdir(targetDir, { recursive: true });
      await writeFile(targetPath, generated.content, 'utf8');
      await writeFile(join(targetDir, OWNERSHIP_MARKER), markerContent, 'utf8');
    }
  }

  return {
    provider: target.provider,
    targetPath,
    skillName: generated.skillName,
    changed,
    pruned: stale,
    emulated: target.emulated,
    dryRun: options.dryRun ?? false,
  };
}

export async function auditProjectQuickref(
  projectDir: string,
  providers: string[],
  options: { homeDir?: string } = {},
): Promise<{ exists: boolean; errors: string[]; drift: string[]; skillName?: string }> {
  let loaded: ProjectQuickrefResolution;
  try {
    loaded = await resolveProjectQuickref(projectDir);
  } catch (error) {
    return { exists: true, errors: [(error as Error).message], drift: [] };
  }
  if (!loaded.exists) return { exists: false, errors: [], drift: [] };
  if (!loaded.definition) return { exists: true, errors: ['project quickref definition unavailable'], drift: [] };

  const content = renderProjectQuickref(loaded.definition);
  const skillName = projectQuickrefSkillName(loaded.definition.project.id);
  const generatedPath = projectAiwgPath(projectDir, 'generated', 'project-quickref', skillName, 'SKILL.md');
  const drift: string[] = [];
  if (await readIfPresent(generatedPath) !== content) {
    drift.push(`generated quickref is missing or stale: ${generatedPath}`);
  }

  for (const provider of providers) {
    try {
      const target = resolveProviderSkillsRoot(provider, projectDir, options.homeDir ?? homedir());
      const deployed = join(target.root, skillName, 'SKILL.md');
      if (await readIfPresent(deployed) !== content) {
        drift.push(`${target.provider}: deployed quickref is missing or stale: ${deployed}`);
      }
    } catch (error) {
      drift.push(`${provider}: ${(error as Error).message}`);
    }
  }
  return { exists: true, errors: [], drift, skillName };
}

export function projectQuickrefSourcePath(projectDir: string): string {
  return projectAiwgPath(projectDir, 'quickref.json');
}
