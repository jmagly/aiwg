// Deploy the experimental Flue app target through shared skills and context owners.
import path from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';
import { collectFrameworkArtifacts, deploySkillsWithKernelRouting, getAddonSkillDirs,
  isKernelSkill, normalizeDeploymentMode, withRuleDeployment } from './base.mjs';
import { flueDeploymentFiles, deployFlueDatabase } from './flue-project.mjs';
import { deployFlueSpecialists } from './flue-specialists.mjs';
export { FLUE_SPECIALISTS } from './flue-specialists.mjs';
const { generate } = await importImpl(import.meta.url, 'smiths/context-pipeline/generator.js');

export const name = 'flue';
export const aliases = [];
export const paths = { agents: '', commands: '', skills: '.agents/skills', rules: '.agents/.aiwg/rules' };
export const kernelSkillsPath = '.agents/skills';
export const capabilities = { skills: true, rules: false, aggregatedOutput: false, homeDirectoryDeploy: false };
export const support = { agents: 'indexed', commands: 'indexed', skills: 'native', rules: 'context' };
export const deploymentFiles = flueDeploymentFiles;
export const mapModel = value => value;
export const getFileExtension = () => '.md';
export const deployAgents = () => 0;
export const deployCommands = () => 0;
export const deployRules = () => 0;

export function deploySkills(skillDirs, target, opts) {
  // Flue has no legacy bulk mirror. Limit cleanup to its selected kernel set
  // so another provider's mirrors and operator standard skills stay untouched.
  return deploySkillsWithKernelRouting(skillDirs.filter(isKernelSkill), null,
    path.join(target, kernelSkillsPath), { ...opts, copyStandardSkills: false });
}

export async function postDeploy(target, opts) {
  deployFlueDatabase(target, opts);
  deployFlueSpecialists(target, opts);
  if (opts.contextFiles !== false) await generate({ provider: name, projectPath: target, sections: [], detectExistingFiles: true });
}

export async function deploy(opts) {
  if (opts.userScope) throw new Error('Flue (experimental) supports project scope only.');
  return withRuleDeployment({ ...opts, provider: name }, provider, async staged => {
    const mode = normalizeDeploymentMode(staged.mode);
    const skills = [...getAddonSkillDirs(staged.srcRoot),
      ...collectFrameworkArtifacts(staged.srcRoot, mode, { includeAgents: false, includeCommands: false, includeSkills: true, includeRules: false }).skills];
    const count = deploySkills(skills, staged.target, staged);
    await postDeploy(staged.target, staged);
    return count.kernel;
  });
}
const provider = { name, aliases, paths, kernelSkillsPath, capabilities, support, deploymentFiles,
  mapModel, getFileExtension, deployAgents, deployCommands, deployRules, deploySkills, postDeploy, deploy };
export default provider;
