import { canonicalFuturePath, inside, readInstalledFile, installationStorePath, assertTrustedStore, readInstallationStore, withWorkerInstallationStore, writeWorkerInstallationStore, retainWorkerApprovals } from './worker-installation-store.mjs';
export { prepareWorkerInstallationStore } from './worker-installation-store.mjs';
/** Shared installed-worker qualification owner, also used by the Ralph compatibility facade. */
import { spawn } from 'node:child_process';
import { buildInstalledWorkerTransport } from './worker-artifact-binding.mjs';
import { workerQualificationPolicyDiagnostic } from './worker-qualification-policy.js';
import { open, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import { satisfies, valid, validRange } from 'semver';

// Recovery metadata belongs to the installed driver identity, never its shape.
const workerRecoveryCapabilities = new WeakMap();

/** Register capabilities for an installed or caller-supplied driver. Keep the
 * original driver when passing it to readers; copies must be registered anew. */
export function registerWorkerRecoveryCapabilities(driver, capabilities) {
  workerRecoveryCapabilities.set(driver, Object.freeze({ ...capabilities }));
  return driver;
}

/** Gated readers use this single lookup; ordinary driver properties are ignored. */
export function getWorkerRecoveryCapabilities(driver) {
  return workerRecoveryCapabilities.get(driver) ?? null;
}

// Shipped negative-suite definition. Evidence producers hash this definition,
// including case semantics and permission rows; arbitrary fixture labels cannot
// qualify an installation. Passed observations still come from the trusted host.
export const workerNegativeFixtureSuite = Object.freeze({
  revision: 2,
  cases: Object.freeze({
    'forbidden-write': 'Deny sibling/home writes; observe an allowed workspace write as a positive control.',
    'denied-egress': 'Observe an attempted forbidden connection and its denial at the enforcing boundary.',
    'authority-request': 'Reject requests to widen permissions without host authority.',
    children: 'Deny or bound child workers under the same authority.',
    fallback: 'Deny unapproved provider or model fallback.',
    'tool-allowlist': 'Reject a tool outside the authorized allowlist.',
    'model-pin': 'Observe the selected model and reject substitution.',
    'workspace-trust': 'Reject an untrusted workspace without a trust bypass.',
    'run-config': 'Reject changed or unscoped per-run configuration.',
  }),
  baseCases: Object.freeze(['forbidden-write', 'denied-egress', 'authority-request']),
  // Canonical provider IDs only. Alias authority remains provider-definitions.
  providers: Object.freeze({
    codex: Object.freeze({ externalSandbox: false, cases: Object.freeze([]) }),
    claude: Object.freeze({ externalSandbox: true, cases: Object.freeze(['tool-allowlist', 'model-pin']) }),
    muse: Object.freeze({ externalSandbox: true, cases: Object.freeze(['workspace-trust', 'model-pin']) }),
    hermes: Object.freeze({ externalSandbox: true, cases: Object.freeze(['run-config', 'model-pin']) }),
  }),
  defaultPolicy: 'External boundary and every negative case, regardless of requested controls.',
});

export async function workerNegativeFixtureDigest() {
  const { qualificationDigest } = await import('./qualification-digest.mjs');
  return qualificationDigest(workerNegativeFixtureSuite);
}

async function workerPermissionRequirements(provider, requiredControls) {
  const { normalizeProviderDefinitionId } = await import('../providers/provider-definitions.js');
  const id = normalizeProviderDefinitionId(provider);
  const rows = workerNegativeFixtureSuite.providers;
  const row = id && Object.hasOwn(rows, id) ? rows[id] : null;
  return {
    provider: id,
    externalBoundary: !row || (row.externalSandbox && requiredControls.includes('sandbox')),
    cases: row ? [...workerNegativeFixtureSuite.baseCases,
      ...['children', 'fallback'].filter(name => requiredControls.includes(name)), ...row.cases]
      : Object.keys(workerNegativeFixtureSuite.cases),
  };
}

// Scoped native process mappings are exact argv tokens: either one flag or a
// JSON array for a contiguous flag/value sequence. Prose is not executable proof.
// External controls also require their declared tokens when they use argv;
// boundary-only prose mappings are checked against the qualified host boundary.
function hasControlArgvMapping(control) {
  return control.support === 'native' || (control.support === 'external'
    && (control.mapping.startsWith('[') || control.mapping.startsWith('-')));
}

function assertWorkerControlArgv(profile, argv) {
  if (!Array.isArray(argv) || argv.some(token => typeof token !== 'string' || token.includes('\0'))) {
    throw new Error('Worker control requires typed argv');
  }
  for (const [name, control] of Object.entries(profile.controls)) {
    if (!hasControlArgvMapping(control)) continue;
    let tokens;
    try { tokens = control.mapping.startsWith('[') ? JSON.parse(control.mapping) : [control.mapping]; }
    catch { throw new Error(`Worker control ${name} has invalid argv mapping`); }
    const endOfOptions = argv.indexOf('--');
    const options = endOfOptions < 0 ? argv : argv.slice(0, endOfOptions);
    if (!Array.isArray(tokens) || !tokens.length || typeof tokens[0] !== 'string' || !/^--?[^-\s]/.test(tokens[0])
      || tokens.some(token => typeof token !== 'string' || !token || token.includes('\0'))
      || !options.some((_, index) => tokens.every((token, offset) => options[index + offset] === token))) {
      throw new Error(`Worker control ${name} is absent from authorized argv`);
    }
  }
}


async function assertWorkerInstallationEvidence(request, scopeDigest) {
  const { DEFAULT_WORKER_SELECTION, WORKER_OPERATOR_APPROVAL, isOperatorQualifiedWorkerAdapter } = await import('./provider-policy.js');
  const { evidence, now } = request;
  if (!Number.isFinite(now) || !evidence || !/^sha256:[a-f0-9]{64}$/.test(scopeDigest) || evidence.scopeDigest !== scopeDigest
    || evidence.fixtureDigest !== await workerNegativeFixtureDigest()
    || !Number.isFinite(Date.parse(evidence.verifiedAt)) || Date.parse(evidence.verifiedAt) > now
    || typeof evidence.evidenceRef !== 'string' || !evidence.evidenceRef.trim()) {
    throw new Error('Missing or stale installation evidence binding');
  }
  if (now - Date.parse(evidence.verifiedAt) >= (request.policy?.freshness?.policyDays ?? DEFAULT_WORKER_SELECTION.freshness.policyDays) * 86400000) {
    throw new Error('Installation evidence expired');
  }
  // Decision 17's direct CLI baseline records operator approval, never claims
  // that a version probe ran the negative suite. Stronger host evidence keeps
  // its existing checks below.
  if (evidence.evidenceRef === WORKER_OPERATOR_APPROVAL && isOperatorQualifiedWorkerAdapter(request.adapter)) return;
  const { cases: requiredCases } = await workerPermissionRequirements(request.adapter.provider, request.requiredControls);
  if (requiredCases.some(id => evidence.cases?.[id] !== 'passed')) {
    throw new Error('Installation negative evidence is incomplete');
  }
}

/** Read-only recheck of the approved installation bytes and bindings. */
async function recheckWorkerInstallation(instance, options) {
  const request = structuredClone(options);
  const { requiredWorkerControls, isOperatorQualifiedWorkerAdapter } = await import('./provider-policy.js');
  if (!isOperatorQualifiedWorkerAdapter(request.adapter)) request.requiredControls = requiredWorkerControls(request);
  const scope = await inspectWorkerInstallation(instance, request);
  await assertWorkerInstallationEvidence(request, scope.scopeDigest);
  return { scope, request };
}

export async function qualifyWorkerInstallation(instance, options) {
  try {
    const { scope, request } = await recheckWorkerInstallation(instance, options);
    const { evidence } = request;
    const { rawBanner, version } = await boundedVersionProbe(scope.binary.realpath,
      request.adapter.invocation.versionArgv, request.environment ?? {}, request.cwd,
      request.timeoutMs ?? 10_000, Math.min(request.maxBytes ?? 4096, 4096), request.adapter.invocation.versionPattern);
    if (version !== request.cliVersion) throw new Error('Installed CLI version changed');
    if (request.versionProbe) {
      const pattern = request.adapter.invocation.versionPattern;
      const captured = banner => pattern === undefined ? banner.trim()
        : compileWorkerVersionPattern(pattern).exec(banner.trim())?.[1];
      if (request.versionProbe.version !== version
        || captured(request.versionProbe.rawBanner) !== captured(rawBanner)) {
        throw new Error('Installed CLI captured version text changed');
      }
    }
    // Detect changes during the probe as well as on subsequent dispatch.
    if ((await inspectWorkerInstallation(instance, request)).scopeDigest !== scope.scopeDigest) {
      throw new Error('Installation changed during qualification');
    }
    return { status: 'ENABLED', scopeDigest: scope.scopeDigest, fixtureDigest: evidence.fixtureDigest,
      verifiedAt: evidence.verifiedAt, evidenceRef: evidence.evidenceRef,
      cliVersion: version, rawVersionBanner: rawBanner, platform: request.platform ?? process.platform,
      ...(request.mcpServerDigest ? { serverDigest: request.mcpServerDigest } : {}) };
  } catch {
    // Probe output, env values, argv and filesystem errors may contain secrets.
    return { status: 'DISABLED', reason: 'Installation missing, unsupported, changed or not qualified' };
  }
}

export async function prepareInstalledWorkerInvocation(instance, invocation, qualification) {
  const { prepareWorkerInvocation, WorkerPathScopeError, WorkerInvocationCheckError } = await import('../serve/worker-invocation.js');
  const { requiredWorkerControls, WorkerPolicyError, isOperatorQualifiedWorkerAdapter } = await import('./provider-policy.js');
  if (!isOperatorQualifiedWorkerAdapter(qualification.adapter)) qualification = { ...qualification, requiredControls: requiredWorkerControls({
    ...qualification, effort: invocation.selected.effort.value }) };
  const result = await prepareWorkerInvocation(invocation, { ...qualification, adapterId: instance.getName() });
  const profile = qualification.adapter.invocationProfiles[result.selected.profileRef];
  if (profile.installationQualification) {
    const installation = qualification.installation;
    if (!installation) throw new Error('Worker installation recheck is required');
    if (['scopeDigest', 'fixtureDigest', 'verifiedAt', 'evidenceRef'].some(key =>
      installation.evidence?.[key] !== profile.installationQualification[key])
      || installation.evidence?.fixtureDigest !== await workerNegativeFixtureDigest()) {
      throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Worker installation evidence changed');
    }
    const scope = await inspectWorkerInstallation(instance, { ...installation,
      adapter: qualification.adapter, profile: result.selected.profileRef,
      cliVersion: qualification.cliVersion, requiredControls: qualification.requiredControls,
      policy: qualification.policy, permissions: qualification.permissions, effort: result.selected.effort.value,
      boundary: qualification.boundary, mcp: qualification.mcp });
    if (scope.scopeDigest !== profile.installationQualification.scopeDigest
      || result.selected.qualificationDigest !== scope.scopeDigest) {
      throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Worker installation qualification changed');
    }
    if (await realpath(result.cwd) !== scope.cwd) {
      throw new WorkerInvocationCheckError('OG_CONFIG_REFERENCE', 'qualified_workspace_mismatch');
    }
    for (const key of ['briefPath', 'stdoutPath', 'stderrPath', 'finalPath']) {
      const target = await canonicalFuturePath(result[key]);
      const roots = key === 'briefPath' ? scope.inputRoots : scope.outputRoots;
      if (!roots.some(root => inside(root, target))) throw new WorkerPathScopeError(key, result[key], roots);
    }
    if (result.transport === 'shell') {
      const driverInput = isOperatorQualifiedWorkerAdapter(qualification.adapter)
        ? { ...result, brief: (await readInstalledFile(result.briefPath)).toString('utf8') } : result;
      const expectedArtifacts = typeof instance.buildWorkerArtifacts === 'function'
        ? instance.buildWorkerArtifacts({ ...driverInput, permissions: qualification.permissions }) : undefined;
      if (JSON.stringify(expectedArtifacts) !== JSON.stringify(result.artifacts)) throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Worker artifacts differ from authorized driver mapping');
      const workerArgs = instance.buildWorkerArgs(driverInput, profile, qualification.permissions);
      if (!isOperatorQualifiedWorkerAdapter(qualification.adapter)) assertWorkerControlArgv(profile, workerArgs);
      const expected = [scope.binary.realpath, ...workerArgs];
      if (JSON.stringify(expected) !== JSON.stringify(result.argv)
        || result.stdin !== qualification.adapter.invocation.stdin) {
        throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Worker argv/stdin differs from the authorized driver mapping');
      }
      // Shell plans contain names, never values. PATH is host plumbing; its
      // allowlisted name stays bound, while the executable is pinned separately.
      // Other launch values must still match qualification.
      if (JSON.stringify([...result.envNames].sort()) !== JSON.stringify(Object.keys(installation.environment ?? {}).sort())
        || result.envNames.some(name => name !== 'PATH' && process.env[name] !== installation.environment[name])) {
        throw new WorkerPolicyError('OG_PIN_MISMATCH', 'Worker launch environment differs from qualification');
      }
    }
  }
  return result;
}

/** @type {Map<string, () => ProviderAdapter>} */
const providerRegistry = new Map();
const installedModules = new Map();
let installedLoad = Promise.resolve();
// Same default byte ceiling as workerAdapter.catalogAdapter.maxBytes.

async function binaryIdentity(filename, workerWritableRoots) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0')) throw new Error('Absolute installed binary required');
  const canonical = await realpath(filename);
  for (const root of workerWritableRoots) {
    if (inside(await realpath(root), canonical)) throw new Error('Worker-writable binary');
  }
  const handle = await open(canonical, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !(stat.mode & 0o111) || (stat.mode & 0o022)
      || (stat.nlink > 1 && (stat.mode & 0o222))) throw new Error('Untrusted binary permissions');
    if (stat.size > 1024 * 1024 * 1024) throw new Error('Binary exceeds qualification byte bound (1 GiB)');
    const hash = createHash('sha256');
    // Incremental, bounded reads: never allocate the size reported by the binary.
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > 1024 * 1024 * 1024) throw new Error('Binary exceeds qualification byte bound');
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { realpath: canonical, sha256: `sha256:${hash.digest('hex')}` };
  } finally { await handle.close(); }
}

export async function inspectWorkerInstallation(instance, request) {
  const { inspectWorkerInvocationProfile, requiredWorkerControls, isOperatorQualifiedWorkerAdapter } = await import('./provider-policy.js');
  const { qualificationDigest } = await import('./qualification-digest.mjs');
  const { adapter, profile: profileId, cliVersion, workerWritableRoots,
    effectiveConfigDigest, accountScope, boundary, cwd } = request;
  const operatorApproved = isOperatorQualifiedWorkerAdapter(adapter);
  const requiredControls = operatorApproved ? request.requiredControls ?? [] : requiredWorkerControls(request);
  const platform = request.platform ?? process.platform;
  if (platform !== 'linux' || adapter.id !== instance.getName()) throw new Error('Unsupported installation identity/platform');
  if (!Array.isArray(requiredControls) || !Array.isArray(workerWritableRoots)
    || !path.isAbsolute(cwd ?? '') || !/^sha256:[a-f0-9]{64}$/.test(effectiveConfigDigest)
    || typeof accountScope !== 'string' || !accountScope) throw new Error('Missing installation scope');
  const profile = inspectWorkerInvocationProfile(adapter, { profile: profileId,
    transport: adapter.invocationProfiles?.[profileId]?.transport, cliVersion, requiredControls, policy: request.policy, permissions: request.permissions,
    effort: request.effort, boundary, mcp: request.mcp });
  if (profile.transport === 'mcp' && !/^sha256:[a-f0-9]{64}$/.test(request.mcpServerDigest)) {
    throw new Error('MCP registration binding required');
  }
  if (adapter.invocation.kind !== 'process') throw new Error('HTTP installation requires its qualified local transport driver');
  if (!boundary || !['native', 'os', 'executor'].includes(boundary.kind)
    || typeof boundary.identity !== 'string' || !boundary.identity
    || !/^sha256:[a-f0-9]{64}$/.test(boundary.digest) || !Array.isArray(boundary.controls)) throw new Error('Missing enforcing boundary');
  if (requiredControls.some(name => profile.controls[name].support === 'external' && !boundary.controls.includes(name))) {
    throw new Error('External control lacks an enforcing boundary');
  }
  const permissionRequirements = await workerPermissionRequirements(adapter.provider, requiredControls);
  if (!operatorApproved && permissionRequirements.externalBoundary && boundary.kind === 'native') {
    throw new Error('Profile requires an external enforcing boundary');
  }
  let controlArgv = null;
  if (!operatorApproved && Object.values(profile.controls).some(hasControlArgvMapping)) {
    if (!request.invocation) throw new Error('Worker control qualification requires representative argv invocation');
    controlArgv = instance.buildWorkerArgs(structuredClone(request.invocation), profile, request.permissions);
    assertWorkerControlArgv(profile, controlArgv);
  }
  const environment = request.environment ?? {};
  if (Object.entries(environment).some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    || !profile.envAllowlist.includes(name) || !adapter.invocation.envAllowlist.includes(name)
    || typeof value !== 'string' || value.includes('\0'))) throw new Error('Unscoped worker environment');
  const endpoints = request.endpoints ?? [];
  for (const endpoint of endpoints) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
      || !request.allowedEndpoints?.includes(endpoint)) throw new Error('Endpoint is not explicitly authorized');
  }
  // The allowlist is supplied by the installation authority, never a downloaded manifest.
  const references = [adapter.runtimeDriver, ...(adapter.catalogAdapter.kind === 'module' ? [adapter.catalogAdapter.locator] : [])];
  const modules = [];
  for (const reference of new Set(references)) {
    const matches = (request.modules ?? []).filter(entry => entry.reference === reference);
    if (matches.length !== 1) throw new Error('Missing trusted module');
    const inspected = await inspectInstalledModule(matches[0], workerWritableRoots, platform);
    if (reference === adapter.runtimeDriver && (inspected.entry.packageVersion !== adapter.adapterVersion
      || !inspected.entry.adapterIds.includes(adapter.id))) throw new Error('Installed driver identity mismatch');
    modules.push({ reference, filename: inspected.filename, key: inspected.key });
  }
  const binary = await binaryIdentity(request.executable, workerWritableRoots);
  const canonicalCwd = await realpath(cwd);
  const canonicalWritableRoots = await Promise.all(workerWritableRoots.map(root => realpath(root)));
  const inputRoots = await Promise.all((request.inputRoots ?? [cwd]).map(root => realpath(root)));
  const outputRoots = await Promise.all((request.outputRoots ?? workerWritableRoots).map(root => realpath(root)));
  if (!Array.isArray(request.runtimeFiles)) throw new Error('Declared runtime dependency closure is required');
  const runtimeFiles = [];
  for (const filename of request.runtimeFiles) {
    if (!path.isAbsolute(filename)) throw new Error('Runtime dependency must be installed');
    const canonical = await realpath(filename);
    for (const root of workerWritableRoots) {
      if (inside(await realpath(root), canonical)) throw new Error('Worker-writable runtime dependency');
    }
    const stat = await lstat(canonical);
    if ((stat.mode & 0o022) || (stat.nlink > 1 && (stat.mode & 0o222))) throw new Error('Untrusted runtime dependency');
    runtimeFiles.push({ filename: canonical, sha256: `sha256:${createHash('sha256').update(await readInstalledFile(canonical)).digest('hex')}` });
  }
  const metadata = structuredClone(adapter);
  for (const entry of Object.values(metadata.invocationProfiles ?? {})) delete entry.installationQualification;
  return { binary, cwd: canonicalCwd, inputRoots, outputRoots, scopeDigest: qualificationDigest({ metadata, profileId, cliVersion, platform, binary, modules, runtimeFiles,
    permissionRequirements, controlArgv, fixtureDigest: await workerNegativeFixtureDigest(),
    requiredControls: [...requiredControls].sort(), effectiveConfigDigest, accountScope, boundary, cwd: canonicalCwd,
    workerWritableRoots: canonicalWritableRoots, inputRoots, outputRoots, environmentDigest: qualificationDigest(Object.fromEntries(Object.entries(environment).filter(([name]) => name !== 'PATH'))), endpoints, mcp: request.mcp ?? null,
    mcpServerDigest: request.mcpServerDigest ?? null }) };
}

/** Restricted whole-banner regex: one capture, no branching, assertions,
 * backreferences, wildcards, unbounded repetition or repeated groups. Bounded
 * at most two atom repetitions capped at 128, or a final [\s\S] banner tail capped at 4096 bytes. */
export function compileWorkerVersionPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length > 256 || !pattern.startsWith('^') || !pattern.endsWith('$')) throw new Error('Invalid worker version pattern');
  let captures = 0, depth = 0, repetitions = 0, atom = false;
  for (let i = 1; i < pattern.length - 1; i++) {
    const c = pattern[i];
    if (c === '\\') {
      const next = pattern[++i];
      if (!next || !'dws.-+()[]\\'.includes(next)) throw new Error('Unsafe worker version escape');
      atom = true;
    } else if (c === '[') {
      const start = i;
      while (++i < pattern.length && pattern[i] !== ']') {
        if (pattern[i] === '\\') i++;
      }
      if (i >= pattern.length - 1 || i === start + 1) throw new Error('Invalid worker version class');
      atom = true;
    } else if (c === '(') {
      if (depth || ++captures > 1) throw new Error('Worker version pattern requires one capture');
      depth++; atom = false;
    } else if (c === ')') {
      if (!depth) throw new Error('Invalid worker version capture');
      depth--; atom = false; // groups cannot be repeated
    } else if (c === '{') {
      const match = /^\{([0-9]+),([0-9]+)\}/.exec(pattern.slice(i));
      if (++repetitions > 2 || !atom || !match || +match[1] < 1 || +match[2] < +match[1] || +match[2] > (captures === 1 && depth === 0 && pattern.slice(i - 6) === '[\\s\\S]{1,4096}$' ? 4096 : 128)) throw new Error('Unsafe worker version repetition');
      i += match[0].length - 1; atom = false;
    } else {
      if ('.*+?|^$}'.includes(c)) throw new Error('Unsafe worker version pattern');
      atom = true;
    }
  }
  if (depth || captures !== 1) throw new Error('Worker version pattern requires one capture');
  return new RegExp(pattern, 'u');
}

export function normalizeWorkerVersionBanner(banner, pattern) {
  if (typeof banner !== 'string' || Buffer.byteLength(banner) > 4096) throw new Error('Worker version banner exceeds bound');
  if (pattern === undefined) return banner;
  const match = compileWorkerVersionPattern(pattern).exec(banner);
  // JS $ also matches before a final newline; require the entire banner.
  if (!match || match[0] !== banner) throw new Error('Worker version banner does not match');
  // Date-style decimal cores (Cursor 2026.10.01) become 2026.10.1;
  // prerelease and build identifiers remain byte-for-byte unchanged.
  const version = match[1].replace(/^([0-9]+)\.([0-9]+)\.([0-9]+)/,
    (_, major, minor, patch) => [major, minor, patch].map(n => String(Number(n))).join('.'));
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-|\+|$)/.test(version) || !valid(version)) throw new Error('Worker version capture is not semver');
  return version;
}

// Credential-free environment for read-only `<executable> ...versionArgv`
// probes. A version call needs process plumbing only (PATH for `env`-shebang
// interpreters, Windows system roots for process startup) — never provider API
// keys, account tokens, HOME, or caller session state. This allowlist is
// intentionally narrower than any adapter `envAllowlist`, which governs worker
// launches, not version probes.
export const workerVersionProbeEnvAllowlist = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR',
]);

// Build the cleared probe environment from a source mapping (defaults to
// process.env). Only allowlisted string values survive; everything else,
// including provider credentials, is dropped. Always returns a fresh object.
export function workerVersionProbeEnvironment(source = process.env) {
  const environment = {};
  for (const name of workerVersionProbeEnvAllowlist) {
    const value = source?.[name];
    if (typeof value === 'string' && !value.includes('\0')) environment[name] = value;
  }
  return environment;
}

// Default bounds for read-only version probes: 10s deadline, 64 KiB output.
export const workerVersionProbeDefaults = Object.freeze({ timeoutMs: 10_000, maxBytes: 64 * 1024 });

// Shared semver range check for an installed CLI version. Returns the first
// unsupported range (or the invalid range declaration), else null. Read-only
// surfaces reuse this instead of re-deriving the inspector's range logic.
export function workerVersionRangeMismatch(version, ranges) {
  for (const range of ranges) {
    if (typeof range !== 'string' || !validRange(range)) return `Unsupported version range '${range}'`;
    if (!satisfies(version, range)) return range;
  }
  return null;
}

export function boundedVersionProbe(executable, argv, environment, cwd, timeoutMs, maxBytes, versionPattern) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000
    || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 5 * 1024 * 1024
    || !Array.isArray(argv) || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('Invalid probe bounds');
  }
  // ETXTBSY: the executable still has a writer somewhere, typically a sibling
  // process forked while the file was being written or a CLI mid-update. It
  // clears in milliseconds, so retry the spawn within the same overall bound.
  const deadline = Date.now() + timeoutMs;
  const attempt = delayMs => runBoundedVersionProbe(executable, argv, environment, cwd, timeoutMs, maxBytes, versionPattern)
    .catch(error => {
      if (error?.code !== 'ETXTBSY' || Date.now() + delayMs >= deadline) throw error;
      return new Promise(resolveDelay => setTimeout(resolveDelay, delayMs)).then(() => attempt(Math.min(delayMs * 2, 200)));
    });
  return attempt(10);
}

function runBoundedVersionProbe(executable, argv, environment, cwd, timeoutMs, maxBytes, versionPattern) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd, env: environment, stdio: 'pipe', detached: true, shell: false });
    let output = Buffer.alloc(0);
    let size = 0;
    let failed = false;
    const stop = () => {
      if (Number.isSafeInteger(child.pid) && child.pid > 0) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ } }
    };
    // Never rely on close: an escaped descendant may retain the pipe descriptors.
    const abort = () => {
      failed = true; stop();
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref();
      reject(new Error('Bounded version probe failed'));
    };
    const timer = setTimeout(abort, timeoutMs);
    const consume = (chunk, stdout) => {
      size += chunk.length;
      if (size > maxBytes) { clearTimeout(timer); abort(); }
      else if (stdout) output = Buffer.concat([output, chunk]);
    };
    child.stdout.on('data', chunk => consume(chunk, true));
    child.stderr.on('data', chunk => consume(chunk, false));
    child.stdin.on('error', () => {});
    child.stdin.end();
    child.once('error', cause => {
      clearTimeout(timer); stop();
      const error = new Error('Version probe unavailable');
      // Preserve the spawn cause (notably ENOENT for a missing CLI) so
      // callers can report "not installed" without re-deriving it.
      if (cause?.code !== undefined) error.code = cause.code;
      reject(error);
    });
    child.once('exit', stop);
    child.once('close', code => {
      clearTimeout(timer); stop();
      if (failed || code !== 0) reject(new Error('Bounded version probe failed'));
      else {
        try {
          const rawBanner = new TextDecoder('utf-8', { fatal: true }).decode(output);
          resolve({ rawBanner, version: normalizeWorkerVersionBanner(rawBanner.trim(), versionPattern) });
        }
        catch (error) { reject(error); }
      }
    });
  });
}

// Inspect syntax without executing module bodies (including top-level effects).
// Only statically declared interfaceVersion and callable register exports qualify.
function checkInstalledExports(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const declarations = new Map();
  const exports = new Map();
  for (const node of ast.body) {
    const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (declaration?.type === 'FunctionDeclaration' && declaration.id) declarations.set(declaration.id.name, declaration);
    if (declaration?.type === 'VariableDeclaration' && declaration.kind === 'const') {
      for (const item of declaration.declarations) if (item.id.type === 'Identifier') declarations.set(item.id.name, item.init);
    }
    if (node.type === 'ExportNamedDeclaration' && !node.source) {
      if (declaration?.type === 'FunctionDeclaration') exports.set(declaration.id.name, declaration.id.name);
      if (declaration?.type === 'VariableDeclaration') {
        for (const item of declaration.declarations) if (item.id.type === 'Identifier') exports.set(item.id.name, item.id.name);
      }
      for (const item of node.specifiers) exports.set(item.exported.name, item.local.name);
    }
  }
  const version = declarations.get(exports.get('interfaceVersion'));
  const register = declarations.get(exports.get('register'));
  if (version?.type !== 'Literal' || version.value !== 1
    || !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(register?.type)
    || register.generator) throw new Error('Installed worker module requires interfaceVersion=1 and register(factory) exports');
  const interfaceBindings = new Set([exports.get('interfaceVersion'), exports.get('register')]);
  function writesInterface(node) {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'Identifier' && interfaceBindings.has(node.name)) return true;
    // Member mutation does not replace the exported binding.
    if (node.type === 'MemberExpression') return false;
    return Object.values(node).some(value => Array.isArray(value) ? value.some(writesInterface) : writesInterface(value));
  }
  function inspect(node) {
    if (!node || typeof node !== 'object') return;
    // Reject visible binding writes and direct eval calls only. This is not a
    // general dynamic-code detector; execution still trusts installation authority.
    if ((node.type === 'AssignmentExpression' && writesInterface(node.left))
      || (node.type === 'UpdateExpression' && writesInterface(node.argument))
      || (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'eval')) {
      throw new Error('Installed worker module exports must remain statically bound');
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(inspect);
      else if (value && typeof value === 'object') inspect(value);
    }
  }
  inspect(ast);
}

async function inspectInstalledModule(entry, workerWritableRoots, platform) {
  if (!entry || !/^installed:[a-z][a-z0-9-]{0,62}$/.test(entry.reference)
    || typeof entry.packageName !== 'string' || !entry.packageName
    || typeof entry.packageVersion !== 'string' || !entry.packageVersion
    || entry.interfaceVersion !== 1 || !/^sha256:[a-f0-9]{64}$/.test(entry.sha256)
    || !Array.isArray(entry.adapterIds) || new Set(entry.adapterIds).size !== entry.adapterIds.length
    || !entry.adapterIds.every(id => /^[a-z][a-z0-9-]{0,62}$/.test(id))) {
    throw new Error('Invalid trusted installed module binding');
  }
  if (!Array.isArray(entry.platforms) || !entry.platforms.includes(platform)) throw new Error(`Unsupported worker module platform: ${platform}`);
  if (!path.isAbsolute(entry.packageRoot) || !entry.modulePath || path.isAbsolute(entry.modulePath)
    || entry.modulePath.includes('\\') || entry.modulePath.split('/').some(part => !part || part === '..' || part === '.')
    || !/\.(mjs|js)$/.test(entry.modulePath)) throw new Error('Invalid installed module path');
  const root = await realpath(entry.packageRoot);
  const filename = await realpath(path.join(root, entry.modulePath));
  if (!inside(root, filename)) throw new Error('Installed module path escapes package');
  for (const writable of workerWritableRoots) {
    const canonical = await realpath(writable);
    if (inside(canonical, filename) || inside(canonical, root)) throw new Error('Installed module is in a worker-writable path');
  }
  for (const target of [root, path.join(root, 'package.json'), ...entry.modulePath.split('/').map((_, i, parts) => path.join(root, ...parts.slice(0, i + 1)))]) {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`Symlink in installed module path: ${target}`);
    if ((stat.mode & 0o022) !== 0) throw new Error(`Installed module path is group/other-writable: ${target}. Run: chmod -R go-w ${JSON.stringify(root)}`);
    // Directory link counts reflect children, not file aliases. Hardlinked store
    // files qualify only when no permission class can write the shared inode.
    if (stat.isFile() && stat.nlink > 1 && (stat.mode & 0o222) !== 0) {
      throw new Error('Writable hardlink in installed module path');
    }
  }
  const pkg = JSON.parse((await readInstalledFile(path.join(root, 'package.json'))).toString('utf8'));
  if (pkg.name !== entry.packageName || pkg.version !== entry.packageVersion) throw new Error('Installed module package identity/version mismatch');
  if (entry.modulePath.endsWith('.js') && pkg.type !== 'module') throw new Error('Installed worker module must be ESM');
  const source = await readInstalledFile(filename);
  if (`sha256:${createHash('sha256').update(source).digest('hex')}` !== entry.sha256) throw new Error('Installed module digest mismatch');
  checkInstalledExports(source.toString('utf8'));
  return { entry, filename, key: `${filename}:${entry.packageVersion}:${entry.sha256}` };
}

/**
 * Trusted host/executor registration boundary, never project configuration.
 * `modules` is the installation authority's allowlist, with realpath-resolved packageRoot,
 * packageName/packageVersion, relative modulePath, sha256, interfaceVersion:1,
 * adapterIds and qualified platforms. workerWritableRoots describes the worker's
 * writable mounts. The host must keep install roots and their dependency closure
 * read-only throughout loading/execution, including against concurrent installers
 * and writable aliases. Path checks and rechecks do not close the import race;
 * this loader is not a sandbox.
 * No module locations are resolved from metadata, URLs, or runtime downloads.
 */
export function loadInstalledWorkerAdapters({ registry, modules, workerWritableRoots, platform = process.platform }) {
  // Snapshot caller-owned bindings before asynchronous work; serialize registration.
  const request = structuredClone({ registry, modules, workerWritableRoots, platform });
  const pending = installedLoad.then(() => loadQualifiedModules(request));
  installedLoad = pending.catch(() => {});
  return pending;
}

async function loadQualifiedModules({ registry, modules, workerWritableRoots, platform }) {
  const { parseProviderModelCapabilities } = await import('./provider-policy.js');
  const parsed = parseProviderModelCapabilities(registry);
  if (!Array.isArray(modules) || !Array.isArray(workerWritableRoots)) throw new Error('Trusted module bindings and worker writable roots are required');
  const allowlist = new Map();
  for (const entry of modules) {
    if (allowlist.has(entry.reference)) throw new Error(`Duplicate installed module reference: ${entry.reference}`);
    allowlist.set(entry.reference, entry);
  }
  const required = new Map();
  const adapters = [...Object.values(parsed.providers).flatMap(p => p.workerAdapter ? [p.workerAdapter] : []), ...Object.values(parsed.workerAdapters ?? {})];
  // An id is "canonical" when the trusted registry itself pins a provider's
  // own `workerAdapter` to that same id (e.g. `providers.codex.workerAdapter.id
  // === 'codex'`). Such an id may already carry a legacy builtin
  // self-registration (same file, loaded a second way); the registry-pinned,
  // digest-authenticated install below is then the upgrade path, not a
  // hijack, so a prior builtin registration alone must not block it. A
  // non-canonical adapter (e.g. an ad-hoc `workerAdapters.*` entry) claiming
  // an id that is already builtin-registered stays a hard conflict.
  const canonicalIds = new Set(Object.entries(parsed.providers)
    .filter(([name, p]) => p.workerAdapter && p.workerAdapter.id === name).map(([name]) => name));
  for (const adapter of adapters) {
    for (const reference of [adapter.runtimeDriver, ...(adapter.catalogAdapter.kind === 'module' ? [adapter.catalogAdapter.locator] : [])]) {
      const entry = allowlist.get(reference);
      if (!entry) throw new Error(`Worker module is not installed/approved: ${reference}`);
      if (reference === adapter.runtimeDriver && (entry.packageVersion !== adapter.adapterVersion || !entry.adapterIds?.includes(adapter.id))) {
        throw new Error('Worker adapter identity/version does not match trusted module');
      }
      required.set(reference, entry);
    }
  }
  // Validate every module, digest, package, export and duplicate before ANY import.
  const inspected = [];
  const ids = new Set();
  for (const entry of required.values()) {
    const inspectedModule = await inspectInstalledModule(entry, workerWritableRoots, platform);
    for (const id of entry.adapterIds) {
      const builtinConflict = canonicalIds.has(id) ? false : providerRegistry.has(id);
      if (ids.has(id) || ((builtinConflict || installedModules.has(inspectedModule.key))
        && installedModules.get(id) !== inspectedModule.key)) {
        throw Object.assign(new Error(`Duplicate worker adapter ID: ${id}`), { code: 'WORKER_ADAPTER_CONFLICT' });
      }
      ids.add(id);
    }
    inspected.push(inspectedModule);
  }
  const staged = new Map();
  for (const { entry, filename, key } of inspected) {
    if (installedModules.has(key)) continue;
    // Recheck immediately before import. ESM opens by path afterward, so a
    // residual race remains; the host must enforce read-only install roots.
    const rechecked = await inspectInstalledModule(entry, workerWritableRoots, platform);
    if (rechecked.key !== key) throw new Error('Installed module canonical identity changed');
    const module = await import(`${pathToFileURL(filename).href}?sha256=${entry.sha256.slice(7)}`);
    if (module.interfaceVersion !== 1 || typeof module.register !== 'function') throw new Error('Installed worker module export mismatch');
    const registered = new Set();
    await module.register((id, factory) => {
      if (!entry.adapterIds.includes(id) || registered.has(id) || staged.has(id) || typeof factory !== 'function') throw new Error(`Invalid or duplicate installed factory: ${id}`);
      registered.add(id);
      staged.set(id, { factory, key });
    });
    if (entry.adapterIds.some(id => !registered.has(id))) throw new Error('Installed module omitted an approved factory');
  }
  for (const [id, { factory, key }] of staged) {
    registerProvider(id, factory);
    installedModules.set(id, key);
  }
  for (const { key } of inspected) installedModules.set(key, true);
  return adapters.map(adapter => adapter.id);
}

/**
 * Register a provider adapter factory.
 *
 * @param {string} name - Provider name (e.g., 'claude', 'codex')
 * @param {() => ProviderAdapter} factory - Factory function
 */
export function registerProvider(name, factory) {
  providerRegistry.set(name.toLowerCase(), factory);
}

/**
 * Create a provider adapter by name.
 *
 * @param {string} name - Provider name (e.g., 'claude', 'codex')
 * @returns {ProviderAdapter}
 * @throws {Error} If provider is not registered
 */
export function createProvider(name) {
  const factory = providerRegistry.get(name.toLowerCase());
  if (!factory) {
    const available = Array.from(providerRegistry.keys()).join(', ');
    throw new Error(
      `Unknown provider: "${name}". Available providers: ${available}`
    );
  }
  return factory();
}

/**
 * List all registered provider names.
 * @returns {string[]}
 */
export function listProviders() {
  return Array.from(providerRegistry.keys());
}

/**
 * Check if a provider is registered.
 * @param {string} name
 * @returns {boolean}
 */
export function hasProvider(name) {
  return providerRegistry.has(name.toLowerCase());
}


// This host-owned record extends the installation owner. It is not project
// configuration and never accepts module locations from models.json/aiwg.config.
// Use the existing delivery ledger's host-selected keyring, never public keys
// supplied by a registration. PAE separates this authority from effect records.
const qualificationPayloadType = 'application/vnd.aiwg.worker-installation-qualification+json';
const requalifyMessage = 'Re-run aiwg doctor --probe-workers --qualify. Existing unsigned approvals require deliberate one-time requalification.';
const keyRecoveryMessage = 'Worker qualification signing trust is unavailable. Check effects.keyProvider in aiwg.config, unlock or restore the existing effect-ledger key, and run aiwg effect keys init if its keyring is not initialized; then re-run aiwg doctor --probe-workers --qualify.';

async function qualificationTrust(cwd, scope) {
  const { effectSession, openLedger } = await import('../effects/host.js');
  const { openEffectLedger, readLedgerKeyring } = await import('../effects/ledger.js');
  const ledger = scope ? openEffectLedger({ projectDir: cwd, scope, writer: 'cli' }) : openLedger(await effectSession(cwd));
  const keyring = await readLedgerKeyring(ledger);
  if (!keyring) throw new Error(keyRecoveryMessage);
  return { ledger, keyring };
}

async function qualificationPayload(record, signedAt, projectDir, scope) {
  const { canonicalJson } = await import('../security/artifact-trust.js');
  const { signature: _signature, ...body } = record;
  return Buffer.from(canonicalJson({ record: JSON.parse(JSON.stringify(body)), signedAt, projectDir, scope }), 'utf8');
}

async function qualificationSignatureFailure(record, trust) {
  if (!record.signature) return 'signature-missing';
  const { keyid, sig, signedAt, projectDir, scope } = record.signature;
  if (typeof keyid !== 'string' || typeof sig !== 'string' || typeof signedAt !== 'string'
    || typeof projectDir !== 'string' || !path.isAbsolute(projectDir) || !scope) return 'signature-invalid';
  let keyring;
  try { ({ keyring } = await trust(projectDir, scope)); } catch { return 'signature-trust-unavailable'; }
  const { checkSignature } = await import('../effects/keyring.js');
  const result = checkSignature(keyring, keyid, sig, qualificationPayloadType,
    await qualificationPayload(record, signedAt, projectDir, scope), signedAt);
  return result === 'ok' ? null : result === 'signature-invalid' ? result : `signature-${result}`;
}

/** Offline projection of recorded approvals only. Never imports drivers, reads auth, or probes CLIs.
 * This is historical evidence, not current launch authority; loadRecordedWorkerInstallations
 * performs binary/version/scope checks when dispatch actually requests a binding.
 */
export async function inspectRecordedWorkerQualifications({ cwd, policy, parallelism, includeInputs = false }) {
  const filename = installationStorePath();
  await assertTrustedStore(filename, [cwd]);
  const { stored } = await readInstallationStore(filename);
  const workspace = await realpath(cwd);
  const results = [];
  const { qualificationDigest } = await import('./qualification-digest.mjs');
  for (const record of stored.registrations) {
    try {
      const { cli, installation, adapter, binding } = record;
      const configured = parallelism?.clis?.[cli];
      if (!configured || configured.enabled === false || !/^[a-z][a-z0-9-]{0,62}$/.test(cli)
        || await realpath(installation.cwd) !== workspace
        || qualificationDigest(policy) !== installation.effectiveConfigDigest
        || configured.adapter !== `providers:${adapter.provider}` && configured.adapter !== adapter.id
        || configured.accountScope !== binding.accountScope
        || binding.profile !== installation.profile || binding.cliVersion !== installation.cliVersion
        || (configured.executable && await realpath(configured.executable) !== await realpath(installation.executable))) continue;
      const proof = adapter.invocationProfiles?.[binding.profile]?.installationQualification;
      if (!proof || ['scopeDigest', 'fixtureDigest', 'verifiedAt', 'evidenceRef'].some(key => proof[key] !== installation.evidence?.[key])) continue;
      if (await qualificationSignatureFailure(record, () => qualificationTrust(cwd))) continue;
      await assertWorkerInstallationEvidence({ ...installation, adapter, now: Date.now(), policy }, proof.scopeDigest);
      results.push({ cli, provider: adapter.provider, ...(includeInputs
        ? { binding: structuredClone(binding), adapter: structuredClone(adapter), observations: structuredClone(record.modelObservations) } : {}) });
    } catch { /* Malformed, expired or unbound evidence is not qualification. */ }
  }
  return results.filter(row => results.filter(other => row.cli === other.cli).length === 1);
}

/** Explicit host operation: successful bounded qualification is required before
 * recording; credentials are reduced to names and are never written to disk. */
export async function recordWorkerInstallation(instance, options) {
  const { cli, binding } = options;
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(cli)) throw new Error('Invalid installation ID');
  const installation = structuredClone(options.installation);
  const result = await qualifyWorkerInstallation(instance, { ...installation, now: Date.now() });
  if (result.status !== 'ENABLED') return result;
  let signingKey, keyring, signingProjectDir;
  try {
    signingProjectDir = await realpath(options.projectDir ?? installation.cwd);
    const trust = await qualificationTrust(signingProjectDir);
    keyring = trust.keyring;
    signingKey = await trust.ledger.signingKey();
    const { activeKey } = await import('../effects/keyring.js');
    if (activeKey(keyring).keyid !== signingKey.keyid) throw new Error('inactive key');
  } catch { return { status: 'DISABLED', reason: keyRecoveryMessage }; }
  const adapter = structuredClone(installation.adapter);
  adapter.invocationProfiles[installation.profile].installationQualification = {
    scopeDigest: result.scopeDigest, fixtureDigest: result.fixtureDigest,
    verifiedAt: result.verifiedAt, evidenceRef: result.evidenceRef,
  };
  if (binding.profile !== installation.profile || binding.cliVersion !== installation.cliVersion
    || binding.accountScope !== installation.accountScope) throw new Error('Installation binding differs from qualification');
  const filename = installationStorePath();
  await assertTrustedStore(filename, installation.workerWritableRoots);
  // Canonical workspace identity is an exact approval key, never a prefix.
  installation.cwd = await realpath(installation.cwd);
  return withWorkerInstallationStore(installation.workerWritableRoots, async ({ stored }) => {
    const environmentNames = Object.keys(installation.environment ?? {});
    delete installation.environment;
    delete installation.adapter;
    delete installation.now;
    const record = { cli, ...(options.modelObservations ? { modelObservations: structuredClone(options.modelObservations) } : {}), binding: { ...structuredClone(binding), boundary: installation.boundary }, adapter,
      installation: { ...installation, environmentNames, versionProbe: { rawBanner: result.rawVersionBanner, version: result.cliVersion } },
      ...(options.mcpSchemas ? { mcpSchemas: structuredClone(options.mcpSchemas) } : {}),
      ...(options.mcpProfile ? { mcpProfile: structuredClone(options.mcpProfile) } : {}) };
    const signedAt = new Date().toISOString();
    try {
      const payload = await qualificationPayload(record, signedAt, signingProjectDir, keyring.scope);
      const sig = signingKey.signPae(qualificationPayloadType, payload);
      const { checkSignature } = await import('../effects/keyring.js');
      if (checkSignature(keyring, signingKey.keyid, sig, qualificationPayloadType, payload, signedAt) !== 'ok') throw new Error('invalid signature');
      record.signature = { keyid: signingKey.keyid, sig, signedAt, projectDir: signingProjectDir, scope: keyring.scope };
    } catch { return { status: 'DISABLED', reason: keyRecoveryMessage }; }
    stored.registrations = await retainWorkerApprovals(stored.registrations, record);
    await writeWorkerInstallationStore(filename, stored, installation.workerWritableRoots);
    return result;
  });
}

/** Read recorded host authority, validate installation bytes and the current CLI
 * version, then load the same approved factory used by Ralph. */
export async function loadRecordedWorkerInstallations({ registry, cwd, policy, parallelism, storePath, storeDigest, precheckPolicy }) {
  const { WorkerPolicyError, WorkerQualificationPolicyError, parseProviderModelCapabilities } = await import('./provider-policy.js');
  const { qualificationDigest } = await import('./qualification-digest.mjs');
  // Only fixed stage codes, bounded indexes and signed policy-drift summaries leave this boundary.
  // Underlying errors can contain probe output, environment values or paths.
  const rejections = [];
  const fail = () => {
    const mismatch = workerQualificationPolicyDiagnostic(rejections, stored?.registrations, policy);
    return mismatch ? new WorkerQualificationPolicyError(mismatch, rejections) : new WorkerPolicyError('OG_ADAPTER_UNQUALIFIED',
    `Trusted installation qualification is required (${[...new Set(rejections.map(row => row.reason))].join(', ')})${rejections.some(row => row.reason.startsWith('signature-'))
      ? `. ${rejections.some(row => row.reason === 'signature-trust-unavailable') ? keyRecoveryMessage : requalifyMessage}` : ''}`,
    { rejections });
  };
  let reason = 'store-binding';
  let filename;
  let stored, digest;
  try {
    filename = storePath ?? installationStorePath();
    if (!path.isAbsolute(filename) || (storePath !== undefined && !/^sha256:[a-f0-9]{64}$/.test(storeDigest ?? ''))) throw fail();
    reason = 'store-untrusted';
    await assertTrustedStore(filename, [cwd]);
    reason = 'store-record';
    ({ stored, digest } = await readInstallationStore(filename, storeDigest));
  }
  catch { rejections.push({ registration: null, reason }); throw fail(); }
  if (!stored.registrations.length) {
    rejections.push({ registration: null, reason: 'no-records' });
    throw fail();
  }
  // Request policy errors remain actionable before digest/adapter checks,
  // while an absent approval retains the qualification contract (#3070).
  precheckPolicy?.();
  const installations = {};
  const drivers = {};
  const observations = {};
  const qualificationFailures = Object.create(null);
  const resolvedRegistry = structuredClone(registry);
  const requestedWorkspace = await realpath(cwd);
  const workspaces = await Promise.all(stored.registrations.map(async record => {
    try { return await realpath(record?.installation?.cwd); } catch { return null; }
  }));
  const counts = new Map();
  const selected = new Map();
  for (const [index, record] of stored.registrations.entries()) {
    const key = JSON.stringify([record?.cli, workspaces[index]]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    // Prefer an exact approval. Retain the latest other-workspace record only
    // to preserve the typed workspace-mismatch diagnostic for unapproved dirs.
    const prior = selected.get(record?.cli);
    if (prior === undefined || workspaces[prior] !== requestedWorkspace) selected.set(record?.cli, index);
  }
  for (const [registration, record] of stored.registrations.entries()) {
    reason = 'record-identity';
    try {
      const { cli, binding, adapter } = record;
      if (!/^[a-z][a-z0-9-]{0,62}$/.test(cli)) throw fail();
      if (counts.get(JSON.stringify([cli, workspaces[registration]])) !== 1) throw fail();
      if (selected.get(cli) !== registration) continue;
      // A conductor-pinned store digest also binds the original config source.
      // Framing from a worker cwd must never read that cwd's configuration.
      reason = await qualificationSignatureFailure(record, (projectDir, scope) => storePath === undefined
        ? qualificationTrust(cwd) : qualificationTrust(projectDir, scope));
      if (reason) throw fail();
      const installation = { ...record.installation, adapter, now: Date.now(), environment: {} };
      reason = 'environment-name';
      if (record.installation.environment && Object.keys(record.installation.environment).length) throw fail();
      for (const name of installation.environmentNames ?? []) {
        if (typeof name !== 'string' || process.env[name] === undefined) throw fail();
        installation.environment[name] = process.env[name];
      }
      reason = 'binding-mismatch';
      if (binding.profile !== installation.profile || binding.cliVersion !== installation.cliVersion
        || binding.accountScope !== installation.accountScope
        || qualificationDigest(binding.boundary) !== qualificationDigest(installation.boundary)) throw fail();
      reason = 'effective-config-digest';
      if (qualificationDigest(policy) !== installation.effectiveConfigDigest) throw fail();
      reason = 'evidence';
      const proof = adapter.invocationProfiles?.[binding.profile]?.installationQualification;
      if (!proof || ['scopeDigest', 'fixtureDigest', 'verifiedAt', 'evidenceRef'].some(key => proof[key] !== installation.evidence?.[key])) throw fail();
      // Reject expired/unbound negative observations before any factory import.
      const { requiredWorkerControls, isOperatorQualifiedWorkerAdapter } = await import('./provider-policy.js');
      if (!isOperatorQualifiedWorkerAdapter(adapter)) installation.requiredControls = requiredWorkerControls(installation);
      await assertWorkerInstallationEvidence(installation, proof.scopeDigest);
      reason = 'store-untrusted';
      await assertTrustedStore(filename, installation.workerWritableRoots);
      reason = 'adapter-metadata';
      const candidateRegistry = structuredClone(resolvedRegistry);
      if (candidateRegistry.providers[adapter.id]) candidateRegistry.providers[adapter.id].workerAdapter = adapter;
      else { candidateRegistry.workerAdapters ??= {}; candidateRegistry.workerAdapters[adapter.id] = adapter; }
      parseProviderModelCapabilities(candidateRegistry);
      // The loader validates package identity, bytes and static exports BEFORE import.
      // Only this installation's metadata is needed; unrelated absent modules do not block it.
      // Preserve the canonical provider slot used to distinguish upgrades from ID conflicts.
      const loadingRegistry = structuredClone(candidateRegistry);
      const canonical = loadingRegistry.providers[adapter.id]?.workerAdapter?.id === adapter.id;
      for (const [name, provider] of Object.entries(loadingRegistry.providers)) {
        if (canonical && name === adapter.id) provider.workerAdapter = adapter;
        else delete provider.workerAdapter;
      }
      loadingRegistry.workerAdapters = canonical ? {} : { [adapter.id]: adapter };
      reason = 'module-registration';
      await loadInstalledWorkerAdapters({ registry: loadingRegistry, modules: installation.modules,
        workerWritableRoots: installation.workerWritableRoots, platform: process.platform });
      reason = 'binary-identity';
      const instance = createProvider(adapter.id);
      const scope = await inspectWorkerInstallation(instance, installation);
      reason = 'scope-digest';
      await assertWorkerInstallationEvidence(installation, scope.scopeDigest);
      reason = 'binary-identity';
      if (parallelism && isOperatorQualifiedWorkerAdapter(adapter)) {
        const { resolveWorkerGroupInstallation } = await import('../config/aiwg-config.js');
        const configured = resolveWorkerGroupInstallation(parallelism, cli, candidateRegistry);
        let executable = configured.executable;
        if (!path.isAbsolute(executable)) {
          if (executable.includes(path.sep)) executable = path.resolve(cwd, executable);
          else {
            const candidates = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.resolve(directory, executable));
            executable = null;
            for (const candidate of candidates) {
              try { await binaryIdentity(candidate, installation.workerWritableRoots); executable = candidate; break; } catch { /* Next PATH entry. */ }
            }
          }
        }
        if (!executable || await realpath(executable) !== scope.binary.realpath) throw fail();
      }
      reason = 'scope-digest';
      if (scope.scopeDigest !== proof.scopeDigest) throw fail();
      // A launcher can keep the same bytes while its CLI payload is updated.
      // Reuse the bounded, credential-free doctor probe before granting authority.
      reason = 'version';
      const { version } = await boundedVersionProbe(scope.binary.realpath,
        adapter.invocation.versionArgv, workerVersionProbeEnvironment(), cwd,
        workerVersionProbeDefaults.timeoutMs, workerVersionProbeDefaults.maxBytes,
        adapter.invocation.versionPattern);
      if (version !== binding.cliVersion) throw fail();
      reason = 'scope-digest';
      if ((await inspectWorkerInstallation(instance, installation)).scopeDigest !== scope.scopeDigest) throw fail();
      reason = 'driver';
      const profile = adapter.invocationProfiles[binding.profile];
      let mcpRegistry;
      if (profile.transport === 'mcp') {
        const { McpServerRegistry } = await import('../mcp/registry.js');
        mcpRegistry = new McpServerRegistry();
        if (typeof instance.buildInvocation !== 'function' || !record.mcpProfile || !record.mcpSchemas) throw fail();
      }
      drivers[cli] = {
        extractFinal: output => instance.parseOutput(output),
        ...(typeof instance.parseWorkerFinal === 'function'
          ? { parseWorkerFinal: (output, options) => instance.parseWorkerFinal(output, options) } : {}),
        ...(typeof instance.createHealthObserver === 'function'
          ? { createHealthObserver: options => instance.createHealthObserver(options) } : {}),
        qualification: { adapter, adapterId: adapter.id, cliVersion: binding.cliVersion, boundary: binding.boundary,
          platform: process.platform, installation, stdinFramerBinding: { storePath: filename, storeDigest: digest },
          ...(profile.transport === 'mcp' ? { mcp: binding.mcp, mcpSchemas: record.mcpSchemas } : {}) },
        ...(typeof instance.buildWorkerStdinFrame === 'function'
          ? { buildWorkerStdinFrame: (brief, invocation) => instance.buildWorkerStdinFrame(brief, invocation) } : {}),
        buildInvocation: async input => profile.transport === 'shell'
          ? buildInstalledWorkerTransport(instance, input, profile, adapter.invocation, scope.binary.realpath, installation.environment)
          : instance.buildInvocation(input),
        prepareWorkerInvocation: (invocation, qualification) => prepareInstalledWorkerInvocation(instance, invocation, qualification),
        ...(mcpRegistry ? { mcpRegistry, mcpProfile: record.mcpProfile } : {}),
      };
      registerWorkerRecoveryCapabilities(drivers[cli], {
        ...(typeof instance.parseWorkerAttemptFinal === 'function'
          ? { parseWorkerAttemptFinal: (output, options) => instance.parseWorkerAttemptFinal(output, options) } : {}),
        // Adapters with neither an explicit signal nor an attempt parser cannot
        // verify success (e.g. OpenHuman); never admit an unreachable canary.
        canVerifyAttempt: typeof instance.supportsAttemptVerification === 'function'
          ? !!instance.supportsAttemptVerification()
          : typeof instance.parseWorkerAttemptFinal === 'function',
      });
      installations[cli] = structuredClone(binding);
      if (record.modelObservations) observations[cli] = structuredClone(record.modelObservations);
      Object.assign(resolvedRegistry, candidateRegistry);
    } catch (error) {
      // One rejected installation cannot grant authority or hide qualified peers.
      const failureReason = reason === 'module-registration' && error?.code === 'WORKER_ADAPTER_CONFLICT'
        ? 'adapter-conflict' : reason;
      rejections.push({ registration, reason: failureReason });
      if (typeof record?.cli === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(record.cli)) qualificationFailures[record.cli] = failureReason;
    }
  }
  if (!Object.keys(installations).length) {
    if (!rejections.length) rejections.push({ registration: null, reason: 'no-records' });
    throw fail();
  }
  return { registry: resolvedRegistry, installations, drivers, observations, qualificationFailures };
}
