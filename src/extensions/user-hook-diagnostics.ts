// Report legacy cwd-relative user hook commands without reading credentials or writing config.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { WorkspaceContextDiagnostic } from '../smiths/context-pipeline/workspace-context-shared.js';

export async function diagnoseUserHookCommands(): Promise<WorkspaceContextDiagnostic[]> {
  const diagnostics: WorkspaceContextDiagnostic[] = [];
  for (const provider of ['claude', 'muse']) {
    const file = path.join(os.homedir(), `.${provider}`, provider === 'claude' ? 'settings.json' : 'hooks.json');
    let doc;
    try { doc = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { continue; } // Existing config diagnostics own unreadable documents.
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
