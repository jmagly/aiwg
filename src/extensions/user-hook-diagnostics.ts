// Report legacy cwd-relative user hook commands without reading credentials or writing config.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { WorkspaceContextDiagnostic } from '../smiths/context-pipeline/workspace-context-shared.js';

function hasPromptHook(doc: any): boolean {
  const groups = doc?.hooks?.UserPromptSubmit;
  return Array.isArray(groups) && groups.some(group => Array.isArray(group?.hooks) && group.hooks.some((hook: any) =>
    hook?.type === 'command' && hook._aiwg_managed === true && hook._aiwg_id === 'aiwg-prompt-discovery'
    && typeof hook.command === 'string' && hook.command.trim()));
}

export async function diagnoseUserHookCommands(projectRoot?: string): Promise<WorkspaceContextDiagnostic[]> {
  const diagnostics: WorkspaceContextDiagnostic[] = [];
  for (const provider of ['claude', 'muse']) {
    const file = path.join(os.homedir(), `.${provider}`, provider === 'claude' ? 'settings.json' : 'hooks.json');
    let doc;
    try { doc = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { continue; } // Existing config diagnostics own unreadable documents.
    if (provider === 'claude' && projectRoot && path.resolve(projectRoot) !== path.resolve(os.homedir()) && hasPromptHook(doc)) {
      try {
        const projectFile = path.join(projectRoot, '.claude/settings.json');
        if (hasPromptHook(JSON.parse(await fs.readFile(projectFile, 'utf8')))) {
          diagnostics.push({ severity: 'warning', code: 'duplicate-prompt-hook', path: projectFile,
            message: 'Claude user and project settings both register AIWG prompt discovery. The current user loader defers to the project hook; refresh older global hooks with aiwg use all --global --providers claude.' });
        }
      } catch { /* Existing config diagnostics own unreadable project settings. */ }
    }
    for (const [event, groups] of Object.entries(doc.hooks || {})) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
          if (typeof hook?.command !== 'string' ||
            !/^node\s+["']?\.[\\/]?(?:claude|muse)[\\/]hooks[\\/]aiwg-[\w-]+\.(?:cjs|js)(?:["'\s]|$)/.test(hook.command)) continue;
          diagnostics.push({ severity: 'warning', code: 'relative-user-hook-command', path: file,
            message: `${provider} user ${event} hook depends on the session cwd. Run aiwg use all --global --providers ${provider} to anchor and verify it.` });
        }
      }
    }
  }
  return diagnostics;
}
