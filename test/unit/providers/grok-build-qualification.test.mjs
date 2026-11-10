import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checks, platforms, platformName, validateContract, verifyPromotion, verifyUpstreamDrift } from '../../../tools/providers/grok-build-qualification.mjs';

const recordedContract = JSON.parse(readFileSync(join(process.cwd(), 'docs/providers/grok-build-qualification.json'), 'utf8'));
// Synthetic complete evidence exercises the positive gate without claiming a live PUW.
const contract = structuredClone(recordedContract);
contract.capturedRelease = { version: contract.releasedVersion };
for (const claim of Object.values(contract.surfaces)) claim.qualification = { kind: 'live-evidenced', reference: 'docs/providers/evidence/example.json' };
const receipt = platform => ({
  schema: 'aiwg.grok-build.qualification.v1', platform,
  version: contract.releasedVersion, publicSourceCommit: contract.publicSourceCommit,
  upstreamSourceRevision: contract.upstreamSourceRevision,
  inspect: 'pass', buildVerify: 'ready',
  checks: Object.fromEntries(checks.map(name => [name, 'pass'])),
  surfaces: Object.fromEntries(Object.entries(contract.surfaces)
    .filter(([, claim]) => claim.status === 'native').map(([name]) => [name, 'pass'])),
  evidence: Object.fromEntries(Object.entries(contract.surfaces)
    .filter(([, claim]) => claim.status === 'native').map(([name]) => [name, { kind: 'live', reference: 'docs/providers/evidence/example.json' }])),
});

test('platform labels distinguish native Linux from WSL and Windows PowerShell', () => {
  assert.equal(platformName('linux', '6.8.0-generic'), 'linux');
  assert.equal(platformName('linux', '6.6.87.2-microsoft-standard-WSL2'), 'wsl');
  assert.equal(platformName('win32', '10.0'), 'windows-powershell');
});

test('stable promotion requires a complete receipt for each OS and every native surface', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'aiwg-grok-evidence-'));
  try {
    mkdirSync(join(fixtureRoot, 'docs/providers/evidence'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'docs/providers/evidence/example.json'), '{"observed":"fixture"}\n');
    validateContract(contract);
    const receipts = platforms.map(receipt);
    const gate = items => verifyPromotion(contract, items, 'stable', fixtureRoot);
    assert.deepEqual(gate(receipts), { ready: true, gated: true, errors: [] });
    const missing = receipts.slice(1);
    assert.match(gate(missing).errors.join(' '), /linux.*receipt/);
    assert.match(gate([...receipts, receipt('linux')]).errors.join(' '), /linux.*exactly one/);
    const incomplete = platforms.map(receipt);
    incomplete[0].checks.rollback = 'pending';
    incomplete[1].surfaces.mcp = 'pending';
    incomplete[2].evidence.acp.reference = 'unreviewed-local-path';
    assert.match(gate(incomplete).errors.join(' '), /linux: rollback not passed/);
    assert.match(gate(incomplete).errors.join(' '), /windows-powershell: native mcp lacks live evidence/);
    assert.match(gate(incomplete).errors.join(' '), /wsl: native acp lacks live evidence/);
    assert.equal(verifyPromotion(contract, [], 'experimental').gated, false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('stable promotion rejects missing, empty, remote, and escaping evidence references', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'aiwg-grok-evidence-'));
  const outsideRoot = mkdtempSync(join(tmpdir(), 'aiwg-grok-outside-'));
  try {
    mkdirSync(join(fixtureRoot, 'docs/evidence'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'test-results'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'test-results/live.json'), '{"observed":"fixture"}\n');
    writeFileSync(join(fixtureRoot, 'docs/evidence/empty.json'), '');
    mkdirSync(join(fixtureRoot, 'docs/providers/evidence'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'docs/providers/evidence/example.json'), '{"observed":"fixture"}');
    writeFileSync(join(outsideRoot, 'secret.json'), '{"secret":"outside"}\n');
    symlinkSync(join(outsideRoot, 'secret.json'), join(fixtureRoot, 'docs/evidence/escape.json'));
    const candidate = platforms.map(receipt);
    const gate = () => verifyPromotion(contract, candidate, 'stable', fixtureRoot);
    for (const entry of candidate) for (const surface of Object.keys(entry.evidence)) {
      entry.evidence[surface].reference = 'test-results/live.json';
    }
    assert.deepEqual(gate(), { ready: true, gated: true, errors: [] });
    for (const reference of [
      'docs/evidence/missing.json', 'docs/evidence/empty.json', 'docs/evidence',
      'docs/evidence/escape.json', 'docs/../../secret.json', 'docs/./evidence/empty.json',
      'docs\\evidence\\escape.json', 'docs/%2e%2e/secret.json',
      'https://example.com/live.json', 'docs/evidence/../evidence/empty.json',
    ]) {
      candidate[0].evidence.acp.reference = reference;
      assert.match(gate().errors.join(' '), /linux: native acp lacks live evidence/, reference);
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('contract rejects unclassified surfaces and unverifiable release pins', () => {
  assert.throws(() => validateContract({ ...contract, releasedVersion: 'main' }), /exact released version/);
  assert.throws(() => validateContract({ ...contract, publicSourceCommit: 'short' }), /full public source commit/);
  assert.throws(() => validateContract({ ...contract, upstreamSourceRevision: 'short' }), /full upstream SOURCE_REV/);
  assert.throws(() => validateContract({ ...contract, surfaces: { ...contract.surfaces, x: { status: 'maybe' } } }), /Unclassified surface/);
  assert.throws(() => validateContract({ ...contract, surfaces: { ...contract.surfaces, x: { status: 'deferred' } } }), /lacks reason/);
  assert.throws(() => validateContract({ ...contract, surfaces: { ...contract.surfaces, x: { status: 'native' } } }), /lacks evidence classification/);
  assert.throws(() => validateContract({ ...contract, surfaces: { ...contract.surfaces, x: { status: 'native', qualification: { kind: 'fixture-backed' } } } }), /lacks missing evidence/);
});

test('drift distinguishes the public Git commit from its internal SOURCE_REV', () => {
  assert.deepEqual(verifyUpstreamDrift(contract, contract.publicSourceCommit, contract.upstreamSourceRevision), {
    status: 'current', publicCommit: contract.publicSourceCommit, sourceRevision: contract.upstreamSourceRevision,
  });
  assert.throws(() => verifyUpstreamDrift(contract, 'a'.repeat(40), contract.upstreamSourceRevision), /public commit changed/);
  assert.throws(() => verifyUpstreamDrift(contract, contract.publicSourceCommit, 'b'.repeat(40)), /SOURCE_REV changed/);
});

test('the gate resolves the Grok Build provider status from the real repository layout', async () => {
  // The provider definitions are split across a facade and seed modules; the CI gate must still find them.
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../../../tools/providers/grok-build-qualification.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [script, 'gate'], { encoding: 'utf8', timeout: 60_000 });
  const result = JSON.parse(out);
  assert.equal(typeof result.ready, 'boolean');
  assert.ok(Array.isArray(result.errors));
});


test('smoke skips before executing anything without explicit opt-in, binary, or login', async () => {
  const { collectSmoke } = await import('../../../tools/providers/grok-build-qualification.mjs');
  assert.equal(typeof collectSmoke, 'function');
  const forbidden = () => { throw new Error('must not execute'); };
  assert.equal(collectSmoke({ env: {}, execute: forbidden }).status, 'skipped');
  assert.equal(collectSmoke({ env: { AIWG_GROK_BUILD_LIVE_SMOKE: '1' }, execute: forbidden }).status, 'skipped');
  const missing = collectSmoke({ env: { AIWG_GROK_BUILD_LIVE_SMOKE: '1', XAI_API_KEY: 'synthetic-canary' },
    execute: () => ({ error: { code: 'ENOENT' } }) });
  assert.match(missing.reason, /binary unavailable/);
});

test('smoke records sanitized inspection, declared auth, deployed surfaces and expected provider receipt', async () => {
  const { collectSmoke } = await import('../../../tools/providers/grok-build-qualification.mjs');
  assert.equal(typeof collectSmoke, 'function');
  const calls = [];
  const report = collectSmoke({ env: { AIWG_GROK_BUILD_LIVE_SMOKE: '1', XAI_API_KEY: 'synthetic-canary' },
    cwd: '/private/operator/project', contract: recordedContract,
    execute: (binary, args) => {
      calls.push([binary, args]);
      if (args[0] === '--version') return { status: 0, stdout: 'grok 1.0.77 (50ca579fa996) [stable]' };
      if (args[0] === 'inspect') return { status: 0, stdout: `
  Environment
  └ CWD: /private/operator/project
  └ Project trusted: yes
  Project Instructions (2)
  └ /private/operator/project/AGENTS.md (project, ~12 tokens)
  └ /private/operator/project/.grok/rules/skill-discovery.md (project, ~12 tokens)
  Skills (1)
  └ aiwg-utils-quickref  project
  Config Sources
  └ User: /private/operator/.grok/config.toml
  └ sensitive: synthetic-canary
` };
      return { status: 0, stdout: JSON.stringify({ schema: 'aiwg.build.verify.v1', provider: 'grok-build', status: 'ready', secret: 'synthetic-canary' }) };
    } });
  assert.equal(report.status, 'passed');
  assert.equal(report.version, '1.0.77');
  assert.equal(report.authenticationMode, 'api-key-environment');
  assert.equal(report.inspectOutput.projectTrusted, true);
  assert.deepEqual(report.inspectOutput.instructions, ['AGENTS.md', '.grok/rules/skill-discovery.md']);
  assert.deepEqual(report.deployedSurfaces.skills, ['aiwg-utils-quickref']);
  assert.deepEqual(report.expectedProviderReceipt, { schema: 'aiwg.build.verify.v1', provider: 'grok-build', status: 'ready' });
  assert.doesNotMatch(JSON.stringify(report), /\/private\/|synthetic-canary/);
  assert.deepEqual(calls.map(([, args]) => args), [['--version'], ['inspect'], ['build-verify', '--provider', 'grok-build']]);
});

test('smoke cannot count an untrusted project, mismatched version or wrong provider receipt as passed', async () => {
  const { collectSmoke } = await import('../../../tools/providers/grok-build-qualification.mjs');
  assert.equal(typeof collectSmoke, 'function');
  const run = (version, inspect, receipt) => collectSmoke({
    env: { AIWG_GROK_BUILD_LIVE_SMOKE: '1', AIWG_GROK_BUILD_AUTH_MODE: 'interactive' }, contract: recordedContract,
    execute: (_, args) => ({ status: 0, stdout: args[0] === '--version' ? version : args[0] === 'inspect' ? inspect : JSON.stringify(receipt) }),
  });
  assert.equal(run('grok 1.0.77', 'Project trusted: no', {}).status, 'failed');
  assert.equal(run('grok 1.0.78', '', {}).status, 'failed');
  assert.equal(run('grok 1.0.77', 'Project trusted: yes\n  └ AGENTS.md (project)\n  └ aiwg-utils-quickref project', { status: 'ready', provider: 'grokbot' }).status, 'failed');
});

test('captured release and fixture-backed native claims block stable promotion', () => {
  const mismatch = { ...contract, capturedRelease: { version: '1.0.77' } };
  assert.match(verifyPromotion(mismatch, [], 'stable').errors.join(' '), /release pin/);
  const candidate = structuredClone(contract);
  candidate.surfaces.acp.qualification = { kind: 'fixture-backed', reason: 'needs ACP capture' };
  assert.match(verifyPromotion(candidate, [], 'stable').errors.join(' '), /acp.*live evidence/);
});

test('capture drift compares help tokens and schema keys without accepting version drift or missing samples', async () => {
  const { compareCaptureSnapshot } = await import('../../../tools/providers/grok-build-qualification.mjs');
  assert.equal(typeof compareCaptureSnapshot, 'function');
  const snapshot = { version: '1.0.77', helpTokens: ['--no-auto-update', '--output-format'], jsonResultKeys: ['text', 'usage'], streamingEventTypes: ['end', 'text'] };
  const observed = { version: '1.0.77', help: '--output-format FORMAT\r\n--no-auto-update', json: { usage: {}, text: 'ok' }, events: [{ type: 'text' }, { type: 'end' }] };
  assert.equal(compareCaptureSnapshot(snapshot, observed).status, 'current');
  for (const changed of [{ version: '1.0.78' }, { help: '--output-format FORMAT' }, { json: { text: 'ok', newField: 1 } }, { events: [{ type: 'result' }] }]) {
    const result = compareCaptureSnapshot(snapshot, { ...observed, ...changed });
    assert.equal(result.status, 'drift');
    assert.match(result.contract, /grok-build/);
  }
  assert.equal(compareCaptureSnapshot(snapshot, { version: '1.0.77', help: observed.help }).status, 'partial');
});


test('structural capture fixtures replay exactly and expose their missing evidence', async () => {
  const { collectSmoke, compareCaptureSnapshot } = await import('../../../tools/providers/grok-build-qualification.mjs');
  const fixture = name => readFileSync(new URL(`../../fixtures/providers/grok-build/capture-1.0.77/${name}`, import.meta.url), 'utf8');
  const snapshot = JSON.parse(fixture('snapshot.json'));
  assert.equal(compareCaptureSnapshot(snapshot, { version: snapshot.version, help: snapshot.helpTokens.join(' '),
    json: JSON.parse(fixture('result.json')), events: fixture('events.jsonl').trim().split('\n').map(JSON.parse) }).status, 'current');
  assert.ok(snapshot.missingEvidence.includes('Full CLI --help capture'));
  for (const [name, status] of [['trusted-project', 'passed'], ['untrusted-cwd', 'failed']]) {
    const result = collectSmoke({ env: { AIWG_GROK_BUILD_LIVE_SMOKE: '1', AIWG_GROK_BUILD_AUTH_MODE: 'managed' }, contract: recordedContract,
      execute: (_, args) => ({ status: 0, stdout: args[0] === '--version' ? 'grok 1.0.77' : args[0] === 'inspect' ? fixture(`inspect-${name}.txt`)
        : JSON.stringify({ schema: 'aiwg.build.verify.v1', provider: 'grok-build', status: 'ready' }) }) });
    assert.equal(result.status, status);
  }
});

test('smoke CLI skips without opt-in even with no output path and never invokes a binary', async () => {
  const { execFileSync } = await import('node:child_process');
  const env = { ...process.env, AIWG_GROK_BUILD_BIN: '/must-not-run/grok' };
  delete env.AIWG_GROK_BUILD_LIVE_SMOKE;
  const result = execFileSync(process.execPath, ['tools/providers/grok-build-qualification.mjs', 'smoke'], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(JSON.parse(result).status, 'skipped');
});

test('smoke skips a login failure without leaking the diagnostic or credentials', async () => {
  const { collectSmoke } = await import('../../../tools/providers/grok-build-qualification.mjs');
  const result = collectSmoke({ env: { AIWG_GROK_BUILD_LIVE_SMOKE: '1', AIWG_GROK_BUILD_AUTH_MODE: 'interactive' }, contract: recordedContract,
    execute: (_, args) => args[0] === '--version' ? { status: 0, stdout: 'grok 1.0.77' }
      : { status: 1, stderr: 'Authentication failed synthetic-canary /private/user' } });
  assert.equal(result.status, 'skipped');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-canary|private/);
});


test('smoke receipt write is exclusive and never changes operator project content', async () => {
  const { smoke } = await import('../../../tools/providers/grok-build-qualification.mjs');
  const project = mkdtempSync(join(tmpdir(), 'aiwg-grok-smoke-write-'));
  try {
    mkdirSync(join(project, '.grok'));
    const operator = join(project, '.grok/config.toml');
    writeFileSync(operator, '# synthetic operator canary\n');
    const target = join(project, 'receipt.json');
    const options = { cwd: project, env: { AIWG_GROK_BUILD_LIVE_SMOKE: '1', AIWG_GROK_BUILD_AUTH_MODE: 'interactive' },
      execute: (_, args) => ({ status: 0, stdout: args[0] === '--version' ? 'grok 1.0.77' : args[0] === 'inspect'
        ? 'Project trusted: yes\n  └ AGENTS.md (project)\n  └ aiwg-utils-quickref project'
        : JSON.stringify({ schema: 'aiwg.build.verify.v1', provider: 'grok-build', status: 'ready' }) }) };
    assert.equal(smoke(['--output', target], recordedContract, options).status, 'passed');
    const before = readFileSync(target, 'utf8');
    assert.throws(() => smoke(['--output', target], recordedContract, options), /EEXIST/);
    assert.equal(readFileSync(target, 'utf8'), before);
    assert.equal(readFileSync(operator, 'utf8'), '# synthetic operator canary\n');
    if (process.platform !== 'win32') assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('offline drift CLI detects changed schema and never runs Grok', async () => {
  const { spawnSync } = await import('node:child_process');
  const folder = mkdtempSync(join(tmpdir(), 'aiwg-grok-drift-'));
  try {
    const fixtureRoot = join(process.cwd(), 'test/fixtures/providers/grok-build/capture-1.0.77');
    const snapshot = JSON.parse(readFileSync(join(fixtureRoot, 'snapshot.json'), 'utf8'));
    const version = join(folder, 'version.txt'), help = join(folder, 'help.txt');
    writeFileSync(version, 'grok 1.0.77');
    writeFileSync(help, snapshot.helpTokens.join('\n'));
    const args = ['tools/providers/grok-build-qualification.mjs', 'drift', '--capture',
      '--version-file', version, '--help-file', help, '--json-file', join(fixtureRoot, 'result.json'), '--stream-file', join(fixtureRoot, 'events.jsonl')];
    const options = { env: { ...process.env, AIWG_GROK_BUILD_BIN: '/must-not-run/grok' }, encoding: 'utf8', timeout: 30_000 };
    const current = spawnSync(process.execPath, args, { ...options, timeout: 30_000 });
    assert.equal(current.status, 0, current.stderr);
    assert.equal(JSON.parse(current.stdout).status, 'current');
    writeFileSync(help, '--new-only');
    const changed = spawnSync(process.execPath, args, { ...options, timeout: 30_000 });
    assert.equal(changed.status, 1);
    assert.equal(JSON.parse(changed.stdout).status, 'drift');
    writeFileSync(version, 'grok 1.0.78');
    const bump = spawnSync(process.execPath, args, { ...options, timeout: 30_000 });
    assert.equal(JSON.parse(bump.stdout).changes.includes('version'), true);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});


test('credential-shaped instruction or skill names are never written to the smoke result', async () => {
  const { collectSmoke } = await import('../../../tools/providers/grok-build-qualification.mjs');
  const result = collectSmoke({ env: { AIWG_GROK_BUILD_LIVE_SMOKE: '1', XAI_API_KEY: 'synthetic-canary' }, contract: recordedContract,
    execute: (_, args) => ({ status: 0, stdout: args[0] === '--version' ? 'grok 1.0.77'
      : 'Project trusted: yes\n  └ AGENTS.md (project)\n  └ aiwg-synthetic-canary project' }) });
  assert.equal(result.status, 'failed');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-canary/);
});
