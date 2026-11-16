import { installedResourceModelsHandler, installedHostResourceReaders } from '../../helpers/host-resource-handler.js';
import { idleHostResourceReaders } from '../../fixtures/host-resources.js';
import { workerInstalledFixture } from '../../helpers/worker-installed-fixture.js';
import { workerSigningFixture } from '../../helpers/worker-qualification-signing.js';
import { mkdtempSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, rm, access, chmod, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readAiwgConfig } from '../../../src/config/aiwg-config.js';
import { buildDirectWorkerDoctorSection } from '../../../src/models/worker-direct-readiness.js';
import { assertWorkerRoleEffort, loadProviderModelCapabilities, validateWorkerCatalogDiscovery } from '../../../src/models/provider-policy.js';
import { writeExecutable } from '../../helpers/write-executable.js';
import { createModelsHandler, loadWorkerInputs } from '../../../src/cli/handlers/models.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';
import { checkCodexWorkerSandbox, checkWorkerInvocationBuilds, checkRecordedWorkerInvocationBuilds, qualifyProbedWorkers } from '../../../tools/cli/worker-qualification.mjs';
const modelsHandler = createModelsHandler({ load: ctx => loadWorkerInputs(ctx, idleHostResourceReaders()) });
const terminal = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({ createInterface: () => terminal }));
// In-process resolver and TTY cases need the same temp HOME as the spawned CLI cases.
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, homedir: () => process.env.HOME || os.homedir() };
});
const exec = promisify(execFile);
const repo = process.cwd();
const roots: string[] = [];
const profile: Array<{ test: string; kind: string; ms: number }> = [];
let profileScope: string | undefined;
function timed(kind: string, start: number) {
  if (process.env.QUALIFICATION_PROFILE) profile.push({ test: profileScope ?? expect.getState().currentTestName ?? 'installation beforeAll', kind, ms: performance.now() - start });
}
afterEach(async () => {
  if (process.env.QUALIFICATION_PROFILE) await writeFile(process.env.QUALIFICATION_PROFILE, JSON.stringify(profile, null, 2));
});
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
let sharedInstalled: string;
const installationRoots: string[] = [];

async function installFixture(root: string) {
  const start = performance.now();
  const installed = await workerInstalledFixture(root, repo);
  timed('installation', start);
  return installed;
}

beforeAll(async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-qualification-install-'));
  installationRoots.push(root);
  sharedInstalled = await installFixture(root);
});
afterAll(async () => {
  for (const root of installationRoots) await rm(root, { recursive: true, force: true });
});

async function fixture(providerless = false, unsetHome = false, namespaceProbe = true, cli = 'codex',
  options: { privateInstallation?: boolean; roots?: string[] } = {}) {
  const fixtureStart = performance.now();
  const role = cli === 'muse' ? 'efficiency' : 'coding';
  const model = cli === 'muse' ? 'muse-spark-1.3' : 'synthetic-model';
  const root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-qualify-workers-'));
  (options.roots ?? roots).push(root);
  // Only permission/renderer mutation cases need a private installation.
  // Project, store, executable and HOME remain private to each fixture.
  const installed = options.privateInstallation ? await installFixture(root) : sharedInstalled;
  const project = path.join(root, 'project');
  const config = path.join(root, 'config');
  await mkdir(path.join(project, '.aiwg'), { recursive: true });
  await mkdir(config, { mode: 0o700 });
  const systemdBin = path.join(root, 'systemd-bin');
  await mkdir(systemdBin);
  await writeExecutable(path.join(systemdBin, 'systemd-run'), `#!${process.execPath}
if (process.argv.includes('--version')) console.log('systemd 255');
else if (${namespaceProbe}) process.exit(0);
else { console.error('uid_map: Operation not permitted'); process.exit(1); }
`);
  // The sandbox probe resolves the CLI's bwrap before entering the unit; hosts and CI
  // runners without one must still reach the fake systemd-run outcome below.
  await writeExecutable(path.join(systemdBin, 'bwrap'), `#!${process.execPath}\nprocess.exit(0);\n`);
  await writeExecutable(path.join(systemdBin, 'systemctl'), `#!${process.execPath}
if (process.argv.includes('show-environment')) process.exit(0);
else console.log('255');
`);
  const binary = path.join(root, `fake-${cli}`);
  const writeCli = (version: string) => writeExecutable(binary, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('codex-cli ${version}');\nelse if (process.argv.slice(2).join(' ') === 'debug models') console.log(JSON.stringify({models:[{slug:'synthetic-model',${providerless ? '' : "provider:'synthetic-inference',"}visibility:'listed',context_window:32000,${providerless ? '' : 'output_limit:4096,'}supported_reasoning_levels:['medium']}]}));\nelse if (process.argv[2] === 'sandbox' && process.env.PATH && process.argv.slice(-3).join(' ') === '/bin/sh -c true') process.exit(0);\nelse process.exit(90);\n`);
  if (cli === 'muse') {
    await writeExecutable(binary, `#!${process.execPath}
if (process.argv.slice(2).join(' ') === '--version') console.log('Muse Code 1.4.12 (1.4.12-R6909.1)');
else if (process.argv[2] === 'exec') console.log(JSON.stringify({argv:process.argv.slice(2)}));
else process.exit(90);
`);
    const catalog = path.join(root, '.local/share/muse/model-catalog');
    await mkdir(catalog, { recursive: true });
    await writeFile(path.join(catalog, 'synthetic.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), rows: [{
      // Native Muse rows report inference identity via provider_id; unlike
      // Codex, discovery cannot infer it when the field is absent.
      model_id: model, provider_id: 'meta', visibility: 'listed', is_default: true, is_current: true,
      reasoning_effort_variants: [{ tier: 'medium' }], context_limit: 128000, output_limit: 16000,
    }] }));
  } else await writeCli(unsetHome ? '0.163.0' : '0.161.0');
  await writeFile(path.join(project, '.aiwg/aiwg.config'), JSON.stringify({ version: '1', providers: [cli],
    parallelism: { worker_dispatch: true, clis: { [cli]: { adapter: `providers:${cli}`, executable: binary,
      accountScope: 'synthetic-account', quotaScope: 'synthetic-quota' } }, groups: { workers: { maxParallel: 1,
      execution: { sandbox: 'workspace-write', approval: 'never', transport: 'shell' },
      members: [{ id: 'primary', cli, model, roles: [role] }] } } } }));
  const signing = await workerSigningFixture(root, project);
  // These are explicit test policy choices, never inferred account/data facts.
  await writeFile(path.join(project, 'models.json'), JSON.stringify({ defaults: { workerSelection: {
    roleGuidance: { [role]: { groups: ['workers'], tier: 'standard', initialEffort: 'medium', effortLadder: ['medium'] } },
    guards: { denySelfDelegation: false }, dataPolicy: { allowUnknown: true } } } }));
  const brief = path.join(project, 'brief.txt');
  await writeFile(brief, 'Synthetic implementation brief.');
  const env = { ...process.env, PATH: `${systemdBin}${path.delimiter}${process.env.PATH}`, HOME: root, AIWG_CONFIG: config, AIWG_HOME: repo, AIWG_ROOT: repo,
    AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', AIWG_RESOLVE_IMPL_FROM: 'dist', NODE_OPTIONS: '' };
  if (unsetHome) delete (env as NodeJS.ProcessEnv).AIWG_HOME;
  delete (env as NodeJS.ProcessEnv).VITEST;
  // Exercise the shipped handlers in a fresh process. Run npm run build:cli
  // before this suite; fake CLIs do not need a TypeScript loader.
  const entry = path.join(root, 'cli.mjs');
  await writeFile(entry, `const [command, ...args] = process.argv.slice(2);
const handler = command === 'models'
  ? ${installedResourceModelsHandler(installed)}
  : (await import(${JSON.stringify(pathToFileURL(path.join(installed, 'dist/src/cli/handlers/utilities.js')).href)})).doctorHandler;
const result = await handler.execute({args, rawArgs: [command, ...args], cwd: process.cwd(), frameworkRoot: ${JSON.stringify(installed)}});
if (result.message) console.error(result.message);
process.exitCode = result.exitCode;
`);
  timed('fixture', fixtureStart);
  const runNode = async (args: string[], cwd = project) => {
    const start = performance.now();
    try {
      const result = await exec(process.execPath, args, { cwd, env, timeout: 30000, maxBuffer: 1024 * 1024 });
      return { code: 0, ...result };
    } catch (error: any) { return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
    finally { timed(args[0] === entry ? args.slice(1).join(' ') : 'runNode ' + args.slice(1).join(' '), start); }
  };
  const run = (args: string[], cwd = project) => runNode([entry, ...args], cwd);
  const resolveArgs = ['resolve', '--role', role, '--task', cli === 'muse' ? 'inventory' : 'implementation', '--group', 'workers',
    '--brief', brief, '--workdir', project, '--final-output', path.join(project, 'result.json'), '--format', 'json'];
  const resolve = () => run(['models', ...resolveArgs]);
  // Resolver-only cases use the same exported handler and real loaders, store,
  // version probe, and installed driver, without restarting the CLI process.
  const inProcess = async <T>(kind: string, action: () => Promise<T>) => {
    const start = performance.now();
    const stdout: string[] = [], stderr: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(value => { stdout.push(String(value)); });
    const error = vi.spyOn(console, 'error').mockImplementation(value => { stderr.push(String(value)); });
    for (const key of ['HOME', 'AIWG_CONFIG', 'AIWG_HOME', 'AIWG_ROOT', 'AIWG_RESOLVE_IMPL_FROM', 'PATH', 'NODE_OPTIONS'] as const) {
      vi.stubEnv(key, env[key]);
    }
    // Use this fixture's actual cache, just as a fresh CLI process would.
    vi.stubEnv('VITEST', undefined);
    try {
      const value = await action();
      return { value, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    } finally {
      log.mockRestore(); error.mockRestore(); vi.unstubAllEnvs();
      timed(kind, start);
    }
  };
  const modelsInProcess = async (args: string[], cwd = project) => {
    const { value, ...output } = await inProcess('models API ' + args.join(' '), () =>
      modelsHandler.execute({ args, rawArgs: ['models', ...args], cwd, frameworkRoot: installed }));
    return { code: value.exitCode, ...output };
  };
  const resolveInProcess = () => modelsInProcess(resolveArgs);
  const qualifyInProcess = async () => {
    const { value } = await inProcess('qualification API', async () => {
      const config = await readAiwgConfig(project);
      const registry = loadProviderModelCapabilities();
      const section = await buildDirectWorkerDoctorSection({ parallelism: config!.parallelism,
        registry, probeWorkers: true, projectRoot: project });
      return qualifyProbedWorkers({ projectDir: project, packageRoot: installed, config, registry, section, yes: true });
    });
    return value;
  };
  return { root, project, config, binary, installed, writeCli, run, runNode, resolve, resolveInProcess, modelsInProcess, qualifyInProcess, signing };
}

describe('doctor worker qualification through the public CLI (fake CLIs only)', () => {
  it('diagnoses unsigned and forged approvals at the affected CLI without trusting valid digests', async () => {
    const f = await fixture();
    const qualified = await f.qualifyInProcess();
    expect(qualified.status, JSON.stringify(qualified)).toBe('recorded');
    const filename = path.join(f.config, 'worker-installations.json');
    const stored = JSON.parse(await readFile(filename, 'utf8'));
    expect(stored.registrations[0].signature.keyid).toBe(f.signing.keyring.keys[0].keyid);
    for (const kind of ['unsigned', 'forged', 'wrong-keyid']) {
      const changed = structuredClone(stored);
      if (kind === 'unsigned') delete changed.registrations[0].signature;
      if (kind === 'forged') changed.registrations[0].binding.endpointFingerprint = 'forged-endpoint';
      if (kind === 'wrong-keyid') changed.registrations[0].signature.keyid = `sha256:${'0'.repeat(64)}`;
      await writeFile(filename, JSON.stringify(changed));
      const probed = await f.run(['doctor', '--probe-workers', '--json']);
      const report = JSON.parse(probed.stdout);
      expect(report.invocationChecks).toContainEqual(expect.objectContaining({ cli: 'codex', status: 'blocked',
        diagnostics: [expect.objectContaining({ code: 'OG_ADAPTER_UNQUALIFIED', pointer: '/parallelism/clis/codex',
          message: expect.stringContaining('aiwg doctor --probe-workers --qualify') })] }));
      if (kind === 'unsigned') expect(probed.stdout).toContain('one-time requalification');
    }
  });

  it('reports unavailable signing keys and leaves dispatch-disabled doctor behavior unchanged', async () => {
    const f = await fixture();
    await rm(f.signing.keyPath);
    const qualification = await f.qualifyInProcess();
    expect(qualification).toMatchObject({ status: 'failed', results: [expect.objectContaining({ cli: 'codex', status: 'failed',
      message: expect.stringContaining('effects.keyProvider') })] });
    expect(qualification.results[0].message).toContain('aiwg effect keys init');
    await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const filename = path.join(f.project, '.aiwg/aiwg.config');
    const config = JSON.parse(await readFile(filename, 'utf8'));
    config.parallelism.worker_dispatch = false;
    await writeFile(filename, JSON.stringify(config));
    const disabled = await f.run(['doctor', '--probe-workers', '--json']);
    expect(disabled.code, disabled.stdout + disabled.stderr).toBe(0);
    expect(disabled.stdout).toContain('WORKER_DIRECT_DISABLED');
    expect(disabled.stdout).not.toContain('signing trust is unavailable');
  });

  it('preserves null effort for models with no applicable effort control', () => {
    const policy = { roleGuidance: { efficiency: { groups: ['workers'], tier: 'standard' as const,
      initialEffort: null, effortLadder: [], allowNotApplicableEffort: true } } };
    expect(() => assertWorkerRoleEffort(policy, 'efficiency', false)).not.toThrow();
    expect(() => assertWorkerRoleEffort(policy, 'efficiency', true)).toThrow('explicit initial effort');
  });

  it.each(['missing-file', 'missing-role', 'missing-field', 'null-effort'])('names missing role effort before adapter build and host loading (%s)', async kind => {
    const f = await fixture();
    const filename = path.join(f.project, 'models.json');
    if (kind === 'missing-file') await rm(filename);
    else {
      const models = JSON.parse(await readFile(filename, 'utf8'));
      if (kind === 'missing-role') delete models.defaults.workerSelection.roleGuidance.coding;
      else if (kind === 'missing-field') delete models.defaults.workerSelection.roleGuidance.coding.initialEffort;
      else Object.assign(models.defaults.workerSelection.roleGuidance.coding,
        { initialEffort: null, effortLadder: [], allowNotApplicableEffort: true });
      await writeFile(filename, JSON.stringify(models));
    }
    const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(qualified.code, qualified.stdout + qualified.stderr).toBe(1);
    expect(qualified.stderr).toBe('');
    expect(qualified.stdout).not.toBe('');
    const report = JSON.parse(qualified.stdout);
    const diagnostic = kind === 'missing-field' ? report.qualification.diagnostics[0]
      : report.qualification.results[0].invocationChecks[0].diagnostics[0];
    expect(diagnostic).toMatchObject({ code: 'OG_CONFIG_REFERENCE',
      pointer: '/defaults/workerSelection/roleGuidance/coding/initialEffort',
      message: expect.stringContaining('models.json') });
    expect(diagnostic.message).toContain('coding');
    expect(qualified.stdout).not.toContain('invocation_build_failed');
    await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const resolved = await f.resolveInProcess();
    expect(resolved.code).toBe(2);
    const resolution = JSON.parse(resolved.stdout);
    if (kind === 'missing-field') expect(resolution.diagnostics).toContainEqual(diagnostic);
    else expect(resolution.diagnostics).toContainEqual(expect.objectContaining({ code: 'OG_ADAPTER_UNQUALIFIED' }));
    expect(resolution.invocation).toBeUndefined();
  });

  it('retains exact approvals for parallel workspaces and replaces only the requalified workspace', async () => {
    const f = await fixture();
    const second = path.join(f.root, 'second-project');
    await mkdir(path.join(second, '.aiwg'), { recursive: true });
    for (const filename of ['.aiwg/aiwg.config', '.aiwg-location', 'models.json', 'brief.txt']) {
      await writeFile(path.join(second, filename), await readFile(path.join(f.project, filename)));
    }
    const qualificationArgs = ['doctor', '--probe-workers', '--qualify', '--yes', '--json'];
    const results = await Promise.all([f.run(qualificationArgs), f.run(qualificationArgs, second)]);
    for (const result of results) expect(result.code, result.stdout + result.stderr).toBe(0);
    const store = path.join(f.config, 'worker-installations.json');
    expect(JSON.parse(await readFile(store, 'utf8')).registrations).toHaveLength(2);
    const again = await f.qualifyInProcess();
    expect(again.status, JSON.stringify(again)).toBe('recorded');
    expect(JSON.parse(await readFile(store, 'utf8')).registrations).toHaveLength(2);
    const first = await f.resolveInProcess();
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const resolved = await f.modelsInProcess(['resolve', '--role', 'coding', '--task', 'implementation', '--group', 'workers',
      '--brief', path.join(second, 'brief.txt'), '--workdir', second, '--final-output', path.join(second, 'result.json'),
      '--format', 'json'], second);
    expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
    expect(JSON.parse(resolved.stdout).invocation.cwd).toBe(second);
    const probed = await f.run(['doctor', '--probe-workers', '--json']);
    expect(probed.code, probed.stdout + probed.stderr).toBe(0);
    // Duplicate authority for one exact key still fails closed.
    const stored = JSON.parse(await readFile(store, 'utf8'));
    stored.registrations.push(stored.registrations.find((record: any) => record.installation.cwd === f.project));
    await writeFile(store, JSON.stringify(stored));
    const ambiguous = await f.resolveInProcess();
    expect(ambiguous.code).toBe(2);
    expect(JSON.parse(ambiguous.stdout).invocation).toBeUndefined();
  });

  it('bounds the approval set without eviction and permits replacement at capacity', async () => {
    const f = await fixture();
    const args = ['doctor', '--probe-workers', '--qualify', '--yes', '--json'];
    const first = await f.run(args);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const store = path.join(f.config, 'worker-installations.json');
    const stored = JSON.parse(await readFile(store, 'utf8'));
    const record = stored.registrations[0];
    stored.registrations = [record, ...Array.from({ length: 127 }, (_, index) => ({ ...record, cli: `retained-${index}` }))];
    await writeFile(store, JSON.stringify(stored));
    const replaced = await f.qualifyInProcess();
    expect(replaced.status, JSON.stringify(replaced)).toBe('recorded');
    expect(JSON.parse(await readFile(store, 'utf8')).registrations).toHaveLength(128);
    stored.registrations[0].cli = 'retained-127';
    const bytes = JSON.stringify(stored);
    await writeFile(store, bytes);
    const full = await f.qualifyInProcess();
    expect(full.status, JSON.stringify(full)).toBe('failed');
    expect(JSON.stringify(full)).toContain('store is full');
    expect(await readFile(store, 'utf8')).toBe(bytes);
    await expect(access(`${store}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses qualification when the model-free Codex sandbox check fails', async () => {
    const f = await fixture();
    await writeExecutable(f.binary, `#!${process.execPath}
if (process.argv.includes('--version')) console.log('codex-cli 0.161.0');
else if (process.argv[2] === 'sandbox') { console.error('synthetic-secret'); process.exit(1); }
else console.log(JSON.stringify({models:[]}));
`);
    const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    const report = JSON.parse(result.stdout);
    expect(report.qualification.status).toBe('failed');
    expect(report.qualification.results[0].message).toMatch(/sandbox no-op check failed/);
    expect(result.stdout + result.stderr).not.toContain('synthetic-secret');
    await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toThrow();
  });

  it.each([
    { cli: 'codex', mixed: false }, { cli: 'codex', mixed: true }, { cli: 'muse', mixed: false },
  ])('qualifies and resolves explicit $cli external sandbox policy (mixed=$mixed)', async ({ cli, mixed }) => {
    const f = await fixture(false, false, true, cli);
    const configPath = path.join(f.project, '.aiwg/aiwg.config');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (mixed) config.parallelism.groups.enforcing = structuredClone(config.parallelism.groups.workers);
    config.parallelism.groups.workers.execution.sandbox = 'external';
    await writeFile(configPath, JSON.stringify(config));
    if (cli === 'codex' && !mixed) {
      const source = await readFile(f.binary, 'utf8');
      const broken = source.replace("process.exit(0);\nelse process.exit(90);", "process.exit(91);\nelse process.exit(90);");
      expect(broken).not.toBe(source);
      await writeFile(f.binary, broken);
    }
    const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
    const report = JSON.parse(qualified.stdout);
    expect(report.qualification.results[0].status).toBe('qualified');
    if (cli === 'codex') expect(report.qualification.results[0].codexSandboxChecks).toEqual([
      expect.objectContaining({ cli, group: 'workers', status: 'skipped' }),
      ...(mixed ? [expect.objectContaining({ cli, group: 'enforcing', status: 'passed' })] : []),
    ]);
    const resolved = await f.resolve();
    expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
    const plan = JSON.parse(resolved.stdout);
    expect(plan.invocation.readiness).toBe('launchable');
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code: 'OG_SANDBOX_EXTERNAL', blocking: false,
      message: expect.stringContaining(`${cli} CLI's own sandbox is disabled`) }));
    expect(plan.invocation.argv).toEqual(expect.arrayContaining(cli === 'codex'
      ? ['-s', 'danger-full-access', 'approval_policy="never"']
      : ['--disable-sandbox', '--approval-mode', 'never', '--approval-judge', 'off']));
  });

  it('passes only named environment variables to the sandbox no-op', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-sandbox-env-'));
    roots.push(root);
    const binary = path.join(root, 'codex');
    await writeExecutable(binary, `#!${process.execPath}
if (process.env.UNRELATED_SECRET || process.env.PATH !== '/usr/bin:/bin'
  || process.argv.slice(-3).join(' ') !== '/bin/sh -c true') process.exit(1);
`);
    vi.stubEnv('UNRELATED_SECRET', 'must-not-pass');
    try {
      await expect(checkCodexWorkerSandbox({ executable: binary, cwd: root,
        environment: { PATH: '/usr/bin:/bin' } })).resolves.toEqual({ status: 'passed' });
    } finally { vi.unstubAllEnvs(); }
  });

  it('qualifies installed Muse and resolves and executes a Tier 0 efficiency command with a fake CLI', async () => {
    const f = await fixture(false, false, true, 'muse');
    const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--cli', 'muse', '--yes', '--json']);
    expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
    expect(JSON.parse(qualified.stdout).qualification.results).toMatchObject([{ cli: 'muse', status: 'qualified' }]);
    const resolved = await f.resolve();
    expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
    const plan = JSON.parse(resolved.stdout);
    expect(plan.invocation).toMatchObject({ readiness: 'launchable', selected: { model: 'muse-spark-1.3', effort: { value: 'medium' } } });
    const launched = await f.runNode([f.binary, ...plan.invocation.argv.slice(1)]);
    expect(launched.code, launched.stderr).toBe(0);
    expect(JSON.parse(launched.stdout).argv).toEqual(plan.invocation.argv.slice(1));
    expect(plan.invocation.argv).toContain('--prompt-file');
    expect(plan.invocation.argv).not.toContain('--output-schema');
    expect(plan.invocation.shellCommand).toContain('< /dev/null');

    const filename = path.join(f.project, '.aiwg/aiwg.config');
    const config = JSON.parse(await readFile(filename, 'utf8'));
    config.parallelism.groups.workers.execution.approval = 'on-request';
    await writeFile(filename, JSON.stringify(config));
    const denied = await f.resolve();
    expect(denied.code).not.toBe(0);
    expect(JSON.parse(denied.stdout).invocation).toBeUndefined();
  });

  it('reports a blocked namespace probe as launcher-scoped and still qualifies Tier 0 direct dispatch', async () => {
    // Tier 0 direct handoff runs the rendered command from the conductor's own
    // shell outside the conductor harness's sandbox; only the systemd-unit
    // launcher needs the namespace probe, and it fails closed at launch.
    const f = await fixture(false, false, false);
    const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.workers[0]).toMatchObject({ ready: true,
      launcherSandbox: { status: 'blocked', code: 'OG_NATIVE_SANDBOX_UNAVAILABLE', scope: 'systemd-launcher' } });
    expect(report.sandboxChecks[0]).toMatchObject({ status: 'blocked', scope: 'systemd-launcher', probe: {
      ok: false, detail: 'uid_map: Operation not permitted', code: 'OG_NATIVE_SANDBOX_UNAVAILABLE' } });
    expect(report.qualification).toMatchObject({ status: 'recorded', sandboxChecks: report.sandboxChecks });
    await expect(access(path.join(f.config, 'worker-installations.json'))).resolves.toBeUndefined();
    const resolved = await f.resolve();
    expect(resolved.code, resolved.stderr).toBe(0);
    expect(JSON.parse(resolved.stdout).invocation.readiness).toBe('launchable');
  });

  it('qualifies native-sandbox policy without the failing systemd namespace probe', async () => {
    const f = await fixture(false, false, false);
    const filename = path.join(f.project, '.aiwg/aiwg.config');
    const config = JSON.parse(await readFile(filename, 'utf8'));
    config.parallelism.groups.workers.execution.launchMode = 'native-sandbox';
    await writeFile(filename, JSON.stringify(config));
    const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.sandboxChecks).toMatchObject([{ isolation: 'native-sandbox', status: 'skipped' }]);
    expect(report.qualification.status).toBe('recorded');
    const resolved = await f.resolve();
    expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
    expect(JSON.parse(resolved.stdout).invocation.isolation).toBe('native-sandbox');
  });

  it('loads and revalidates an eligible plan through the launcher after builtin Codex registration', async () => {
    const f = await fixture(false, true);
    const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(qualified.code, qualified.stderr).toBe(0);
    expect(JSON.parse(qualified.stdout).qualification.status).toBe('recorded');
    const script = path.join(f.root, 'launcher-check.mjs');
    const planPath = path.join(f.root, 'plan.json');
    await writeFile(script, `import { mkdir, writeFile } from 'node:fs/promises';
import { loadWorkerInputs } from ${JSON.stringify(pathToFileURL(path.join(f.installed, 'dist/src/cli/handlers/models.js')).href)};
import { hasProvider } from ${JSON.stringify(pathToFileURL(path.join(f.installed, 'dist/src/models/worker-installation.mjs')).href)};
const context = { cwd: process.cwd(), args: [], rawArgs: [], frameworkRoot: ${JSON.stringify(f.installed)} };
if (process.argv[2] === 'seed') {
  if (hasProvider('codex')) throw new Error('Unexpected builtin registration before resolve');
  const { snapshot } = await loadWorkerInputs(context, ${installedHostResourceReaders()});
  const directory = process.env.HOME + '/.cache/aiwg';
  await mkdir(directory, { recursive: true });
  await writeFile(directory + '/model-catalog.v1.json', JSON.stringify(snapshot.catalog));
} else {
  await import(${JSON.stringify(pathToFileURL(path.join(f.installed, 'tools/ralph-external/lib/codex-adapter.mjs')).href)});
  if (!hasProvider('codex')) throw new Error('Builtin Codex was not registered');
  const { SessionLauncher } = await import(${JSON.stringify(pathToFileURL(path.join(f.installed, 'tools/ralph-external/session-launcher.mjs')).href)});
  let loaded = false;
  let spawned = false;
  try {
    await new SessionLauncher().launchWorker({ invocationPath: ${JSON.stringify(planPath)}, runDir: process.cwd(),
      loadInputs: async () => { const inputs = await loadWorkerInputs(context, ${installedHostResourceReaders()}); loaded = true; return inputs; },
      launchIsolated: () => { spawned = true; throw new Error('Unexpected worker spawn'); } });
    throw new Error('Expected invalid run directory refusal');
  } catch (error) {
    if (!error.message.startsWith('Worker run directory must be fresh, empty, private and owned. Pass a run_dir path that does not exist yet')) throw error;
  }
  console.log(JSON.stringify({ loaded, spawned }));
}
`);
    expect((await f.runNode([script, 'seed'])).code).toBe(0);
    const resolved = await f.resolve();
    expect(resolved.code, resolved.stdout).toBe(0);
    expect(JSON.parse(resolved.stdout)).toMatchObject({ status: 'eligible', invocation: { readiness: 'launchable' } });
    await writeFile(planPath, resolved.stdout, { mode: 0o600 });
    const launched = await f.runNode([script, 'launch']);
    expect(launched.code, launched.stderr).toBe(0);
    expect(JSON.parse(launched.stdout)).toEqual({ loaded: true, spawned: false });
    const storePath = path.join(f.config, 'worker-installations.json');
    const store = JSON.parse(await readFile(storePath, 'utf8'));
    store.registrations[0].installation.environment = { AIWG_SYNTHETIC_PRIVATE: 'synthetic-private-content' };
    await writeFile(storePath, JSON.stringify(store));
    const refused = await f.runNode([script, 'launch']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('OG_ADAPTER_UNQUALIFIED');
    expect(refused.stderr).toContain('signature-invalid');
    expect(refused.stderr).not.toContain('synthetic-private-content');
  });

  it('refuses a non-canonical workerAdapters entry claiming a pre-registered builtin id', async () => {
    const f = await fixture();
    expect((await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json'])).code).toBe(0);
    const script = path.join(f.root, 'conflicting-adapter.mjs');
    await writeFile(script, `import { readFile } from 'node:fs/promises';
import ${JSON.stringify(pathToFileURL(path.join(f.installed, 'tools/ralph-external/lib/codex-adapter.mjs')).href)};
import { loadInstalledWorkerAdapters, loadRecordedWorkerInstallations, createProvider } from ${JSON.stringify(pathToFileURL(path.join(f.installed, 'dist/src/models/worker-installation.mjs')).href)};
import { loadProviderModelCapabilities } from ${JSON.stringify(pathToFileURL(path.join(f.installed, 'dist/src/models/provider-policy.js')).href)};
import { ConfigLoader } from ${JSON.stringify(pathToFileURL(path.join(f.installed, 'dist/src/models/config-loader.js')).href)};
import { readAiwgConfig } from ${JSON.stringify(pathToFileURL(path.join(f.installed, 'dist/src/config/aiwg-config.js')).href)};
const { registrations: [record] } = JSON.parse(await readFile(${JSON.stringify(path.join(f.config, 'worker-installations.json'))}, 'utf8'));
const registry = structuredClone(loadProviderModelCapabilities());
for (const provider of Object.values(registry.providers)) delete provider.workerAdapter;
registry.workerAdapters = { imposter: record.adapter };
const builtin = createProvider('codex').constructor;
try {
  await loadInstalledWorkerAdapters({ registry, modules: record.installation.modules,
    workerWritableRoots: record.installation.workerWritableRoots });
  throw new Error('Unexpected conflicting registration');
} catch (error) {
  if (error.code !== 'WORKER_ADAPTER_CONFLICT' || createProvider('codex').constructor !== builtin) throw error;
  console.log(error.code);
}
const config = await readAiwgConfig(process.cwd());
const models = await new ConfigLoader(process.cwd()).load(config.parallelism);
try {
  await loadRecordedWorkerInstallations({ registry, cwd: process.cwd(), policy: models.defaults.workerSelection });
  throw new Error('Unexpected promotion of a conflicting workerAdapters entry');
} catch (error) {
  if (error.code !== 'OG_ADAPTER_UNQUALIFIED' || error.details?.rejections?.[0]?.reason !== 'adapter-metadata') throw error;
  console.log(error.code);
}
`);
    const result = await f.runNode([script]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['WORKER_ADAPTER_CONFLICT', 'OG_ADAPTER_UNQUALIFIED']);
  });

  it.each([false, true])('checks the configured tuple without launching a worker (build failure: %s)', async fail => {
    const f = workerResolutionFixture();
    const root = mkdtempSync(path.join(os.tmpdir(), 'worker-build-check-')); roots.push(root);
    const buildInvocation = vi.fn(async () => {
      if (fail) throw new Error('sensitive-build-details');
      return { argv: ['/synthetic/worker'], stdin: 'closed', envNames: [] };
    });
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    try {
      const checks = await checkWorkerInvocationBuilds({ projectDir: root, config: f.snapshot.config,
        policy: f.snapshot.models.defaults.workerSelection, cli: 'codex',
        observations: f.snapshot.catalog.discovery!.instances!.codex, driver: { buildInvocation,
          qualification: { adapter: f.snapshot.registry.providers.codex.workerAdapter,
            installation: { cwd: root, profile: 'fixture-shell' } } } });
      expect(checks).toHaveLength(2);
      expect(buildInvocation).toHaveBeenCalledTimes(2);
      expect(buildInvocation.mock.calls[0]).toEqual([expect.objectContaining({ cwd: root,
        selected: expect.objectContaining({ member: 'primary', effort: { support: 'explicit', value: 'medium' } }) })]);
      expect(checks[0]).toMatchObject({ status: fail ? 'blocked' : 'passed', workdir: root });
      if (fail) expect(checks[0].diagnostics[0]).toMatchObject({ reason: 'invocation_build_failed', pointer: '/invocation/buildInvocation' });
      expect(JSON.stringify(checks)).not.toContain('sensitive-build-details');
      expect(await readdir(root)).toEqual([]);
    } finally { vi.unstubAllEnvs(); }
  });

  it('rejects missing role guidance before calling the installed renderer', async () => {
    const f = workerResolutionFixture();
    const root = mkdtempSync(path.join(os.tmpdir(), 'worker-role-precheck-')); roots.push(root);
    const buildInvocation = vi.fn(() => { throw new Error('renderer must not run'); });
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    try {
      const checks = await checkWorkerInvocationBuilds({ projectDir: root, config: f.snapshot.config,
        policy: { ...f.snapshot.models.defaults.workerSelection, roleGuidance: {} }, cli: 'codex',
        observations: f.snapshot.catalog.discovery!.instances!.codex, driver: { buildInvocation,
          qualification: { adapter: f.snapshot.registry.providers.codex.workerAdapter,
            installation: { cwd: root, profile: 'fixture-shell' } } } });
      expect(checks).toHaveLength(2);
      expect(buildInvocation).not.toHaveBeenCalled();
      for (const check of checks) expect(check).toMatchObject({ status: 'blocked', diagnostics: [{
        code: 'OG_CONFIG_REFERENCE', pointer: `/defaults/workerSelection/roleGuidance/${check.role}/initialEffort`,
        message: expect.stringContaining('models.json'),
      }] });
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(['native-controls', 'workspace'])('names the failing %s check without launching a worker', async kind => {
    const f = workerResolutionFixture();
    const root = mkdtempSync(path.join(os.tmpdir(), 'worker-build-check-')); roots.push(root);
    const other = path.join(root, 'other'); await mkdir(other);
    const adapter = f.snapshot.registry.providers.codex.workerAdapter!;
    adapter.provider = 'codex';
    adapter.qualification.evidenceRef = 'aiwg doctor --probe-workers --qualify';
    const buildInvocation = vi.fn(async () => ({ argv: ['/synthetic/worker'], stdin: 'closed', envNames: [] }));
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    try {
      const checks = await checkWorkerInvocationBuilds({ projectDir: root, config: f.snapshot.config,
        policy: f.snapshot.models.defaults.workerSelection, cli: 'codex',
        observations: f.snapshot.catalog.discovery!.instances!.codex, driver: { buildInvocation,
          qualification: { adapter, installation: { cwd: kind === 'workspace' ? other : root, profile: 'fixture-shell' } } } });
      expect(checks[0]).toMatchObject({ status: 'blocked', diagnostics: [expect.objectContaining({
        reason: kind === 'workspace' ? 'qualified_workspace_mismatch' : 'native_argv_invalid',
        pointer: kind === 'workspace' ? '/request/workdir' : '/invocation/argv' })] });
      if (kind === 'workspace') expect(buildInvocation).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([false, true])('checks the configured tuple from recorded installations (load failure: %s)', async fail => {
    const f = workerResolutionFixture();
    const root = mkdtempSync(path.join(os.tmpdir(), 'worker-recorded-check-')); roots.push(root);
    await writeFile(path.join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: f.projectPolicy } }));
    await writeFile(path.join(root, 'worker-installations.json'), '{"version":1,"registrations":[]}');
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src'); vi.stubEnv('AIWG_CONFIG', root);
    const host = await import('../../../src/models/worker-installation.mjs');
    const { WorkerPolicyError } = await import('../../../src/models/provider-policy.js');
    const load = vi.spyOn(host, 'loadRecordedWorkerInstallations');
    if (fail) load.mockRejectedValue(new WorkerPolicyError('OG_ADAPTER_UNQUALIFIED', 'sensitive-installation-details'));
    else load.mockResolvedValue({ ...f.snapshot, qualificationFailures: { missing: 'signature-missing' },
      observations: { codex: f.snapshot.catalog.discovery!.instances!.codex }, drivers: {
      codex: { qualification: { adapter: f.snapshot.registry.providers.codex.workerAdapter,
        installation: { cwd: root, profile: 'fixture-shell' } },
      buildInvocation: async () => ({ argv: ['/synthetic/worker'], stdin: 'closed', envNames: [] }) },
    } } as any);
    try {
      const checks = await checkRecordedWorkerInvocationBuilds({ projectDir: root, config: f.snapshot.config,
        registry: f.snapshot.registry, workers: [{ cli: 'codex', ready: true }, { cli: 'missing', ready: true }] });
      expect(checks.find(check => check.cli === 'codex')?.status).toBe(fail ? 'blocked' : 'passed');
      expect(checks.find(check => check.cli === 'missing')).toMatchObject({ status: 'blocked',
        diagnostics: [expect.objectContaining({ code: 'OG_ADAPTER_UNQUALIFIED' })] });
      if (!fail) expect(checks.find(check => check.cli === 'missing')?.diagnostics[0]).toMatchObject({
        pointer: '/parallelism/clis/missing', message: expect.stringContaining('one-time requalification'),
      });
      expect(JSON.stringify(checks)).not.toContain('sensitive-installation-details');
    } finally { load.mockRestore(); vi.unstubAllEnvs(); }
  });

  it('blocks changed payload versions behind an unchanged launcher, and failed probes', async () => {
    const f = await fixture();
    const payload = path.join(f.root, 'payload.cjs');
    await writeFile(payload, await readFile(f.binary));
    await writeExecutable(f.binary, `#!${process.execPath}\nrequire(${JSON.stringify(payload)});\n`);
    const launcher = await readFile(f.binary, 'utf8');
    const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
    const resolved = await f.resolveInProcess();
    expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
    for (const source of [
      `console.log('codex-cli 0.162.0');\n`,
      `process.exit(90);\n`,
      `console.log('invalid version banner');\n`,
    ]) {
      await writeFile(payload, source);
      expect(await readFile(f.binary, 'utf8')).toBe(launcher);
      const changed = await f.resolveInProcess();
      expect(changed.code).not.toBe(0);
      expect(changed.stdout).toContain('aiwg doctor --probe-workers --qualify');
    }
  });

  it('qualifies installation and exact model roles and renders a launchable plan', async () => {
    const f = await fixture();
    const before = await f.resolve();
    expect(before.code, before.stdout + before.stderr).not.toBe(0);
    const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
    const report = JSON.parse(qualified.stdout);
    expect(report.qualification.results).toEqual([expect.objectContaining({ cli: 'codex', status: 'qualified', models: ['synthetic-model'] })]);
    expect(report.invocationChecks).toEqual([expect.objectContaining({ cli: 'codex', group: 'workers', member: 'primary',
      role: 'coding', model: 'synthetic-model', effort: 'medium', workdir: f.project, status: 'passed', diagnostics: [] })]);
    const probed = await f.run(['doctor', '--probe-workers', '--json']);
    expect(probed.code, probed.stdout + probed.stderr).toBe(0);
    expect(JSON.parse(probed.stdout).invocationChecks).toEqual(report.invocationChecks);
    await expect(access(path.join(f.project, '.worker-probe'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(report.qualification.accountScopeNotice).toContain('bound only to the configured accountScope label');
    expect(report.qualification.accountScopeNotice).toContain('Account switches are not detected');
    const resolved = await f.resolve();
    expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
    const invocation = JSON.parse(resolved.stdout).invocation;
    expect(invocation.readiness).toBe('launchable');
    expect(invocation.argv).toEqual(expect.arrayContaining(['-m', 'synthetic-model', '-s', 'workspace-write', '-c', 'model_reasoning_effort="medium"']));
    expect(invocation.shellCommand).toContain("'-s' 'workspace-write'");
  });

  it('blocks a qualified installation when the group asks for unsupported approval or step controls', async () => {
    const f = await fixture();
    const qualified = await f.qualifyInProcess();
    expect(qualified.status, JSON.stringify(qualified)).toBe('recorded');
    const configPath = path.join(f.project, '.aiwg/aiwg.config');
    const configText = await readFile(configPath, 'utf8');
    const unsupportedApproval = JSON.parse(configText);
    unsupportedApproval.parallelism.groups.workers.execution.approval = 'on-request';
    await writeFile(configPath, JSON.stringify(unsupportedApproval));
    const blockedProbe = await f.run(['doctor', '--probe-workers', '--json']);
    expect(blockedProbe.code, blockedProbe.stdout + blockedProbe.stderr).toBe(1);
    const blockedReport = JSON.parse(blockedProbe.stdout);
    expect(blockedReport.workers[0]).toMatchObject({ ready: false, reason: 'WORKER_DIRECT_INVOCATION_BLOCKED' });
    const blockedResolve = await f.resolveInProcess();
    expect(blockedResolve.code).toBe(2);
    expect(blockedReport.invocationChecks[0].diagnostics).toEqual(JSON.parse(blockedResolve.stdout).diagnostics);
    const blockedText = await f.run(['doctor', '--probe-workers', '--cli', 'codex']);
    expect(blockedText.code).toBe(1);
    expect(blockedText.stdout).toContain('invocation_build_failed');
    await writeFile(configPath, configText);
    const stricter = JSON.parse(configText);
    stricter.parallelism.health = { requireStepCap: true };
    await writeFile(configPath, JSON.stringify(stricter));
    const unsupportedControl = await f.resolveInProcess();
    expect(unsupportedControl.code).not.toBe(0);
    expect(unsupportedControl.stdout).toContain('OG_ADAPTER_UNQUALIFIED');
    await writeFile(configPath, configText);
  });

  it('records role qualification and invalidates it when the binary version changes', async () => {
    const f = await fixture();
    const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
    const stored = JSON.parse(await readFile(path.join(f.config, 'worker-installations.json'), 'utf8'));
    expect(stored.registrations[0].modelObservations.models[0].worker.qualification.roles).toEqual(['coding']);
    expect(stored.registrations[0].installation.evidence.cases).toBeUndefined();
    await f.writeCli('0.162.0');
    const changed = await f.resolveInProcess();
    expect(changed.code).not.toBe(0);
    expect(changed.stdout).toContain('aiwg doctor --probe-workers --qualify');
  });

  it('requires requalification after the configured accountScope label changes', async () => {
    const f = await fixture();
    const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
    const resolved = await f.resolveInProcess();
    expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
    const filename = path.join(f.project, '.aiwg/aiwg.config');
    const config = JSON.parse(await readFile(filename, 'utf8'));
    config.parallelism.clis.codex.accountScope = 'synthetic-account-2';
    await writeFile(filename, JSON.stringify(config));
    const changed = await f.resolveInProcess();
    expect(changed.code).not.toBe(0);
    expect(JSON.parse(changed.stdout).invocation).toBeUndefined();
  });

  it('restores dispatch after requalifying under a changed accountScope label', async () => {
    const f = await fixture();
    const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
    const filename = path.join(f.project, '.aiwg/aiwg.config');
    const config = JSON.parse(await readFile(filename, 'utf8'));
    config.parallelism.clis.codex.accountScope = 'synthetic-account-2';
    await writeFile(filename, JSON.stringify(config));
    const requalified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(requalified.code, requalified.stdout + requalified.stderr).toBe(0);
    const restored = await f.resolveInProcess();
    expect(restored.code, restored.stdout + restored.stderr).toBe(0);
  });

  it('reports the accountScope limitation in text qualification results', async () => {
    const f = await fixture();
    const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('bound only to the configured accountScope label');
    expect(result.stdout).toContain('Account switches are not detected');
    expect(result.stdout).toContain('change parallelism.clis.<cli>.accountScope');
    expect(result.stdout).toContain('refresh model discovery, and requalify before dispatch');
  });

  describe('approved observation reconciliation', () => {
    const retainedRoots: string[] = [];
    let current: Awaited<ReturnType<typeof approvedFixture>>;
    let legacy: Awaited<ReturnType<typeof approvedFixture>>;
    async function approvedFixture(localAccount: boolean) {
      const f = await fixture(false, false, true, 'codex', { roots: retainedRoots });
      if (localAccount) {
        const filename = path.join(f.project, '.aiwg/aiwg.config');
        const config = JSON.parse(await readFile(filename, 'utf8'));
        config.parallelism.clis.codex.accountScope = 'local-account';
        await writeFile(filename, JSON.stringify(config));
      }
      const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
      expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
      const stored = JSON.parse(await readFile(path.join(f.config, 'worker-installations.json'), 'utf8'));
      const sources = await f.modelsInProcess(['sources', '--json']);
      expect(sources.code, sources.stdout + sources.stderr).toBe(0);
      return { f, approved: stored.registrations[0].modelObservations, sources: JSON.parse(sources.stdout) };
    }
    beforeAll(async () => {
      profileScope = 'approved observation reconciliation beforeAll';
      try { current = await approvedFixture(false); legacy = await approvedFixture(true); }
      finally { profileScope = undefined; }
    });
    afterEach(async () => {
      for (const root of retainedRoots) await rm(path.join(root, '.cache'), { recursive: true, force: true });
    });
    afterAll(async () => {
      for (const root of retainedRoots) await rm(root, { recursive: true, force: true });
    });
    it.each(['same-facts', 'banner', 'context', 'efforts', 'older', 'retired', 'hidden', 'conflict'])(
      'reconciles approved observations with %s discovery cache', async kind => {
        const { f, approved, sources } = kind === 'banner' ? legacy : current;
        const catalog = JSON.parse(await readFile(path.join(repo, 'agentic/code/providers/model-catalog.v1.json'), 'utf8'));
        const discovery = structuredClone(approved);
        const timestamp = new Date(Date.parse(approved.observedAt) + (kind === 'older' ? -1000 : 1)).toISOString();
        discovery.observedAt = timestamp;
        if (kind === 'banner') { discovery.runtimeVersion = 'codex-cli 0.161.0'; delete discovery.accountBinding; }
        for (const row of discovery.models) {
          row.worker.observedAt = timestamp;
          if (kind === 'banner') row.worker.runtimeVersion = 'codex-cli 0.161.0';
          row.worker.verifiedAt = timestamp;
          row.worker.fetchedAt = timestamp;
          row.worker.evidenceDigest = 'sha256:' + 'a'.repeat(64);
          row.worker.qualification = { status: 'unqualified', roles: [] };
          if (kind === 'context' || kind === 'older') row.worker.contextTokens = 1;
          if (kind === 'efforts') { row.worker.efforts = [{ id: 'high', selfDelegates: false }]; row.reasoningEfforts = ['high']; }
          if (kind === 'retired') row.worker.lifecycle = 'retired';
          if (kind === 'hidden') { row.hidden = true; row.worker.visibility = 'hidden'; }
          if (kind === 'conflict') row.worker.conflicts = [{ field: '/contextTokens',
            evidence: [16000, 32000].map(value => ({ value, source: 'fixture:catalog', pointer: '/context_window',
              observedAt: timestamp, digest: row.worker.evidenceDigest })) }];
        }
        catalog.refreshedAt = new Date().toISOString();
        catalog.discovery = { ...sources.discovery, source: 'native', fetchedAt: catalog.refreshedAt,
          providers: { codex: discovery } };
        expect(validateWorkerCatalogDiscovery(catalog.discovery)).toEqual([]);
        const cacheFile = path.join(f.root, '.cache/aiwg/model-catalog.v1.json');
        await mkdir(path.dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, JSON.stringify(catalog));
        const resolved = await f.resolveInProcess();
        if (kind === 'same-facts' || kind === 'banner' || kind === 'older') {
          expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
          expect(JSON.parse(resolved.stdout).invocation.readiness).toBe('launchable');
        } else {
          expect(resolved.code, resolved.stdout + resolved.stderr).not.toBe(0);
          expect(resolved.stdout).toContain('aiwg doctor --probe-workers --qualify');
        }
        await expect(access(path.join(f.project, 'result.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      });
  });

  it('surfaces the offending installed path and exact permission remedy', async () => {
    const f = await fixture(false, false, true, 'codex', { privateInstallation: true });
    await chmod(f.installed, 0o775);
    const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout).qualification.results[0].message).toBe(
      `Installed module path is group/other-writable: ${f.installed}. Run: chmod -R go-w ${JSON.stringify(f.installed)}`);
    expect((await stat(f.installed)).mode & 0o777).toBe(0o775);
  });

  it('previews owned store permission tightening without writes and applies it with --yes', async () => {
    const f = await fixture();
    await chmod(f.config, 0o775);
    const preview = await f.run(['doctor', '--probe-workers', '--qualify', '--dry-run', '--json']);
    expect(preview.code, preview.stdout + preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout).qualification.storeChanges).toEqual([{ path: f.config, action: 'chmod go-w' }]);
    expect((await stat(f.config)).mode & 0o777).toBe(0o775);
    await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const applied = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(applied.code, applied.stdout + applied.stderr).toBe(0);
    expect((await stat(f.config)).mode & 0o777).toBe(0o755);
  });

  it('qualifies providerless Codex 0.163.0 rows with AIWG_HOME unset', async () => {
    const f = await fixture(true, true);
    const configFile = path.join(f.project, '.aiwg/aiwg.config');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.parallelism.groups.workers.members.push({ id: 'reviewer', cli: 'codex', model: 'synthetic-model', roles: ['reasoning'] });
    config.parallelism.groups.workers.requiredRoles = ['coding', 'reasoning'];
    await writeFile(configFile, JSON.stringify(config));
    const modelsFile = path.join(f.project, 'models.json');
    const models = JSON.parse(await readFile(modelsFile, 'utf8'));
    models.defaults.workerSelection.roleGuidance.reasoning = { groups: ['workers'], tier: 'premium', initialEffort: 'medium', effortLadder: ['medium'] };
    await writeFile(modelsFile, JSON.stringify(models));
    const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).qualification.status).toBe('recorded');
    const stored = JSON.parse(await readFile(path.join(f.config, 'worker-installations.json'), 'utf8'));
    expect(stored.registrations[0].modelObservations.models[0].llmProvider).toBe('openai');
    expect(stored.registrations[0].modelObservations.models[0].worker.qualification.roles).toEqual(['coding', 'reasoning']);
    expect((await f.resolveInProcess()).code).toBe(0);
    const reviewArgs = ['models', 'resolve', '--role', 'reasoning', '--task', 'review', '--group', 'workers',
      '--brief', path.join(f.project, 'brief.txt'), '--workdir', f.project, '--final-output', path.join(f.project, 'review.json'), '--format', 'json'];
    const review = JSON.parse((await f.modelsInProcess(reviewArgs.slice(1))).stdout);
    const exclusions = review.exclusions;
    expect(exclusions.flatMap((entry: any) => entry.diagnostics).some((d: any) => d.message.includes('Role lacks qualified evidence'))).toBe(false);
    expect(exclusions.find((entry: any) => entry.member === 'reviewer').diagnostics.filter((d: any) => d.blocking !== false).map((d: any) => d.pointer)).toEqual(['/request/authority']);
    expect(JSON.stringify(exclusions)).toContain('--authorize-premium');
    const authorized = await f.modelsInProcess([...reviewArgs.slice(1), '--authorize-premium']);
    expect(authorized.code, authorized.stdout + authorized.stderr).toBe(0);
    const plan = JSON.parse(authorized.stdout);
    expect(plan.invocation.readiness).toBe('launchable');
    expect(plan.selected.context.qualifiedMaxOutputTokens).toBeNull();
    expect(plan.selected.diagnostics).toContainEqual(expect.objectContaining({ blocking: false,
      message: 'Output limit is unreported; only the context window was checked.' }));
    expect((await f.run([...reviewArgs.slice(0, -1), 'shell', '--authorize-premium'])).code).toBe(0);
    expect((await f.modelsInProcess(reviewArgs.slice(1))).code).not.toBe(0);
    await expect(access(path.join(f.project, 'review.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('explains that an existing relative brief must be absolute', async () => {
    const f = await fixture();
    await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    const result = await f.modelsInProcess(['resolve', '--role', 'coding', '--task', 'implementation', '--group', 'workers',
      '--brief', 'brief.txt', '--workdir', f.project, '--final-output', path.join(f.project, 'result.json'), '--format', 'json']);
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout).diagnostics).toContainEqual({ code: 'OG_CONFIG_REFERENCE', pointer: '/request/brief',
      message: '--brief must be an absolute path; relative paths are not resolved against cwd or --workdir.' });
  });

  it('blocks an operator-approved installed renderer that silently drops the requested sandbox', async () => {
    const f = await fixture(false, false, true, 'codex', { privateInstallation: true });
    const driver = path.join(f.installed, 'tools/ralph-external/lib/codex-adapter.mjs');
    const source = await readFile(driver, 'utf8');
    expect(source).toContain("'-s', sandbox === 'external' ? 'danger-full-access' : sandbox,");
    await writeFile(driver, source.replace("'-s', sandbox === 'external' ? 'danger-full-access' : sandbox,", ''));
    const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(qualified.code, qualified.stdout + qualified.stderr).toBe(1);
    const report = JSON.parse(qualified.stdout);
    expect(report.qualification.results[0].status).toBe('failed');
    expect(report.workers[0]).toMatchObject({ ready: false, inRange: true, reason: 'WORKER_DIRECT_INVOCATION_BLOCKED' });
    expect(report.invocationChecks[0].diagnostics[0]).toMatchObject({
      pointer: '/invocation/argv', reason: 'native_argv_invalid' });
    await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const resolved = await f.resolve();
    expect(resolved.code).not.toBe(0);
    expect(JSON.parse(resolved.stdout).invocation).toBeUndefined();
    expect(resolved.stdout).toContain('OG_ADAPTER_UNQUALIFIED');
  });

  it('reports a sanitized adapter build failure before recording qualification', async () => {
    const f = await fixture(false, false, true, 'codex', { privateInstallation: true });
    const driver = path.join(f.installed, 'tools/ralph-external/lib/codex-adapter.mjs');
    const source = await readFile(driver, 'utf8');
    await writeFile(driver, source.replace('const model = invocation?.selected?.model;', "throw new Error('sensitive-build-details');"));
    const result = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.workers[0]).toMatchObject({ ready: false, reason: 'WORKER_DIRECT_INVOCATION_BLOCKED' });
    expect(report.invocationChecks[0].diagnostics[0]).toMatchObject({
      pointer: '/invocation/buildInvocation', reason: 'invocation_build_failed' });
    expect(result.stdout + result.stderr).not.toContain('sensitive-build-details');
    await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('doctor and resolve name the same qualified workspace mismatch for another worktree', async () => {
    const f = await fixture();
    const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
    const worktree = path.join(f.project, 'worktree');
    await mkdir(path.join(worktree, '.aiwg'), { recursive: true });
    for (const filename of ['.aiwg/aiwg.config', '.aiwg-location', 'models.json', 'brief.txt']) {
      await writeFile(path.join(worktree, filename), await readFile(path.join(f.project, filename)));
    }
    const probed = await f.run(['doctor', '--probe-workers', '--json'], worktree);
    expect(probed.code, probed.stdout + probed.stderr).toBe(1);
    const report = JSON.parse(probed.stdout);
    expect(report.workers[0]).toMatchObject({ inRange: true, ready: false, reason: 'WORKER_DIRECT_INVOCATION_BLOCKED' });
    const resolved = await f.run(['models', 'resolve', '--role', 'coding', '--task', 'implementation', '--group', 'workers',
      '--brief', path.join(worktree, 'brief.txt'), '--workdir', worktree, '--final-output', path.join(worktree, 'result.json'),
      '--format', 'json'], worktree);
    expect(resolved.code).toBe(2);
    const diagnostic = JSON.parse(resolved.stdout).diagnostics.at(-1);
    expect(diagnostic).toMatchObject({ code: 'OG_CONFIG_REFERENCE', pointer: '/request/workdir', reason: 'qualified_workspace_mismatch' });
    expect(report.invocationChecks[0].diagnostics).toContainEqual(diagnostic);
  });

  it('requires --yes without a TTY and dry-run previews without creating qualification records', async () => {
    const f = await fixture();
    const refused = await f.run(['doctor', '--probe-workers', '--qualify', '--json']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('--yes');
    await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const configPath = path.join(f.project, '.aiwg/aiwg.config');
    const configured = JSON.parse(await readFile(configPath, 'utf8'));
    configured.parallelism.clis.other = { adapter: 'providers:codex', executable: path.join(f.root, 'never-probed'), accountScope: 'other', quotaScope: 'other' };
    configured.parallelism.groups.workers.members.push({ id: 'other-member', cli: 'other', model: 'synthetic-model', roles: ['coding'] });
    configured.parallelism.groups.workers.fallback = ['other-member'];
    await writeFile(configPath, JSON.stringify(configured));
    const preview = await f.run(['doctor', '--probe-workers', '--qualify', '--dry-run', '--json', '--cli', 'codex']);
    expect(preview.code, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout).qualification.status).toBe('dry-run');
    expect(JSON.parse(preview.stdout).qualification.accountScopeNotice).toContain('Account switches are not detected');
    expect(JSON.parse(preview.stdout).workers.map((worker: any) => worker.cli)).toEqual(['codex']);
    await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('records ready installations independently of whether worker policy permits dispatch', async () => {
    const f = await fixture();
    const filename = path.join(f.project, 'models.json');
    const policy = JSON.parse(await readFile(filename, 'utf8'));
    policy.defaults.workerSelection.guards.denySelfDelegation = true;
    await writeFile(filename, JSON.stringify(policy));
    const approved = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(approved.code, approved.stdout + approved.stderr).toBe(0);
    expect(JSON.parse(approved.stdout).qualification.results[0].status).toBe('qualified');
    const denied = await f.resolve();
    expect(denied.code).not.toBe(0);
    expect(denied.stdout).toContain('OG_ADAPTER_UNQUALIFIED');
    expect(JSON.parse(await readFile(filename, 'utf8')).defaults.workerSelection.guards.denySelfDelegation).toBe(true);
  });

  it('asks one TTY question listing installation/model/roles and honors no without writes', async () => {
    const f = await fixture();
    await chmod(f.config, 0o775);
    const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const outputTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    vi.stubEnv('AIWG_HOME', repo);
    vi.stubEnv('HOME', f.root);
    vi.stubEnv('AIWG_CONFIG', f.config);
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    terminal.question.mockResolvedValue('n');
    terminal.close.mockClear();
    try {
      const { qualifyProbedWorkers } = await import('../../../tools/cli/worker-qualification.mjs');
      const { loadProviderModelCapabilities } = await import('../../../src/models/provider-policy.js');
      const result = await qualifyProbedWorkers({ projectDir: f.project, packageRoot: f.installed,
        config: JSON.parse(await readFile(path.join(f.project, '.aiwg/aiwg.config'), 'utf8')),
        registry: loadProviderModelCapabilities(), section: { installFindings: [{ cli: 'codex', readiness: 'ready', installedVersion: '0.161.0' }] },
        detectIsolation: () => ({ mode: 'systemd-unit' }),
        probeNativeSandbox: async () => ({ ok: true, mode: 'systemd-unit' }) });
      expect(result.status).toBe('declined');
      expect(result.accountScopeNotice).toContain('Account switches are not detected');
      expect(terminal.question).toHaveBeenCalledTimes(1);
      expect(terminal.question.mock.calls[0][0]).toContain('synthetic-model');
      expect(terminal.question.mock.calls[0][0]).toContain('coding');
      expect(terminal.question.mock.calls[0][0]).toContain('codex');
      expect(terminal.question.mock.calls[0][0]).toContain('chmod go-w');
      expect(terminal.question.mock.calls[0][0]).toContain(f.config);
      expect(terminal.question.mock.calls[0][0]).toContain('Account switches are not detected');
      expect(terminal.question.mock.calls[0][0]).toContain('change parallelism.clis.<cli>.accountScope');
      expect((await stat(f.config)).mode & 0o777).toBe(0o775);
      expect(terminal.close).toHaveBeenCalledTimes(1);
      await expect(access(path.join(f.config, 'worker-installations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (inputTTY) Object.defineProperty(process.stdin, 'isTTY', inputTTY);
      else delete (process.stdin as any).isTTY;
      if (outputTTY) Object.defineProperty(process.stdout, 'isTTY', outputTTY);
      else delete (process.stdout as any).isTTY;
      vi.unstubAllEnvs();
    }
  });

});
