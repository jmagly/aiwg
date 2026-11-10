// Read Hermes shell-hook consent without accepting commands or changing config.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { resolveHermesHomePath } from '../../providers/hermes-home.js';
import type { WorkspaceContextDiagnostic } from '../context-pipeline/workspace-context-shared.js';

export type HermesHookAcceptance = 'accepted' | 'unaccepted' | 'unknown';

// One short deploy line; doctor carries the complete set of acceptance options.
export const HERMES_HOOK_ACCEPTANCE_NEXT_STEP = 'Accept the Hermes hook (--accept-hooks); see aiwg doctor.';
export const HERMES_HOOK_ACCEPTANCE_DETAIL = 'Hermes skips unaccepted pre_llm_call hooks. Review and accept at the TTY prompt, '
  + 'or explicitly opt in with --accept-hooks, HERMES_ACCEPT_HOOKS=1 or hooks_auto_accept: true. '
  + 'AIWG never accepts hooks for you. Acceptance matches the exact event and command string; '
  + 'a script change changes the fingerprinted command on redeploy and requires re-acceptance.';

export function hermesHookAcceptanceNextStep(state: HermesHookAcceptance | null): string {
  return state && state !== 'accepted' ? HERMES_HOOK_ACCEPTANCE_NEXT_STEP : '';
}

export async function readHermesHookAcceptance(): Promise<HermesHookAcceptance | null> {
  const home = resolveHermesHomePath();
  let commands: string[];
  let autoAccept: unknown;
  try {
    const doc = parseDocument(await fs.readFile(path.join(home, 'config.yaml'), 'utf8'));
    if (doc.errors.length) return null;
    const config = doc.toJS();
    const entries = config?.hooks?.pre_llm_call;
    if (!Array.isArray(entries)) return null;
    commands = entries.filter(entry => entry?._aiwg_managed === true
      && entry._aiwg_id === 'aiwg-prompt-discovery' && typeof entry.command === 'string')
      .map(entry => entry.command);
    if (!commands.length) return null;
    await fs.access(path.join(home, 'agent-hooks/aiwg-prompt-discovery.cjs'));
    autoAccept = config.hooks_auto_accept;
  } catch {
    // Broken deployments are handled by the existing drift diagnostics.
    return null;
  }
  // Match Hermes's existing config opt-in, without setting it or assuming a CLI flag.
  if (autoAccept === true || typeof autoAccept === 'string'
    && ['1', 'true', 'yes', 'on'].includes(autoAccept.trim().toLowerCase())) return 'accepted';
  try {
    const data = JSON.parse((await fs.readFile(path.join(home, 'shell-hooks-allowlist.json'), 'utf8')).replace(/^\uFEFF/, ''));
    if (!Array.isArray(data?.approvals)) return 'unknown';
    // Hermes agent/shell_hooks.py _entry_matches compares both strings exactly.
    return commands.every(command => data.approvals.some((entry: { event?: unknown; command?: unknown } | null) =>
      entry?.event === 'pre_llm_call' && entry.command === command)) ? 'accepted' : 'unaccepted';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unaccepted' : 'unknown';
  }
}

export async function diagnoseHermesHookAcceptance(): Promise<WorkspaceContextDiagnostic | null> {
  const state = await readHermesHookAcceptance();
  if (!hermesHookAcceptanceNextStep(state)) return null;
  return {
    severity: state === 'unaccepted' ? 'warning' : 'info', code: 'hermes-prompt-discovery-acceptance',
    path: resolveHermesHomePath('config.yaml'),
    message: `Hermes prompt-discovery hook deployed but ${state === 'unaccepted' ? 'not accepted' : 'acceptance unverified'}. `
      + HERMES_HOOK_ACCEPTANCE_DETAIL,
  };
}
