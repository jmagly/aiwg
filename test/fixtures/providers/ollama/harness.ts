// Offline Ollama fixture lifecycle, installed package and resolver snapshots.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { rm } from '../../../helpers/worker-capture-cleanup.mjs';
import { createServer as createTcpServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, vi } from 'vitest';
import { loadProviderModelCapabilities } from '../../../../src/models/provider-policy.js';
import { workerResolutionFixture } from '../../worker-resolution.js';
import { prepareWorkerInvocation, type WorkerInvocationDriver } from '../../../../src/serve/worker-invocation.js';
import { copyWorkerAdapterRuntime } from '../../../helpers/worker-adapter-runtime.mjs';

export const MODULE = 'tools/ralph-external/lib/ollama-adapter.mjs';
export const APPROVED = JSON.parse(readFileSync('test/fixtures/providers/ollama/approved-module.json', 'utf8'));
export const FAKE_SERVER = path.resolve('test/fixtures/providers/ollama/fake-ollama-server.mjs');
export const MODEL = 'qwen3:8b';
const roots: string[] = [];
const installRoots: string[] = [];
export const children = new Set<ReturnType<typeof spawn>>();
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

export async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-ollama-')); roots.push(root);
  return root;
}

interface Run { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException }

export function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdinData?: string; timeoutMs?: number }): Promise<Run> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdinData);
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 10_000);
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr, error }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

/** A listener on an ephemeral loopback port that destroys every connection: a
 * deterministically unreachable endpoint owned by this test, with no fixed-port assumption. */
export async function startRefusingEndpoint() {
  const server = createTcpServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as { port: number };
  return { endpoint: `127.0.0.1:${port}`, stop: () => server.close() };
}

/** Starts the fake Ollama HTTP server on an ephemeral loopback port, returns its `host:port` and a stop function. */
export async function startFakeServer(root: string, scenario: string, response?: string) {
  const configFile = path.join(root, `fake-${scenario}.json`);
  const recordPath = path.join(root, `record-${scenario}.json`);
  const portFile = path.join(root, `port-${scenario}.txt`);
  await writeFile(configFile, JSON.stringify({ scenario, recordPath, response }));
  const child = spawn(process.execPath, [FAKE_SERVER, portFile], { env: { ...process.env, AIWG_FAKE_WORKER_CONFIG: configFile }, stdio: ['ignore', 'ignore', 'pipe'] });
  children.add(child);
  const deadline = Date.now() + 5000;
  // The server renames a complete port file into place; still require a
  // well-formed port so a partial read can never become a bad endpoint.
  let port = '';
  while (!/^[1-9][0-9]{0,4}$/.test(port)) {
    if (Date.now() > deadline) throw new Error('fake ollama server did not start in time');
    await new Promise(r => setTimeout(r, 25));
    port = existsSync(portFile) ? readFileSync(portFile, 'utf8').trim() : '';
  }
  return { endpoint: `127.0.0.1:${port}`, recordPath, stop: () => { child.kill('SIGTERM'); children.delete(child); } };
}

export async function installPackage(bytes: Buffer) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'aiwg-local-http-install-')); installRoots.push(base);
  await writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'aiwg', version: '0.0.0-test-root', type: 'module' }));
  const packageRoot = path.join(base, 'package');
  const writable = path.join(base, 'worker-writable');
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true, mode: 0o755 }); await mkdir(writable);
  await chmod(base, 0o755); await chmod(packageRoot, 0o755); await chmod(path.join(packageRoot, 'lib'), 0o755);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: APPROVED.entry.packageName,
    version: APPROVED.entry.packageVersion, type: 'module' }), { mode: 0o644 });
  await writeFile(path.join(packageRoot, APPROVED.entry.modulePath), bytes, { mode: 0o644 });
  await copyWorkerAdapterRuntime(base, packageRoot);
  const resolveImpl = path.join(base, '_resolve-impl.mjs');
  await copyFile(path.resolve('tools/_resolve-impl.mjs'), resolveImpl);
  await chmod(resolveImpl, 0o644);
  // provider-adapter.mjs's top-level `await importImpl(..., 'models/worker-installation.mjs')`
  // runs at import time; bridge it back to the real file under test.
  await mkdir(path.join(base, 'src', 'models'), { recursive: true, mode: 0o755 });
  const target = path.resolve('src/models/worker-installation.mjs');
  const relative = path.relative(path.join(base, 'src', 'models'), target);
  await writeFile(path.join(base, 'src', 'models', 'worker-installation.mjs'),
    `export * from ${JSON.stringify(relative)};\n`);
  await mkdir(path.join(base, 'src', 'mission-protocol'), { recursive: true });
  const protocol = path.relative(path.join(base, 'src', 'mission-protocol'), path.resolve('src/mission-protocol/index.ts'));
  await writeFile(path.join(base, 'src', 'mission-protocol', 'index.js'), `export * from ${JSON.stringify(protocol)};\n`);
  return { packageRoot, writable };
}

afterAll(async () => { for (const root of installRoots.splice(0)) await rm(root, { recursive: true, force: true }); });

export function loadingRegistry() {
  const registry = structuredClone(loadProviderModelCapabilities());
  // Loader fixtures select only the module under test, as the recorded loader does.
  for (const provider of Object.values(registry.providers)) delete provider.workerAdapter;
  registry.workerAdapters = { 'local-http': registry.workerAdapters!['local-http'] };
  return registry;
}

export function resolverFixture(root: string, owner: any, role: 'efficiency' | 'coding' = 'efficiency') {
  const f = workerResolutionFixture();
  const adapter: any = loadingRegistry().workerAdapters!['local-http'];
  adapter.qualification = { status: 'qualified', fixtureDigest: 'sha256:' + 'a'.repeat(64),
    verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
  // Synthetic boundary/evidence only; preserve every bundled control mapping.
  const profile = adapter.invocationProfiles['direct-http'];
  profile.installationQualification = { scopeDigest: 'sha256:' + 'c'.repeat(64),
    fixtureDigest: 'sha256:' + 'd'.repeat(64), verifiedAt: f.observation.verifiedAt, evidenceRef: 'fixture:synthetic-only' };
  const boundary = { kind: 'executor' as const, identity: 'fixture:synthetic-ollama-boundary',
    digest: 'sha256:' + 'e'.repeat(64),
    controls: Object.keys(profile.controls).filter(name => profile.controls[name].support === 'external') };
  const registry = f.snapshot.registry;
  delete registry.providers.codex.workerAdapter;
  registry.workerAdapters = { 'local-http': adapter };
  const group = f.snapshot.config.parallelism!.groups!.workers;
  group.members = [{ id: 'local-text', cli: 'local-http', model: MODEL, roles: [role] }];
  group.fallback = [];
  group.execution = { isolation: 'worktree', sandbox: 'external', approval: 'never',
    network: 'deny', transport: 'shell', receipts: 'optional' };
  (f.snapshot.config.parallelism as any).clis = { 'local-http': { adapter: 'workerAdapters:local-http',
    accountScope: f.snapshot.installations.codex.accountScope, quotaScope: 'synthetic', executable: 'curl', enabled: true } };
  const binding = { ...f.snapshot.installations.codex, profile: 'direct-http', cliVersion: '8.18.0', boundary };
  f.snapshot.installations = { 'local-http': binding };
  const discovery = f.snapshot.catalog.discovery!.instances!.codex;
  discovery.provider = 'local-http'; discovery.runtimeVersion = '8.18.0';
  discovery.models = discovery.models.slice(0, 1);
  for (const row of discovery.models) {
    row.id = MODEL; row.apiModelId = MODEL;
    row.worker!.cliId = 'local-http'; row.worker!.runtimeVersion = '8.18.0';
    row.reasoningEfforts = []; Object.assign(row.worker!, { effortSupport: 'not-applicable', efforts: [] });
  }
  f.snapshot.catalog.discovery!.instances = { 'local-http': discovery };
  f.snapshot.models.defaults.workerSelection!.roleGuidance![role] = {
    ...f.snapshot.models.defaults.workerSelection!.roleGuidance!.coding!,
    initialEffort: null, effortLadder: [], allowNotApplicableEffort: true };
  const drivers: Record<string, WorkerInvocationDriver> = { 'local-http': {
    qualification: { adapter, adapterId: 'local-http', cliVersion: binding.cliVersion, boundary,
      installation: { executable: '/usr/bin/curl', cwd: path.join(root, 'work'), workerWritableRoots: [path.join(root, 'work')],
        effectiveConfigDigest: 'sha256:' + 'f'.repeat(64), accountScope: binding.accountScope, boundary,
        evidence: { ...profile.installationQualification, cases: {} } },
      stdinFramerBinding: { storePath: path.join(root, 'synthetic-store.json'), storeDigest: 'sha256:' + 'b'.repeat(64) } },
    buildInvocation: async input => ({ argv: [realpathSync((process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, 'curl')).find(existsSync)!), ...owner.buildWorkerArgs(input, adapter.invocationProfiles['direct-http'], input.permissions)],
      stdin: 'adapter-frame', envNames: [] }),
    buildWorkerStdinFrame: (brief, invocation) => owner.buildWorkerStdinFrame(brief, invocation),
    extractFinal: output => owner.parseOutput(output),
    parseWorkerFinal: (output, options) => owner.parseWorkerFinal(output, options),
    prepareWorkerInvocation: (invocation, qualification) => prepareWorkerInvocation(invocation, qualification),
  } };
  const request = { role, group: 'workers', task: role === 'coding' ? 'implementation' : 'inventory',
    brief: path.join(root, 'brief.txt'), workdir: path.join(root, 'work'),
    final_output: path.join(root, 'final.json'), transport: 'shell' as const };
  return { ...f, drivers, request, now: f.request.now };
}
