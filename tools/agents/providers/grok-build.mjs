/**
 * Grok Build provider (experimental).
 * Project skills under `.grok/skills`; user home via $GROK_HOME (default ~/.grok).
 * Distinct from grokbot. No bare `grok` alias.
 *
 * Native agent compilation is deliberately limited to the three AIWG model
 * workers until the wider corpus has a qualified Grok tool mapping (#2577).
 * Rules remain indexed; Grok loads AGENTS.md and native .grok/rules itself.
 *
 * @issue #2575
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import {
  createAgentsMdFromTemplate,
  deploySkillsWithKernelRouting,
  collectFrameworkArtifacts,
  getAddonSkillDirs,
  injectPlatformInContent,
  isKernelSkill,
  normalizeDeploymentMode,
  resolveAiwgRoot,
  deployFiles,
  ensureDir,
} from './base.mjs';

export const name = 'grok-build';
export const aliases = [];
export const paths = {
  agents: '.grok/agents',
  skills: '.grok/skills',
  rules: '',
  hooks: '.grok/hooks',
  config: '.grok/config.toml',
};
export const kernelSkillsPath = '.grok/skills';
/** Standard-tier opt-in mirror (`--copy-all`) lives under the project .aiwg tree. */
export const standardSkillsPath = '.grok/.aiwg/skills';

export const support = {
  agents: 'native',
  commands: 'indexed', // discoverable through the AIWG index; no native command writer
  skills: 'native',
  rules: 'indexed', // deferred native writer until #2577; host still loads AGENTS.md + .grok/rules hierarchically
};

export const capabilities = {
  skills: true,
  rules: false, // indexed/deferred — do not claim native rule transforms yet
  yamlFormat: false,
  aggregatedOutput: false,
  homeDirectoryDeploy: true,
  parallelCommandAndSkillSurfaces: false,
};

const GROK_HOME_ENV = 'GROK_HOME';

export function resolveGrokHome(env = process.env, userHome = os.homedir()) {
  const raw = (env[GROK_HOME_ENV] || '').trim();
  const candidate = raw || path.join(userHome, '.grok');
  if (candidate === '~') return null;
  let expanded = candidate;
  if (candidate.startsWith('~/')) expanded = path.join(userHome, candidate.slice(2));
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  if (!resolved || path.parse(resolved).root === resolved) return null;
  return resolved;
}

export function createAgentsMd(target, srcRoot, dryRun) {
  assertSafeAgentsMd(target);
  createAgentsMdFromTemplate(
    target,
    resolveAiwgRoot(srcRoot) || srcRoot,
    'grok-build/AGENTS.md.aiwg-template',
    dryRun,
  );
}

function assertSafeAgentsMd(target) {
  const dest = path.join(target, 'AGENTS.md');
  const stat = existingStat(dest);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error(`Refusing unsafe Grok Build AGENTS.md target: ${dest}`);
  }
}

function existingStat(target) {
  try { return fs.lstatSync(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertSafeNativeDirectory(target, relative) {
  let current = path.resolve(target);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = existingStat(current);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing unsafe Grok Build deployment directory: ${current}`);
    }
  }
  return current;
}

/**
 * Kernel skills → `.grok/skills` (always).
 * Standard skills → index-driven by default; `.grok/.aiwg/skills` with `--copy-all`.
 */
export function deploySkills(skillDirs, targetDir, opts = {}) {
  const kernelDest = path.join(targetDir, kernelSkillsPath);
  const standardDest = path.join(targetDir, standardSkillsPath);
  assertSafeNativeDirectory(targetDir, kernelSkillsPath);
  assertSafeNativeDirectory(targetDir, standardSkillsPath);
  for (const source of skillDirs) {
    const relative = path.join(isKernelSkill(source) ? kernelSkillsPath : standardSkillsPath, path.basename(source));
    const dest = assertSafeNativeDirectory(targetDir, relative);
    if (fs.existsSync(dest)) regularFiles(dest);
  }
  return deploySkillsWithKernelRouting(skillDirs, standardDest, kernelDest, {
    ...opts,
    copyStandardSkills: opts.copyStandardSkills === true,
  });
}

const WORKER_ROLES = new Set(['reasoning', 'coding', 'efficiency']);
const ROLE_FROM_ALIAS = { opus: 'reasoning', sonnet: 'coding', haiku: 'efficiency' };
const GROK_TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob']);

/** Grok agent files accept a small YAML frontmatter subset, not AIWG metadata. */
export function compileGrokAgent(source, content, opts = {}) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`${source}: expected YAML agent frontmatter`);
  const metadata = yaml.load(match[1]);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`${source}: invalid agent frontmatter`);
  }
  const name = metadata.name;
  const role = metadata['model-role'] || ROLE_FROM_ALIAS[metadata.model];
  if (!/^aiwg-model-(reasoning|coding|efficiency)-worker$/.test(String(name)) || !WORKER_ROLES.has(role)) {
    throw new Error(`${source}: Grok Build native compilation currently supports only the three AIWG model-worker roles; use aiwg show agent for other roles`);
  }
  if (typeof metadata.description !== 'string' || !metadata.description.trim()) {
    throw new Error(`${source}: agent description is required`);
  }
  const tools = metadata.tools;
  if (!Array.isArray(tools) || tools.some(tool => !GROK_TOOLS.has(tool))) {
    throw new Error(`${source}: unsupported Grok Build tool mapping; supported tools: ${[...GROK_TOOLS].join(', ')}`);
  }
  const sourceModel = String(metadata.model || '').trim();
  if (sourceModel && !ROLE_FROM_ALIAS[sourceModel] && sourceModel !== 'inherit') {
    throw new Error(`${source}: exact model pin '${sourceModel}' is not a qualified Grok Build selector; configure --${role}-model with a discovered Grok model`);
  }
  const configuredModel = opts[`${role}Model`] || opts.modelsConfig?.['grok-build']?.[role]?.model;
  if (configuredModel && (typeof configuredModel !== 'string' || /^(configured\/|inherit$)/.test(configuredModel))) {
    throw new Error(`${source}: unresolved Grok Build ${role} model; configure --${role}-model with a discovered selector`);
  }
  const header = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(metadata.description)}`,
    `tools: ${tools.join(', ')}`,
    ...(configuredModel ? [`model: ${JSON.stringify(configuredModel)}`] : []),
    '---',
  ];
  const intent = configuredModel
    ? `AIWG model role: ${role}; exact Grok Build selector: ${configuredModel}.`
    : `AIWG model role: ${role}; no exact Grok Build model is configured. This agent inherits the parent model. Configure --${role}-model after native model discovery to pin this role.`;
  return `${header.join('\n')}\n\n${intent}\n\n${match[2].trim()}\n`;
}

export function deployAgents(agentFiles, targetDir, opts = {}) {
  const selected = agentFiles.filter(file => /^aiwg-model-(reasoning|coding|efficiency)-worker\.md$/.test(path.basename(file)));
  const dir = assertSafeNativeDirectory(targetDir, paths.agents);
  for (const source of selected) {
    const dest = path.join(dir, path.basename(source));
    const stat = existingStat(dest);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing unsafe Grok Build agent target: ${dest}`);
  }
  const manifest = path.join(dir, '.aiwg-manifest.json');
  const manifestStat = existingStat(manifest);
  if (manifestStat && (!manifestStat.isFile() || manifestStat.isSymbolicLink())) {
    throw new Error(`Refusing unsafe Grok Build agent manifest: ${manifest}`);
  }
  ensureDir(dir, opts.dryRun);
  return deployFiles(selected, dir, { ...opts, provider: 'grok-build' }, compileGrokAgent);
}

export function deployRules() {
  return 0;
}

function regularFiles(dir, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('symlink in managed Grok Build artifact');
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(`${relative}${path.sep}`);
      files.push(...regularFiles(path.join(dir, entry.name), relative));
    }
    else if (entry.isFile()) files.push(relative);
    else throw new Error('special file in managed Grok Build artifact');
  }
  return files.sort();
}

function matchesSkillSource(source, target) {
  try {
    const expected = regularFiles(source);
    const actual = regularFiles(target).filter(name => name !== '.aiwg-managed');
    if (JSON.stringify(expected) !== JSON.stringify(actual)) return false;
    return expected.every(relative => {
      if (relative.endsWith(path.sep)) return true;
      let content = fs.readFileSync(path.join(source, relative), 'utf8');
      if (relative === 'SKILL.md') content = injectPlatformInContent(content, 'grok-build');
      return content === fs.readFileSync(path.join(target, relative), 'utf8');
    });
  } catch { return false; }
}

/** Remove only unchanged AIWG Grok artifacts; shared context files stay intact. */
export function uninstall(target, opts = {}) {
  const root = path.resolve(target);
  const native = path.join(root, '.grok');
  if (!fs.existsSync(native)) return { planned: [], removed: [], skipped: [] };
  if (fs.lstatSync(native).isSymbolicLink()) throw new Error('Refusing symlinked Grok Build root');
  const internal = path.join(native, '.aiwg');
  if (fs.existsSync(internal) && fs.lstatSync(internal).isSymbolicLink()) throw new Error('Refusing symlinked Grok Build AIWG mirror');
  const sourceRoot = resolveAiwgRoot(opts.srcRoot) || opts.srcRoot;
  if (!sourceRoot) throw new Error('AIWG source is required for safe Grok Build removal');
  const sources = [
    ...getAddonSkillDirs(sourceRoot),
    ...collectFrameworkArtifacts(sourceRoot, 'all', {
      includeAgents: false, includeCommands: false, includeSkills: true, includeRules: false,
    }).skills,
  ];
  const byName = new Map();
  for (const source of sources) {
    const name = path.basename(source);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(source);
  }
  const planned = [];
  const skipped = [];
  for (const skillRoot of [path.join(native, 'skills'), path.join(native, '.aiwg', 'skills')]) {
    if (!fs.existsSync(skillRoot)) continue;
    if (fs.lstatSync(skillRoot).isSymbolicLink()) throw new Error('Refusing symlinked Grok Build skill root');
    for (const entry of fs.readdirSync(skillRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const skill = path.join(skillRoot, entry.name);
      const marker = path.join(skill, '.aiwg-managed');
      if (!fs.existsSync(marker)) continue;
      const relative = path.relative(root, skill);
      if (fs.lstatSync(marker).isSymbolicLink() || fs.readFileSync(marker, 'utf8') !== 'aiwg\n') {
        skipped.push(relative); continue;
      }
      if ((byName.get(entry.name) ?? []).some(source => matchesSkillSource(source, skill))) {
        planned.push(relative);
      } else skipped.push(relative);
    }
  }
  const agentsDir = path.join(native, 'agents');
  const manifestPath = path.join(agentsDir, '.aiwg-manifest.json');
  let manifest;
  if (fs.existsSync(manifestPath)) {
    if (fs.lstatSync(agentsDir).isSymbolicLink() || fs.lstatSync(manifestPath).isSymbolicLink()) {
      throw new Error('Refusing symlinked Grok Build agent manifest');
    }
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const [name, record] of Object.entries(manifest.managed ?? {})) {
      if (path.basename(name) !== name || !/^aiwg-model-(reasoning|coding|efficiency)-worker\.md$/.test(name)) continue;
      const file = path.join(agentsDir, name);
      const relative = path.relative(root, file);
      if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile()) {
        skipped.push(relative); continue;
      }
      const digest = `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
      if (record?.source === 'bundled' && record.hash === digest) planned.push(relative);
      else skipped.push(relative);
    }
  }
  const removed = [];
  if (!opts.dryRun) {
    for (const relative of planned) {
      const file = path.join(root, relative);
      if (relative.includes(`${path.sep}skills${path.sep}`)) {
        const marker = path.join(file, '.aiwg-managed');
        if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== 'aiwg\n'
          || !(byName.get(path.basename(file)) ?? []).some(source => matchesSkillSource(source, file))) {
          skipped.push(relative); continue;
        }
        fs.rmSync(file, { recursive: true });
      } else {
        const name = path.basename(file);
        const record = manifest?.managed?.[name];
        const digest = fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink()
          ? `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}` : '';
        if (!record || digest !== record.hash) { skipped.push(relative); continue; }
        fs.unlinkSync(file);
        delete manifest.managed[name];
      }
      removed.push(relative);
    }
    if (manifest && removed.some(relative => relative.startsWith(`.grok${path.sep}agents${path.sep}`))) {
      if (Object.keys(manifest.managed).length === 0) fs.unlinkSync(manifestPath);
      else {
        const temporary = `${manifestPath}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, manifestPath);
      }
    }
  }
  return { planned, removed, skipped: [...new Set(skipped)] };
}

export async function postDeploy(target, opts = {}) {
  if (opts.createAgentsMd || (!opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly)) {
    createAgentsMd(target, opts.srcRoot, opts.dryRun);
  }
  if (!opts.quiet) {
    const home = resolveGrokHome(opts.env || process.env);
    console.log(
      `Grok Build (experimental): kernel skills → ${kernelSkillsPath}; ` +
        `standard skills index-driven (opt-in mirror → ${standardSkillsPath} with --copy-all); ` +
        `model-worker agents → ${paths.agents}; rules indexed; user home → ${home || '(unresolved GROK_HOME)'}. ` +
        'Distinct from grokbot.',
    );
  }
}

export function getFileExtension() {
  return '.md';
}

export async function deploy(opts) {
  const mode = normalizeDeploymentMode(opts.mode);
  if (opts.createAgentsMd || (!opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly)) {
    assertSafeAgentsMd(opts.target);
  }
  const aiwgRoot = resolveAiwgRoot(opts.srcRoot) || opts.srcRoot;
  const skillDirs = [...getAddonSkillDirs(opts.srcRoot)];
  skillDirs.push(
    ...collectFrameworkArtifacts(opts.srcRoot, mode, {
      includeAgents: false,
      includeCommands: false,
      includeSkills: true,
      includeRules: false,
    }).skills,
  );
  let count = 0;
  if (!opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly) {
    const workerDir = path.join(aiwgRoot, 'agentic', 'code', 'addons', 'aiwg-utils', 'agents');
    const workers = ['reasoning', 'coding', 'efficiency']
      .map(role => path.join(workerDir, `aiwg-model-${role}-worker.md`))
      .filter(file => fs.existsSync(file));
    count += deployAgents(workers, opts.target, opts).filter(action => action.type === 'deploy').length;
  }
  if (!opts.commandsOnly && !opts.rulesOnly) {
    const result = deploySkills(skillDirs, opts.target, opts);
    count += (result?.kernel ?? 0) + (result?.standardCopied ?? 0);
  }
  await postDeploy(opts.target, opts);
  return count;
}

export default {
  name,
  aliases,
  paths,
  kernelSkillsPath,
  standardSkillsPath,
  support,
  capabilities,
  resolveGrokHome,
  createAgentsMd,
  deploySkills,
  deployAgents,
  compileGrokAgent,
  deployRules,
  postDeploy,
  getFileExtension,
  deploy,
  uninstall,
};
