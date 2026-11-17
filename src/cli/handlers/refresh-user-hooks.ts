// Migrate only existing legacy user hook registrations, preserving operator settings.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { managedClaudeHooks } from '../../extensions/claude-hooks-installer.js';
import { managedMuseHooks } from '../../extensions/muse-managed-hooks.js';
import { managedHookScriptState } from '../../extensions/managed-hook-script-state.js';
import { diagnoseUserHookCommands } from '../../extensions/user-hook-diagnostics.js';
import { captureDeploymentOutputs, recordDeploymentOutputs } from '../../providers/deployment-ownership.mjs';
import * as ui from '../ui.js';

function relativeCommand(command: unknown): string | undefined {
  if (typeof command !== 'string') return;
  const match = /^node\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(start|stop))?\s*$/.exec(command);
  if (!match) return;
  const script = (match[1] || match[2] || match[3]).replace(/\\/g, '/').replace(/\.js$/, '.cjs');
  return `node ${script}${match[4] ? ` ${match[4]}` : ''}`;
}

export async function refreshUserHooks(options: {
  frameworkRoot: string; provider: string; dryRun: boolean; quiet: boolean;
}): Promise<void> {
  const { frameworkRoot, provider, dryRun, quiet } = options;
  if (!['claude', 'muse'].includes(provider)) return;
  const home = os.homedir();
  const directory = path.join(home, `.${provider}`);
  const file = path.join(directory, provider === 'claude' ? 'settings.json' : 'hooks.json');
  const diagnostics = await diagnoseUserHookCommands();
  if (!diagnostics.some(diagnostic => diagnostic.path === file)) return;
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  const source = path.join(frameworkRoot, 'agentic/code/addons/aiwg-hooks/hooks');
  const files = await fs.readdir(source);
  const canonical = provider === 'claude'
    ? managedClaudeHooks(files, home, source, 'user').map((hook, i) => ({ ...hook,
      relativeCommand: managedClaudeHooks(files)[i].command }))
    : managedMuseHooks(home, await fs.readFile(path.join(source, 'aiwg-prompt-discovery.cjs')), 'user')
      .filter(hook => hook.id === 'aiwg-prompt-discovery').map(hook => ({ event: hook.event,
        script: '.muse/hooks/aiwg-prompt-discovery.cjs', command: hook.group.hooks[0].command,
        relativeCommand: 'node .muse/hooks/aiwg-prompt-discovery.cjs' }));
  const scripts = new Map<string, Buffer>();
  let count = 0;
  for (const hook of canonical) {
    const groups = doc.hooks?.[hook.event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const entry of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (entry?.type !== 'command' || relativeCommand(entry.command) !== hook.relativeCommand) continue;
        entry.command = hook.command;
        scripts.set(hook.script, await fs.readFile(path.join(source, path.basename(hook.script))));
        count++;
      }
    }
  }
  if (!count) return;
  // Validate every script before making any writes or blessing a new digest.
  for (const [script, bytes] of scripts) {
    const state = await managedHookScriptState(home, script, bytes);
    if (state === 'operator-edited' || state === 'unreadable') throw new Error(`${script}: kept (${state}); user hook migration needs review`);
  }
  if (dryRun) {
    if (!quiet) ui.info(`Would anchor ${count} ${provider} user hook(s) — ${file} (with backup)`);
    return;
  }
  const before = captureDeploymentOutputs([directory]);
  const backup = `${file}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await fs.copyFile(file, backup, fs.constants.COPYFILE_EXCL);
  for (const [script, bytes] of scripts) {
    const target = path.join(home, script);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  const temporary = `${file}.tmp.${process.pid}`;
  try {
    await fs.writeFile(temporary, JSON.stringify(doc, null, 2) + '\n');
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
  recordDeploymentOutputs(before, [directory], { frameworkSlug: 'aiwg-hooks',
    writtenFiles: [file, ...[...scripts.keys()].map(script => path.join(home, script))] });
  if (!quiet) ui.info(`Anchored ${count} ${provider} user hook(s) — backup: ${backup}`);
}

/** Run the user-hook migration without letting a review-needed hook abort `aiwg refresh`. */
export async function refreshUserHooksOrWarn(options: Parameters<typeof refreshUserHooks>[0],
  migrate: typeof refreshUserHooks = refreshUserHooks): Promise<string | undefined> {
  try {
    await migrate(options);
    return undefined;
  } catch (error) {
    const message = `User hook migration skipped: ${error instanceof Error ? error.message : String(error)}`;
    ui.warn(message);
    return message;
  }
}
