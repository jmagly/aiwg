// Exercise legacy Codex loop dispatch offline and complete on the second launch.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const record = '.fake-codex-launches.jsonl';
const prior = existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').length : 0;
const argv = process.argv.slice(2);
if (!argv.includes('exec') || !argv.includes('--model')) throw new Error('Expected Codex session argv');
appendFileSync(record, JSON.stringify({ argv, cwd: process.cwd() }) + '\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: `fixture-${prior + 1}` }));
console.log(prior === 0 ? 'Working on the task; more work remains.' : JSON.stringify({
  ralph_external_completion: true, success: true, reason: 'Synthetic task completed',
}));
