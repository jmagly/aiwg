// Deploy the experimental Flue app target through shared skills and context owners.
import path from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';
import { collectFrameworkArtifacts, listSkillDirs, getAddonSkillDirs,
  isKernelSkill, normalizeDeploymentMode, withRuleDeployment } from './base.mjs';
import { deployFlueSkill } from './flue-skill-copy.mjs';
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
  const destination = path.join(target, kernelSkillsPath);
  for (const dir of skillDirs) deployFlueSkill(dir, destination, opts);
  return { kernel: skillDirs.length, standard: 0 };
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
    const invoked = listSkillDirs(path.join(staged.srcRoot, 'skills'));
    const skills = [...invoked, ...(mode === 'all' ? getAddonSkillDirs(staged.srcRoot) : []),
      ...collectFrameworkArtifacts(staged.srcRoot, mode, { includeAgents: false, includeCommands: false, includeSkills: true, includeRules: false }).skills];
    const count = deploySkills(mode === 'all' && !invoked.length ? skills.filter(isKernelSkill) : skills, staged.target, staged);
    await postDeploy(staged.target, staged);
    return count.kernel;
  });
}
const provider = { name, aliases, paths, kernelSkillsPath, capabilities, support, deploymentFiles,
  mapModel, getFileExtension, deployAgents, deployCommands, deployRules, deploySkills, postDeploy, deploy };
export default provider;
