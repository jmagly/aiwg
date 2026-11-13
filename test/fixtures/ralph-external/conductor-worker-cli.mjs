#!/usr/bin/env node
// Fake native worker: exercise bwrap, write in the worker tree, and capture its host context.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const project = path.dirname(process.argv[1]);
const deadline = Date.now() + 5000;
let owned = false;
while (!owned && Date.now() < deadline) {
  for (const entry of readdirSync(project).filter(name => name.startsWith('.worker-run-'))) {
    try {
      const record = JSON.parse(readFileSync(path.join(project, entry, 'run', 'process.json'), 'utf8'));
      if (record.worker?.pid === process.pid && record.ownership === 'owned-group') owned = true;
    } catch { /* the launcher may still be sampling identity */ }
  }
  if (!owned) await new Promise(resolve => setTimeout(resolve, 10));
}
if (!owned) throw new Error('Launcher did not observe the fake worker identity');
readFileSync(0, 'utf8');
const cwd = process.cwd();
const proof = path.join(cwd, 'worker-proof.json');
const sandbox = spawnSync('/usr/bin/bwrap', ['--ro-bind', '/', '/', '--bind', cwd, cwd,
  '--unshare-user', '--unshare-net', '--', '/bin/sh', '-c', 'printf native-worker > "$1"; printf accepted-probe-bytes > final.txt', 'sh', path.join(cwd, 'native-write')],
{ encoding: 'utf8', timeout: 10000 });
if (sandbox.error || sandbox.status !== 0) throw new Error(`Fake worker native sandbox failed: ${sandbox.stderr ?? sandbox.error}`);
writeFileSync(proof, JSON.stringify({ cwd, cgroup: readFileSync('/proc/self/cgroup', 'utf8'),
  sandbox: 'native-sandbox', write: readFileSync(path.join(cwd, 'native-write'), 'utf8') }));
const claims = { version: 1, status: 'completed', summary: 'Fixture native worker wrote its tree.', claims: [], artifacts: [], checks: [], limitations: [] };
writeFileSync(process.argv[process.argv.indexOf('-o') + 1], JSON.stringify({ type: 'result', result: claims }));
