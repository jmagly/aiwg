// Offline resolver and judge fixture; never invokes a provider.
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
if (args[0] === 'models') {
  writeFileSync(`${value('--brief')}.resolve.json`, JSON.stringify(args));
  const quote = x => `'${x.replaceAll("'", "'\\''")}'`;
  process.stdout.write([process.execPath, import.meta.filename, 'judge', value('--brief'), value('--final-output')].map(quote).join(' ') + '\n');
} else {
  const [brief, final] = args.slice(1);
  const prompt = readFileSync(brief, 'utf8');
  const attempt = Number(final.match(/attempt-(\d+)/)[1]);
  const mode = process.env.FAKE_JUDGE_MODE;
  if (mode === 'error' || (mode === 'retry' && attempt === 1)) { process.stderr.write('synthetic provider error'); process.exit(7); }
  if (mode === 'missing') process.exit(0);
  if (mode === 'partial') { writeFileSync(final, '{"label":'); process.exit(0); }
  const request = JSON.parse(prompt.slice(prompt.indexOf('\n{') + 1));
  if (mode === 'event-error') process.stdout.write(JSON.stringify({ type: 'error', message: 'synthetic failure' }) + '\n');
  if (mode === 'observed') process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fixture', model: 'observed-codex' }) + '\n');
  const label = mode === 'na' && request.criterion.id === 'Q5' ? 'NOT_APPLICABLE' : 'CANNOT_ASSESS';
  const answer = { label, evidence: [], rationale: 'Synthetic missing evidence', critical_flags: [], secondary_flags: ['fixture'], confidence: null };
  writeFileSync(final, JSON.stringify(mode === 'wrapper' ? { version: 1, status: 'completed', summary: JSON.stringify(answer), claims: [], artifacts: [], checks: [], limitations: [] } : answer));
}
