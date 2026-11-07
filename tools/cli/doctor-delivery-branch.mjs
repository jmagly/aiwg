// Report best-effort delivery branch availability without creating policy warnings.
import { importImpl } from '../_resolve-impl.mjs';

const { boundedExecFileSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');

function gitOutput(projectDir, args) {
  try {
    return boundedExecFileSync('git', ['-C', projectDir, 'rev-parse', ...args], 'quick', {
      encoding: 'utf-8', stdio: 'pipe',
    });
  } catch (err) {
    // Some sandboxes report EPERM despite exit 0. A timeout is still a failure.
    if (err.code !== 'ETIMEDOUT' && err.status === 0) return String(err.stdout ?? '');
    throw err;
  }
}

export function deliveryBranchInfo(projectDir, defaultBranch) {
  let insideWorkTree;
  try {
    insideWorkTree = gitOutput(projectDir, ['--is-inside-work-tree']).trim();
  } catch {
    return 'not a git repository; branch check skipped';
  }
  if (insideWorkTree !== 'true') return 'not a git worktree; branch check skipped';

  try {
    gitOutput(projectDir, ['--verify', '--quiet', defaultBranch]);
  } catch {
    return `default_branch '${defaultBranch}' not found locally (may be remote-only — this is informational)`;
  }
  return null;
}
