// Render the compact delegation policy from the shipped template and merged model preferences.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageRoot } from '../../cli/find-package-root.js';
import { ConfigLoader } from '../../models/config-loader.js';
import type { WorkerSelectionPolicy } from '../../models/types.js';
import type { ParallelismConfig } from '../../config/aiwg-config.js';

export const DELEGATION_BLOCK_START = '<!-- AIWG-DELEGATION:START -->';
export const DELEGATION_BLOCK_END = '<!-- AIWG-DELEGATION:END -->';

/** Load only existing files; never discover models or contact providers. */
export async function readDelegationPolicy(projectPath: string, parallelism?: ParallelismConfig): Promise<WorkerSelectionPolicy> {
  try {
    const models = await new ConfigLoader(projectPath).load(parallelism);
    return models.defaults.workerSelection ?? {};
  } catch (error) {
    if (error instanceof Error && error.message.includes('Failed to load AIWG default config')) return {};
    throw error;
  }
}

export async function renderDelegationRubric(policy: WorkerSelectionPolicy, missingConfig = false): Promise<string> {
  const root = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (!root) throw new Error('Cannot locate bundled delegation rubric');
  const template = await readFile(join(root, 'agentic/code/addons/aiwg-utils/templates/context/delegation-rubric.md'), 'utf8');
  const mode = policy.mode ?? 'advisory';
  const values: Record<string, string> = {
    policy: mode === 'default' ? 'Delegate by default' : mode === 'off'
      ? 'Automatic delegation is off; keep work local unless the user explicitly requests delegation'
      : 'Consider delegation',
    mode,
    strategy: policy.strategy ?? 'cost-effective',
    ceiling: policy.maxAutoTier ?? 'premium',
    return_budget: String(policy.returnBudgetTokens ?? 2000),
    defaults_note: missingConfig ? ' (defaults; edit project models.json defaults.workerSelection to change)' : '',
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Unknown delegation template variable: ${key}`);
    return values[key];
  }).trimEnd();
}

export async function buildDelegationBridge(projectPath: string): Promise<string> {
  if (process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT === '1') return '';
  const policy = await readDelegationPolicy(projectPath);
  return `${DELEGATION_BLOCK_START}\n${await renderDelegationRubric(policy)}\n${DELEGATION_BLOCK_END}\n`;
}
