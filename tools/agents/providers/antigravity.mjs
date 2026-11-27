import { deployAntigravityPromptDiscovery } from './antigravity-prompt-discovery.mjs';
import { withModelWrapper } from './model-wrapper.mjs';
/** Google Antigravity CLI project resource deployment, qualified against 1.1.26. */
import fs from 'node:fs';
import path from 'node:path';
import {
  withRuleDeployment,
  collectFrameworkArtifacts,
  createAgentsMdFromTemplate,
  deployFiles,
  deploySkillsWithKernelRouting,
  ensureDir,
  getAddonAgentFiles,
  getAddonSkillDirs,
  listMdFiles,
  listSkillDirs,
  normalizeDeploymentMode,
  resolveAiwgRoot,
} from './base.mjs';
export const name = 'antigravity';
export const aliases = ['agy'];
export const paths = { agents: '.agents/agents', commands: '', skills: '.agents/skills', rules: '.antigravity/rules' };
export const kernelSkillsPath = '.agents/skills';
export const support = { agents: 'degraded', commands: 'indexed', skills: 'native', rules: 'context' };
export const capabilities = {
  skills: true,
  rules: false,
  yamlFormat: true,
  aggregatedOutput: false,
  homeDirectoryDeploy: false,
  parallelCommandAndSkillSurfaces: false,
};
export const mapModel = model => model;
const ANTIGRAVITY_TOOL_MAP = new Map([
  ['Read', 'view_file'],
  ['Write', 'write_to_file'],
  ['Edit', 'replace_file_content'],
  ['Grep', 'grep_search'],
  ['Bash', 'run_command'],
]);
function mapTools(value) {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(tool => ANTIGRAVITY_TOOL_MAP.get(tool.trim()))
    .filter(Boolean);
}

export const transformAgent = withModelWrapper('antigravity', translateAgent);
function translateAgent(_source, content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return content;
  const frontmatter = match[1];
  const body = match[2].trim();
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  const tools = mapTools(frontmatter.match(/^tools:\s*(.+)$/m)?.[1]?.trim());
  return [
    '---',
    ...(name ? [`name: ${name}`] : []),
    ...(description ? [`description: ${description}`] : []),
    ...(tools.length ? ['tools:', ...tools.map(tool => `  - ${tool}`)] : []),
    '---',
    '',
    body,
    '',
  ].join('\n');
}

export function deployAgents(files, target, opts = {}) {
  const destination = path.join(target, paths.agents);
  ensureDir(destination, opts.dryRun);
  return deployFiles(files, destination, { ...opts, provider: name }, transformAgent);
}

export function deploySkills(dirs, target, opts = {}) {
  return deploySkillsWithKernelRouting(
    dirs,
    path.join(target, '.agents/.aiwg/skills'),
    path.join(target, kernelSkillsPath),
    { ...opts, provider: name, copyStandardSkills: opts.copyStandardSkills === true },
  );
}

export function deployCommands() { return 0; }
export function deployRules() { return 0; }

export function createAgentsMd(target, srcRoot, dryRun) {
  const root = resolveAiwgRoot(srcRoot) || srcRoot;
  createAgentsMdFromTemplate(target, root, 'antigravity/AGENTS.md.aiwg-template', dryRun);
}

export async function postDeploy(target, opts) {
  if (opts.global || opts.user || opts.scope === 'user') {
    throw new Error('Antigravity global skill deployment is disabled: official 1.1.26 path documentation conflicts');
  }
  await deployAntigravityPromptDiscovery(target, opts);
  if (opts.createAgentsMd || (!opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly)) {
    if (opts.contextFiles !== false) createAgentsMd(target, opts.srcRoot, opts.dryRun);
  }
  if (!opts.quiet) {
    console.log('Antigravity resources are project scoped. Restart agy after resource changes; authenticate with the provider separately.');
  }
}

export function getFileExtension() { return '.md'; }

export async function deploy(opts) {
  return withRuleDeployment(opts, { name, paths, kernelSkillsPath }, deploySelected);
}

async function deploySelected(opts) {
  if (opts.global || opts.user || opts.scope === 'user') {
    throw new Error('Antigravity global skill deployment is disabled: official 1.1.26 path documentation conflicts');
  }
  const mode = normalizeDeploymentMode(opts.mode);
  const agents = [];
  const skills = [];
  const directSource = ['agents', 'skills'].some(type => fs.existsSync(path.join(opts.srcRoot, type)));
  if (directSource) {
    agents.push(...listMdFiles(path.join(opts.srcRoot, 'agents')));
    if (opts.deploySkills || opts.skillsOnly) skills.push(...listSkillDirs(path.join(opts.srcRoot, 'skills')));
  } else if (['general', 'sdlc', 'both', 'all'].includes(mode)) {
    agents.push(...getAddonAgentFiles(opts.srcRoot));
    if (opts.deploySkills || opts.skillsOnly) skills.push(...getAddonSkillDirs(opts.srcRoot));
  }
  const framework = directSource ? { agents: [], skills: [] } : collectFrameworkArtifacts(opts.srcRoot, mode, {
    includeAgents: true,
    includeCommands: false,
    includeSkills: opts.deploySkills || opts.skillsOnly,
    includeRules: false,
  });
  agents.push(...framework.agents);
  skills.push(...framework.skills);
  let count = 0;
  if (!opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly) {
    count += deployAgents(agents, opts.target, opts).filter(action => action.type === 'deploy').length;
  }
  if ((opts.deploySkills || opts.skillsOnly) && !opts.commandsOnly && !opts.rulesOnly) {
    const result = deploySkills(skills, opts.target, opts);
    count += result.kernel + result.standardCopied;
  }
  await postDeploy(opts.target, opts);
  return count;
}

export default {
  name, aliases, paths, kernelSkillsPath, support, capabilities, mapModel,
  transformAgent, deployAgents, deploySkills, deployCommands, deployRules,
  createAgentsMd, postDeploy, getFileExtension, deploy,
};
