import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { releaseIdentity, sha256, RC_LANES, ROUTINE_RC_LANES, RC_VALIDATION_PROFILES, RC_WORKFLOW, RC_STEPS, RC_JOB, SURFACES,
  validateRelease, packAndSmoke, smokeTarballs, writeCandidateManifest, verifyRcBundle, promotionPlan } from '../../../tools/release/release-candidate.mjs';
const roots = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-rc-test-')); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const commit = 'a'.repeat(40), tagObject = 'b'.repeat(40), version = '2026.10.4', tag = `v${version}-rc.2`;
const repository = 'jmagly/aiwg', workflowId = 73;
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const workflowFile = path.join(repoRoot, RC_WORKFLOW);
function fixture() {
  const root = temp(), output = path.join(root, 'bundle'); fs.mkdirSync(output);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'aiwg', version }));
  fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify({ version: 1, commit, pass: true, lanes: RC_LANES.map(lane => ({ lane, status: 'success' })) }));
  const packages = SURFACES.map(surface => {
    const filename = `${surface.stem}-${version}.tgz`; fs.writeFileSync(path.join(output, filename), `exact ${surface.name} bytes`);
    return { package: surface.name, filename, installed_version: version, sha256: sha256(path.join(output, filename)), status: 'success' };
  });
  fs.writeFileSync(path.join(output, 'installed-smoke.json'), JSON.stringify({ version: 1, pass: true, packages }));
  fs.writeFileSync(path.join(output, `aiwg-${version}.cdx.json`), '{"bomFormat":"CycloneDX","specVersion":"1.6"}');
  fs.writeFileSync(path.join(output, 'install.sh'), '#!/bin/bash\necho installer\n');
  const manifest = writeCandidateManifest({ root, output, tag, env: { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: '12', GITHUB_RUN_ATTEMPT: '1', RUNNER_NAME: 'fixture' },
    spawn: (command, args) => ({ status: 0, stdout: args[1] === tag ? tagObject : commit }) });
  const run = { id: 12, workflow_id: workflowId, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'push', path: RC_WORKFLOW,
    repository: { full_name: repository }, head_repository: { full_name: repository }, head_sha: commit, head_branch: tag };
  const jobs = [{ name: RC_JOB, run_id: 12, head_sha: commit, runner_name: 'fixture', status: 'completed', conclusion: 'success',
    steps: RC_STEPS.map(name => ({ name, status: 'completed', conclusion: 'success' })) }];
  const artifact = { id: 44, name: `release-candidate-${commit}-12-1`, expired: false, workflow_run: { id: 12, head_sha: commit } };
  const workflow = { id: workflowId, path: RC_WORKFLOW };
  const workflowSource = { schema: 'workflow-source/v1', repository, path: RC_WORKFLOW, commit, sha256: sha256(workflowFile) };
  return { root, directory: output, run, jobs, artifact, workflow, workflowSource, repository, commit, stableTag: `v${version}`, rcTagObjectSha: tagObject, manifest };
}
function rewriteManifest(fixture, mutate) {
  const file = path.join(fixture.directory, 'rc-manifest.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(manifest); fs.writeFileSync(file, JSON.stringify(manifest));
}
function rewriteValidation(f, mutate) {
  const file = path.join(f.directory, 'validation.json'), evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(evidence); fs.writeFileSync(file, JSON.stringify(evidence));
  rewriteManifest(f, manifest => { manifest.files['validation.json'] = sha256(file); });
}

describe('signed RC identity and exact-artifact promotion foundation (#3201)', () => {
  it('validates RC tags against the unchanged stable package version', () => {
    expect(releaseIdentity(tag, version)).toEqual({ version, tag, stage: 'rc', candidate: 2 });
    expect(releaseIdentity(`v${version}`, version, 'stable').version).toBe(version);
    expect(() => releaseIdentity(tag, `${version}-rc.2`)).toThrow(/identity/);
    expect(() => releaseIdentity('v2026.10.5-rc.2', version)).toThrow(/identity/);
    expect(() => releaseIdentity(tag, version, 'stable')).toThrow(/identity/);
  });
  it.each(['v2026.10.4-rc.0', 'v2026.10.4-rc.x', 'v2026.010.4-rc.1', 'v2026.10.4-beta.1', 'main'])('rejects malformed RC tag %s', invalid => expect(() => releaseIdentity(invalid, version)).toThrow());
  it('retains and verifies all three exact artifacts, SBOM, installer, and complete validation evidence', () => {
    const f = fixture(), verified = verifyRcBundle(f), plan = promotionPlan(verified);
    expect(plan.packages).toHaveLength(3);
    for (const pkg of plan.packages) {
      expect(pkg.sha256).toBe(sha256(pkg.path));
      expect(pkg.proposed_argv[1]).toBe(pkg.path);
      expect(pkg.proposed_argv).toContain('--ignore-scripts');
      expect(pkg.proposed_argv).not.toContain('pack');
    }
    expect(plan.ready_for_publication).toBe(false);
    expect(plan.unmet_gates.join(' ')).toContain('release-comparison');
    expect(sha256(plan.sbom)).toBe(f.manifest.files[`aiwg-${version}.cdx.json`]);
    expect(sha256(plan.installer)).toBe(f.manifest.files['install.sh']);
  });
  it('accepts an exact versioned routine profile and rejects mislabeled profile inventories', () => {
    const routine = fixture();
    rewriteValidation(routine, evidence => {
      evidence.version = 2; evidence.profile = 'routine-release-v1';
      evidence.lanes = ROUTINE_RC_LANES.map(lane => ({ lane, status: 'success' }));
    });
    expect(verifyRcBundle(routine).validation_profile).toBe('routine-release-v1');
    routine.run.event = 'workflow_dispatch';
    expect(verifyRcBundle(routine).validation_profile).toBe('routine-release-v1');

    const extra = fixture();
    rewriteValidation(extra, evidence => {
      evidence.version = 2; evidence.profile = 'routine-release-v1';
      evidence.lanes = [...ROUTINE_RC_LANES, 'test:deployment'].map(lane => ({ lane, status: 'success' }));
    });
    expect(() => verifyRcBundle(extra)).toThrow(/validation lane/);

    const unknown = fixture();
    rewriteValidation(unknown, evidence => { evidence.version = 2; evidence.profile = 'quarterly-full-v2'; });
    expect(() => verifyRcBundle(unknown)).toThrow(/validation lane/);
  });
  it('authenticates the quarterly-full profile only from an explicit dispatch on the signed RC tag', () => {
    const quarterly = fixture(); quarterly.run.event = 'workflow_dispatch';
    rewriteValidation(quarterly, evidence => {
      evidence.version = 2; evidence.profile = 'quarterly-full-v1';
      evidence.lanes = RC_LANES.map(lane => ({ lane, status: 'success' }));
    });
    expect(verifyRcBundle(quarterly).validation_profile).toBe('quarterly-full-v1');
    quarterly.run.event = 'push';
    expect(() => verifyRcBundle(quarterly)).toThrow(/workflow trigger/);
    const legacy = fixture(); legacy.run.event = 'workflow_dispatch';
    expect(() => verifyRcBundle(legacy)).toThrow(/workflow trigger/);
  });
  it.each(['missing', 'failure', 'cancelled', 'skipped', 'in_progress'])('rejects a %s RC run', state => {
    const f = fixture();
    if (state === 'missing') f.run = null;
    else if (state === 'in_progress') f.run.status = state;
    else f.run.conclusion = state;
    expect(() => verifyRcBundle(f)).toThrow();
  });
  it.each(['head_sha', 'repository', 'head_repository', 'path', 'event', 'head_branch', 'run_attempt'])('rejects mismatching trusted run field %s', key => {
    const f = fixture(); f.run[key] = key.includes('repository') ? { full_name: 'attacker/aiwg' } : key === 'run_attempt' ? 2 : 'wrong';
    expect(() => verifyRcBundle(f)).toThrow(/identity/);
  });
  it('rejects wrong stable commit and wrong signed RC tag object', () => {
    expect(() => verifyRcBundle({ ...fixture(), commit: 'c'.repeat(40) })).toThrow(/identity/);
    expect(() => verifyRcBundle({ ...fixture(), rcTagObjectSha: 'c'.repeat(40) })).toThrow(/identity/);
  });
  it('rejects mismatching manifest commit and missing required step evidence', () => {
    const f = fixture(); rewriteManifest(f, manifest => { manifest.commit = 'c'.repeat(40); });
    expect(() => verifyRcBundle(f)).toThrow(/identity/);
    const other = fixture(); other.jobs[0].steps.pop();
    expect(() => verifyRcBundle(other)).toThrow(/step/);
  });
  it.each([
    'Install locked dependencies',
    'Install locked Flue example dependencies for the offline release lane',
    'Install mandatory SQLite session test backend',
    'Scan known affected package feed',
    'Install syft (SBOM generator)',
  ])('rejects missing critical workflow step %s', name => {
    const f = fixture(); f.jobs[0].steps = f.jobs[0].steps.filter(step => step.name !== name);
    expect(() => verifyRcBundle(f)).toThrow(/step/);
  });
  it('binds the run to trusted workflow metadata and exact candidate source', () => {
    const wrongId = fixture(); wrongId.workflow.id += 1;
    expect(() => verifyRcBundle(wrongId)).toThrow(/workflow identity/);
    const wrongRunId = fixture(); wrongRunId.run.workflow_id += 1;
    expect(() => verifyRcBundle(wrongRunId)).toThrow(/workflow identity/);
    const wrongCommit = fixture(); wrongCommit.workflowSource.commit = 'c'.repeat(40);
    expect(() => verifyRcBundle(wrongCommit)).toThrow(/workflow identity/);
    const wrongContent = fixture(); wrongContent.workflowSource.sha256 = 'd'.repeat(64);
    expect(() => verifyRcBundle(wrongContent)).toThrow(/workflow identity/);
  });
  it('requires the manifest runner to match trusted job metadata', () => {
    const missingJobRunner = fixture(); delete missingJobRunner.jobs[0].runner_name;
    expect(() => verifyRcBundle(missingJobRunner)).toThrow(/job/);
    const differentJobRunner = fixture(); differentJobRunner.jobs[0].runner_name = 'different-runner';
    expect(() => verifyRcBundle(differentJobRunner)).toThrow(/job/);
    const missingManifestRunner = fixture(); rewriteManifest(missingManifestRunner, manifest => { manifest.runner = ''; });
    expect(() => verifyRcBundle(missingManifestRunner)).toThrow(/job/);
  });
  it.each(['expired', 'wrong-run', 'wrong-commit', 'missing'])('rejects %s artifacts', state => {
    const f = fixture();
    if (state === 'expired') f.artifact.expired = true;
    if (state === 'wrong-run') f.artifact.workflow_run.id = 22;
    if (state === 'wrong-commit') f.artifact.workflow_run.head_sha = 'c'.repeat(40);
    if (state === 'missing') f.artifact = null;
    expect(() => verifyRcBundle(f)).toThrow();
  });
  it.each(['aiwg', 'aiwg-cli', 'aiwg-cockpit'])('rejects changed %s bytes and missing tarballs', stem => {
    const f = fixture(), file = path.join(f.directory, `${stem}-${version}.tgz`);
    fs.appendFileSync(file, 'modified'); expect(() => verifyRcBundle(f)).toThrow(/digest/);
    fs.rmSync(file); expect(() => verifyRcBundle(f)).toThrow(/inventory/);
  });
  it('rejects missing manifest digests, symlinked assets, and failed validation lanes', () => {
    const f = fixture(); rewriteManifest(f, manifest => { delete manifest.files['install.sh']; });
    expect(() => verifyRcBundle(f)).toThrow(/digest/);
    const other = fixture(), file = path.join(other.directory, 'install.sh'), target = path.join(other.root, 'outside.sh');
    fs.renameSync(file, target); fs.symlinkSync(target, file); expect(() => verifyRcBundle(other)).toThrow(/inventory/);
    const failed = fixture(), validation = path.join(failed.directory, 'validation.json');
    const evidence = JSON.parse(fs.readFileSync(validation, 'utf8')); evidence.lanes[0].status = 'failure';
    fs.writeFileSync(validation, JSON.stringify(evidence)); rewriteManifest(failed, manifest => { manifest.files['validation.json'] = sha256(validation); });
    expect(() => verifyRcBundle(failed)).toThrow(/validation lane/);
  });
  it.each(['missing', 'failed'])('rejects %s deployment lane evidence', kind => {
    const f = fixture(), validation = path.join(f.directory, 'validation.json');
    const evidence = JSON.parse(fs.readFileSync(validation, 'utf8'));
    if (kind === 'missing') evidence.lanes = evidence.lanes.filter(item => item.lane !== 'test:deployment');
    else evidence.lanes.find(item => item.lane === 'test:deployment').status = 'failure';
    fs.writeFileSync(validation, JSON.stringify(evidence));
    rewriteManifest(f, manifest => { manifest.files['validation.json'] = sha256(validation); });
    expect(() => verifyRcBundle(f)).toThrow(/validation lane/);
  });
  it.each(['file', 'directory', 'symlink'])('rejects an extra unmanifested %s in the retained bundle', kind => {
    const f = fixture(), extra = path.join(f.directory, `extra-${kind}`);
    if (kind === 'file') fs.writeFileSync(extra, 'unmanifested');
    else if (kind === 'directory') fs.mkdirSync(extra);
    else {
      const target = path.join(f.root, 'outside'); fs.writeFileSync(target, 'outside'); fs.symlinkSync(target, extra);
    }
    expect(() => verifyRcBundle(f)).toThrow(/inventory/);
  });
  it('preserves every attempted validation lane and stops at a failed required lane', () => {
    const root = temp(), output = path.join(root, 'validation.json'), calls = [];
    expect(() => validateRelease({ root, output, spawn(command, args) {
      if (command === 'git') return { status: 0, stdout: commit };
      calls.push(args[1]); return { status: args[1] === 'build' ? 1 : 0 };
    } })).toThrow(/failed/);
    expect(calls).toEqual(['typecheck', 'build']);
    const evidence = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(evidence.pass).toBe(false); expect(evidence.lanes.at(-1).status).toBe('failure');
    expect(evidence.lanes.at(-1).completed_at).toBeTruthy();
  });
  it('records complete successful validation with exact required lane inventory', () => {
    const root = temp();
    const evidence = validateRelease({ root, output: path.join(root, 'validation.json'), spawn(command) { return { status: 0, stdout: command === 'git' ? commit : '' }; } });
    expect(evidence.pass).toBe(true); expect(evidence.profile).toBe('routine-release-v1');
    expect(evidence.lanes.map(item => item.lane)).toEqual(ROUTINE_RC_LANES);
    expect(new Set(ROUTINE_RC_LANES).size).toBe(ROUTINE_RC_LANES.length);
    expect(ROUTINE_RC_LANES).toHaveLength(24);
    expect(ROUTINE_RC_LANES).toContain('test:release:routine-deployment');
    expect(ROUTINE_RC_LANES).not.toContain('test:deployment');
    const quarterly = validateRelease({ root, profile: 'quarterly-full-v1', output: path.join(root, 'quarterly.json'),
      spawn(command) { return { status: 0, stdout: command === 'git' ? commit : '' }; } });
    expect(quarterly.lanes.map(item => item.lane)).toEqual(RC_LANES);
    expect(new Set(RC_LANES).size).toBe(RC_LANES.length);
    expect(RC_LANES).toHaveLength(43);
    for (const lane of ['build', 'test:ci', 'test:deployment', 'test:conformance', 'test:packaging', 'test:d29-slow', 'ci:fortemi-index']) expect(RC_LANES).toContain(lane);
    expect(RC_LANES.indexOf('test:deployment')).toBe(RC_LANES.indexOf('test:ci') + 1);
    expect(RC_VALIDATION_PROFILES).toEqual({ 'routine-release-v1': ROUTINE_RC_LANES, 'quarterly-full-v1': RC_LANES });
    expect(() => validateRelease({ root, profile: 'unknown', output: path.join(root, 'bad.json') })).toThrow(/Unknown/);
  });
  it('bounds the deployment lane and stops validation when it fails', () => {
    const root = temp(), output = path.join(root, 'validation.json'), calls = [];
    expect(() => validateRelease({ root, output, profile: 'quarterly-full-v1', spawn(command, args) {
      if (command === 'git') return { status: 0, stdout: commit };
      calls.push({ command, args });
      return { status: args.at(-1) === 'test:deployment' ? 1 : 0 };
    } })).toThrow(/failed/);
    expect(calls.at(-1).args.slice(-6)).toEqual(['--timeout', '18m', '--', 'npm', 'run', 'test:deployment']);
    const evidence = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(evidence.pass).toBe(false);
    expect(evidence.lanes.at(-1)).toMatchObject({ lane: 'test:deployment', status: 'failure' });
  });
  it('fails the full provider gate if the release-only infrastructure lane fails', () => {
    const root = temp(), output = path.join(root, 'validation.json'), calls = [];
    expect(() => validateRelease({ root, output, profile: 'quarterly-full-v1', spawn(command, args) {
      if (command === 'git') return { status: 0, stdout: commit };
      calls.push({ command, args });
      return { status: args.at(-1) === 'test:release-slow' ? 1 : 0 };
    } })).toThrow(/failed/);
    expect(calls.slice(-2).map(call => call.args.at(-1))).toEqual(['test:deployment', 'test:release-slow']);
    expect(calls.at(-1).args.slice(-6)).toEqual(['--timeout', '30m', '--', 'npm', 'run', 'test:release-slow']);
    const evidence = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(evidence.pass).toBe(false);
    expect(evidence.lanes.at(-1)).toMatchObject({ lane: 'test:deployment', status: 'failure' });
    expect(evidence.lanes.at(-1).completed_at).toBeTruthy();
  });
  it('smoke-installs the exact packed tarballs with isolated HOME and checks installed identity', () => {
    const root = temp(), output = path.join(root, 'bundle'), calls = [], homes = [];
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version })); fs.mkdirSync(path.join(root, 'ci'));
    fs.writeFileSync(path.join(root, 'ci/expected-tarball-top-level.txt'), 'package.json\n');
    const evidence = packAndSmoke({ root, output, spawn(command, args, profile, options) {
      calls.push({ command, args });
      if (command === 'npm' && args[0] === 'pack') {
        const surface = SURFACES.find(surface => path.join(root, surface.dir) === options.cwd);
        const filename = `${surface.stem}-${version}.tgz`; fs.writeFileSync(path.join(args[3], filename), surface.name);
        return { status: 0, stdout: JSON.stringify([{ name: surface.name, version, filename, files: [{ path: 'package.json' }] }]) };
      }
      if (command === 'npm' && args[0] === 'install') {
        expect(options.env.HOME).not.toBe(process.env.HOME); homes.push(options.env.HOME);
        expect(args).toContain('--ignore-scripts');
        const surface = SURFACES.find(surface => args.at(-1).endsWith(`${surface.stem}-${version}.tgz`));
        const installed = path.join(args[2], 'node_modules', ...surface.name.split('/'));
        fs.mkdirSync(installed, { recursive: true }); fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: surface.name, version }));
      }
      return { status: 0, stdout: version };
    } });
    expect(evidence.packages).toHaveLength(3);
    const packs = calls.filter(call => call.command === 'npm' && call.args[0] === 'pack');
    expect(packs).toHaveLength(4);
    expect(packs.at(-1).args[3]).not.toBe(output);
    expect(fs.existsSync(packs.at(-1).args[3])).toBe(false);
    expect(calls.filter(call => call.command === 'npm' && call.args[0] === 'install').every(call => path.dirname(call.args.at(-1)) === output)).toBe(true);
    expect(homes.every(home => !fs.existsSync(home))).toBe(true);
  });
  it('refuses a second cockpit build with different bytes before smoke or publication', () => {
    const root = temp(), output = path.join(root, 'bundle'), repacks = [];
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version })); fs.mkdirSync(path.join(root, 'ci'));
    fs.writeFileSync(path.join(root, 'ci/expected-tarball-top-level.txt'), 'package.json\n');
    let cockpitInstalls = 0;
    expect(() => packAndSmoke({ root, output, spawn(command, args, profile, options) {
      if (command === 'npm' && args[0] === 'pack') {
        const surface = SURFACES.find(surface => path.join(root, surface.dir) === options.cwd);
        const filename = `${surface.stem}-${version}.tgz`, destination = args[3];
        if (destination !== output) repacks.push(destination);
        fs.writeFileSync(path.join(destination, filename), surface.name + (destination === output ? '' : ' changed bundle'));
        return { status: 0, stdout: JSON.stringify([{ name: surface.name, version, filename, files: [{ path: 'package.json' }] }]) };
      }
      if (command === 'npm' && args[0] === 'install') {
        const surface = SURFACES.find(surface => args.at(-1).endsWith(`${surface.stem}-${version}.tgz`));
        if (surface.name === '@aiwg/cockpit') cockpitInstalls++;
        const installed = path.join(args[2], 'node_modules', ...surface.name.split('/'));
        fs.mkdirSync(installed, { recursive: true }); fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: surface.name, version }));
      }
      return { status: 0, stdout: version };
    } })).toThrow('Non-reproducible package tarball: @aiwg/cockpit');
    expect(cockpitInstalls).toBe(0);
    expect(repacks).toHaveLength(1);
    expect(repacks.every(directory => !fs.existsSync(directory))).toBe(true);
    expect(fs.existsSync(path.join(output, 'installed-smoke.json'))).toBe(false);
  });
  it('smoke-tests supplied recovery tarballs without running pack or build', () => {
    const root = temp(), output = path.join(root, 'bundle'), calls = [];
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version })); fs.mkdirSync(output);
    for (const surface of SURFACES) fs.writeFileSync(path.join(output, `${surface.stem}-${version}.tgz`), surface.name);
    const evidence = smokeTarballs({ root, output, spawn(command, args) {
      calls.push({ command, args });
      if (command === 'npm') {
        expect(args[0]).toBe('install');
        const surface = SURFACES.find(surface => args.at(-1).endsWith(`${surface.stem}-${version}.tgz`));
        const installed = path.join(args[2], 'node_modules', ...surface.name.split('/'));
        fs.mkdirSync(installed, { recursive: true }); fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: surface.name, version }));
      }
      return { status: 0, stdout: version };
    } });
    expect(evidence.packages.map(pkg => pkg.package)).toEqual(SURFACES.map(surface => surface.name));
    expect(calls.filter(call => call.command === 'npm')).toHaveLength(3);
    for (const item of evidence.packages) expect(item.sha256).toBe(sha256(path.join(output, item.filename)));
  });
  it('withholds publication and signing credentials from every recovery smoke child', () => {
    const root = temp(), output = path.join(root, 'bundle'), childEnvs = [];
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version })); fs.mkdirSync(output);
    for (const surface of SURFACES) fs.writeFileSync(path.join(output, `${surface.stem}-${version}.tgz`), surface.name);
    const credentials = Object.fromEntries(['GH_TOKEN', 'GITHUB_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_FUTURE',
      'SIGSTORE_ID_TOKEN', 'COSIGN_PASSWORD', 'COSIGN_PKCS11_PIN', 'COSIGN_IDENTITY_TOKEN', 'COSIGN_PRIVATE_KEY',
    ].map(key => [key, `synthetic-${key}`]));
    const env = { ...credentials, PATH: '/synthetic/bin', GITHUB_REPOSITORY: repository };
    const before = { ...env };
    const evidence = smokeTarballs({ root, output, env, spawn(command, args, _profile, options) {
      childEnvs.push(options.env);
      if (command === 'npm') {
        const surface = SURFACES.find(surface => args.at(-1).endsWith(`${surface.stem}-${version}.tgz`));
        const installed = path.join(args[2], 'node_modules', ...surface.name.split('/'));
        fs.mkdirSync(installed, { recursive: true }); fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: surface.name, version }));
      }
      return { status: 0, stdout: version };
    } });
    expect(evidence.pass).toBe(true);
    expect(childEnvs).toHaveLength(8);
    for (const childEnv of childEnvs) {
      for (const key of Object.keys(credentials)) expect(childEnv).not.toHaveProperty(key);
      expect(childEnv).toMatchObject({ PATH: '/synthetic/bin', GITHUB_REPOSITORY: repository });
    }
    expect(env).toEqual(before);
  });
  it('RC workflow retains pinned actions, signed-tag gate and all-success artifact upload; stable publish consumes it', () => {
    const root = repoRoot;
    const workflow = yaml.load(fs.readFileSync(workflowFile, 'utf8'));
    expect(workflow.on.push).toBeUndefined(); expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.on.workflow_dispatch.inputs.profile).toMatchObject({ required: true, default: 'routine-release-v1',
      options: ['routine-release-v1', 'quarterly-full-v1'] });
    const steps = workflow.jobs.validate.steps;
    expect(steps.filter(step => step.name !== 'Preserve failed validation diagnostics').map(step => step.name)).toEqual(RC_STEPS);
    for (const name of RC_STEPS) {
      const step = steps.find(step => step.name === name); expect(step).toBeDefined();
      expect(step['continue-on-error']).toBeUndefined(); expect(step.if).toBeUndefined();
    }
    const pins = fs.readFileSync(path.join(root, 'ci/digests.txt'), 'utf8');
    for (const step of steps.filter(step => step.uses)) expect(pins).toContain(step.uses.split('@')[1]);
    expect(steps.find(step => step.name === 'Verify signed RC tag').run).toContain('verify-signed-tag.sh');
    const upload = steps.find(step => step.name === 'Retain validated release candidate');
    expect(upload.with['if-no-files-found']).toBe('error'); expect(upload.with.name).toContain('github.run_attempt');
    const stable = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/npm-publish.yml'), 'utf8'));
    const publication = stable.jobs['publish-to-npmjs-org'].steps.find(step => step.name === 'Publish smoke-tested stable tarballs to npmjs.org');
    expect(publication.run).toContain('direct-stable-publish.mjs');
    expect(stable.on.workflow_dispatch.inputs).not.toHaveProperty('rc_tag');
    const profile = steps.find(step => step.name === 'Resolve validation profile');
    expect(profile.run).toContain("if [ \"${{ github.event_name }}\" = push ]");
    expect(profile.run).toContain("PROFILE='routine-release-v1'");
    expect(profile.run).toContain('routine-release-v1|quarterly-full-v1');
  });
  it('the tag helper validates an RC tag using stable package versions without reaching signing', () => {
    const root = temp(), script = path.resolve(import.meta.dirname, '../../../tools/release/cut-tag.sh');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
    fs.mkdirSync(path.join(root, '.claude-plugin'));
    // Deliberately stop at marketplace lockstep, before any key lookup or tag operation.
    fs.writeFileSync(path.join(root, '.claude-plugin/marketplace.json'), '{"version":"wrong"}');
    const result = spawnSync('bash', [script, `${version}-rc.2`], { cwd: root, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`preflight checks for v${version}-rc.2`);
    expect(result.stdout).toContain('[2/13] package.json lockstep OK');
    expect(result.stderr).toContain('marketplace.json version');
    expect(result.stderr).not.toContain(`expected '${version}-rc.2'`);
  });
  it('manifest creation refuses modified tarballs after installed smoke', () => {
    const f = fixture(); fs.appendFileSync(path.join(f.directory, `aiwg-${version}.tgz`), 'changed');
    expect(() => writeCandidateManifest({ root: f.root, output: f.directory, tag,
      spawn: (command, args) => ({ status: 0, stdout: args[1] === tag ? tagObject : commit }) })).toThrow(/smoke digest/);
  });
  it('manifest creation requires a nonempty runner identity', () => {
    const f = fixture();
    expect(() => writeCandidateManifest({ root: f.root, output: f.directory, tag,
      env: { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: '12', GITHUB_RUN_ATTEMPT: '1' },
      spawn: (command, args) => ({ status: 0, stdout: args[1] === tag ? tagObject : commit }) })).toThrow(/run identity/);
  });

});
