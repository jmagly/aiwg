import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openBaoHttpFixture } from '../../fixtures/decision/openbao-http.js';
import { lookupJevCredential, inspectJevCredential } from '../../../src/decision/jev-credentials.js';
import { askDecision } from '../../../src/decision/ask.js';
import { buildDecisionOffloadSnapshot, runDecisionOffloadCheckpoint } from '../../../src/decision/offload.js';
import { decisionHandler } from '../../../src/cli/handlers/decision.js';
import { validateDecisionConfig } from '../../../src/config/decision-config.js';
// @ts-expect-error untyped CLI report formatter
import { formatDecisionOffloadReport } from '../../../tools/cli/decision-offload-report.mjs';
// @ts-expect-error untyped MCP surface
import { registerDecisionToolset } from '../../../src/mcp/tools/decision.mjs';

// Exercise the production HTTPS client against a loopback HTTP fixture only.
vi.mock('node:https', async () => {
  const http = await import('node:http');
  return { request: (url: URL, options: object, callback: Parameters<typeof http.request>[2]) => {
    if (url.hostname !== '127.0.0.1') throw new Error('nonlocal test transport refused');
    const local = new URL(url); local.protocol = 'http:';
    return http.request(local, options, callback);
  } };
});
const { loadSecret } = vi.hoisted(() => ({ loadSecret: vi.fn() }));
vi.mock('../../../src/auth/credential-store.js', () => ({ createSecretStore: (identity: { account: string }) => ({
  loadSecret: () => loadSecret(identity),
}) }));

const reference = { source: 'openbao', path: 'kv_internal/data/typesafe/jev/api-key', field: 'token',
  auth: { method: 'approle', role: 'aiwg-jev-reader' } };
const input = { question: 'Proceed?', mode: { kind: 'yes-no' as const }, passes: 1, escalationPasses: 1 };

describe('Jev OpenBao runtime reference (#3871)', () => {
  let root: string;
  let bao: Awaited<ReturnType<typeof openBaoHttpFixture>>;
  let environment: NodeJS.ProcessEnv;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'jev-openbao-'));
    bao = await openBaoHttpFixture();
    environment = { AIWG_CONFIG: path.join(root, 'user'), XDG_CONFIG_HOME: root, BAO_ADDR: bao.addr };
    for (const [key, value] of Object.entries({ ...environment, JEV_API_KEY: '', AIWG_DECISION_JEV_API_KEY: '',
      AIWG_DECISION_ENABLED: '', AIWG_DISABLE_PROCESS_PROVIDER_DETECTION: '1' })) vi.stubEnv(key, value!);
    loadSecret.mockImplementation(async ({ account }: { account: string }) => account.endsWith(':role-id') ? 'fixture-role' : 'fixture-secret');
    await configure();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization') === `Bearer ${bao.token}`).toBe(true);
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id,
        { type: 'noul', noul: 0.99 }])), model: 'jev-fixture', usage: { input_tokens: 2, output_tokens: 1 } }));
    });
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await bao.close(); await rm(root, { recursive: true, force: true }); });

  async function configure(credential: object = reference) {
    await mkdir(path.join(root, '.aiwg'), { recursive: true });
    await writeFile(path.join(root, '.aiwg', 'aiwg.config'), JSON.stringify({ decision: { enabled: true, jev: { credential } } }));
  }
  const options = () => ({ cwd: root, configHome: root, homeDir: root, env: environment });

  it('answers through the CLI handler with no exported key or jev.json', async () => {
    const result = await decisionHandler.execute({ cwd: root, frameworkRoot: process.cwd(), rawArgs: [],
      args: ['ask', '--question', 'Proceed?', '--yes-no', '--passes', '1', '--escalation-passes', '1', '--json'] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.message!)).toMatchObject({ status: 'answered', model: 'jev-fixture' });
    expect(bao.operations).toEqual(['POST /v1/auth/approle/login', 'GET /v1/kv_internal/data/typesafe/jev/api-key', 'POST /v1/auth/token/revoke-self']);
  });

  it('inspects and reports source/path offline without loading any secret', async () => {
    expect(await inspectJevCredential(options())).toEqual({ configured: true, enabled: true, source: 'openbao', path: reference.path });
    const snapshot = await buildDecisionOffloadSnapshot({ projectRoot: root, env: environment });
    expect(snapshot.readiness.ask).toMatchObject({ source: 'openbao', path: reference.path, probed: false });
    expect(formatDecisionOffloadReport(snapshot).join('\n')).toContain(`source: openbao; path: ${reference.path}`);
    expect(loadSecret).not.toHaveBeenCalled();
    expect(bao.operations).toEqual([]);
  });

  it('reports the reference through the built doctor command without probing', async () => {
    const router = new URL('../../../dist/src/cli/router.js', import.meta.url).href;
    const script = 'const {run}=await import(process.argv[1]);await run(process.argv.slice(2),{cwd:process.cwd()});process.exit(process.exitCode??0);';
    const env = { ...environment, PATH: process.env.PATH, HOME: root, AIWG_NO_UPDATE_CHECK: '1', AIWG_DISABLE_PROCESS_PROVIDER_DETECTION: '1' };
    for (const flags of [['--json'], []]) {
      const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, router, 'doctor', '--decision-offload', ...flags],
        { cwd: root, env, timeout: 10_000 });
      if (flags.length) expect(JSON.parse(result.stdout).decisionOffload.readiness.ask)
        .toMatchObject({ source: 'openbao', path: reference.path, probed: false });
      else expect(result.stdout).toContain(`source: openbao; path: ${reference.path}`);
      expect(`${result.stdout}${result.stderr}`.includes(bao.token)).toBe(false);
    }
    expect(bao.operations).toEqual([]);
  });

  it('resolves once for concurrent lookups and never exports or persists credentials', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const results = await Promise.all([lookupJevCredential(options()), lookupJevCredential(options())]);
    expect(results.map(value => value?.token === bao.token)).toEqual([true, true]);
    const run = await runDecisionOffloadCheckpoint(input, { projectRoot: root, env: environment, transport: 'internal', caller: 'fixture-flow',
      askRuntime: options() });
    expect(run.result?.status).toBe('answered');
    const child = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))']);
    const contents = await diskContents(root);
    const outputs = JSON.stringify({ run, stdout: stdout.mock.calls, stderr: stderr.mock.calls, env: process.env, child: child.stdout, contents });
    expect(outputs.includes(bao.token)).toBe(false);
    expect(outputs.includes(bao.vaultToken)).toBe(false);
    expect(bao.operations.filter(op => op.startsWith('GET'))).toHaveLength(1);
  });

  it.each(['flow', 'mission'] as const)('uses the shared checkpoint in %s', async transport => {
    const result = await runDecisionOffloadCheckpoint(input, { projectRoot: root, env: environment, transport: 'internal',
      caller: `fixture-${transport}`, askRuntime: options() });
    expect(result.result).toMatchObject({ status: 'answered' });
  });

  it('answers through the registered MCP ask capability', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const handlers = new Map<string, (args: object) => Promise<any>>();
    registerDecisionToolset({ registerTool: (name: string, _config: unknown, handler: (args: object) => Promise<any>) => handlers.set(name, handler) });
    const result = await handlers.get('decision-ask')!({ question: 'Proceed?', yes_no: true, passes: 1, escalation_passes: 1 });
    expect(result.structuredContent.result).toMatchObject({ status: 'answered' });
  });

  it.each([403, 404, 500])('fails safely on HTTP %s with no response-body disclosure', async status => {
    bao.fail(status);
    const result = await askDecision(input, options());
    expect(result).toMatchObject({ status: 'fallback', fallback: 'llm', reason: 'credential-unavailable' });
    expect(JSON.stringify(result).includes(bao.token)).toBe(false);
    expect(bao.operations.at(-1)).toBe('POST /v1/auth/token/revoke-self');
  });

  it('retries a failed reference and never uses an invalid legacy file behind it', async () => {
    const directory = path.join(root, 'aiwg', 'credentials');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'jev.json'), 'invalid legacy record');
    bao.fail(403);
    expect(await askDecision(input, options())).toMatchObject({ reason: 'credential-unavailable' });
    bao.fail(200);
    expect(await askDecision(input, options())).toMatchObject({ status: 'answered' });
  });

  it('does not resolve a disabled reference', async () => {
    const disabled = { ...options(), env: { ...environment, AIWG_DECISION_ENABLED: '0' } };
    expect(await inspectJevCredential(disabled)).toMatchObject({ source: 'openbao', enabled: false });
    expect(await askDecision(input, disabled)).toMatchObject({ status: 'fallback', reason: 'not-configured' });
    expect(loadSecret).not.toHaveBeenCalled();
  });

  it.each([{ BAO_ADDR: 'http://127.0.0.1/' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { BAO_ADDR: '' }])(
    'refuses unsafe or missing host configuration before accessing secrets', async overrides => {
      expect(await askDecision(input, { ...options(), env: { ...environment, ...overrides } }))
        .toMatchObject({ reason: 'credential-unavailable' });
      expect(loadSecret).not.toHaveBeenCalled();
      expect(bao.operations).toEqual([]);
    });

  it('sanitizes host secret-store failures and missing IDs', async () => {
    for (const fail of [async () => { throw new Error(bao.token); }, async () => null]) {
      loadSecret.mockImplementation(fail);
      const result = await askDecision(input, options());
      expect(result).toMatchObject({ reason: 'credential-unavailable' });
      expect(JSON.stringify(result).includes(bao.token)).toBe(false);
    }
    expect(bao.operations).toEqual([]);
  });

  it('keeps explicit environment credentials first and skips OpenBao', async () => {
    expect(await lookupJevCredential({ ...options(), env: { ...environment, AIWG_DECISION_ENABLED: '1', JEV_API_KEY: 'explicit' } }))
      .toMatchObject({ source: 'env', token: 'explicit' });
    expect(bao.operations).toEqual([]);
  });

  it('answers with the origin persisted in the reference and no OpenBao environment', async () => {
    await configure({ ...reference, addr: bao.addr });
    const environmentWithoutBao = { ...environment };
    delete environmentWithoutBao.BAO_ADDR;
    expect(await askDecision(input, { ...options(), env: environmentWithoutBao })).toMatchObject({ status: 'answered' });
    expect(loadSecret).toHaveBeenCalledWith({ service: 'aiwg.openbao', account: `${new URL(bao.addr).origin}/aiwg-jev-reader:role-id` });
    expect(loadSecret).toHaveBeenCalledWith({ service: 'aiwg.openbao', account: `${new URL(bao.addr).origin}/aiwg-jev-reader:secret-id` });
  });

  it('cannot send IDs provisioned for one origin to another project-selected origin', async () => {
    const other = await openBaoHttpFixture();
    try {
      loadSecret.mockImplementation(async ({ account }: { account: string }) => !account.startsWith(`${new URL(bao.addr).origin}/`)
        ? null : account.endsWith(':role-id') ? 'fixture-role' : 'fixture-secret');
      await configure({ ...reference, addr: other.addr });
      const environmentWithoutBao = { ...environment }; delete environmentWithoutBao.BAO_ADDR;
      expect(await askDecision(input, { ...options(), env: environmentWithoutBao })).toMatchObject({ reason: 'credential-unavailable' });
      expect(other.operations).toEqual([]);
    } finally { await other.close(); }
  });

  it('loads a user-scope reference when the project has none', async () => {
    await writeFile(path.join(root, '.aiwg', 'aiwg.config'), '{"decision":{"enabled":true}}');
    await mkdir(path.join(root, 'user'));
    await writeFile(path.join(root, 'user', 'config.yaml'), `decision:\n  jev:\n    credential:\n      source: openbao\n      path: ${reference.path}\n      field: token\n      auth:\n        method: approle\n        role: aiwg-jev-reader\n`);
    const credential = await lookupJevCredential(options());
    expect(credential?.source).toBe('openbao');
    expect(credential?.token === bao.token).toBe(true);
  });

  it('rejects inline values, unknown keys, invalid paths and auth methods', () => {
    for (const credential of [{ ...reference, token: 'inline' }, { ...reference, path: 'kv/data/../escape' },
      { ...reference, auth: { method: 'exec', role: 'x' } }, { ...reference, source: 'exec' }]) {
      expect(validateDecisionConfig({ jev: { credential } }).length).toBeGreaterThan(0);
    }
    expect(validateDecisionConfig({ jev: { credential: reference } })).toEqual([]);
  });
});

async function diskContents(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? diskContents(path.join(root, entry.name))
    : readFile(path.join(root, entry.name), 'utf8').then(value => [value])))).flat();
}
