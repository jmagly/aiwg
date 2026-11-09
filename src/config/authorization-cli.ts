// Exposes HITL inspection, validation, preview, enable/revoke and signed receipts under config/steward.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AiwgError, EXIT_CODES } from '../cli/errors.js';
import { getProjectDir, readAiwgConfig, writeAiwgConfig } from './aiwg-config.js';
import { ensureAuthorization, loadHitlLayers } from '../policy/hitl-config.js';
import { resolveHitlAuthorization } from '../policy/hitl.js';
import { validateHitlPolicy } from '../policy/hitl-validation.js';
import { checkHitlAuthorization } from '../policy/hitl-check.js';
import { listAuthorizationGrants, showAuthorizationGrant, searchAuthorizationGrants, explainAuthorization, revokeAuthorizationGrant, type GrantStatus } from '../policy/authorization-operations.js';
import type { HitlPolicy } from '../policy/hitl-types.js';

export const authorizationUsage = `aiwg config authorization (also aiwg steward authorization)
  inspect | validate [--target DIRECTORY]
  preview --action-file FILE [--target DIRECTORY]
  check --action-file FILE [--receipt-file FILE --effect-id ID] [--target DIRECTORY]
  enable --policy-file FILE [--target DIRECTORY]
  revoke [--profile NAME] [--target DIRECTORY]
  receipt --action-file FILE [--target DIRECTORY]
  list [--active|--expired|--revoked] [--target DIRECTORY]
  show <grantId> | search "<text>" [--target DIRECTORY]
  explain --action-file FILE [--target DIRECTORY]
  revoke <grantId> [--target DIRECTORY]
  verify [--target DIRECTORY]
All operations accept --json; operator lookup output is JSON by default.
Search ranks up to 20 matches by token/field overlap, then grant/effect ID.
Explain is read-only: no receipts, uses, or index repairs.
Verify checks signed grant records and rebuilds/diffs their private descriptor index;
integrity failures exit 6. Missing indexes are rebuilt from verified records.
Preview is read-only. Receipt writes the decision to the existing signed effect ledger;
it does not perform the proposed action. Check writes a verified receipt before returning
auto-authorized; failures escalate. Action files must be host-classified descriptors,
never issue/model output. Check looks up verified durable grants before asking and
reports the nearest grant's differing fields when scope does not match.
Action files cannot supply session authorization. Platform prompts remain authoritative.`;
const usageError = (message: string) => new AiwgError({ code: 'ERR_AUTHORIZATION_USAGE', message, exitCode: EXIT_CODES.USAGE });
async function jsonFile(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { throw usageError('Authorization JSON input could not be read or parsed'); }
}
export async function authorizationCli(args: string[], cwd = process.cwd()): Promise<void> {
  if (!args.length || args.includes('--help') || args[0] === 'help') { console.log(authorizationUsage); return; }
  const [operation, ...rest] = args;
  let operand: string | undefined;
  if (['show', 'search', 'revoke'].includes(operation) && rest[0] && !rest[0].startsWith('--')) operand = rest.shift();
  const flags: Record<string, string> = {};
  const allowed = ['--target', ...(operation === 'enable' ? ['--policy-file'] : []),
    ...(['preview', 'receipt', 'check', 'explain'].includes(operation) ? ['--action-file'] : []),
    ...(operation === 'check' ? ['--receipt-file', '--effect-id'] : []), ...(operation === 'revoke' ? ['--profile'] : [])];
  for (let i = 0; i < rest.length; i++) {
    if (['--json', ...(operation === 'list' ? ['--active', '--expired', '--revoked'] : [])].includes(rest[i])) {
      if (flags[rest[i]]) throw usageError('Invalid authorization option');
      flags[rest[i]] = 'true'; continue;
    }
    if (!allowed.includes(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith('--') || flags[rest[i]]) throw usageError('Invalid authorization option');
    flags[rest[i]] = rest[i + 1]; i++;
  }
  const target = resolve(getProjectDir({ cwd }, rest));
  if (['list', 'show', 'search', 'explain'].includes(operation) || (operation === 'revoke' && operand)) {
    let result: unknown;
    if (operation === 'list') {
      const selected = ['active', 'expired', 'revoked'].filter(s => flags[`--${s}`]);
      if (selected.length > 1) throw usageError('Choose one grant status filter');
      result = await listAuthorizationGrants(target, selected[0] as GrantStatus | undefined);
    } else if (operation === 'explain') {
      if (!flags['--action-file']) throw usageError('--action-file is required');
      result = await explainAuthorization(target, await jsonFile(resolve(cwd, flags['--action-file'])));
    } else {
      if (!operand) throw usageError('A grant ID or search text is required');
      if (operation === 'revoke' && flags['--profile']) throw usageError('Grant ID and --profile cannot be combined');
      result = operation === 'show' ? await showAuthorizationGrant(target, operand)
        : operation === 'search' ? await searchAuthorizationGrants(target, operand) : await revokeAuthorizationGrant(target, operand);
    }
    console.log(JSON.stringify(result, null, 2)); return;
  }
  if (operation === 'verify') {
    const { effectSession } = await import('../effects/host.js');
    const { openEffectLedger } = await import('../effects/ledger.js');
    const { verifyAuthorizationGrants } = await import('../effects/authorization-store.js');
    const session = await effectSession(target, 'custom');
    const result = await verifyAuthorizationGrants(openEffectLedger({ projectDir: target, scope: session.scope, writer: 'cli' }));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) throw new AiwgError({ code: 'ERR_AUTHORIZATION_INTEGRITY', message: 'Authorization ledger verification failed', exitCode: result.exitCode });
    return;
  }
  if (operation === 'inspect' || operation === 'validate') {
    const loaded = await loadHitlLayers(target);
    console.log(JSON.stringify(operation === 'inspect' ? loaded : { valid: true, layers: loaded.layers.length }, null, 2));
    return;
  }
  if (operation === 'preview' || operation === 'receipt' || operation === 'check') {
    if (!flags['--action-file']) throw usageError('--action-file is required');
    const action = await jsonFile(resolve(cwd, flags['--action-file']));
    if (operation === 'check') {
      if (Boolean(flags['--receipt-file']) !== Boolean(flags['--effect-id'])) throw usageError('--receipt-file and --effect-id are required together');
      const receipt = flags['--receipt-file'] ? { file: resolve(cwd, flags['--receipt-file']), effectId: flags['--effect-id'] } : undefined;
      console.log(JSON.stringify(await checkHitlAuthorization(target, action, { receipt }), null, 2));
      return;
    }
    const loaded = await loadHitlLayers(target);
    const context = { now: new Date().toISOString(), layers: loaded.layers };
    if (operation === 'preview') console.log(JSON.stringify(resolveHitlAuthorization(action, context), null, 2));
    else {
      const { effectSession, openLedger } = await import('../effects/host.js');
      const { recordHitlAuthorization } = await import('../policy/hitl-receipt.js');
      const session = await effectSession(loaded.projectDir, 'custom');
      console.log(JSON.stringify(await recordHitlAuthorization(openLedger(session), action, context), null, 2));
    }
    return;
  }
  if (operation !== 'enable' && operation !== 'revoke') throw usageError('Unknown authorization operation');
  const config = await readAiwgConfig(target);
  if (!config) throw usageError('No project config found; initialize project config first');
  const authorization = ensureAuthorization(config);
  if (operation === 'enable') {
    if (!flags['--policy-file']) throw usageError('--policy-file is required');
    const policy = await jsonFile(resolve(cwd, flags['--policy-file']));
    const errors = validateHitlPolicy(policy);
    if (policy === undefined || errors.length) throw usageError('Invalid authorization.hitl policy');
    authorization.hitl = { ...(policy as HitlPolicy), enabled: true };
  } else if (authorization.hitl) {
    if (flags['--profile']) {
      if (!Object.hasOwn(authorization.hitl.profiles, flags['--profile'])) throw usageError('Unknown authorization profile');
      delete authorization.hitl.profiles[flags['--profile']];
    } else authorization.hitl.enabled = false;
  }
  await writeAiwgConfig(target, config);
  console.log(JSON.stringify({ operation, enabled: authorization.hitl?.enabled ?? false }));
}
