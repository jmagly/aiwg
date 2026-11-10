#!/usr/bin/env node
/** Released-binary qualification and stable promotion gate for Grok Build (#2580). */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { release as osRelease } from 'node:os';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const contractPath = join(root, 'docs/providers/grok-build-qualification.json');
const receiptSchema = 'aiwg.grok-build.qualification.v1';
export const platforms = ['linux', 'windows-powershell', 'wsl'];
export const checks = ['clean-install', 'existing-config', 'update', 'deploy', 'verify', 'refresh', 'uninstall',
  'operator-content', 'idempotence', 'path-safety', 'rollback', 'no-secret-leakage', 'compatibility'];

function fail(message) { throw new Error(message); }
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function execute(command, args, cwd, env = process.env) {
  return spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000,
    stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command), killSignal: 'SIGKILL' });
}

export function validateContract(contract) {
  if (contract.schema !== 'aiwg.grok-build.qualification-contract.v1') fail('Qualification contract schema mismatch');
  if (!/^\d+\.\d+\.\d+$/.test(contract.releasedVersion)) fail('Contract needs an exact released version');
  if (!/^[0-9a-f]{40}$/.test(contract.publicSourceCommit)) fail('Contract needs a full public source commit');
  if (!/^[0-9a-f]{40}$/.test(contract.upstreamSourceRevision)) fail('Contract needs a full upstream SOURCE_REV');
  for (const [name, claim] of Object.entries(contract.surfaces ?? {})) {
    if (!['native', 'unsupported', 'deferred'].includes(claim.status)) fail(`Unclassified surface: ${name}`);
    if (claim.status === 'native' && !['live-evidenced', 'fixture-backed', 'deferred'].includes(claim.qualification?.kind)) fail(`Native surface lacks evidence classification: ${name}`);
    if (claim.status === 'native' && claim.qualification.kind !== 'live-evidenced' && !claim.qualification.reason) fail(`Fixture-backed/deferred surface lacks missing evidence: ${name}`);
    if (claim.status !== 'native' && !claim.reason) fail(`Deferred/unsupported surface lacks reason: ${name}`);
  }
  if (!contract.surfaces?.instructions || !contract.surfaces?.skills) fail('Instruction and skill surfaces must be classified');
}

export function platformName(platform = process.platform, release = osRelease()) {
  if (platform === 'linux') return /microsoft|wsl/i.test(release) ? 'wsl' : 'linux';
  if (platform === 'win32') return 'windows-powershell';
  fail(`Unsupported qualification platform: ${platform}`);
}

function hasReviewableEvidence(reference, repositoryRoot) {
  // Offline promotion cannot establish that an HTTPS URL still exists or contains
  // the reviewed artifact. Keep a local copy in the repository instead.
  if (typeof reference !== 'string' || !/^(docs|test-results)\//.test(reference)
    || reference.includes('\\') || reference.includes('%')
    || reference.split('/').some(part => !part || part === '.' || part === '..')) return false;
  try {
    const canonicalRoot = realpathSync(repositoryRoot);
    const canonicalFile = realpathSync(resolve(repositoryRoot, reference));
    const withinRoot = relative(canonicalRoot, canonicalFile);
    const file = statSync(canonicalFile);
    return !!withinRoot && withinRoot !== '..' && !withinRoot.startsWith(`..${sep}`)
      && !isAbsolute(withinRoot) && file.isFile() && file.size > 0;
  } catch {
    return false;
  }
}

export function verifyPromotion(contract, receipts, providerStatus, repositoryRoot = root) {
  validateContract(contract);
  const errors = [];
  if (providerStatus !== 'stable') return { ready: false, gated: false, errors: [] };
  if (contract.capturedRelease?.version !== contract.releasedVersion) errors.push('Reviewed source release pin differs from captured release; needs current source review before promotion');
  for (const [name, claim] of Object.entries(contract.surfaces)) {
    if (claim.status === 'native' && (claim.qualification?.kind !== 'live-evidenced'
      || !hasReviewableEvidence(claim.qualification?.reference, repositoryRoot))) errors.push(`${name}: native claim lacks live evidence for captured release`);
  }
  for (const platform of platforms) {
    const matching = receipts.filter(r => r?.schema === receiptSchema && r.platform === platform
      && r.version === contract.releasedVersion && r.publicSourceCommit === contract.publicSourceCommit
      && r.upstreamSourceRevision === contract.upstreamSourceRevision);
    if (matching.length !== 1) { errors.push(`${platform}: requires exactly one current qualification receipt`); continue; }
    const receipt = matching[0];
    for (const check of checks) if (receipt.checks?.[check] !== 'pass') errors.push(`${platform}: ${check} not passed`);
    if (receipt.inspect !== 'pass' || receipt.buildVerify !== 'ready') errors.push(`${platform}: native inspection/deployment verification missing`);
    for (const [name, claim] of Object.entries(contract.surfaces)) {
      if (claim.status !== 'native') continue;
      if (receipt.surfaces?.[name] !== 'pass' || receipt.evidence?.[name]?.kind !== 'live'
        || !hasReviewableEvidence(receipt.evidence?.[name]?.reference, repositoryRoot)) {
        errors.push(`${platform}: native ${name} lacks live evidence`);
      }
    }
  }
  return { ready: errors.length === 0, gated: true, errors };
}

function providerStatus(contract) {
  // provider-definitions.ts is a facade; the provider seeds live in provider-seeds-*.ts beside it.
  const dir = join(root, 'src/providers');
  const definition = ['provider-definitions.ts', ...readdirSync(dir).filter(name => /^provider-seeds-.*\.ts$/.test(name)).sort()]
    .map(name => readFileSync(join(dir, name), 'utf8')).join('\n');
  const match = definition.match(/id: 'grok-build',[\s\S]*?status: '(experimental|stable)',[\s\S]*?version: '([^']+)',[\s\S]*?revision: '([^']+)'/);
  if (!match) fail('Cannot resolve Grok Build provider status');
  if (match[2] !== contract.releasedVersion || match[3] !== contract.publicSourceCommit) fail('Provider inventory and qualification contract release pins differ');
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

/** Read-only smoke: inspection is projected onto known fields, never copied verbatim. */
export function collectSmoke({ env = process.env, cwd = process.cwd(), contract = readJson(contractPath), execute: invoke = execute } = {}) {
  const skip = reason => ({ provider: 'grok-build', status: 'skipped', reason });
  if (env.AIWG_GROK_BUILD_LIVE_SMOKE !== '1') return skip('Set AIWG_GROK_BUILD_LIVE_SMOKE=1 explicitly');
  const authenticationMode = env.XAI_API_KEY ? 'api-key-environment'
    : ['interactive', 'managed'].includes(env.AIWG_GROK_BUILD_AUTH_MODE) ? env.AIWG_GROK_BUILD_AUTH_MODE : null;
  if (!authenticationMode) return skip('Login unavailable or undeclared; set AIWG_GROK_BUILD_AUTH_MODE after login');
  const failed = reason => ({ provider: 'grok-build', status: 'failed', reason });
  const binary = env.AIWG_GROK_BUILD_BIN || 'grok';
  const versionResult = invoke(binary, ['--version'], cwd, env);
  if (versionResult.error?.code === 'ENOENT') return skip('Grok Build binary unavailable');
  if (versionResult.error || versionResult.status !== 0) return failed('Version probe failed');
  const version = versionResult.stdout?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (version !== contract.capturedRelease?.version) return failed('Installed version differs from captured release');
  const inspection = invoke(binary, ['inspect'], cwd, env);
  if (inspection.error || inspection.status !== 0) {
    if (/login|log in|authenticat/i.test(inspection.stderr || '')) return skip('Grok Build login unavailable');
    return failed('Inspection failed; inspect local output privately');
  }
  const raw = inspection.stdout || '';
  // Only known deployed project paths/names survive. Drop user paths, config, prompts, IDs and arbitrary values.
  const instructions = [...new Set([...raw.matchAll(/(?:^|[\\/\s])((?:AGENTS\.md|\.grok[\\/]rules[\\/][a-z0-9_-]+\.md))(?=\s|$)/gim)].map(m => m[1].replaceAll('\\', '/')))];
  const skills = [...new Set([...raw.matchAll(/└\s+((?:aiwg-[a-z0-9-]+))\s+project\b/g)].map(m => m[1]))];
  const inspectOutput = { projectTrusted: /Project trusted:\s*yes/i.test(raw), instructions, skills };
  if (env.XAI_API_KEY && JSON.stringify(inspectOutput).includes(env.XAI_API_KEY)) return failed('Inspection contains credential material');
  if (!inspectOutput.projectTrusted || !instructions.includes('AGENTS.md') || !skills.length) return failed('Trusted project instructions and AIWG project skills required');
  const verification = invoke('aiwg', ['build-verify', '--provider', 'grok-build'], cwd, env);
  let parsed;
  try { parsed = JSON.parse(verification.stdout); } catch { return failed('Invalid provider receipt'); }
  if (verification.error || verification.status !== 0 || !parsed || parsed.schema !== 'aiwg.build.verify.v1'
    || parsed.provider !== 'grok-build' || parsed.status !== 'ready') return failed('Expected Grok Build provider receipt is not ready');
  return {
    schema: receiptSchema, provider: 'grok-build', status: 'passed', platform: platformName(), osRelease: osRelease(), version,
    recordedAt: new Date().toISOString(), authenticationMode,
    authenticationEvidence: 'environment presence or operator declaration; no credential/model validation',
    inspect: 'pass', inspectOutput, buildVerify: 'ready',
    deployedSurfaces: { instructions, skills, rules: instructions.filter(p => p.startsWith('.grok/rules/')) },
    expectedProviderReceipt: { schema: parsed.schema, provider: parsed.provider, status: parsed.status },
    surfaces: { instructions: 'pass', skills: 'pass' }, evidence: {},
    checks: Object.fromEntries(checks.map(name => [name, 'pending'])),
  };
}

export function smoke(args, contract, options = {}) {
  const result = collectSmoke({ ...options, contract });
  if (result.status === 'skipped') return result;
  if (result.status === 'failed') { process.exitCode = 1; return result; }
  const index = args.indexOf('--output');
  if (index < 0 || !args[index + 1]) fail('smoke requires --output <receipt.json>');
  const target = resolve(args[index + 1]);
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { status: result.status, platform: result.platform, version: result.version };
}

/** Compare the observed CLI vocabulary and schema signature, without invoking a model. */
export function compareCaptureSnapshot(snapshot, observed) {
  const changes = [];
  const missing = [];
  if (observed.version !== snapshot.version) changes.push('version');
  if (typeof observed.help !== 'string') missing.push('CLI help');
  else for (const token of snapshot.helpTokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(^|[^a-z0-9_-])${escaped}(?=$|[^a-z0-9_-])`, 'm').test(observed.help)) changes.push(`CLI help: ${token}`);
  }
  const compare = (label, expected, actual) => {
    if (!actual) { missing.push(label); return; }
    if (JSON.stringify([...new Set(actual)].sort()) !== JSON.stringify([...expected].sort())) changes.push(label);
  };
  compare('headless JSON keys', snapshot.jsonResultKeys, observed.json && Object.keys(observed.json));
  compare('streaming event types', snapshot.streamingEventTypes, observed.events?.map(event => event.type));
  return { status: changes.length ? 'drift' : missing.length ? 'partial' : 'current', changes, missing,
    contract: 'docs/providers/grok-build-qualification.json; docs/providers/grok-build-cli-evidence.md' };
}

function captureDrift(args) {
  const value = flag => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith('--')) fail(`Missing value for ${flag}`);
    return args[index + 1];
  };
  const snapshot = readJson(join(root, 'test/fixtures/providers/grok-build/capture-1.0.77/snapshot.json'));
  const fromFile = flag => value(flag) ? readFileSync(resolve(value(flag)), 'utf8') : undefined;
  const version = fromFile('--version-file') ?? execute(process.env.AIWG_GROK_BUILD_BIN || 'grok', ['--version']).stdout;
  const help = fromFile('--help-file') ?? execute(process.env.AIWG_GROK_BUILD_BIN || 'grok', ['--help']).stdout;
  const json = fromFile('--json-file');
  const stream = fromFile('--stream-file');
  let jsonSample, events;
  try {
    jsonSample = json ? JSON.parse(json) : undefined;
    events = stream ? stream.trim().split(/\r?\n/).map(line => JSON.parse(line)) : undefined;
  } catch { fail('Invalid capture JSON; review sample privately (content omitted)'); }
  const result = compareCaptureSnapshot(snapshot, { version: version?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1], help,
    json: jsonSample, events });
  if (result.status !== 'current') process.exitCode = 1;
  return result;
}

export function verifyUpstreamDrift(contract, publicCommit, sourceRevision) {
  if (!/^[0-9a-f]{40}$/.test(publicCommit)) fail('Upstream public commit shape changed');
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) fail('Upstream SOURCE_REV shape changed');
  if (publicCommit !== contract.publicSourceCommit) fail(`Upstream Grok Build public commit changed: ${contract.publicSourceCommit} -> ${publicCommit}; review docs/providers/grok-build-qualification.json and inspect/config contracts`);
  if (sourceRevision !== contract.upstreamSourceRevision) fail(`Upstream Grok Build SOURCE_REV changed: ${contract.upstreamSourceRevision} -> ${sourceRevision}; review docs/providers/grok-build-qualification.json and inspect/config contracts`);
  return { status: 'current', publicCommit, sourceRevision };
}

async function drift(contract) {
  const [commitResponse, revisionResponse] = await Promise.all([
    fetch('https://api.github.com/repos/xai-org/grok-build/commits/main', { signal: AbortSignal.timeout(15_000) }),
    fetch('https://raw.githubusercontent.com/xai-org/grok-build/main/SOURCE_REV', { signal: AbortSignal.timeout(15_000) }),
  ]);
  if (!commitResponse.ok) fail(`Upstream public commit fetch failed: HTTP ${commitResponse.status}`);
  if (!revisionResponse.ok) fail(`Upstream SOURCE_REV fetch failed: HTTP ${revisionResponse.status}`);
  const commit = await commitResponse.json();
  return verifyUpstreamDrift(contract, commit.sha, (await revisionResponse.text()).trim());
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
  } else if (mode === 'drift' && args.includes('--capture')) console.log(JSON.stringify(captureDrift(args)));
  else if (mode === 'drift') console.log(JSON.stringify(await drift(contract)));
  else fail('Usage: grok-build-qualification.mjs <smoke --output FILE|gate [--evidence-dir DIR]|drift [--capture --version-file FILE --help-file FILE --json-file FILE --stream-file FILE]>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
