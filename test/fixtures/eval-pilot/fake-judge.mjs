// Offline resolver and judge fixture; never invokes a provider.
import { readFileSync, writeFileSync, readdirSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
if (args.join(' ') === 'effect keys init') {
  writeFileSync('.fake-effect-keys', 'synthetic; no signing key');
} else if (args.join(' ') === 'doctor --probe-workers --qualify --yes') {
  readFileSync('.fake-effect-keys');
  readFileSync('.aiwg/aiwg.config'); readFileSync('models.json');
  writeFileSync('.fake-qualified', process.cwd());
} else if (args[0] === 'models') {
  if (readFileSync('.fake-qualified', 'utf8') !== process.cwd() || value('--workdir') !== process.cwd()) throw new Error('Unqualified workspace');
  writeFileSync(`${value('--brief')}.resolve.json`, JSON.stringify(args));
  writeFileSync(`${value('--brief')}.cwd.json`, JSON.stringify(process.cwd()));
  if (process.env.FAKE_JUDGE_MODE?.startsWith('blocked')) {
    const block = JSON.stringify(process.env.FAKE_JUDGE_MODE === 'blocked-exclusions'
      ? { status: 'blocked', diagnostics: [], exclusions: [{ group: value('--group'), member: 'muse-worker',
        model: 'synthetic-muse', effort: 'low', diagnostics: [{ code: 'OG_ADAPTER_UNQUALIFIED',
          message: 'Missing exact model, inference provider, observation or current installation evidence' }] }] }
      : { status: 'blocked', diagnostics: [{ code: 'OG_CONFIG_REFERENCE',
        pointer: '/parallelism/worker_dispatch', message: 'Direct worker dispatch is off' }] });
    if (process.env.FAKE_JUDGE_MODE === 'blocked-stdout') process.stdout.write(block);
    else process.stderr.write(block);
    process.exit(process.env.FAKE_JUDGE_MODE === 'blocked-stdout' ? 0 : 2);
  }
  const quote = x => `'${x.replaceAll("'", "'\\''")}'`;
  process.stdout.write([process.execPath, import.meta.filename, 'judge', value('--brief'), value('--final-output')].map(quote).join(' ') + '\n');
} else {
  const [brief, final] = args.slice(1);
  const stage = path.join(process.cwd(), '.judge-attempts');
  const entries = readdirSync(stage);
  if (entries.length !== 1 || path.basename(path.dirname(final)) !== entries[0]) throw new Error('Other attempts visible');
  writeFileSync(`${brief}.isolation.json`, JSON.stringify({ cwd: process.cwd(), entries, files: readdirSync(path.dirname(final)) }));
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
  if (mode?.startsWith('artifact')) {
    const bytes = JSON.stringify(answer, null, 2) + '\n';
    let artifactPath = 'answer.json';
    if (mode === 'artifact-escape') artifactPath = '../../outside.json';
    if (mode === 'artifact-absolute-escape') artifactPath = path.join(process.cwd(), 'outside.json');
    if (mode === 'artifact-non-json') artifactPath = 'answer.txt';
    if (mode === 'artifact-absolute') artifactPath = path.join(path.dirname(final), artifactPath);
    if (mode === 'artifact-symlink') {
      const outside = path.join(process.cwd(), 'outside.json');
      writeFileSync(outside, bytes);
      symlinkSync(outside, path.join(path.dirname(final), artifactPath));
    } else if (mode !== 'artifact-missing') writeFileSync(path.resolve(path.dirname(final), artifactPath), bytes);
    const artifact = { path: artifactPath, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
    if (mode === 'artifact-digest') artifact.digest = `sha256:${'0'.repeat(64)}`;
    if (mode === 'artifact-no-digest') delete artifact.digest;
    const artifacts = mode === 'artifact-two' ? [artifact, { ...artifact, path: 'second.json' }] : [artifact];
    writeFileSync(final, JSON.stringify({ version: 1, status: 'completed', summary: 'Judgment saved in the artifact.',
      claims: [], artifacts, checks: [], limitations: [] }));
    process.exit(0);
  }
  writeFileSync(final, JSON.stringify(mode === 'wrapper' ? { version: 1, status: 'completed', summary: JSON.stringify(answer), claims: [], artifacts: [], checks: [], limitations: [] } : answer));
}
