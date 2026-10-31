// Retain per-provider deployment intent in the existing project ownership receipt.
import { writeContextFileSync } from '../../smiths/context-pipeline/context-file-safety.js';
import fs from 'node:fs';
import path from 'node:path';
import { readAiwgConfig, type AiwgConfig } from '../../config/aiwg-config.js';
import type { HandlerContext } from './types.js';
import { frameworkRegistryId } from '../../config/framework-aliases.js';

type History = Record<string, Record<string, { copy: boolean; produces?: string[]; reconciled?: boolean }>>;
const receiptPath = (project: string) => path.join(project, '.aiwg/.aiwg-manifest.json');
export function bundleDeploymentHistory(project: string): History {
  try { return JSON.parse(fs.readFileSync(receiptPath(project), 'utf8')).bundleDeployments ?? {}; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}
export function bundleCopyArgs(installed: AiwgConfig['installed'], id: string, provider: string): string[] {
  const entry = Object.entries(installed).find(([key]) => frameworkRegistryId(key) === frameworkRegistryId(id))?.[1];
  return [...(entry?.deployedTo[provider]?.copy === true ? ['--copy-all'] : []),
    ...(provider === 'flue' && entry?.deployedTo.flue?.package === true ? ['--package'] : [])];
}
export async function recordBundleDeployment(project: string, id: string, provider: string, args: string[], frameworkRoot?: string): Promise<void> {
  const { expectedBundleOwners } = await import('./bundle-reconciliation.js');
  const { getFrameworkRoot } = await import('../../channel/manager.mjs');
  const selected = { installed: { [id]: { deployedTo: { [provider]: {} } } } } as AiwgConfig;
  const produces = id === 'all' ? ['*'] : [...await expectedBundleOwners(selected, provider, frameworkRoot ?? await getFrameworkRoot())].sort();
  const file = receiptPath(project);
  const receipt = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { scope: 'project', managed: {} };
  receipt.bundleDeployments ??= {};
  receipt.bundleDeployments[provider] ??= {};
  receipt.bundleDeployments[provider][frameworkRegistryId(id)] = { copy: args.includes('--copy-all') || args.includes('--copy-standard-skills'), produces };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeContextFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
}
// Once index-mode removal completes, later additive passes own any new surface.
export function markBundleReconciled(project: string, id: string, provider: string): void {
  const file = receiptPath(project);
  if (!fs.existsSync(file)) return;
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!receipt.bundleDeployments?.[provider]?.[frameworkRegistryId(id)]) return;
  receipt.bundleDeployments[provider][frameworkRegistryId(id)].reconciled = true;
  writeContextFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
}

// Local/support bundles copy physically in index mode too; only operator flags prohibit cleanup.
export function copyCleanupArgs(args: string[]): string[] {
  return args.includes('--copy-all') || args.includes('--copy-standard-skills') ? [] : ['--index-mode'];
}

// Framework passes retain a separately declared local bundle's provider mode.
export async function projectLocalDeploymentContext(ctx: HandlerContext, project: string, id: string, provider: string, explicit: boolean): Promise<HandlerContext> {
  if (explicit) return ctx;
  const installed = (await readAiwgConfig(project))?.installed;
  if (!installed?.[id]?.deployedTo[provider]) return ctx;
  return { ...ctx, args: [...ctx.args.filter(arg => !['--copy-all', '--copy-standard-skills'].includes(arg)), ...bundleCopyArgs(installed, id, provider)] };
}

export function projectLocalCopyMode(config: AiwgConfig, id: string, provider: string, args: string[], explicit: boolean): boolean {
  const requested = args.includes('--copy-all') || args.includes('--copy-standard-skills');
  return explicit ? requested : config.installed[id]?.deployedTo[provider]?.copy ?? requested;
}
