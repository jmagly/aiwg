#!/usr/bin/env node
// Two-stage release foundation. Stable publication remains disabled in this helper
// until the real release-comparison approval protocol is reviewed and bound.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { importImpl } from '../_resolve-impl.mjs';
const { boundedSpawnSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');
const ROOT = path.resolve(import.meta.dirname, '../..');
export const RC_WORKFLOW = '.github/workflows/release-candidate.yml';
export const RC_JOB = 'Validate release candidate';
export const RC_STEPS = [
  'Checkout RC source',
  'Restore annotated tag object and require main ancestry',
  'Verify signed RC tag',
  'Validate RC tag identity',
  'Setup Node.js',
  'Install locked dependencies',
  'Install locked Flue example dependencies for the offline release lane',
  'Install mandatory SQLite session test backend',
  'Scan known affected package feed',
  'Resolve validation profile',
  'Run release validation profile',
  'Require provider sandbox tests when supported',
  'Pack and smoke-test exact npm surfaces',
  'Install syft (SBOM generator)',
  'Generate CycloneDX SBOM',
  'Preserve exact installer',
  'Write RC artifact manifest',
  'Retain validated release candidate',
];
export const RC_LANES = [
  'typecheck', 'build', 'package:cli',
  'lint:dep-sources', 'lint:eval-imports', 'lint:package-license-boundary', 'lint:audit-signatures',
  'lint:agent-sizes', 'lint:test-registration', 'lint:test-process-timeouts', 'lint:orchestration-packs',
  'lint:rule-activation', 'lint:schemas', 'lint:ops-templates', 'lint:mission-inventory', 'lint:mission-contract',
  'lint:generated-artifacts', 'lint:plugin-copies', 'lint:vault-migration',
  'test:coverage:testing-quality', 'test:coverage:audit-foundations', 'test:coverage:enforcement',
  'test:conformance:example', 'test:contract', 'test:conformance', 'test:conformance:dataset',
  'test:security:attestation-conformance', 'test:node', 'test:conformance:storage', 'verify:storage-claims',
  'lint:session-fixtures', 'test:sessions:sqlite', 'benchmark:sessions', 'test:ci', 'test:deployment', 'test:integration:serve',
  'test:integration:artifact-index', 'test:d29-slow', 'check:budgets', 'test:packaging',
  'ci:fortemi-index', 'test:sessions:feature-install', 'lint:tarball',
];
export const ROUTINE_RC_LANES = [
  'typecheck', 'build', 'package:cli',
  'lint:dep-sources', 'lint:eval-imports', 'lint:package-license-boundary', 'lint:audit-signatures',
  'lint:test-registration', 'lint:test-process-timeouts', 'lint:schemas', 'lint:generated-artifacts',
  'lint:plugin-copies', 'lint:vault-migration',
  'test:contract', 'test:security:attestation-conformance', 'test:node', 'verify:storage-claims',
  'lint:session-fixtures', 'test:sessions:sqlite', 'test:release:routine-deployment',
  'test:packaging', 'ci:fortemi-index', 'test:sessions:feature-install', 'lint:tarball',
];
export const RC_VALIDATION_PROFILES = Object.freeze({
  'routine-release-v1': ROUTINE_RC_LANES,
  'quarterly-full-v1': RC_LANES,
});
export const SURFACES = [
  { name: 'aiwg', dir: '.', stem: 'aiwg', bin: 'bin/aiwg.mjs' },
  { name: '@aiwg/cli', dir: 'dist/packages/cli', stem: 'aiwg-cli', bin: 'bin/aiwg.mjs' },
  { name: '@aiwg/cockpit', dir: 'apps/cockpit', stem: 'aiwg-cockpit', bin: 'bridge/src/server.mjs' },
];
const CALVER = '(?:19|20)\\d{2}\\.(?:[1-9]|1[0-2])\\.(?:0|[1-9]\\d*)';
const SHA = /^[a-f0-9]{40}$/;
export function releaseIdentity(tag, packageVersion, stage = 'rc') {
  const match = new RegExp(`^v(${CALVER})${stage === 'rc' ? '-rc\\.([1-9]\\d*)' : ''}$`).exec(tag);
  if (!['rc', 'stable'].includes(stage) || !match || match[1] !== packageVersion) throw new Error('Tag/package identity mismatch: RC tags must retain the stable package version');
  return { version: packageVersion, tag, stage, ...(stage === 'rc' ? { candidate: Number(match[2]) } : {}) };
}
export function sha256(file) {
  const hash = createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(65536);
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function command(command, args, { cwd = ROOT, env = process.env, spawn = boundedSpawnSync, timeout = 3600000, stdio = 'pipe' } = {}) {
  const result = spawn(command, args, 'long', { cwd, env, timeout, stdio, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed: ${result.error?.message ?? result.status}`);
  return result.stdout ?? '';
}
export function validateRelease({ root = ROOT, output, profile = 'routine-release-v1', spawn = boundedSpawnSync, env = process.env } = {}) {
  if (!output) throw new Error('Validation output is required');
  const lanes = RC_VALIDATION_PROFILES[profile];
  if (!lanes) throw new Error('Unknown RC validation profile');
  const evidence = { version: 2, profile, commit: command('git', ['rev-parse', 'HEAD'], { cwd: root, spawn }).trim(),
    runner: env.RUNNER_NAME ?? 'local', node: process.version, lanes: [], pass: false };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  for (const lane of lanes) {
    const record = { lane, started_at: new Date().toISOString(), status: 'running' }; evidence.lanes.push(record);
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
    try {
      const budget = lane === 'test:ci' ? '40m' : lane === 'test:deployment' ? '18m' : lane === 'test:d29-slow' ? '25m' : null;
      if (budget) command(process.execPath, [path.join(root, 'tools/ci/run-with-hang-report.mjs'), '--timeout', budget, '--', 'npm', 'run', lane], { cwd: root, env, spawn, stdio: 'inherit' });
      else command('npm', ['run', lane], { cwd: root, env, spawn, stdio: 'inherit' });
      // Keep the exact 43-gate full profile: its provider deployment gate owns
      // both the existing deployment lane and the release-only infrastructure
      // lane. Mark this gate successful only after both commands pass. Routine
      // RCs run the latter through test:release:routine-deployment instead.
      if (lane === 'test:deployment') command(process.execPath, [path.join(root, 'tools/ci/run-with-hang-report.mjs'), '--timeout', '30m', '--', 'npm', 'run', 'test:release-slow'], { cwd: root, env, spawn, stdio: 'inherit' });
      record.status = 'success';
    }
    catch (error) { record.status = 'failure'; record.error = error.message; throw error; }
    finally { record.completed_at = new Date().toISOString(); fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n'); }
  }
  evidence.pass = true; fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n'); return evidence;
}
function packJson(text) {
  // npm lifecycle banners can precede the final JSON array.
  try { return JSON.parse(text); } catch { const start = text.lastIndexOf('\n['); if (start < 0) throw new Error('Malformed npm pack result'); return JSON.parse(text.slice(start + 1)); }
}
function isolatedEnv(temp, base) {
  const home = path.join(temp, 'home'); fs.mkdirSync(home, { recursive: true });
  const clean = { ...base, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'),
    CODEX_HOME: path.join(home, '.codex'), HERMES_HOME: path.join(home, '.hermes'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    AIWG_ARTIFACTS_PATH: path.join(temp, 'artifacts'), AIWG_CONFIG: path.join(home, '.aiwg'), AIWG_ROOT: '',
    npm_config_userconfig: path.join(home, '.npmrc'), npm_config_prefix: path.join(temp, 'prefix'),
    npm_config_cache: path.join(temp, 'npm-cache'), AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1' };
  // Downloaded package executables must not inherit publication or signing authority.
  for (const key of Object.keys(clean)) {
    if (/^(?:GH_TOKEN|GITHUB_TOKEN|NODE_AUTH_TOKEN|NPM_TOKEN|SIGSTORE_ID_TOKEN|ACTIONS_ID_TOKEN_REQUEST_.*|COSIGN_.*)$/i.test(key)) delete clean[key];
  }
  return clean;
}
export function packAndSmoke({ root = ROOT, output, spawn = boundedSpawnSync, env = process.env } = {}) {
  if (!output) throw new Error('Bundle output is required');
  output = path.resolve(output); fs.mkdirSync(output, { recursive: true });
  const version = readJson(path.join(root, 'package.json')).version;
  const allowlist = new Set(fs.readFileSync(path.join(root, 'ci/expected-tarball-top-level.txt'), 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')));
  for (const surface of SURFACES) {
    const info = packJson(command('npm', ['pack', '--json', '--pack-destination', output], { cwd: path.join(root, surface.dir), env, spawn }));
    const packed = info?.[0], filename = `${surface.stem}-${version}.tgz`;
    if (info.length !== 1 || packed?.name !== surface.name || packed.version !== version || packed.filename !== filename || !Array.isArray(packed.files) || !packed.files.length) throw new Error(`Invalid packed identity: ${surface.name}`);
    const tops = new Set();
    for (const file of packed.files) {
      if (typeof file.path !== 'string' || path.isAbsolute(file.path) || file.path.split(/[\\/]/).some(part => part === '..' || part === '.aiwg')) throw new Error(`Unsafe package payload: ${surface.name}`);
      tops.add(file.path.split('/')[0]);
    }
    if (surface.name === 'aiwg' && ([...tops].some(name => !allowlist.has(name)) || [...allowlist].some(name => !tops.has(name)))) throw new Error('Root tarball top-level allowlist mismatch');
    const tarball = path.join(output, filename);
    if (surface.name === '@aiwg/cockpit') {
      // Its prepack rebuilds web/dist. Keep this real two-build byte check in
      // the release packaging lane so staging-path or bundler drift fails
      // before the smoke-tested bytes can be published.
      const repeat = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-rc-repack-'));
      try {
        const repeated = packJson(command('npm', ['pack', '--json', '--pack-destination', repeat], { cwd: path.join(root, surface.dir), env, spawn }));
        if (repeated.length !== 1 || repeated[0]?.name !== surface.name || repeated[0]?.version !== version || repeated[0]?.filename !== filename
          || !fs.readFileSync(tarball).equals(fs.readFileSync(path.join(repeat, filename)))) throw new Error(`Non-reproducible package tarball: ${surface.name}`);
      } finally { fs.rmSync(repeat, { recursive: true, force: true }); }
    }
  }
  return smokeTarballs({ root, output, spawn, env });
}
// Recovery runs the same installed-package checks on authenticated registry
// bytes without invoking prepack or replacing them with a new local build.
export function smokeTarballs({ root = ROOT, output, spawn = boundedSpawnSync, env = process.env } = {}) {
  if (!output) throw new Error('Bundle output is required');
  output = path.resolve(output);
  const version = readJson(path.join(root, 'package.json')).version, smoke = [];
  for (const surface of SURFACES) {
    const filename = `${surface.stem}-${version}.tgz`, tarball = path.join(output, filename), before = sha256(tarball);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-rc-install-'));
    try {
      const cleanEnv = isolatedEnv(temp, env), prefix = path.join(temp, 'install');
      command('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', tarball], { cwd: temp, env: cleanEnv, spawn });
      const installed = path.join(prefix, 'node_modules', ...surface.name.split('/'));
      const pkg = readJson(path.join(installed, 'package.json'));
      if (pkg.name !== surface.name || pkg.version !== version) throw new Error(`Installed package identity mismatch: ${surface.name}`);
      if (surface.name === '@aiwg/cockpit') {
        command(process.execPath, ['--input-type=module', '-e', 'const m=await import(process.argv[1]);if(typeof m.createBridge!=="function")throw new Error("Missing bridge API")', pathToFileURL(path.join(installed, surface.bin)).href], { cwd: temp, env: cleanEnv, spawn, timeout: 120000 });
      } else {
        const actual = command(process.execPath, [path.join(installed, surface.bin), '--version'], { cwd: temp, env: cleanEnv, spawn, timeout: 120000 });
        if (!actual.includes(version)) throw new Error(`Installed version smoke mismatch: ${surface.name}`);
        command(process.execPath, [path.join(installed, surface.bin), '--help'], { cwd: temp, env: cleanEnv, spawn, timeout: 120000 });
      }
      if (sha256(tarball) !== before) throw new Error('Smoke mutated candidate tarball');
      smoke.push({ package: surface.name, filename, sha256: before, installed_version: version, status: 'success' });
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  const evidence = { version: 1, pass: true, packages: smoke };
  fs.writeFileSync(path.join(output, 'installed-smoke.json'), JSON.stringify(evidence, null, 2) + '\n'); return evidence;
}
function validateLanes(evidence, commit) {
  const legacy = evidence?.version === 1 && evidence.profile === undefined;
  const profile = legacy ? 'legacy-full-v1' : evidence?.profile;
  const lanes = legacy ? RC_LANES : RC_VALIDATION_PROFILES[profile];
  if (!evidence || !lanes || (!legacy && evidence.version !== 2) || evidence.commit !== commit || evidence.pass !== true
    || !Array.isArray(evidence.lanes) || evidence.lanes.length !== lanes.length
    || lanes.some(lane => evidence.lanes.filter(item => item.lane === lane && item.status === 'success').length !== 1)) {
    throw new Error('Missing or failed RC validation lane');
  }
  return profile;
}
export function writeCandidateManifest({ root = ROOT, output, tag, env = process.env, spawn = boundedSpawnSync } = {}) {
  const version = readJson(path.join(root, 'package.json')).version;
  releaseIdentity(tag, version);
  const commit = command('git', ['rev-parse', `${tag}^{commit}`], { cwd: root, spawn }).trim();
  const head = command('git', ['rev-parse', 'HEAD'], { cwd: root, spawn }).trim();
  const tagObject = command('git', ['rev-parse', tag], { cwd: root, spawn }).trim();
  if (!SHA.test(commit) || head !== commit || !SHA.test(tagObject)) throw new Error('RC tag does not match checked-out commit');
  validateLanes(readJson(path.join(output, 'validation.json')), commit);
  const smoke = readJson(path.join(output, 'installed-smoke.json'));
  if (!smoke.pass || smoke.packages?.length !== 3 || SURFACES.some(surface => smoke.packages.filter(item => item.package === surface.name && item.status === 'success' && item.installed_version === version).length !== 1)) throw new Error('Missing exact installed smoke evidence');
  for (const surface of SURFACES) {
    const filename = `${surface.stem}-${version}.tgz`;
    if (smoke.packages.find(item => item.package === surface.name)?.sha256 !== sha256(path.join(output, filename))) throw new Error('Exact installed smoke digest mismatch');
  }
  const sbom = readJson(path.join(output, `aiwg-${version}.cdx.json`));
  if (sbom.bomFormat !== 'CycloneDX' || !sbom.specVersion) throw new Error('Invalid candidate CycloneDX SBOM');
  const files = [...SURFACES.map(surface => `${surface.stem}-${version}.tgz`), `aiwg-${version}.cdx.json`, 'install.sh', 'validation.json', 'installed-smoke.json'];
  const manifest = { version: 1, package_version: version, rc_tag: tag, tag_object_sha: tagObject, commit,
    repository: env.GITHUB_REPOSITORY, workflow: RC_WORKFLOW, run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
    runner: env.RUNNER_NAME, created_at: new Date().toISOString(), files: Object.fromEntries(files.map(file => [file, sha256(path.join(output, file))])) };
  if (!manifest.repository || typeof manifest.runner !== 'string' || !manifest.runner.trim()
    || !Number.isSafeInteger(manifest.run_id) || manifest.run_id < 1 || !Number.isSafeInteger(manifest.run_attempt) || manifest.run_attempt < 1) throw new Error('Missing GitHub RC run identity');
  fs.writeFileSync(path.join(output, 'rc-manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); return manifest;
}

/**
 * `run`, `jobs`, `artifact`, and `workflow` must be authenticated GitHub API responses.
 * `workflowSource` is a separate caller-created receipt for the workflow file fetched
 * from `commit` through an authenticated source API. It is never read from the bundle.
 */
export function verifyRcBundle({ directory, run, jobs, artifact, workflow, workflowSource, repository, commit, stableTag, rcTagObjectSha } = {}) {
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Missing trusted repository identity');
  if (!run || !Array.isArray(jobs) || !artifact || !workflow || !workflowSource || !SHA.test(commit ?? '')) throw new Error('Missing trusted RC run/evidence');
  const manifestPath = path.join(directory, 'rc-manifest.json');
  if (!fs.existsSync(manifestPath) || !fs.lstatSync(manifestPath).isFile()) throw new Error('Invalid RC bundle inventory');
  const manifest = readJson(manifestPath);
  if (manifest.version !== 1) throw new Error('Unsupported RC manifest version');
  releaseIdentity(stableTag, manifest.package_version, 'stable'); releaseIdentity(manifest.rc_tag, manifest.package_version);
  const workflowFile = path.join(ROOT, RC_WORKFLOW);
  if (!Number.isSafeInteger(workflow.id) || workflow.id < 1 || workflow.path !== RC_WORKFLOW || run.workflow_id !== workflow.id
    || Object.keys(workflowSource).sort().join(',') !== 'commit,path,repository,schema,sha256'
    || workflowSource.schema !== 'workflow-source/v1' || workflowSource.repository !== repository || workflowSource.path !== RC_WORKFLOW
    || workflowSource.commit !== commit || !/^[a-f0-9]{64}$/.test(workflowSource.sha256 ?? '')
    || !fs.existsSync(workflowFile) || !fs.lstatSync(workflowFile).isFile() || sha256(workflowFile) !== workflowSource.sha256) throw new Error('Untrusted or mismatching RC workflow identity');
  if (!run.id || run.status !== 'completed' || run.conclusion !== 'success'
    || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
    || run.path !== RC_WORKFLOW || run.head_sha !== commit || run.head_branch !== manifest.rc_tag
    || run.run_attempt !== manifest.run_attempt || run.id !== manifest.run_id
    || manifest.repository !== repository || manifest.workflow !== RC_WORKFLOW || manifest.commit !== commit
    || manifest.tag_object_sha !== rcTagObjectSha || !SHA.test(rcTagObjectSha ?? '')) throw new Error('Untrusted, failed, or mismatching RC run/tag identity');
  const job = jobs.filter(job => job.name === RC_JOB);
  if (job.length !== 1 || job[0].run_id !== run.id || job[0].head_sha !== commit || job[0].status !== 'completed' || job[0].conclusion !== 'success'
    || typeof manifest.runner !== 'string' || !manifest.runner.trim() || job[0].runner_name !== manifest.runner
    || RC_STEPS.some(name => job[0].steps?.filter(step => step.name === name && step.status === 'completed' && step.conclusion === 'success').length !== 1)) throw new Error('Missing or failed required RC job/step');
  if (artifact.expired !== false || artifact.name !== `release-candidate-${commit}-${run.id}-${run.run_attempt}`
    || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== commit) throw new Error('Missing, expired, or mismatching RC artifact');
  const expected = [...SURFACES.map(surface => `${surface.stem}-${manifest.package_version}.tgz`), `aiwg-${manifest.package_version}.cdx.json`, 'install.sh', 'validation.json', 'installed-smoke.json'];
  const expectedEntries = new Set(['rc-manifest.json', ...expected]);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length !== expectedEntries.size || entries.some(entry => !expectedEntries.has(entry.name) || !entry.isFile())) throw new Error('Invalid RC bundle inventory');
  if (!manifest.files || Object.keys(manifest.files).length !== expected.length || expected.some(file => !/^[a-f0-9]{64}$/.test(manifest.files[file] ?? '')
    || !fs.existsSync(path.join(directory, file)) || !fs.lstatSync(path.join(directory, file)).isFile() || sha256(path.join(directory, file)) !== manifest.files[file])) throw new Error('Missing or mismatching RC artifact digest');
  const validationProfile = validateLanes(readJson(path.join(directory, 'validation.json')), commit);
  const validTrigger = validationProfile === 'quarterly-full-v1' ? run.event === 'workflow_dispatch'
    : validationProfile === 'routine-release-v1' ? ['push', 'workflow_dispatch'].includes(run.event)
      : run.event === 'push';
  if (!validTrigger) {
    throw new Error('RC validation identity profile does not match its authenticated workflow trigger');
  }
  const smoke = readJson(path.join(directory, 'installed-smoke.json'));
  if (smoke.pass !== true || smoke.packages?.length !== 3 || SURFACES.some(surface => {
    const filename = `${surface.stem}-${manifest.package_version}.tgz`;
    return smoke.packages.filter(item => item.package === surface.name && item.status === 'success' && item.filename === filename && item.sha256 === manifest.files[filename] && item.installed_version === manifest.package_version).length !== 1;
  })) throw new Error('Mismatching exact installed smoke evidence');
  return { manifest, directory: path.resolve(directory), artifact_id: artifact.id, validation_profile: validationProfile };
}
export function promotionPlan(verified) {
  if (!verified?.manifest || !verified.directory) throw new Error('A verified RC bundle is required');
  return { ready_for_publication: false, unmet_gates: ['Real release-comparison evidence and approval must be bound to these candidate digests; stable publication integration is not enabled.'],
    commit: verified.manifest.commit, rc_run_id: verified.manifest.run_id,
    packages: SURFACES.map(surface => { const filename = `${surface.stem}-${verified.manifest.package_version}.tgz`;
      return { package: surface.name, filename, path: path.join(verified.directory, filename), sha256: verified.manifest.files[filename],
        proposed_argv: ['publish', path.join(verified.directory, filename), '--ignore-scripts', '--provenance', '--access', 'public', '--tag', 'latest'] }; }),
    sbom: path.join(verified.directory, `aiwg-${verified.manifest.package_version}.cdx.json`), installer: path.join(verified.directory, 'install.sh') };
}
function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' }, tag: { type: 'string' }, profile: { type: 'string' },
    directory: { type: 'string' }, run: { type: 'string' }, jobs: { type: 'string' }, artifact: { type: 'string' },
    workflow: { type: 'string' }, 'workflow-source': { type: 'string' }, repository: { type: 'string' }, commit: { type: 'string' }, 'rc-tag-object': { type: 'string' } } });
  if (positionals[0] === 'identity') console.log(JSON.stringify(releaseIdentity(values.tag, readJson(path.join(ROOT, 'package.json')).version)));
  else if (positionals[0] === 'validate') validateRelease({ output: values.output, profile: values.profile });
  else if (positionals[0] === 'pack') packAndSmoke({ output: values.output });
  else if (positionals[0] === 'manifest') writeCandidateManifest({ output: values.output, tag: values.tag });
  else if (positionals[0] === 'verify') {
    // Offline diagnostic only. Production shipping must obtain authenticated API
    // metadata/source receipts and independently verify signed RC tag before using this plan.
    const verified = verifyRcBundle({ directory: values.directory, run: readJson(values.run), jobs: readJson(values.jobs), artifact: readJson(values.artifact),
      workflow: readJson(values.workflow), workflowSource: readJson(values['workflow-source']),
      repository: values.repository, commit: values.commit, stableTag: values.tag, rcTagObjectSha: values['rc-tag-object'] });
    console.log(JSON.stringify(promotionPlan(verified), null, 2)); process.exitCode = 1;
  } else throw new Error('Usage: release-candidate.mjs identity|validate|pack|manifest|verify [--output DIR --tag TAG --workflow FILE --workflow-source FILE]');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
