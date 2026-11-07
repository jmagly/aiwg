// Read Codex project trust without granting trust or inventing hook-review storage.
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import type { WorkspaceContextDiagnostic } from '../context-pipeline/workspace-context-shared.js';

export interface CodexHookTrust {
  project: 'trusted' | 'untrusted' | 'unknown';
  hookReview: 'approved' | 'unreviewed' | 'unknown';
}

export const CODEX_HOOK_TRUST_NEXT_STEP = 'Trust this project in Codex, then approve the AIWG hook when Codex asks.';

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

  // Codex 0.167 has no documented offline file signal for hook review.
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

export async function diagnoseCodexHookTrust(projectPath: string): Promise<WorkspaceContextDiagnostic | null> {
  const trust = await readCodexHookTrust(projectPath);
  const nextStep = codexHookTrustNextStep(trust);
  return trust && nextStep ? {
    // Review state is never observable offline, so a trusted project is only advisory.
    severity: trust.project === 'trusted' ? 'info' : 'warning', code: 'codex-prompt-discovery-trust', path: '.codex/hooks.json',
    message: 'Codex prompt-discovery hook installed but inactive or unverified (untrusted project or unreviewed hook). '
      + `Project trust: ${trust.project}; hook review: ${trust.hookReview}. ${nextStep}`,
  } : null;
}
