// Deploy portable Markdown artifacts through the shared rule and skill lifecycle.
import path from 'node:path';
import {
  collectFrameworkArtifacts,
  deployFiles,
  deploySkillsWithKernelRouting,
  ensureDir,
  getAddonAgentFiles,
  getAddonCommandFiles,
  getAddonSkillDirs,
  normalizeDeploymentMode,
  withRuleDeployment,
} from './base.mjs';

export const name = 'generic';
export const aliases = [];
export const paths = { agents: 'agents', commands: 'commands', skills: 'skills', rules: 'rules' };
export const kernelSkillsPath = '.agents/skills';
// Portable files need an explicit host loader; no native harness features are claimed.
export const support = { agents: 'context', commands: 'context', skills: 'context', rules: 'context' };
export const capabilities = { skills: true, rules: true, aggregatedOutput: false, yamlFormat: false, homeDirectoryDeploy: false };
export const mapModel = model => model;
export const transformAgent = (_file, content) => content;
export const transformCommand = (_file, content) => content;
export const getFileExtension = () => '.md';

function deployMarkdown(files, target, directory, opts) {
  const destination = path.join(target, directory);
  ensureDir(destination, opts.dryRun);
  return deployFiles(files, destination, opts).filter(action => action.type === 'deploy').length;
}
export const deployAgents = (files, target, opts) => deployMarkdown(files, target, paths.agents, opts);
export const deployCommands = (files, target, opts) => deployMarkdown(files, target, paths.commands, opts);
// Activation-selected rules and the bootstrap are projected by withRuleDeployment.
export const deployRules = () => 0;

export function deploySkills(dirs, target, opts) {
  return deploySkillsWithKernelRouting(dirs, path.join(target, paths.skills),
    path.join(target, kernelSkillsPath), opts);
}

export async function deploy(opts) {
  return withRuleDeployment(opts, { name, paths, kernelSkillsPath }, deploySelected);
}

async function deploySelected(opts) {
  const mode = normalizeDeploymentMode(opts.mode);
  const commands = (opts.deployCommands || opts.commandsOnly) && !opts.skillsOnly && !opts.rulesOnly;
  const skills = (opts.deploySkills || opts.skillsOnly) && !opts.commandsOnly && !opts.rulesOnly;
  const agents = !opts.commandsOnly && !opts.skillsOnly && !opts.rulesOnly;
  const selected = collectFrameworkArtifacts(opts.srcRoot, mode, {
    includeAgents: agents, includeCommands: commands, includeSkills: skills, includeRules: false,
  });
  if (['general', 'sdlc', 'both', 'all'].includes(mode)) {
    if (agents) selected.agents.push(...getAddonAgentFiles(opts.srcRoot));
    if (commands) selected.commands.push(...getAddonCommandFiles(opts.srcRoot));
    if (skills) selected.skills.push(...getAddonSkillDirs(opts.srcRoot));
  }
  if (agents) deployAgents(selected.agents, opts.target, opts);
  if (commands) deployCommands(selected.commands, opts.target, opts);
  if (skills) deploySkills([...new Set(selected.skills)], opts.target, opts);
  if (!opts.quiet) console.log('Generic: configure your host to read AGENTS.md; automatic loading and prompt hooks are host dependent.');
}

export default { name, aliases, paths, kernelSkillsPath, support, capabilities, mapModel,
  transformAgent, transformCommand, getFileExtension, deployAgents, deployCommands, deploySkills, deployRules, deploy };
