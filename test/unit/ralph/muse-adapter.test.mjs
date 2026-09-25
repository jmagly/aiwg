// Contract tests for the optional Muse Code headless (`muse exec`) Ralph
// adapter (#230). Everything runs against the committed offline stub —
// no live Meta auth, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MuseAdapter, isMuseRalphEnabled } from '../../../tools/ralph-external/lib/muse-adapter.mjs';
import { createProvider, ensureProvidersRegistered, listProviders, isMuseRalphEnabled as registryGate } from '../../../tools/ralph-external/lib/provider-adapter.mjs';
import { SessionLauncher } from '../../../tools/ralph-external/session-launcher.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const stub = resolve(here, '../../fixtures/providers/muse/muse-stub.mjs');
const manifest = JSON.parse(readFileSync(resolve(here, '../../fixtures/providers/muse/manifest.json'), 'utf8'));
const repoRoot = resolve(here, '../../..');
chmodSync(stub, 0o755);

function withEnv(patch, run) {
  const saved = {};
  for (const [key, value] of Object.entries(patch)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const restore = () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  try { const result = run(); return result?.finally ? result.finally(restore) : (restore(), result); } catch (error) { restore(); throw error; }
}
function scratch(prefix) { const dir = mkdtempSync(join(tmpdir(), prefix)); return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }; }

test('Muse adapter builds a sub-command-first exec argv with the prompt positional last', () => {
  const adapter = new MuseAdapter();
  assert.deepEqual(adapter.buildSessionArgs({ prompt: 'do the task' }),
    ['exec', '--json', 'do the task'],
    'flags are parsed by `exec`, never by the `muse` root — argv must start with exec');
});

test('Muse adapter resumes via --session-id and passes through documented run controls', () => {
  const adapter = new MuseAdapter();
  assert.deepEqual(
    adapter.buildSessionArgs({ prompt: 'continue', sessionId: 'uuid-1', model: 'muse-spark-1.2',
      reasoningEffort: 'medium', maxTurns: 10, approvalMode: 'never' }),
    ['exec', '--json', '--session-id', 'uuid-1', '--model', 'muse-spark-1.2',
      '--reasoning-effort', 'medium', '--max-model-steps', '10', '--approval-mode', 'never', 'continue']);
  assert.deepEqual(
    adapter.buildSessionArgs({ prompt: 'unused', promptFile: '/tmp/task.txt' }),
    ['exec', '--json', '--prompt-file', '/tmp/task.txt'],
    '--prompt-file replaces the positional prompt');
});

test('Muse adapter warns on unsupported options and never emits unevidenced flags', () => {
  const adapter = new MuseAdapter();
  const warnings = []; const warn = console.warn; console.warn = message => warnings.push(message);
  try {
    const args = adapter.buildSessionArgs({ prompt: 'p', budget: 5, systemPrompt: 'sys',
      agent: 'analyst', mcpConfig: { servers: {} } });
    assert.deepEqual(args, ['exec', '--json', 'p'], 'unsupported options never reach the CLI');
    assert.deepEqual(warnings.map(message => message.match(/Warning: (.+?) not supported/)[1]),
      ['Budget control', 'System prompt', 'Agent mode', 'MCP configuration']);
  } finally { console.warn = warn; }
  const args = adapter.buildSessionArgs({ prompt: 'p', maxTurns: 3 });
  assert.ok(!args.includes('--max-turns'), 'muse has no --max-turns; the cap is --max-model-steps');
  assert.ok(!args.includes('--yolo'), 'no approval posture is defaulted (#230 out of scope)');
  assert.deepEqual(adapter.buildAnalysisArgs({ prompt: 'analyze' }), ['exec', 'analyze'],
    'analysis wants reply text, so --json is not requested');
});

test('Muse adapter builds the muse export transcript path', () => {
  const adapter = new MuseAdapter();
  assert.deepEqual(adapter.buildExportArgs({ sessionId: 'uuid-9', out: '/tmp/run.json' }),
    ['export', '--session', 'uuid-9', '--out', '/tmp/run.json']);
  assert.deepEqual(adapter.buildExportArgs({ last: true, redacted: true, out: '/tmp/share.json' }),
    ['export', '--last', '--redacted', '--out', '/tmp/share.json']);
  assert.equal(adapter.getTranscriptPath('uuid-9'), null,
    'no native session root is assumed (ADR fail-closed); transcripts come from `muse export`');
});

test('Muse adapter reports the documented capability set', () => {
  const adapter = new MuseAdapter();
  assert.deepEqual(adapter.getCapabilities(), {
    streamJson: true, sessionResume: true, budgetControl: false,
    systemPrompt: false, agentMode: false, mcpConfig: false, maxTurns: true,
  });
  assert.equal(adapter.getAbortInput(), null, 'no evidenced stdin command channel, so no abort frame');
  assert.deepEqual(adapter.getEnvOverrides(), { CI: 'true', NO_COLOR: '1' });
  assert.equal(adapter.mapModel('muse-spark-1.2'), 'muse-spark-1.2', 'Muse ids pass through');
  assert.equal(adapter.mapModel('claude-sonnet-5'), null, 'other-provider names are dropped');
  assert.equal(adapter.mapModel('sonnet'), null, 'generic Ralph names are dropped');
  assert.ok(!adapter.buildSessionArgs({ prompt: 'p', model: 'claude-sonnet-5' }).includes('--model'),
    'no --model flag when the name is not a Muse id');
  assert.equal(adapter.getName(), 'muse');
  assert.equal(withEnv({ AIWG_MUSE_BIN: undefined }, () => adapter.getBinary()), 'muse');
  assert.equal(withEnv({ AIWG_MUSE_BIN: '/opt/muse/bin/muse' }, () => adapter.getBinary()), '/opt/muse/bin/muse');
});

test('Muse adapter validates JSONL framing and leaves settlement indeterminate', () => {
  const adapter = new MuseAdapter();
  const stream = '{"stub":"muse-exec","event":"run_started"}\n{"stub":"muse-exec","event":"run_terminal"}\n';
  const parsed = adapter.parseOutput(stream);
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.settled, null, 'the --json envelope schema is unevidenced; settlement comes from exit codes');
  assert.ok(!('text' in parsed), 'no text is extracted from an unevidenced envelope');
  assert.equal(adapter.parseOutput(`${stream}not json\n`), null, 'a malformed line rejects the whole stream');
  assert.equal(adapter.parseOutput(`${stream}\r\n`).events.length, 2, 'CRLF-terminated records are tolerated');
  assert.equal(adapter.parseOutput(''), null);
  assert.equal(adapter.parseOutput('plain text\n'), null, 'non-JSONL output is never accepted as events');
});

test('the disable flag gates only the Ralph registry, never the muse provider itself', () => {
  for (const value of ['0', 'false', 'FALSE', 'no', 'off', ' 0 ']) {
    assert.equal(withEnv({ AIWG_MUSE_RALPH_ENABLED: value }, isMuseRalphEnabled), false, `enabled("${value}") is false`);
    assert.equal(withEnv({ AIWG_MUSE_RALPH_ENABLED: value }, registryGate), false, `registry gate("${value}") is false`);
  }
  for (const value of [undefined, '', '1', 'true', 'yes']) {
    assert.equal(withEnv({ AIWG_MUSE_RALPH_ENABLED: value }, isMuseRalphEnabled), true, `enabled(${JSON.stringify(value)}) defaults on`);
  }
  const providerDefinitions = readFileSync(join(repoRoot, 'src/providers/provider-definitions.ts'), 'utf8');
  assert.ok(providerDefinitions.includes(`'muse'`), 'the muse provider definition exists');
  assert.ok(!providerDefinitions.includes('AIWG_MUSE_RALPH_ENABLED'),
    'the disable flag is unknown to the deploy/writer path — `aiwg use --provider muse` is unaffected');
  assert.ok(manifest.disableFlag.includes('AIWG_MUSE_RALPH_ENABLED'), 'the fixture contract pins the disable flag');
});

test('disabled registration leaves other providers intact and muse unresolvable', () => {
  const probe = `
import { ensureProvidersRegistered, listProviders, createProvider } from ${JSON.stringify(resolve(here, '../../../tools/ralph-external/lib/provider-adapter.mjs'))};
await ensureProvidersRegistered();
let muse = 'registered';
try { createProvider('muse'); } catch (error) { muse = error.message; }
process.stdout.write(JSON.stringify({ providers: listProviders().sort(), muse }));
`;
  const runProbe = extraEnv => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe],
      { encoding: 'utf8', env: { ...process.env, ...extraEnv }, timeout: 30_000 });
    assert.equal(child.status, 0, `probe failed: ${child.stderr}`);
    return JSON.parse(child.stdout);
  };
  const disabled = runProbe({ AIWG_MUSE_RALPH_ENABLED: '0' });
  assert.ok(!disabled.providers.includes('muse'), 'muse is not registered when disabled');
  assert.ok(disabled.providers.includes('claude') && disabled.providers.includes('pi'),
    'sibling providers are unaffected by the muse flag');
  assert.match(disabled.muse, /Unknown provider/, 'createProvider("muse") throws when disabled');
  const enabled = runProbe({ AIWG_MUSE_RALPH_ENABLED: undefined });
  assert.ok(enabled.providers.includes('muse'), 'muse registers by default');
});

test('launcher drives the offline stub with exactly the adapter-built argv', async () => {
  const { dir, cleanup } = scratch('muse-adapter-launch-');
  const receipt = join(dir, 'receipt.json');
  try {
    const adapter = new MuseAdapter();
    const launcher = new SessionLauncher();
    launcher.setProviderAdapter(adapter);
    let started = null;
    launcher.on('started', info => { started = info; });
    const result = await withEnv(
      { AIWG_MUSE_BIN: stub, AIWG_MUSE_STUB_SCENARIO: undefined, AIWG_MUSE_STUB_RECEIPT: receipt, CI: undefined, NO_COLOR: undefined },
      () => launcher.launch({ prompt: 'bounded fixture task', sessionId: 'aiwg-fixture-session',
        resumeSession: 'muse-job-1', workingDir: dir, stdoutPath: join(dir, 'stdout.log'), stderrPath: join(dir, 'stderr.log') }));
    assert.equal(result.exitCode, 0, 'the documented 0 exit means the turn completed');
    // Only a real muse resume id is forwarded; AIWG's tracking id never is.
    assert.deepEqual(started.args.slice(0, 4), ['exec', '--json', '--session-id', 'muse-job-1']);
    const observed = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.deepEqual(observed.argv, started.args, 'the child received exactly the adapter-built argv');
    assert.deepEqual(observed.env, { CI: 'true', NO_COLOR: '1' }, 'headless env overrides reach the child');
    const parsed = adapter.parseOutput(readFileSync(join(dir, 'stdout.log'), 'utf8'));
    assert.equal(parsed.events.length, 2, 'fixture JSONL events validate as framing');
    assert.equal(launcher.currentProcess, null);
  } finally { cleanup(); }
});

test('launcher surfaces the documented non-zero exit codes without live auth', async () => {
  for (const [scenario, exitCode] of [['exec-failure', 1], ['exec-usage-error', 2]]) {
    const { dir, cleanup } = scratch('muse-adapter-exit-');
    try {
      const launcher = new SessionLauncher();
      launcher.setProviderAdapter(new MuseAdapter());
      const result = await withEnv(
        { AIWG_MUSE_BIN: stub, AIWG_MUSE_STUB_SCENARIO: scenario, CI: undefined, NO_COLOR: undefined },
        () => launcher.launch({ prompt: 'p', workingDir: dir,
          stdoutPath: join(dir, 'stdout.log'), stderrPath: join(dir, 'stderr.log') }));
      assert.equal(result.exitCode, exitCode, `scenario ${scenario} exits ${exitCode} per the documented contract`);
    } finally { cleanup(); }
  }
});

test('muse export produces the transcript path offline via the adapter-built argv', () => {
  const { dir, cleanup } = scratch('muse-adapter-export-');
  try {
    const adapter = new MuseAdapter();
    const out = join(dir, 'run.json');
    const argv = adapter.buildExportArgs({ sessionId: 'uuid-9', out });
    const child = withEnv({ AIWG_MUSE_BIN: stub },
      () => spawnSync(process.execPath, [stub, ...argv], { encoding: 'utf8', timeout: 30_000 }));
    assert.equal(child.status, 0);
    assert.equal(child.stdout.trim(), out, 'stdout carries the absolute path written, per Meta docs');
    assert.ok(existsSync(out), 'the export document is written without network or auth');
    const document = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(document.export_schema_version, 1, 'the documented export schema version');
    assert.equal(document.sessions[0].session_id, 'uuid-9');
    assert.equal(document.diagnostics.unparseable_lines, 0);
  } finally { cleanup(); }
});

test('muse availability fails closed when the binary is missing or --version fails', async () => {
  const adapter = new MuseAdapter();
  assert.equal(await withEnv({ AIWG_MUSE_BIN: stub, AIWG_MUSE_STUB_SCENARIO: 'version-failure' }, () => adapter.isAvailable()), false);
  assert.equal(await withEnv({ AIWG_MUSE_BIN: join(tmpdir(), 'missing-muse-binary') }, () => adapter.isAvailable()), false);
  assert.equal(await withEnv({ AIWG_MUSE_BIN: stub }, () => adapter.isAvailable()), true);
  assert.match(await withEnv({ AIWG_MUSE_BIN: stub }, () => adapter.getVersion()), /Muse Code/);
});
