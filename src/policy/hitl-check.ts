// Checks host-classified effects and requires a verified signed receipt before suppressing a workflow prompt.
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { effectSession, openLedger } from '../effects/host.js';
import { loadHitlLayers } from './hitl-config.js';
import { recordHitlAuthorization } from './hitl-receipt.js';
import { consumeHitlAuthorization, type HitlReceiptRef } from './hitl-consume.js';
import { resolveHitlAuthorization, validHitlAction } from './hitl.js';
import type { HitlAction, HitlContext, HitlResolution } from './hitl-types.js';
import { refreshDurableAuthorization } from './hitl-durable-store.js';

export interface HitlCheck extends HitlResolution {
  receipt?: { file: string; effectId: string };
}

/** Resolve existing ancestors as well as new leaves; dangling links fail closed. */
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { await lstat(path); throw new Error('Unresolved action symlink'); }
    catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonical(parent), basename(path));
  }
}

const policyPath = (path: string) => /(^|\/)(aiwg\.config|AGENTS\.md|WORKSPACE\.md|AIWG\.md|CLAUDE\.md)$/.test(path)
  || /(^|\/)(rules|policies|hooks)(\/|$)/.test(path)
  || /^(\.git|\.claude|\.codex|\.agents|\.github|\.gitea)(\/|$)/.test(path);
const secretPath = (path: string) => /(^|\/)(\.env(?:\.[^/]*)?|\.ssh|\.aws|credentials?|tokens?|secrets?)(\/|$)/i.test(path);

/** Input is a host descriptor, never an issue, model response, or authorization claim. */
export async function canonicalHitlAction(projectDir: string, input: unknown): Promise<unknown> {
  if (!validHitlAction(input)) return input;
  const root = await realpath(projectDir);
  const resources: string[] = [];
  for (const path of input.resources) {
    const resource = relative(root, await canonical(resolve(root, path))).split('\\').join('/');
    if (!resource || resource === '..' || resource.startsWith('../') || isAbsolute(resource)) return null;
    resources.push(resource);
  }
  const action: HitlAction = { ...input, resources: [...new Set(resources)].sort() };
  // Check both spellings: an alias must not hide a protected resource.
  const paths = [...input.resources, ...resources];
  if (paths.some(secretPath)) action.category = 'secret.access';
  else if (action.category !== 'repo.read' && paths.some(policyPath)) action.category = 'policy.override';
  return action;
}

/** No receipt, no automatic action. Errors retain the caller's existing review path. */
export async function checkHitlAuthorization(projectDir: string, input: unknown,
  options: Partial<Pick<HitlContext, 'now' | 'platform' | 'expectedPolicyVersion' | 'sessionAuthorization'>> & { receipt?: HitlReceiptRef } = {}): Promise<HitlCheck> {
  let context: HitlContext = { ...options, now: options.now ?? new Date().toISOString(), layers: [] };
  try {
    const loaded = await loadHitlLayers(projectDir);
    context = { ...context, layers: loaded.layers };
    const action = await canonicalHitlAction(loaded.projectDir, input);
    const ledger = openLedger(await effectSession(loaded.projectDir, 'custom', { clock: () => Date.parse(context.now) }));
    context = await refreshDurableAuthorization(ledger, context);
    if (options.receipt) {
      const consumed = await consumeHitlAuthorization(ledger, action, context, options.receipt);
      return consumed.decision === 'auto-authorized' ? { ...consumed, receipt: options.receipt } : consumed;
    }
    const decision = resolveHitlAuthorization(action, context);
    if (decision.decision !== 'auto-authorized') return decision;
    // Reload policies and the clock at consumption time, including expiry and revocation.
    context = { ...context, now: options.now ?? new Date().toISOString(), layers: (await loadHitlLayers(projectDir)).layers,
      expectedPolicyVersion: options.expectedPolicyVersion ?? decision.policyVersion };
    const recorded = await recordHitlAuthorization(ledger, action, context);
    if (recorded.resolution.decision !== 'auto-authorized') return recorded.resolution;
    if (recorded.reconciled.result.verification.result !== 'present') throw new Error('Unverified HITL receipt');
    const receipt = { file: recorded.file, effectId: recorded.intent.effectId };
    context = { ...context, now: options.now ?? new Date().toISOString(), layers: (await loadHitlLayers(projectDir)).layers,
      expectedPolicyVersion: options.expectedPolicyVersion };
    const consumed = await consumeHitlAuthorization(ledger, action, context, receipt);
    return consumed.decision === 'auto-authorized' ? { ...consumed, receipt } : consumed;
  } catch {
    return { ...resolveHitlAuthorization(null, context), decision: 'escalate', reason: 'authorization-check-unavailable' };
  }
}
