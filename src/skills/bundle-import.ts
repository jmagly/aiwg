// Import repositories into existing project-local addons and refresh pinned provenance.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectAiwgPath } from '../config/project-artifacts.js';
import { BundleManifestSchema, MANIFEST_MAX_BYTES, type BundleManifest } from '../extensions/manifest.js';
import { discoverProjectLocalBundles } from '../extensions/project-local-discovery.js';
import { buildUpstreamRegistry } from '../extensions/upstream-registry.js';
import { resolveFrameworkIndexRoot } from '../artifacts/framework-index-paths.js';
import { loadGraphIndexFile } from '../artifacts/index-reader.js';
import type { ArtifactIndex } from '../artifacts/types.js';
import { buildIndex } from '../artifacts/index-builder.js';
import { syncFortemiCoreIndex } from '../artifacts/fortemi-core-sync.js';
import { discoverLocalSkillOwners } from './collision-discovery.js';
import { planRepository, repositoryKey, type BundleImportDiagnostic } from './bundle-import-plan.js';

export interface BundleImportPlan {
  bundlePath: string;
  manifest: BundleManifest;
  installed: false;
  dryRun: boolean;
  diagnostics: BundleImportDiagnostic[];
  diff: { added: string[]; modified: string[]; removed: string[] };
}
export interface BundleImportOptions {
  source?: string;
  into?: string;
  refresh?: string;
  ref?: string;
  only?: string;
  dryRun?: boolean;
  projectDir: string;
  frameworkRoot?: string;
  /** Called after all preflight checks and before any project write. */
  report?: (plan: BundleImportPlan) => void;
}

function readTree(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (directory: string, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), `${file}/`);
      else if (entry.isFile()) files.set(file, fs.readFileSync(path.join(directory, entry.name)));
      else throw new Error(`Refusing non-regular addon path: ${file}`);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return files;
}

function assertSafeDestination(project: string, destination: string): void {
  // Existing ancestors must be real directories, never symlinks into another tree.
  const artifactRoot = projectAiwgPath(project);
  for (let current = destination; ; current = path.dirname(current)) {
    if (fs.existsSync(current) || (() => { try { fs.lstatSync(current); return true; } catch { return false; } })()) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe addon destination: ${current}`);
    }
    if (current === path.dirname(artifactRoot) || current === path.dirname(current)) break;
  }
}

async function occupiedNames(options: BundleImportOptions, destination: string): Promise<Set<string>> {
  const frameworkRoot = options.frameworkRoot ?? resolveFrameworkIndexRoot(options.projectDir);
  const registry = await buildUpstreamRegistry({ frameworkRoot });
  const names = new Set([...registry.byKey.values()].filter(item => item.type === 'skill').map(item => item.id));
  for (const skill of discoverLocalSkillOwners({ projectDir: options.projectDir })) names.add(skill.name);
  const discovery = await discoverProjectLocalBundles(options.projectDir);
  if (discovery.errors.length) throw new Error(`Project-local manifests require repair: ${discovery.errors.map(error => error.path).join(', ')}`);
  for (const bundle of discovery.bundles) {
    if (bundle.bundlePath === destination) continue;
    for (const name of bundle.manifest.skills ?? bundle.manifest.addonConfig?.skills ?? []) names.add(name);
    const root = path.join(bundle.bundlePath, bundle.manifest.addonConfig?.entry?.skills ?? 'skills');
    if (fs.existsSync(root)) for (const entry of fs.readdirSync(root)) names.add(entry);
  }
  for (const graph of ['framework', 'project'] as const) {
    const index = loadGraphIndexFile<ArtifactIndex>(options.projectDir, 'metadata.json', graph);
    for (const entry of Object.values(index?.entries ?? {})) {
      const ownPrefix = `.aiwg/addons/${path.basename(destination)}/`;
      if (entry.type !== 'skill' || entry.path.startsWith(ownPrefix) || entry.path.startsWith(`${destination}/`)) continue;
      names.add(entry.name ?? path.basename(path.dirname(entry.path)));
    }
  }
  return names;
}

function publish(destination: string, files: Map<string, Buffer>): void {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const stage = fs.mkdtempSync(path.join(parent, '.skill-import-'));
  const backup = `${stage}-backup-${randomUUID()}`;
  let moved = false;
  try {
    for (const [file, bytes] of files) {
      const target = path.join(stage, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    if (fs.existsSync(destination)) { fs.renameSync(destination, backup); moved = true; }
    try { fs.renameSync(stage, destination); }
    catch (error) { if (moved) fs.renameSync(backup, destination); throw error; }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
  }
}

export async function importSkillBundle(options: BundleImportOptions): Promise<BundleImportPlan> {
  const name = options.refresh ?? options.into;
  if (!name || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) || name.length > 64) throw new Error('A valid addon name is required');
  if (options.refresh ? options.source || options.into || options.only : !options.source) throw new Error('Use a repository with --into, or --refresh <addon> alone');
  const destination = projectAiwgPath(options.projectDir, 'addons', name);
  assertSafeDestination(options.projectDir, destination);
  const previous = readTree(destination);
  const rawManifest = previous.get('manifest.json');
  const manifest = BundleManifestSchema.parse(rawManifest ? JSON.parse(rawManifest.toString('utf8')) : {
    id: name, type: 'addon', name, description: `Imported community skills for ${name}`, version: '1.0.0',
    manifestVersion: '1', platforms: { claude: 'full' }, keywords: ['community', 'project-local'],
    deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
    skills: [], core: false, autoInstall: false, addonConfig: { entry: { skills: 'skills/' } }, upstream: [],
  });
  if (manifest.type !== 'addon' || manifest.id !== name) throw new Error('Import destination must be a matching project-local addon');
  if (manifest.addonConfig?.entry?.skills && manifest.addonConfig.entry.skills !== 'skills/') throw new Error('Import requires the canonical skills/ entry path');
  if (options.refresh && !manifest.upstream?.length) throw new Error('Refresh requires an addon with pinned upstreams');
  if (options.refresh && options.ref && manifest.upstream!.length !== 1) throw new Error('--ref on refresh requires exactly one upstream');
  const repo = options.source && (fs.existsSync(path.resolve(options.projectDir, options.source))
    ? fs.realpathSync(path.resolve(options.projectDir, options.source)) : options.source);
  if (repo && manifest.upstream?.some(upstream => upstream.repo === repo)) throw new Error('Repository already imported; use --refresh');
  const occupied = await occupiedNames(options, destination);
  const desired = new Map(previous);
  let skills = [...(manifest.skills ?? manifest.addonConfig?.skills ?? [])];
  if (options.refresh) {
    const owned = new Set(manifest.upstream!.flatMap(upstream => upstream.skills.map(skill => upstream.renames[skill] ?? skill)));
    for (const file of desired.keys()) {
      if (owned.has(file.split('/')[1]) && file.startsWith('skills/')
        || manifest.upstream!.some(upstream => file.startsWith(`licenses/${repositoryKey(upstream.repo)}/`))) desired.delete(file);
    }
    skills = skills.filter(skill => !owned.has(skill));
  }
  for (const skill of skills) occupied.add(skill);
  const sources = options.refresh ? manifest.upstream!.map(upstream => ({
    repo: upstream.repo, ref: options.ref ?? upstream.commit, pinned: upstream,
  })) : [{ repo: repo!, ref: options.ref ?? 'HEAD', pinned: undefined }];
  const diagnostics: BundleImportDiagnostic[] = [];
  const upstreams = options.refresh ? [] : [...(manifest.upstream ?? [])];
  for (const source of sources) {
    const result = planRepository({ ...source, only: options.only, occupied });
    for (const [file, bytes] of result.files) {
      if (desired.has(file)) throw new Error(`Refusing to overwrite an unmanaged addon file: ${file}`);
      desired.set(file, bytes);
    }
    diagnostics.push(...result.diagnostics);
    upstreams.push(result.upstream);
    skills.push(...result.upstream.skills.map(skill => result.upstream.renames[skill] ?? skill));
  }
  manifest.upstream = upstreams;
  manifest.skills = skills.sort();
  BundleManifestSchema.parse(manifest);
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  if (manifestBytes.length > MANIFEST_MAX_BYTES) throw new Error('Imported manifest exceeds 64 KB');
  desired.set('manifest.json', manifestBytes);
  const plan: BundleImportPlan = {
    bundlePath: destination, manifest, installed: false, dryRun: Boolean(options.dryRun), diagnostics,
    diff: {
      added: [...desired.keys()].filter(file => !previous.has(file)).sort(),
      modified: [...desired.keys()].filter(file => previous.has(file) && !desired.get(file)!.equals(previous.get(file)!)).sort(),
      removed: [...previous.keys()].filter(file => !desired.has(file)).sort(),
    },
  };
  options.report?.(plan);
  if (!options.dryRun) {
    publish(destination, desired);
    await buildIndex(options.projectDir, { graph: 'project', force: true, explicit: true, quiet: true });
    syncFortemiCoreIndex(options.projectDir, { graph: 'project' });
  }
  return plan;
}
