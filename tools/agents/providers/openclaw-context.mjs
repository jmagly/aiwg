// Select OpenClaw startup destinations for default sessions and agent exec --cwd.
import path from 'node:path';

export function openClawContextWorkspaces(opts, workspace) {
  return [...new Set([workspace, ...(opts.contextFiles === false ? [] : [opts.target])].map(dir => path.resolve(dir)))];
}
