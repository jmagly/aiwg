import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checks, platforms, platformName, validateContract, verifyPromotion, verifyUpstreamDrift } from '../../../tools/providers/grok-build-qualification.mjs';

const contract = JSON.parse(readFileSync(join(process.cwd(), 'docs/providers/grok-build-qualification.json'), 'utf8'));
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
});

test('drift distinguishes the public Git commit from its internal SOURCE_REV', () => {
  assert.deepEqual(verifyUpstreamDrift(contract, contract.publicSourceCommit, contract.upstreamSourceRevision), {
    status: 'current', publicCommit: contract.publicSourceCommit, sourceRevision: contract.upstreamSourceRevision,
  });
  assert.throws(() => verifyUpstreamDrift(contract, 'a'.repeat(40), contract.upstreamSourceRevision), /public commit changed/);
  assert.throws(() => verifyUpstreamDrift(contract, contract.publicSourceCommit, 'b'.repeat(40)), /SOURCE_REV changed/);
});
