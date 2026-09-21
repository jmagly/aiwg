#!/usr/bin/env node
/** Released-binary qualification and stable promotion gate for Grok Build (#2580). */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { release as osRelease } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const contractPath = join(root, 'docs/providers/grok-build-qualification.json');
const receiptSchema = 'aiwg.grok-build.qualification.v1';
export const platforms = ['linux', 'macos', 'windows-powershell', 'wsl'];
export const checks = ['clean-install', 'existing-config', 'update', 'deploy', 'verify', 'refresh', 'uninstall',
  'operator-content', 'idempotence', 'path-safety', 'rollback', 'no-secret-leakage', 'compatibility'];

function fail(message) { throw new Error(message); }
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000,
    shell: process.platform === 'win32',
  });
  if (result.error || result.status !== 0) fail(`${command} ${args.join(' ')} failed; inspect the local command output (it is intentionally not copied into the receipt)`);
  return result.stdout.trim();
}

export function validateContract(contract) {
  if (contract.schema !== 'aiwg.grok-build.qualification-contract.v1') fail('Qualification contract schema mismatch');
  if (!/^\d+\.\d+\.\d+$/.test(contract.releasedVersion)) fail('Contract needs an exact released version');
  if (!/^[0-9a-f]{40}$/.test(contract.upstreamRevision)) fail('Contract needs a full upstream source revision');
  for (const [name, claim] of Object.entries(contract.surfaces ?? {})) {
    if (!['native', 'unsupported', 'deferred'].includes(claim.status)) fail(`Unclassified surface: ${name}`);
    if (claim.status !== 'native' && !claim.reason) fail(`Deferred/unsupported surface lacks reason: ${name}`);
  }
  if (!contract.surfaces?.instructions || !contract.surfaces?.skills) fail('Instruction and skill surfaces must be classified');
}

export function platformName(platform = process.platform, release = osRelease()) {
  if (platform === 'linux') return /microsoft|wsl/i.test(release) ? 'wsl' : 'linux';
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows-powershell';
  fail(`Unsupported qualification platform: ${platform}`);
}

export function verifyPromotion(contract, receipts, providerStatus) {
  validateContract(contract);
  const errors = [];
  if (providerStatus !== 'stable') return { ready: false, gated: false, errors: [] };
  for (const platform of platforms) {
    const matching = receipts.filter(r => r?.schema === receiptSchema && r.platform === platform
      && r.version === contract.releasedVersion && r.upstreamRevision === contract.upstreamRevision);
    if (matching.length !== 1) { errors.push(`${platform}: requires exactly one current qualification receipt`); continue; }
    const receipt = matching[0];
    for (const check of checks) if (receipt.checks?.[check] !== 'pass') errors.push(`${platform}: ${check} not passed`);
    if (receipt.inspect !== 'pass' || receipt.buildVerify !== 'ready') errors.push(`${platform}: native inspection/deployment verification missing`);
    for (const [name, claim] of Object.entries(contract.surfaces)) {
      if (claim.status !== 'native') continue;
      if (receipt.surfaces?.[name] !== 'pass' || receipt.evidence?.[name]?.kind !== 'live'
        || !/^https:\/\/|^docs\/|^test-results\//.test(receipt.evidence?.[name]?.reference ?? '')) {
        errors.push(`${platform}: native ${name} lacks live evidence`);
      }
    }
  }
  return { ready: errors.length === 0, gated: true, errors };
}

function providerStatus(contract) {
  const definition = readFileSync(join(root, 'src/providers/provider-definitions.ts'), 'utf8');
  const match = definition.match(/id: 'grok-build',[\s\S]*?status: '(experimental|stable)',[\s\S]*?version: '([^']+)',[\s\S]*?revision: '([^']+)'/);
  if (!match) fail('Cannot resolve Grok Build provider status');
  if (match[2] !== contract.releasedVersion || match[3] !== contract.upstreamRevision) fail('Provider inventory and qualification contract release pins differ');
  const provider = definition.slice(match.index, definition.indexOf("matrixRef: 'grok-build'", match.index));
  for (const [surface, pattern] of [
    ['mcp', /mcpInjection: 'grok-build'/],
    ['hooks', /hookBridge: 'grok-build'/],
    ['subagents', /artifacts:\s*\{\s*agents: '\.grok\/agents'/],
  ]) {
    if (pattern.test(provider) && contract.surfaces[surface]?.status !== 'native') fail(`Provider claims ${surface}, but qualification contract does not classify it native`);
  }
  return match[1];
}

function smoke(args, contract) {
  const index = args.indexOf('--output');
  if (index < 0 || !args[index + 1]) fail('smoke requires --output <receipt.json>');
  const target = resolve(args[index + 1]);
  if (existsSync(target)) fail('Refusing to replace an existing qualification receipt');
  const cwd = process.cwd();
  for (const file of ['WORKSPACE.md', 'AIWG.md', 'AGENTS.md']) if (!existsSync(join(cwd, file))) fail(`Missing generated context: ${file}`);
  const agents = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
  if (agents.indexOf('WORKSPACE.md') < 0 || agents.indexOf('AIWG.md') < agents.indexOf('WORKSPACE.md')) fail('AGENTS.md does not load canonical WORKSPACE.md before AIWG.md');
  const versionText = run('grok', ['--version'], cwd);
  const version = versionText.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (version !== contract.releasedVersion) fail(`Expected released Grok Build ${contract.releasedVersion}, observed ${version || 'unknown'}`);
  const inspect = run('grok', ['inspect', '--json'], cwd);
  let parsed;
  try { parsed = JSON.parse(inspect); } catch { fail('grok inspect --json did not return JSON'); }
  if (!Array.isArray(parsed.projectInstructions) || !Array.isArray(parsed.skills)) fail('InspectReport instruction/skill shape changed');
  const hasInstructions = parsed.projectInstructions.some(v => /(^|[\\/])AGENTS\.md$/.test(String(v.path ?? '')));
  const hasSkills = parsed.skills.some(v => /aiwg/i.test(String(v.name ?? v.source?.path ?? '')));
  if (!hasInstructions || !hasSkills) fail('grok inspect does not report deployed AGENTS.md and AIWG skills');
  const verification = JSON.parse(run('aiwg', ['build-verify', '--provider', 'grok-build'], cwd));
  if (verification.status !== 'ready') fail('aiwg build-verify is not ready');
  const receipt = {
    schema: receiptSchema, platform: platformName(), version, upstreamRevision: contract.upstreamRevision,
    recordedAt: new Date().toISOString(),
    authenticationMode: process.env.XAI_API_KEY ? 'api-key-environment' : 'interactive-or-managed',
    inspect: 'pass', buildVerify: 'ready',
    surfaces: { instructions: 'pass', skills: 'pass' },
    evidence: {},
    // Manual PUW results are added by the operator after running the documented matrix.
    checks: Object.fromEntries(checks.map(name => [name, 'pending'])),
  };
  writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { receipt: target, platform: receipt.platform, version, inspect: receipt.inspect, buildVerify: receipt.buildVerify };
}

function drift(contract) {
  const url = 'https://raw.githubusercontent.com/xai-org/grok-build/main/SOURCE_REV';
  return fetch(url, { signal: AbortSignal.timeout(15_000) }).then(async response => {
    if (!response.ok) fail(`Upstream SOURCE_REV fetch failed: HTTP ${response.status}`);
    const revision = (await response.text()).trim();
    if (!/^[0-9a-f]{40}$/.test(revision)) fail('Upstream SOURCE_REV shape changed');
    if (revision !== contract.upstreamRevision) fail(`Upstream Grok Build source changed: ${contract.upstreamRevision} -> ${revision}; review docs/providers/grok-build-qualification.json and inspect/config contracts`);
    return { status: 'current', revision };
  });
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const contract = readJson(contractPath);
  validateContract(contract);
  if (mode === 'smoke') console.log(JSON.stringify(smoke(args, contract)));
  else if (mode === 'gate') {
    const evidenceDir = resolve(args[args.indexOf('--evidence-dir') + 1] || 'docs/providers/grok-build-evidence');
    const receipts = existsSync(evidenceDir) ? readdirSync(evidenceDir).filter(name => name.endsWith('.json')).map(name => readJson(join(evidenceDir, name))) : [];
    const result = verifyPromotion(contract, receipts, providerStatus(contract));
    console.log(JSON.stringify(result));
    if (result.errors.length) process.exitCode = 1;
  } else if (mode === 'drift') console.log(JSON.stringify(await drift(contract)));
  else fail('Usage: grok-build-qualification.mjs <smoke --output FILE|gate [--evidence-dir DIR]|drift>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
