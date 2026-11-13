#!/usr/bin/env node
// Synthetic native CLI: consume the private brief and write only its worker tree.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
const project = path.dirname(process.argv[1]);
const deadline = Date.now() + 5000;
let owned = false;
while (!owned && Date.now() < deadline) {
  for (const entry of readdirSync(project)) {
    const run = entry.startsWith('.worker-run-') ? path.join(project, entry, 'run') : path.join(project, entry);
    try {
      const record = JSON.parse(readFileSync(path.join(run, 'process.json'), 'utf8'));
      if (record.worker?.pid === process.pid && record.ownership === 'owned-group') owned = true;
    } catch { /* launch capture may still be sampling kernel identity */ }
  }
  if (!owned) await new Promise(resolve => setTimeout(resolve, 10));
}
if (!owned) throw new Error('Launcher did not observe the synthetic worker identity');
const prompt = readFileSync(0, 'utf8');
writeFileSync('proof.json', JSON.stringify({ prompt, cwd: process.cwd(), group: process.env.AIWG_WORKER_GROUP }));
writeFileSync('artifact.txt', 'accepted-worker-bytes');
process.stdout.write('x'.repeat(1024 * 1024));
process.stderr.write('x'.repeat(1024 * 1024));
const claims = { version: 1, status: 'completed', summary: 'Fixture worker wrote its artifact.', claims: [], artifacts: [], checks: [], limitations: [] };
writeFileSync(process.argv[process.argv.indexOf('-o') + 1], JSON.stringify({ type: 'result', result: claims }));
