// Make journal rejection visible to ask callers and offline doctor reports.
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { projectAiwgPath } from '../config/project-artifacts.js';
import { workspacePermissionsAllowed } from '../utils/workspace-permissions.mjs';
import type { DecisionAskInput, DecisionAskResult } from './ask.js';
import { recordDecisionAsk, type RecordDecisionAskOptions } from './ledger.js';

export async function recordCheckpointLedger(input: DecisionAskInput, result: DecisionAskResult,
  options: RecordDecisionAskOptions, recordAsk = recordDecisionAsk) {
  let reason = 'recording-failed';
  delete result.ledger;
  const warn = (message: string) => {
    reason = message.replace(/^warning:\s*/, '').replace(/; skipping record$/, '');
    try { (options.warn ?? (text => process.stderr.write(`${text}\n`)))(message); }
    catch { /* A broken diagnostic sink must not suppress the JSON skip. */ }
  };
  let record = null;
  try { record = await recordAsk(input, result, { ...options, warn }); }
  catch { warn('warning: decision ledger recording failed'); }
  if (!record) Object.assign(result, { ledger: `skipped:${reason}` });
  return record;
}

export async function inspectDecisionRecording(projectRoot: string) {
  const root = projectAiwgPath(projectRoot);
  const directory = join(root, 'decision');
  const findings: Array<{ path: string; reason: string; repair: string }> = [];
  for (const file of [directory, join(directory, 'ledger.jsonl'), join(directory, 'opportunities.jsonl')]) {
    try {
      const info = await lstat(file);
      const isDirectory = file === directory;
      const reason = info.isSymbolicLink() ? 'symlink'
        : (isDirectory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) ? 'unsafe-file-type-or-links'
          : !workspacePermissionsAllowed(info, root) ? 'unsafe-permissions'
            : process.getuid && info.uid !== process.getuid() ? 'wrong-owner' : null;
      if (reason) findings.push({ path: file, reason,
        repair: 'Restore a real, owned decision directory and single-link journals; remove other access. In a shared workspace use its group (chgrp) and g+rwX; otherwise chmod 700 on the directory and 600 on journals.' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') findings.push({ path: file,
        reason: 'unreadable', repair: 'Restore directory traversal and journal read/write access for the workspace user/group.' });
    }
  }
  return { status: findings.length ? 'skipped' : 'ok', findings };
}
