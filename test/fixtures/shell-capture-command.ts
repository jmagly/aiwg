/** Assert the shell safety envelope while retaining exact vendor-command expectations. */
import path from 'node:path';
import { expect } from 'vitest';
import type { WorkerResolvedInvocation } from '../../src/mission-protocol/types.js';
import { workerOutputPaths } from '../../src/serve/worker-invocation-paths.js';

export function shellCaptureBody(invocation: WorkerResolvedInvocation, task = { role: 'coding', task: 'implementation' as string | null }): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  const binding = { request: { ...task, group: invocation.selected.group, workdir: invocation.cwd },
    invocation: { cwd: invocation.cwd, briefPath: invocation.briefPath, briefDigest: invocation.briefDigest, stdin: invocation.stdin, selected: invocation.selected },
    paths: { ...workerOutputPaths(invocation), ...(invocation.stdin !== 'closed' || invocation.argv!.includes(invocation.briefPath!)
      ? { workerBrief: `${invocation.finalPath}.worker-brief` } : {}) } };
  const stage = invocation.stdin !== 'closed' || invocation.argv!.includes(invocation.briefPath!)
    ? [process.execPath, path.resolve('src/serve/worker-shell-prompt.mjs'), '--stage', path.resolve('.'), invocation.briefPath, invocation.briefDigest ?? '', invocation.finalPath]
      .map(quote).join(' ') + ' && ' : '';
  const prefix = [process.execPath, path.resolve('tools/ralph-external/lib/worker-shell-capture.mjs'), JSON.stringify(binding)]
    .map(quote).join(' ') + ` && ${stage}(set -C; `;
  expect(invocation.shellCommand!.startsWith(prefix)).toBe(true);
  expect(invocation.shellCommand!.endsWith(')')).toBe(true);
  return invocation.shellCommand!.slice(prefix.length, -1);
}
