// Deploy canonical prompt discovery through Cursor's flat beforeSubmitPrompt command array.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HookSource, TranslateOptions, TranslateResult } from './types.js';
import { loadHookSources } from './loader.js';
import { verifiedHookCommand } from '../../extensions/verified-hook-command.js';
import { managedHookScriptState } from '../../extensions/managed-hook-script-state.js';
import { captureDeploymentOutputs, recordDeploymentOutputs } from '../../providers/deployment-ownership.mjs';

export const CURSOR_PROMPT_SCRIPT = '.cursor/hooks/aiwg-prompt-discovery.cjs';
export function managedCursorPromptHook(root: string, bytes: Buffer) {
  return { type: 'command', command: verifiedHookCommand(root, CURSOR_PROMPT_SCRIPT, bytes), timeout: 2,
    _aiwg_managed: true, _aiwg_id: 'aiwg-prompt-discovery' };
}

export async function translateForCursor(source: HookSource, options: TranslateOptions): Promise<TranslateResult> {
  const result: TranslateResult = { provider: 'cursor', emittedPaths: [], warnings: [], skipped: false };
  if (source.degradeOn?.includes('cursor')) return { ...result, skipped: true, skipReason: 'degrade-on declared cursor' };
  if (source.id !== 'aiwg-prompt-discovery' || !source.events.includes('UserPromptSubmit')) {
    return { ...result, skipped: true, skipReason: 'no Cursor-mapped prompt discovery event' };
  }
  if (!source.args?.[0]) throw new Error('Missing shared prompt discovery script');
  const directory = path.join(options.projectPath, '.cursor');
  const script = path.join(options.projectPath, CURSOR_PROMPT_SCRIPT);
  const config = path.join(directory, 'hooks.json');
  if (options.dryRun) return { ...result, emittedPaths: [config, script].map(file => file + ' (dry-run)') };
  for (const file of [directory, config, path.dirname(script), script]) {
    try {
      if ((await fs.lstat(file)).isSymbolicLink()) throw new Error(`Refusing symlinked Cursor hook target: ${file}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  let existing = '';
  try { existing = await fs.readFile(config, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const doc = existing ? JSON.parse(existing) : { version: 1, hooks: {} };
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Number.isInteger(doc.version) || doc.version < 1
    || !doc.hooks || typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)
    || Object.values(doc.hooks).some(entries => !Array.isArray(entries)
      || entries.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry)))) {
    throw new Error(`Invalid Cursor hooks object: ${config}`);
  }
  const before = captureDeploymentOutputs([directory]);
  const bytes = await fs.readFile(source.args[0]);
  const state = await managedHookScriptState(options.projectPath, CURSOR_PROMPT_SCRIPT, bytes);
  if (state === 'operator-edited' || state === 'unreadable') result.warnings.push(`${script}: kept (${state})`);
  else {
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.writeFile(script, bytes, { mode: 0o755 });
    result.emittedPaths.push(script);
  }
  // Replace only our registration; flat operator entries and other events retain their order.
  const hooks = doc.hooks.beforeSubmitPrompt ?? [];
  doc.hooks.beforeSubmitPrompt = [...hooks.filter((hook: { _aiwg_managed?: boolean; _aiwg_id?: string }) =>
    !(hook._aiwg_managed === true && hook._aiwg_id === source.id)),
  managedCursorPromptHook(options.commandRoot ?? options.projectPath, bytes)];
  await fs.mkdir(directory, { recursive: true });
  const temporary = `${config}.tmp.${randomUUID()}`;
  try {
    await fs.writeFile(temporary, JSON.stringify(doc, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(temporary, config);
  } finally { await fs.rm(temporary, { force: true }); }
  result.emittedPaths.push(config);
  recordDeploymentOutputs(before, [directory], { frameworkSlug: 'aiwg-hooks', claimUnchangedSettings: false, writtenFiles: result.emittedPaths });
  return result;
}

export async function installCursorPromptDiscovery(options: TranslateOptions & { frameworkRoot: string }): Promise<TranslateResult> {
  const { sources, errors } = await loadHookSources(options.frameworkRoot);
  if (errors.length) throw new Error(errors.join('\n'));
  const source = sources.find(hook => hook.id === 'aiwg-prompt-discovery');
  if (!source) throw new Error('Missing canonical aiwg-prompt-discovery source');
  return translateForCursor(source, options);
}
