// Read Factory project hook prerequisites without granting trust or creating commits.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceContextDiagnostic } from '../context-pipeline/workspace-context-shared.js';
import { isFactoryManaged, readFactoryDocument } from './factory-hook-config.js';

const execFileAsync = promisify(execFile);

export interface FactoryHookTrust {
  project: 'trusted' | 'untrusted' | 'unknown';
  gitCommit: boolean;
}

export const FACTORY_HOOK_TRUST_NEXT_STEP = 'Trust this folder in droid; hooks need a git repo with at least one commit.';

export function factoryHookTrustNextStep(trust: FactoryHookTrust | null): string {
  return trust && (trust.project !== 'trusted' || !trust.gitCommit) ? FACTORY_HOOK_TRUST_NEXT_STEP : '';
}

export async function readFactoryHookTrust(projectPath: string): Promise<FactoryHookTrust | null> {
  const root = path.resolve(projectPath);
  try {
    const doc = readFactoryDocument(path.join(root, '.factory/hooks.json'));
    if (!Object.values(doc.hooks ?? {}).some(groups => groups.some(group =>
      group.hooks.some(hook => hook.type === 'command' && isFactoryManaged(hook))))) return null;
  } catch {
    // Missing/broken installations are handled by deployment drift checks.
    return null;
  }

  const trust: FactoryHookTrust = { project: 'unknown', gitCommit: false };
  try {
    const config = JSON.parse(await fs.readFile(path.join(process.env.HOME || homedir(), '.factory/settings.json'), 'utf8'));
    const folders = config?.trustedFolders;
    // Droid records trust as object keys; values are not trust booleans.
    if (folders && typeof folders === 'object' && !Array.isArray(folders)) {
      trust.project = Object.hasOwn(folders, root) ? 'trusted' : 'untrusted';
    }
  } catch {
    // Missing, unreadable, or malformed settings cannot establish trust.
  }
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: root, timeout: 2000, maxBuffer: 4096, windowsHide: true,
    });
    trust.gitCommit = true;
  } catch {
    // Non-repositories, unborn HEAD, missing git, and timeouts leave this unverified.
  }
  return trust;
}

export async function diagnoseFactoryHookTrust(projectPath: string): Promise<WorkspaceContextDiagnostic | null> {
  const trust = await readFactoryHookTrust(projectPath);
  const nextStep = factoryHookTrustNextStep(trust);
  return trust && nextStep ? {
    severity: 'warning', code: 'factory-hook-trust', path: '.factory/hooks.json',
    message: 'Factory project hooks installed but inactive or unverified. '
      + `Project trust: ${trust.project}; Git commit: ${trust.gitCommit ? 'present' : 'missing or unverified'}. ${nextStep}`,
  } : null;
}
