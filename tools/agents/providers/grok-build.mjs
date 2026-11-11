import { withModelWrapper } from './model-wrapper.mjs';
/**
 * Grok Build provider (experimental).
 * Project skills under `.grok/skills`; user home via $GROK_HOME (default ~/.grok).
 * Distinct from grokbot. No bare `grok` alias.
 *
 * Native agents use captured name/description frontmatter and a body prompt.
 * Grok 1.0.77 ignores model frontmatter; worker CLI -m controls model selection.
 * Rules are written to .grok/rules and loaded by Grok alongside AGENTS.md.
 *
 * @issue #2575
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import { importImpl } from '../../_resolve-impl.mjs';
const { GROK_BUILD_STANDARD_SKILLS_PATH } = await importImpl(import.meta.url, 'providers/grok-build-paths.js');
import {
  withRuleDeployment,
  replaceBoundRulesBlock,
  createAgentsMdFromTemplate,
  deploySkillsWithKernelRouting,
  collectFrameworkArtifacts,
  getAddonAgentFiles,
  filterAgentFiles,
  listMdFiles,
  toKebabCase,
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
  rules: '.grok/rules',
  hooks: '.grok/hooks',
  config: '.grok/config.toml',
};
export const kernelSkillsPath = '.grok/skills';
/** Standard-tier opt-in mirror (`--copy-all`) lives under the project .aiwg tree. */
export const standardSkillsPath = GROK_BUILD_STANDARD_SKILLS_PATH;

export const support = {
  agents: 'native',
  commands: 'indexed', // discoverable through the AIWG index; no native command writer
  skills: 'native',
  // CONTEXT_CONTRACTS: https://docs.x.ai/build/features/project-rules
  // .grok/rules/*.md loads hierarchically on every task; no frontmatter marker
  // is required for always-on rules (unlike Windsurf's trigger field).
  rules: 'native', // always-on Markdown rules discovered root-to-cwd by Grok Build
};

export const capabilities = {
  skills: true,
  rules: true, // Native Markdown; path activation uses the index
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

const ROLE_FROM_ALIAS = { opus: 'reasoning', sonnet: 'coding', haiku: 'efficiency' };

/** Grok agent files accept a small YAML frontmatter subset, not AIWG metadata. */
export const compileGrokAgent = withModelWrapper('grok-build', translateAgent);
function translateAgent(source, content, opts = {}) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`${source}: expected YAML agent frontmatter`);
  const metadata = yaml.load(match[1]);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`${source}: invalid agent frontmatter`);
  }
  const name = toKebabCase(metadata.name || path.basename(source, '.md'));
  const role = metadata['model-role'] || ROLE_FROM_ALIAS[metadata.model];
  if (typeof metadata.description !== 'string' || !metadata.description.trim()) {
    throw new Error(`${source}: agent description is required`);
  }
  // Portable tier aliases are intent. Exact pins cannot be honored in Grok agents.
  const sourceModel = String(metadata.model || '').trim();
  const configuredModel = metadata['model-override'] || opts[`${role}Model`]
    || opts.modelsConfig?.['grok-build']?.[role]?.model;
  if (configuredModel || (sourceModel && !ROLE_FROM_ALIAS[sourceModel] && sourceModel !== 'inherit')) {
    throw new Error(`${source}: exact model pin is unsupported in Grok Build agents: frontmatter model is ignored. Select a model with -m in the worker CLI invocation instead.`);
  }
  const header = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(metadata.description)}`,
    '---',
  ];
  const intent = [
    ...(role ? [`AIWG model role: ${role}.`] : []),
    ...(metadata['model-tier'] ? [`AIWG model tier intent: ${metadata['model-tier']}.`] : []),
    'Grok Build frontmatter model is ignored; this agent inherits the session model. Role and tier intent do not pin a model. Select the worker model with -m in the CLI invocation.',
  ].join(' ');
  return `${header.join('\n')}\n\n${intent}\n\n${match[2].trim()}\n`;
}

export function deployAgents(agentFiles, targetDir, opts = {}) {
  const selected = filterAgentFiles(agentFiles, opts);
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
    // The marker and the per-skill ownership receipt are AIWG bookkeeping,
    // not skill content, so neither makes a deployed skill look modified.
    const actual = regularFiles(target).filter(name => name !== '.aiwg-managed' && name !== '.aiwg-manifest.json');
    if (JSON.stringify(expected) !== JSON.stringify(actual)) return false;
    return expected.every(relative => {
      if (relative.endsWith(path.sep)) return true;
      let content = fs.readFileSync(path.join(source, relative), 'utf8');
      if (relative === 'SKILL.md') content = injectPlatformInContent(content, 'grok-build');
      const deployed = fs.readFileSync(path.join(target, relative), 'utf8');
      if (content === deployed) return true;
      if (relative !== 'SKILL.md' || !deployed.includes('<!-- AIWG:bound-rules:start -->')) return false;
      // Activation projection appends generated bindings. Verify the complete
      // deployed bytes against the receipt before comparing the authored body;
      // an operator edit (including inside the binding block) must survive.
      const receipt = JSON.parse(fs.readFileSync(path.join(target, '.aiwg-manifest.json'), 'utf8'));
      const digest = `sha256:${createHash('sha256').update(deployed).digest('hex')}`;
      return receipt.skillSource === path.resolve(source)
        && receipt.managed?.[relative]?.hash === digest
        && replaceBoundRulesBlock(content, []).trimEnd() === replaceBoundRulesBlock(deployed, []).trimEnd();
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
      if (path.basename(name) !== name || !name.endsWith('.md')) continue;
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
    if (opts.contextFiles !== false) createAgentsMd(target, opts.srcRoot, opts.dryRun);
  }
  if (!opts.quiet) {
    const home = resolveGrokHome(opts.env || process.env);
    console.log(
      `Grok Build (experimental): kernel skills → ${kernelSkillsPath}; ` +
        `standard skills index-driven (opt-in mirror → ${standardSkillsPath} with --copy-all); ` +
        `agents → ${paths.agents}; rules → ${paths.rules}; user home → ${home || '(unresolved GROK_HOME)'}. ` +
        'Distinct from grokbot.',
    );
  }
}

export function getFileExtension() {
  return '.md';
}

export async function deploy(opts) {
  return withRuleDeployment(opts, { name, paths, kernelSkillsPath }, deploySelected);
}

async function deploySelected(opts) {
  const mode = normalizeDeploymentMode(opts.mode);
  if (opts.createAgentsMd || (!opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly)) {
    assertSafeAgentsMd(opts.target);
  }
  const skillDirs = [...getAddonSkillDirs(opts.srcRoot)];
  const artifacts = collectFrameworkArtifacts(opts.srcRoot, mode, {
    includeAgents: true,
    includeCommands: false,
    includeSkills: true,
    includeRules: false,
  });
  skillDirs.push(...artifacts.skills);
  let count = 0;
  if (!opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly) {
    // Use the same frozen source root as skills/frameworks, including direct bundles.
    const agents = [...getAddonAgentFiles(opts.srcRoot), ...artifacts.agents,
      ...listMdFiles(path.join(opts.srcRoot, 'agents'))];
    count += deployAgents(agents, opts.target, opts).filter(action => action.type === 'deploy').length;
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
