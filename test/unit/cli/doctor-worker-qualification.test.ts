import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, cp, chmod, readdir, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateWorkerCatalogDiscovery } from '../../../src/models/provider-policy.js';
import { writeExecutable } from '../../helpers/write-executable.js';

const terminal = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({ createInterface: () => terminal }));
// The in-process TTY case needs the same temp HOME as the spawned CLI cases.
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, homedir: () => process.env.HOME || os.homedir() };
});

const exec = promisify(execFile);
const repo = process.cwd();
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(providerless = false, unsetHome = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-qualify-workers-'));
  roots.push(root);
  // Installed modules must be outside worker-writable roots with trusted modes,
  // independent of the checkout's umask or dist/ state.
  const installed = path.join(root, 'installed');
  await mkdir(installed, { mode: 0o755 });
  await cp(path.join(repo, 'package.json'), path.join(installed, 'package.json'));
  for (const directory of ['src', 'tools']) await cp(path.join(repo, directory), path.join(installed, directory), { recursive: true });
  async function trust(directory: string) {
    await chmod(directory, 0o755);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await trust(filename);
      else if (entry.isFile()) await chmod(filename, 0o644);
    }
  }
  await trust(installed);
  for (const directory of ['node_modules', 'agentic', 'schemas', 'vscode-extension']) await symlink(path.join(repo, directory), path.join(installed, directory));
  const project = path.join(root, 'project');
  const config = path.join(root, 'config');
  await mkdir(path.join(project, '.aiwg'), { recursive: true });
  await mkdir(config, { mode: 0o700 });
  const binary = path.join(root, 'fake-codex');
  const writeCli = (version: string) => writeExecutable(binary, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('codex-cli ${version}');\nelse if (process.argv.slice(2).join(' ') === 'debug models') console.log(JSON.stringify({models:[{slug:'synthetic-model',${providerless ? '' : "provider:'synthetic-inference',"}visibility:'listed',context_window:32000,${providerless ? '' : 'output_limit:4096,'}supported_reasoning_levels:['medium']}]}));\nelse process.exit(90);\n`);
  await writeCli(unsetHome ? '0.163.0' : '0.161.0');
  await writeFile(path.join(project, '.aiwg/aiwg.config'), JSON.stringify({ version: '1', providers: ['codex'],
    parallelism: { worker_dispatch: true, clis: { codex: { adapter: 'providers:codex', executable: binary,
      accountScope: 'synthetic-account', quotaScope: 'synthetic-quota' } }, groups: { workers: { maxParallel: 1,
      execution: { sandbox: 'workspace-write', approval: 'never', transport: 'shell' },
      members: [{ id: 'primary', cli: 'codex', model: 'synthetic-model', roles: ['coding'] }] } } } }));
  // These are explicit test policy choices, never inferred account/data facts.
  await writeFile(path.join(project, 'models.json'), JSON.stringify({ defaults: { workerSelection: {
    roleGuidance: { coding: { groups: ['workers'], tier: 'standard', initialEffort: 'medium', effortLadder: ['medium'] } },
    guards: { denySelfDelegation: false }, dataPolicy: { allowUnknown: true } } } }));
  const brief = path.join(project, 'brief.txt');
  await writeFile(brief, 'Synthetic implementation brief.');
  const env = { ...process.env, HOME: root, AIWG_CONFIG: config, AIWG_HOME: repo, AIWG_ROOT: repo,
    AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', AIWG_RESOLVE_IMPL_FROM: 'src', NODE_OPTIONS: `--import=${path.join(repo, 'node_modules/tsx/dist/loader.mjs')}` };
  if (unsetHome) delete (env as NodeJS.ProcessEnv).AIWG_HOME;
  delete (env as NodeJS.ProcessEnv).VITEST;
  // Exercise the public handlers in a fresh process, without a dist prerequisite.
  const entry = path.join(root, 'cli.mjs');
  await writeFile(entry, `import { modelsHandler } from ${JSON.stringify(pathToFileURL(path.join(installed, 'src/cli/handlers/models.ts')).href)};
import { doctorHandler } from ${JSON.stringify(pathToFileURL(path.join(installed, 'src/cli/handlers/utilities.ts')).href)};
const [command, ...args] = process.argv.slice(2);
const result = await ({models: modelsHandler, doctor: doctorHandler})[command].execute({args, rawArgs: [command, ...args], cwd: process.cwd(), frameworkRoot: ${JSON.stringify(installed)}});
if (result.message) console.error(result.message);
process.exitCode = result.exitCode;
`);
  const run = async (args: string[]) => {
    try {
      const result = await exec(process.execPath, [entry, ...args], { cwd: project, env, timeout: 30000, maxBuffer: 1024 * 1024 });
      return { code: 0, ...result };
    } catch (error: any) { return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
  };
  const resolve = () => run(['models', 'resolve', '--role', 'coding', '--task', 'implementation', '--group', 'workers',
    '--brief', brief, '--workdir', project, '--final-output', path.join(project, 'result.json'), '--format', 'json']);
  return { root, project, config, binary, installed, writeCli, run, resolve };
}

describe('doctor worker qualification through the public CLI (fake CLIs only)', () => {
  it('blocks changed payload versions behind an unchanged launcher, and failed probes', async () => {
    const f = await fixture();
    const payload = path.join(f.root, 'payload.cjs');
    await writeFile(payload, await readFile(f.binary));
    await writeExecutable(f.binary, `#!${process.execPath}\nrequire(${JSON.stringify(payload)});\n`);
    const launcher = await readFile(f.binary, 'utf8');
    const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
    const resolved = await f.resolve();
    expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
    for (const source of [
      `console.log('codex-cli 0.162.0');\n`,
      `process.exit(90);\n`,
      `console.log('invalid version banner');\n`,
    ]) {
      await writeFile(payload, source);
      expect(await readFile(f.binary, 'utf8')).toBe(launcher);
      const changed = await f.resolve();
      expect(changed.code).not.toBe(0);
      expect(changed.stdout).toContain('aiwg doctor --probe-workers --qualify');
    }
  });

  it('qualifies installation and exact model roles, renders a launchable plan, and invalidates changed binary/version', async () => {
    const f = await fixture();
    const before = await f.resolve();
    expect(before.code, before.stdout + before.stderr).not.toBe(0);
    const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
    const report = JSON.parse(qualified.stdout);
    expect(report.qualification.results).toEqual([expect.objectContaining({ cli: 'codex', status: 'qualified', models: ['synthetic-model'] })]);
    const resolved = await f.resolve();
    expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
    const invocation = JSON.parse(resolved.stdout).invocation;
    expect(invocation.readiness).toBe('launchable');
    expect(invocation.argv).toEqual(expect.arrayContaining(['-m', 'synthetic-model', '-s', 'workspace-write', '-c', 'model_reasoning_effort="medium"']));
    expect(invocation.shellCommand).toContain("'-s' 'workspace-write'");
    const configPath = path.join(f.project, '.aiwg/aiwg.config');
    const configText = await readFile(configPath, 'utf8');
    const stricter = JSON.parse(configText);
    stricter.parallelism.health = { requireStepCap: true };
    await writeFile(configPath, JSON.stringify(stricter));
    const unsupportedControl = await f.resolve();
    expect(unsupportedControl.code).not.toBe(0);
    expect(unsupportedControl.stdout).toContain('OG_ADAPTER_UNQUALIFIED');
    await writeFile(configPath, configText);
    const stored = JSON.parse(await readFile(path.join(f.config, 'worker-installations.json'), 'utf8'));
    expect(stored.registrations[0].modelObservations.models[0].worker.qualification.roles).toEqual(['coding']);
    expect(stored.registrations[0].installation.evidence.cases).toBeUndefined();
    await f.writeCli('0.162.0');
    const changed = await f.resolve();
    expect(changed.code).not.toBe(0);
    expect(changed.stdout).toContain('aiwg doctor --probe-workers --qualify');
  });

  it.each(['same-facts', 'banner', 'context', 'efforts', 'older', 'retired', 'hidden', 'conflict'])(
    'reconciles approved observations with %s discovery cache', async kind => {
      const f = await fixture();
      if (kind === 'banner') {
        const filename = path.join(f.project, '.aiwg/aiwg.config');
        const config = JSON.parse(await readFile(filename, 'utf8'));
        config.parallelism.clis.codex.accountScope = 'local-account';
        await writeFile(filename, JSON.stringify(config));
      }
      const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
      expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
      const stored = JSON.parse(await readFile(path.join(f.config, 'worker-installations.json'), 'utf8'));
      const approved = stored.registrations[0].modelObservations;
      // Resolve uses the same inventory signature as sources. The test process
      // writes only this fixture's HOME cache, never the real user's cache.
      const sources = await f.run(['models', 'sources', '--json']);
      expect(sources.code, sources.stdout + sources.stderr).toBe(0);
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
      catalog.discovery = { ...JSON.parse(sources.stdout).discovery, source: 'native', fetchedAt: catalog.refreshedAt,
        providers: { codex: discovery } };
      expect(validateWorkerCatalogDiscovery(catalog.discovery)).toEqual([]);
      const cacheFile = path.join(f.root, '.cache/aiwg/model-catalog.v1.json');
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, JSON.stringify(catalog));
      const resolved = await f.resolve();
      if (kind === 'same-facts' || kind === 'banner' || kind === 'older') {
        expect(resolved.code, resolved.stdout + resolved.stderr).toBe(0);
        expect(JSON.parse(resolved.stdout).invocation.readiness).toBe('launchable');
      } else {
        expect(resolved.code, resolved.stdout + resolved.stderr).not.toBe(0);
        expect(resolved.stdout).toContain('aiwg doctor --probe-workers --qualify');
      }
      await expect(access(path.join(f.project, 'result.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

  it('surfaces the offending installed path and exact permission remedy', async () => {
    const f = await fixture();
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
    expect((await f.resolve()).code).toBe(0);
    const reviewArgs = ['models', 'resolve', '--role', 'reasoning', '--task', 'review', '--group', 'workers',
      '--brief', path.join(f.project, 'brief.txt'), '--workdir', f.project, '--final-output', path.join(f.project, 'review.json'), '--format', 'json'];
    const review = JSON.parse((await f.run(reviewArgs)).stdout);
    const exclusions = review.exclusions;
    expect(exclusions.flatMap((entry: any) => entry.diagnostics).some((d: any) => d.message.includes('Role lacks qualified evidence'))).toBe(false);
    expect(exclusions.find((entry: any) => entry.member === 'reviewer').diagnostics.filter((d: any) => d.blocking !== false).map((d: any) => d.pointer)).toEqual(['/request/authority']);
    expect(JSON.stringify(exclusions)).toContain('--authorize-premium');
    const authorized = await f.run([...reviewArgs, '--authorize-premium']);
    expect(authorized.code, authorized.stdout + authorized.stderr).toBe(0);
    const plan = JSON.parse(authorized.stdout);
    expect(plan.invocation.readiness).toBe('launchable');
    expect(plan.selected.context.qualifiedMaxOutputTokens).toBeNull();
    expect(plan.selected.diagnostics).toContainEqual(expect.objectContaining({ blocking: false,
      message: 'Output limit is unreported; only the context window was checked.' }));
    expect((await f.run([...reviewArgs.slice(0, -1), 'shell', '--authorize-premium'])).code).toBe(0);
    expect((await f.run(reviewArgs)).code).not.toBe(0);
    await expect(access(path.join(f.project, 'review.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('explains that an existing relative brief must be absolute', async () => {
    const f = await fixture();
    await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    const result = await f.run(['models', 'resolve', '--role', 'coding', '--task', 'implementation', '--group', 'workers',
      '--brief', 'brief.txt', '--workdir', f.project, '--final-output', path.join(f.project, 'result.json'), '--format', 'json']);
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stdout).diagnostics).toContainEqual({ code: 'OG_CONFIG_REFERENCE', pointer: '/request/brief',
      message: '--brief must be an absolute path; relative paths are not resolved against cwd or --workdir.' });
  });

  it('blocks an operator-approved installed renderer that silently drops the requested sandbox', async () => {
    const f = await fixture();
    const driver = path.join(f.installed, 'tools/ralph-external/lib/codex-adapter.mjs');
    const source = await readFile(driver, 'utf8');
    expect(source).toContain("'-s', sandbox,");
    await writeFile(driver, source.replace("'-s', sandbox,", ''));
    const qualified = await f.run(['doctor', '--probe-workers', '--qualify', '--yes', '--json']);
    expect(qualified.code, qualified.stdout + qualified.stderr).toBe(0);
    const resolved = await f.resolve();
    expect(resolved.code).not.toBe(0);
    expect(JSON.parse(resolved.stdout).invocation).toBeUndefined();
    expect(resolved.stdout).toContain('OG_ADAPTER_UNQUALIFIED');
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
        registry: loadProviderModelCapabilities(), section: { installFindings: [{ cli: 'codex', readiness: 'ready', installedVersion: '0.161.0' }] } });
      expect(result.status).toBe('declined');
      expect(terminal.question).toHaveBeenCalledTimes(1);
      expect(terminal.question.mock.calls[0][0]).toContain('synthetic-model');
      expect(terminal.question.mock.calls[0][0]).toContain('coding');
      expect(terminal.question.mock.calls[0][0]).toContain('codex');
      expect(terminal.question.mock.calls[0][0]).toContain('chmod go-w');
      expect(terminal.question.mock.calls[0][0]).toContain(f.config);
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
