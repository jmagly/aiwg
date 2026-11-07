// Diagnose and explicitly repair permissions on known non-secret workspace outputs.
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { projectAiwgPath } from '../config/project-artifacts.js';
import { sharedWorkspace, workspacePermissionsAllowed } from './workspace-permissions.js';

export interface WorkspacePermissionFinding {
  path: string;
  reason: 'collapsed-group-mask' | 'ledger-permissions';
  repaired: boolean;
  repair: string;
}
export interface WorkspacePermissionReport {
  findings: WorkspacePermissionFinding[];
  journals: Array<{ path: string; state: 'private' | 'shared' | 'unsafe' }>;
}

/** Only outputs with a non-secret contract are eligible; token/key stores are never traversed. */
export async function inspectWorkspacePermissions(projectRoot: string, fix = false): Promise<WorkspacePermissionReport> {
  const root = projectAiwgPath(projectRoot);
  const report: WorkspacePermissionReport = { findings: [], journals: [] };
  const visit = async (file: string, descend = true): Promise<void> => {
    let info;
    try { info = await lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) return;
    const name = relative(root, file);
    const journal = /^decision\/(ledger|opportunities)\.jsonl$/.test(name);
    const allowed = workspacePermissionsAllowed(file, info);
    const shared = sharedWorkspace(dirname(file));
    if (journal) report.journals.push({ path: file, state: !allowed ? 'unsafe' : (info.mode & 0o070) ? 'shared' : 'private' });
    const collapsed = shared !== null && info.gid === shared.gid && (info.mode & 0o070) === 0;
    if (collapsed || (journal && !allowed)) {
      const finding: WorkspacePermissionFinding = { path: file, reason: collapsed ? 'collapsed-group-mask' : 'ledger-permissions',
        repaired: false, repair: 'aiwg doctor --decision-offload --fix' };
      report.findings.push(finding);
      if (fix && (!process.getuid || info.uid === process.getuid()) && (info.isDirectory() || info.nlink === 1)) {
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = await handle.stat();
          if (opened.ino === info.ino && opened.dev === info.dev && opened.uid === info.uid && opened.nlink === info.nlink) {
            await handle.chmod(collapsed ? (info.mode & 0o7777) | (info.isDirectory() ? 0o070 : 0o060) : 0o600);
            finding.repaired = true;
          }
        } finally { await handle.close(); }
      }
    }
    if (info.isDirectory() && descend) {
      for (const entry of await readdir(file)) await visit(join(file, entry));
    }
  };
  // The local config and firewall baseline are control-plane outputs even with an external artifact root.
  for (const file of [join(projectRoot, '.aiwg', 'aiwg.config'), join(projectRoot, '.aiwg', 'context-memory-firewall-baseline.json'),
    join(root, 'receipts'), join(root, 'traces', 'transcripts'), join(root, 'archive', 'decision')]) await visit(file);
  for (const directory of new Set([join(projectRoot, '.aiwg'), root, join(root, 'decision')])) await visit(directory, false);
  // Do not descend into decision's credential/private stores or transient lock files.
  for (const name of ['ledger.jsonl', 'opportunities.jsonl']) await visit(join(root, 'decision', name));
  return report;
}
