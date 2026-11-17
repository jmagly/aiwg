// Read Codex trust and deduplicate trusted-project advice without granting hook approval.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { getUserStateDir } from '../../config/user-state.js';
import type { WorkspaceContextDiagnostic } from '../context-pipeline/workspace-context-shared.js';

const execFileAsync = promisify(execFile);

export interface CodexHookTrust {
  project: 'trusted' | 'untrusted' | 'unknown';
  hookReview: 'approved' | 'unreviewed' | 'unknown';
}

// Printed after deploy: one line that fits an 80-column terminal.
export const CODEX_HOOK_TRUST_NEXT_STEP = 'Trust this project in Codex and approve its AIWG hook; codex exec needs both.';
// Full explanation for doctor and docs (#4035).
export const CODEX_EXEC_HOOK_TRUST_DETAIL = 'Codex requires saved folder and hook trust for codex exec; a per-run -c project trust override '
  + 'does not enable project hooks, even with --dangerously-bypass-hook-trust. '
  + 'Review and save trust interactively for each worker worktree before automation; AIWG never grants trust.';

export function codexHookTrustNextStep(trust: CodexHookTrust | null): string {
  return trust && (trust.project !== 'trusted' || trust.hookReview !== 'approved')
    ? CODEX_HOOK_TRUST_NEXT_STEP : '';
}

export async function readCodexHookTrust(projectPath: string): Promise<CodexHookTrust | null> {
  const root = path.resolve(projectPath);
  try {
    const doc = JSON.parse(await fs.readFile(path.join(root, '.codex/hooks.json'), 'utf8'));
    const groups = doc?.hooks?.UserPromptSubmit;
    if (!Array.isArray(groups) || !groups.some(group => Array.isArray(group?.hooks)
      && group.hooks.some((hook: Record<string, unknown>) => hook?.type === 'command'
        && hook._aiwg_managed === true && hook._aiwg_id === 'aiwg-prompt-discovery'))) return null;
    await fs.access(path.join(root, '.codex/hooks/aiwg-prompt-discovery.cjs'));
  } catch {
    // Missing/broken installations are handled by deployment drift checks.
    return null;
  }

  // A notice marker is not evidence of Codex hook approval; keep that state unknown.
  const trust: CodexHookTrust = { project: 'unknown', hookReview: 'unknown' };
  const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || homedir(), '.codex');
  try {
    const bytes = await fs.readFile(path.resolve(codexHome, 'config.toml'), 'utf8');
    const config = getStaticTOMLValue(parseTOML(bytes)) as { projects?: Record<string, { trust_level?: unknown }> };
    const level = config.projects?.[root]?.trust_level;
    trust.project = level === 'trusted' ? 'trusted' : 'untrusted';
  } catch {
    // Unreadable, missing, and invalid config cannot establish project trust.
  }
  return trust;
}

async function codexHookAdvisoryAlreadyShown(projectPath: string): Promise<boolean> {
  const root = path.resolve(projectPath);
  try {
    const codexHome = path.resolve(process.env.CODEX_HOME || path.join(process.env.HOME || homedir(), '.codex'));
    const registration = await fs.readFile(path.join(root, '.codex/hooks.json'));
    const script = await fs.readFile(path.join(root, '.codex/hooks/aiwg-prompt-discovery.cjs'));
    const digest = createHash('sha256').update(JSON.stringify([root, codexHome,
      registration.toString('base64'), script.toString('base64')])).digest('hex');
    // Empty host-local markers record only that advice was shown, never trust.
    const directory = path.join(getUserStateDir(), 'codex-hook-advisories');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(path.join(directory, digest), '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return true;
      throw error;
    }
  } catch {
    // A missing/unwritable state directory must never silence the diagnostic.
  }
  return false;
}

async function detectedCodexVersion(projectPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('codex', ['--version'], {
      cwd: path.resolve(projectPath), timeout: 2000, maxBuffer: 4096, windowsHide: true,
    });
    return /^codex-cli (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/.exec(stdout.trim())?.[1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function diagnoseCodexHookTrust(projectPath: string): Promise<WorkspaceContextDiagnostic | null> {
  const trust = await readCodexHookTrust(projectPath);
  const nextStep = codexHookTrustNextStep(trust);
  if (!trust || !nextStep) return null;
  if (trust.project === 'trusted' && await codexHookAdvisoryAlreadyShown(projectPath)) return null;
  const version = await detectedCodexVersion(projectPath);
  return {
    severity: trust.project === 'trusted' ? 'info' : 'warning', code: 'codex-prompt-discovery-trust', path: '.codex/hooks.json',
    message: 'Codex prompt-discovery hook installed but inactive or unverified (untrusted project or unreviewed hook). '
      + `Project trust: ${trust.project}; hook review: ${trust.hookReview}. Detected Codex version: ${version}. `
      + `${nextStep} ${CODEX_EXEC_HOOK_TRUST_DETAIL} `
      + 'For trusted projects, this advisory is shown once per hook digest; changes to the script or registration re-raise it.',
  };
}
