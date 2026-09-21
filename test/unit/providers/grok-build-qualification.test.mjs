import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checks, platforms, platformName, validateContract, verifyPromotion } from '../../../tools/providers/grok-build-qualification.mjs';

const contract = JSON.parse(readFileSync(join(process.cwd(), 'docs/providers/grok-build-qualification.json'), 'utf8'));
const receipt = platform => ({
  schema: 'aiwg.grok-build.qualification.v1', platform,
  version: contract.releasedVersion, upstreamRevision: contract.upstreamRevision,
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
  assert.equal(platformName('darwin', '24.0'), 'macos');
  assert.equal(platformName('win32', '10.0'), 'windows-powershell');
});

test('stable promotion requires a complete receipt for each OS and every native surface', () => {
  validateContract(contract);
  const receipts = platforms.map(receipt);
  assert.deepEqual(verifyPromotion(contract, receipts, 'stable'), { ready: true, gated: true, errors: [] });
  const missing = receipts.slice(1);
  assert.match(verifyPromotion(contract, missing, 'stable').errors.join(' '), /linux.*receipt/);
  assert.match(verifyPromotion(contract, [...receipts, receipt('linux')], 'stable').errors.join(' '), /linux.*exactly one/);
  const incomplete = platforms.map(receipt);
  incomplete[0].checks.rollback = 'pending';
  incomplete[1].surfaces.mcp = 'pending';
  incomplete[2].evidence.acp.reference = 'unreviewed-local-path';
  assert.match(verifyPromotion(contract, incomplete, 'stable').errors.join(' '), /linux: rollback not passed/);
  assert.match(verifyPromotion(contract, incomplete, 'stable').errors.join(' '), /macos: native mcp lacks live evidence/);
  assert.match(verifyPromotion(contract, incomplete, 'stable').errors.join(' '), /windows-powershell: native acp lacks live evidence/);
  assert.equal(verifyPromotion(contract, [], 'experimental').gated, false);
});

test('contract rejects unclassified surfaces and unverifiable release pins', () => {
  assert.throws(() => validateContract({ ...contract, releasedVersion: 'main' }), /exact released version/);
  assert.throws(() => validateContract({ ...contract, surfaces: { ...contract.surfaces, x: { status: 'maybe' } } }), /Unclassified surface/);
  assert.throws(() => validateContract({ ...contract, surfaces: { ...contract.surfaces, x: { status: 'deferred' } } }), /lacks reason/);
});
