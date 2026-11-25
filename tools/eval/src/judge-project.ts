// Set up native judge projects and serialize their single qualified staging workspace.
import { mkdir, readFile, writeFile, realpath, open, unlink, readdir, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { validateWorkerGroupReferences } from '../../../src/config/aiwg-config.js';
import { DEFAULT_WORKER_SELECTION, WorkerSelectionPolicySchema } from '../../../src/models/worker-selection-policy.js';
import { validateEvalContract } from './contracts.js';
import type { CollectOptions, JudgeConfiguration } from './judge-types.js';

const stagingName = '.judge-attempts';
export class JudgeProjectIsolationError extends Error {}
const beneath = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
async function canonicalFuture(target: string): Promise<string> {
  try { return await realpath(target); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(await canonicalFuture(path.dirname(target)), path.basename(target));
  }
}
function validateProject(config: any, models: any, judges: JudgeConfiguration[]) {
  const policy = WorkerSelectionPolicySchema.parse(models.defaults?.workerSelection ?? {});
  const errors = validateWorkerGroupReferences(config.parallelism ?? {}, policy);
  if (config.parallelism?.worker_dispatch !== true) errors.push('Judge project requires parallelism.worker_dispatch: true');
  const tasks = { ...DEFAULT_WORKER_SELECTION.taskClasses, ...policy.taskClasses };
  for (const judge of judges) {
    validateEvalContract('JudgeConfiguration', judge);
    if (judge.transport !== 'cli') continue;
    const task = judge.task ?? 'inventory';
    if (!Object.hasOwn(tasks, task) || tasks[task] !== judge.role) errors.push(`Judge ${judge.id}: unknown task class or conflicting role: ${task}/${judge.role}`);
    const guidance = judge.role && policy.roleGuidance?.[judge.role];
    if (!judge.group || !config.parallelism?.groups?.[judge.group] || !guidance || !guidance.groups.includes(judge.group)) {
      errors.push(`Judge ${judge.id}: declare its group and models.json role guidance in the judge project`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
}
export async function setupJudgeProject(project: string, configFile: string, modelsFile: string, judges: JudgeConfiguration[]) {
  const configText = await readFile(configFile, 'utf8'), modelsText = await readFile(modelsFile, 'utf8');
  validateProject(JSON.parse(configText), JSON.parse(modelsText), judges);
  // A fresh destination prevents overwriting a qualified project or mixing in task data.
  await mkdir(project, { mode: 0o700 });
  await mkdir(path.join(project, '.aiwg'));
  await writeFile(path.join(project, '.aiwg/aiwg.config'), configText, { flag: 'wx' });
  await writeFile(path.join(project, 'models.json'), modelsText, { flag: 'wx' });
}
export async function prepareJudgeProject(options: CollectOptions): Promise<CollectOptions> {
  if (!options.evaluators.some(j => j.transport === 'cli')) return options;
  if (!options.judgeProject) throw new Error('--judge-project is required for CLI judges; run judge-setup, then qualify from that project');
  const project = await realpath(path.resolve(options.judgeProject));
  const archive = await canonicalFuture(path.resolve(options.runDir));
  if (beneath(project, archive) || beneath(archive, project)) throw new Error('Judge archive and judge project must be separate, non-nested directories');
  validateProject(JSON.parse(await readFile(path.join(project, '.aiwg/aiwg.config'), 'utf8')),
    JSON.parse(await readFile(path.join(project, 'models.json'), 'utf8')), options.evaluators);
  return { ...options, judgeProject: project, runDir: archive };
}
export async function lockJudgeProject(project?: string) {
  if (!project) return async () => {};
  const filename = path.join(project, '.judge-collector.lock');
  const lock = await open(filename, 'wx');
  const release = async () => { await lock.close(); await unlink(filename); };
  try {
    const entries = await readdir(path.join(project, stagingName)).catch((error: any) => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    });
    if (entries.length) throw new Error('Judge project has an interrupted staged attempt; reconcile and remove .judge-attempts before resuming');
    return release;
  } catch (error) { await release(); throw error; }
}
export async function stageJudgeAttempt(project: string, archive: string) {
  const directory = path.join(project, stagingName, path.basename(archive));
  await mkdir(path.dirname(directory), { recursive: true });
  if ((await readdir(path.dirname(directory))).length) throw new JudgeProjectIsolationError('Previous judge attempt still staged; reconcile before resuming');
  await mkdir(directory);
  return { directory, archive: async () => {
    // Keep all resolver/adapter artifacts, then remove every prior output from the qualified workspace.
    try {
      await cp(directory, archive, { recursive: true });
      await rm(directory, { recursive: true });
    } catch (cause) { throw new JudgeProjectIsolationError('Could not archive and remove staged judge output; reconcile before resuming', { cause }); }
  } };
}
