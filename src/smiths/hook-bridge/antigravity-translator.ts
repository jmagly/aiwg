// Emit named Antigravity hooks using the installed agy 1.3.3 JSONHookSpec contract.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HookEvent, HookSource, TranslateOptions, TranslateResult } from './types.js';
import { loadHookSources } from './loader.js';
import { verifiedHookCommand } from '../../extensions/verified-hook-command.js';
import { managedHookScriptState } from '../../extensions/managed-hook-script-state.js';
import { captureDeploymentOutputs, recordDeploymentOutputs } from '../../providers/deployment-ownership.mjs';

export const ANTIGRAVITY_PROMPT_SCRIPT = '.agents/hooks/aiwg-prompt-discovery.cjs';
export const ANTIGRAVITY_EVENT_MAP: Partial<Record<HookEvent, string>> = {
  UserPromptSubmit: 'PreInvocation', SessionStart: 'SessionStart',
  PreToolUse: 'PreToolUse', PostToolUse: 'PostToolUse', Stop: 'Stop',
};
export function managedAntigravityPromptHook(root: string, bytes: Buffer) {
  return { PreInvocation: [{ type: 'command', timeout: 2,
    command: verifiedHookCommand(root, ANTIGRAVITY_PROMPT_SCRIPT, bytes, ['--antigravity-pre-invocation']) }] };
}

export async function translateForAntigravity(source: HookSource, options: TranslateOptions): Promise<TranslateResult> {
  const result: TranslateResult = { provider: 'antigravity', emittedPaths: [], warnings: [], skipped: false };
  if (source.degradeOn?.includes('antigravity')) return { ...result, skipped: true, skipReason: 'degrade-on declared antigravity' };
  if (options.scope === 'user') return { ...result, skipped: true, skipReason: 'Antigravity hooks are project scoped' };
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(source.id)) throw new Error('Invalid Antigravity hook name');
  const events = source.events.flatMap(event => {
    const mapped = ANTIGRAVITY_EVENT_MAP[event];
    if (!mapped) result.warnings.push(`Unsupported Antigravity hook event: ${event}`);
    return mapped ? [mapped] : [];
  });
  if (!events.length) return { ...result, skipped: true, skipReason: 'no Antigravity-mapped events' };
  const prompt = source.id === 'aiwg-prompt-discovery';
  if (prompt && !source.args?.[0]) throw new Error('Missing shared prompt discovery script');
  const directory = path.join(options.projectPath, '.agents');
  const script = path.join(options.projectPath, ANTIGRAVITY_PROMPT_SCRIPT);
  const config = path.join(directory, 'hooks.json');
  if (options.dryRun) return { ...result, emittedPaths: [config, ...(prompt ? [script] : [])].map(file => file + ' (dry-run)') };
  for (const file of [directory, config, ...(prompt ? [path.dirname(script), script] : [])]) {
    try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error(`Refusing symlinked Antigravity hook target: ${file}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  let doc: Record<string, Record<string, unknown>> = {};
  try { doc = JSON.parse(await fs.readFile(config, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || Object.values(doc).some(value =>
    !value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid Antigravity named hooks object');
  const roots = [config, path.join(directory, '.aiwg-manifest.json'), path.dirname(script)];
  const before = captureDeploymentOutputs(roots);
  let registration: Record<string, unknown>;
  if (prompt) {
    const bytes = await fs.readFile(source.args![0]);
    const state = await managedHookScriptState(options.projectPath, ANTIGRAVITY_PROMPT_SCRIPT, bytes);
    if (state === 'operator-edited' || state === 'unreadable') result.warnings.push(`${script}: kept (${state})`);
    else {
      await fs.mkdir(path.dirname(script), { recursive: true });
      await fs.writeFile(script, bytes, { mode: 0o755 });
      result.emittedPaths.push(script);
    }
    registration = managedAntigravityPromptHook(options.commandRoot ?? options.projectPath, bytes);
  } else {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const handler = { type: 'command', command: [source.command, ...(source.args ?? []).map(quote)].join(' '),
      timeout: Math.ceil(source.timeout ?? 30) };
    registration = Object.fromEntries(events.map(event => [event,
      event === 'PreToolUse' || event === 'PostToolUse' ? [{ matcher: '*', hooks: [handler] }] : [handler]]));
  }
  // The top-level source name is the native identity; emit no undocumented metadata keys.
  // Preserve explicit operator disablement and every other named hook.
  doc[source.id] = { ...(typeof doc[source.id]?.enabled === 'boolean' ? { enabled: doc[source.id].enabled } : {}), ...registration };
  await fs.mkdir(directory, { recursive: true });
  const temporary = `${config}.tmp.${randomUUID()}`;
  try {
    await fs.writeFile(temporary, JSON.stringify(doc, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(temporary, config);
  } finally { await fs.rm(temporary, { force: true }); }
  result.emittedPaths.push(config);
  recordDeploymentOutputs(before, roots, {
    frameworkSlug: 'aiwg-hooks', claimUnchangedSettings: false, writtenFiles: result.emittedPaths,
  });
  return result;
}

export async function installAntigravityPromptDiscovery(options: TranslateOptions & { frameworkRoot: string }): Promise<TranslateResult> {
  const { sources, errors } = await loadHookSources(options.frameworkRoot);
  if (errors.length) throw new Error(errors.join('\n'));
  const source = sources.find(hook => hook.id === 'aiwg-prompt-discovery');
  if (!source) throw new Error('Missing canonical aiwg-prompt-discovery source');
  return translateForAntigravity(source, options);
}
