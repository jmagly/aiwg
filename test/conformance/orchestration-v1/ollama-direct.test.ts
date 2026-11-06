/** Offline Ollama transport, installed module, resolver and attached-launcher coverage (#2899). */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OLLAMA_MAX_BRIEF_BYTES, OllamaAdapter, assertLocalOllamaEndpoint, assertOllamaModelName, buildOllamaGenerateBody, register } from '../../../tools/ralph-external/lib/ollama-adapter.mjs';
import { DEFAULT_WORKER_SELECTION, loadProviderModelCapabilities, qualifyWorkerInvocationProfile, resolveWorkerAdapter } from '../../../src/models/provider-policy.js';
import { resolveWorkerInvocation } from '../../../src/serve/worker-invocation.js';
import { createProvider, loadInstalledWorkerAdapters, normalizeWorkerVersionBanner, compileWorkerVersionPattern } from '../../../src/models/worker-installation.mjs';
import { workerStdinBytes } from '../../../src/serve/worker-stdin-frame.mjs';
import { SessionLauncher } from '../../../tools/ralph-external/session-launcher.mjs';
import { workerPromptBrief } from '../../../tools/ralph-external/lib/worker-prompt.mjs';
import { launchIsolatedWorker } from '../../../tools/ralph-external/lib/worker-isolation.mjs';
import { APPROVED, MODULE, MODEL, FAKE_SERVER, children, scratch, run, startFakeServer,
  startRefusingEndpoint, installPackage, loadingRegistry, resolverFixture } from '../../fixtures/providers/ollama/harness.js';
const sha256 = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

describe('Local-http (Ollama backend) text-only HTTP profile (roctinam/aiwg#2899)', () => {
  it('OL01 the approved module digest matches the adapter file and registers exactly "local-http"', async () => {
    expect(APPROVED.source).toBe(MODULE);
    expect(sha256(readFileSync(MODULE))).toBe(APPROVED.entry.sha256);
    expect(APPROVED.entry).toMatchObject({ reference: 'installed:local-http', interfaceVersion: 1, adapterIds: ['local-http'], platforms: ['linux'] });
    const registered: Array<[string, () => unknown]> = [];
    await register((id, factory) => registered.push([id, factory]));
    expect(registered.map(([id]) => id)).toEqual(['local-http']);
    const instance: any = registered[0][1]();
    expect(instance).toBeInstanceOf(OllamaAdapter);
    expect(instance.getName()).toBe('local-http');
    expect(instance.getBinary()).toBe('curl');
  });

  it('OL02 the endpoint guard accepts loopback and the Docker-bridge private range, refuses cloud/public/hostnames', () => {
    expect(assertLocalOllamaEndpoint('127.0.0.1:11434')).toBe('127.0.0.1:11434');
    expect(assertLocalOllamaEndpoint('172.17.0.1:11434')).toBe('172.17.0.1:11434'); // titan's actual, shared, non-loopback bridge
    expect(assertLocalOllamaEndpoint('10.0.0.5:11434')).toBe('10.0.0.5:11434');
    expect(assertLocalOllamaEndpoint('192.168.1.5:11434')).toBe('192.168.1.5:11434');
    expect(assertLocalOllamaEndpoint('127.0.0.0:1')).toBe('127.0.0.0:1');
    expect(() => assertLocalOllamaEndpoint(undefined as unknown as string)).toThrow(/explicit local endpoint/);
    expect(() => assertLocalOllamaEndpoint('')).toThrow(/explicit local endpoint/);
    expect(() => assertLocalOllamaEndpoint('ollama.com:443')).toThrow(/IPv4 host:port/);
    expect(() => assertLocalOllamaEndpoint('8.8.8.8:11434')).toThrow(/loopback or an explicit private address/);
    expect(() => assertLocalOllamaEndpoint('203.0.113.5:11434')).toThrow(/loopback or an explicit private address/);
    expect(() => assertLocalOllamaEndpoint('127.0.0.1:11434 ')).toThrow(/whitespace/);
    expect(() => assertLocalOllamaEndpoint('127.0.0.1')).toThrow(/IPv4 host:port/); // no port is a guess, refused
    // Non-canonical dotted-decimal: leading zeros are rejected (libcurl would parse 010.0.0.1 as 8.0.0.1).
    expect(() => assertLocalOllamaEndpoint('010.0.0.1:11434')).toThrow(/canonical dotted-decimal/);
    expect(() => assertLocalOllamaEndpoint('01.2.3.4:11434')).toThrow(/canonical dotted-decimal/);
    expect(() => assertLocalOllamaEndpoint('127.00.0.1:11434')).toThrow(/canonical dotted-decimal/);
    expect(() => assertLocalOllamaEndpoint('127.0.0.01:11434')).toThrow(/canonical dotted-decimal/);
    expect(() => assertLocalOllamaEndpoint('00.0.0.0:11434')).toThrow(/canonical dotted-decimal/);
    expect(() => assertLocalOllamaEndpoint('256.0.0.1:11434')).toThrow(/valid IPv4 host:port/);
    expect(() => assertLocalOllamaEndpoint('127.0.0.300:11434')).toThrow(/valid IPv4 host:port/);
    expect(() => assertLocalOllamaEndpoint('0.0.0.0:11434')).toThrow(/loopback or an explicit private address/);
    expect(() => assertLocalOllamaEndpoint('127.0.0.1:0')).toThrow(/valid IPv4 host:port/);
    expect(() => assertLocalOllamaEndpoint('127.0.0.1:65536')).toThrow(/valid IPv4 host:port/);
    expect(() => assertLocalOllamaEndpoint('http://127.0.0.1:11434')).toThrow(/canonical dotted-decimal/);
    expect(() => assertLocalOllamaEndpoint('127.0.0.1:11434/api/generate')).toThrow(/canonical dotted-decimal/);
    expect(() => assertLocalOllamaEndpoint('127.0.0.1@evil:11434')).toThrow(/canonical dotted-decimal/);
  });

  it('OL03 buildWorkerArgs refuses explicit effort, bad model, the coding role, relative cwd and a missing/cloud endpoint; buildOllamaGenerateBody is pure and bounded', () => {
    const adapter = new OllamaAdapter();
    const base = { cwd: '/w', selected: { model: MODEL, effort: { value: null } } };
    vi.stubEnv('OLLAMA_HOST', '172.17.0.1:11434');
    expect(adapter.buildWorkerArgs(base, null, {})).toEqual(['-q', '-sS', '--max-redirs', '0', '--proto', '=http',
      '--noproxy', '*', '--connect-timeout', '10', '--max-time', '300', '--max-filesize', '10485760',
      '--fail-with-body', '-H', 'Content-Type: application/json', '-X', 'POST',
      'http://172.17.0.1:11434/api/generate', '--data-binary', '@-']);
    const argv = adapter.buildWorkerArgs(base, null, {}) as string[];
    expect(argv[0]).toBe('-q'); // curlrc is disabled before anything else is parsed
    expect(argv).toContain('--data-binary');
    expect(argv[argv.indexOf('--data-binary') + 1]).toBe('@-'); // body stays on stdin, never argv
    expect(() => adapter.buildWorkerArgs({ ...base, selected: { model: MODEL, effort: { value: 'high' } } }, null, {})).toThrow(/effort/);
    expect(() => adapter.buildWorkerArgs({ ...base, role: 'coding' }, null, {})).toThrow(/text-only transport.*refuses the 'coding' role/);
    expect(() => adapter.buildWorkerArgs({ ...base, selected: { model: '-rf', effort: { value: null } } }, null, {})).toThrow(/model/);
    expect(() => adapter.buildWorkerArgs({ ...base, selected: { model: 'auto', effort: { value: null } } }, null, {})).toThrow(/auto\/default/);
    expect(() => adapter.buildWorkerArgs({ ...base, selected: { model: 'gpt-oss:120b-cloud', effort: { value: null } } }, null, {})).toThrow(/cloud/);
    expect(() => adapter.buildWorkerArgs({ ...base, cwd: 'relative' }, null, {})).toThrow(/absolute/);
    expect(() => adapter.buildSessionArgs()).toThrow(/no qualified Ralph loop session/);
    vi.stubEnv('OLLAMA_HOST', 'ollama.com:443');
    expect(() => adapter.buildWorkerArgs(base, null, {})).toThrow(/IPv4 host:port/);
    vi.stubEnv('OLLAMA_HOST', '');
    expect(() => adapter.buildWorkerArgs(base, null, {})).toThrow(/explicit local endpoint/);

    // One conservative shared model pattern, enforced identically in both gates.
    expect(assertOllamaModelName('qwen3:8b')).toBe('qwen3:8b');
    expect(assertOllamaModelName('smollm2:135m')).toBe('smollm2:135m');
    expect(assertOllamaModelName('llama3.1')).toBe('llama3.1');
    for (const bad of ['auto', 'AUTO', 'Default', 'default:tag', 'AUTO:x', 'gpt-oss:120b-cloud', 'MoDel-ClOuD',
      'foo:cloud', 'foo:CLOUD', 'evil.example/model:tag', '../../x', 'x;$(id)', '-rf', 'a b', 'a\tb',
      'a\u007fb', 'model:', 'a:b:c', '', `${'m'.repeat(129)}`]) {
      expect(() => assertOllamaModelName(bad), JSON.stringify(bad)).toThrow(/model|auto\/default|cloud|registry-style|option-like|well-formed|exceeds/);
    }

    // The pure body-builder never touches argv, the network or the filesystem.
    expect(buildOllamaGenerateBody({ model: MODEL, brief: 'hello' })).toBe(JSON.stringify({ model: MODEL, prompt: 'hello', stream: false }));
    expect(() => buildOllamaGenerateBody({ model: '', brief: 'hi' })).toThrow(/model/);
    expect(() => buildOllamaGenerateBody({ model: MODEL, brief: 5 as unknown as string })).toThrow(/brief/);
    expect(() => buildOllamaGenerateBody({ model: MODEL, brief: '' })).toThrow(/non-empty/);
    expect(() => buildOllamaGenerateBody({ model: MODEL, brief: '   \n\t  ' })).toThrow(/non-empty/);
    expect(() => buildOllamaGenerateBody({ model: MODEL, brief: 'x'.repeat(OLLAMA_MAX_BRIEF_BYTES + 1) })).toThrow(/exceeds/);
    expect(buildOllamaGenerateBody({ model: MODEL, brief: 'x'.repeat(OLLAMA_MAX_BRIEF_BYTES) }))
      .toBe(JSON.stringify({ model: MODEL, prompt: 'x'.repeat(OLLAMA_MAX_BRIEF_BYTES), stream: false }));
    expect(() => buildOllamaGenerateBody({ model: MODEL, brief: 'hi', role: 'coding' })).toThrow(/text-only transport.*refuses the 'coding' role/);
    // keep_alive is omitted: server residency defaults apply.
    expect(JSON.parse(buildOllamaGenerateBody({ model: MODEL, brief: 'hi' }))).toEqual({ model: MODEL, prompt: 'hi', stream: false });
  });

  it('the installed stdin frame binds each selection independently and keeps strict role/body limits', () => {
    const adapter = new OllamaAdapter();
    const invocation = { stdin: 'adapter-frame' as const, selected: { model: MODEL } };
    const other = { ...invocation, selected: { model: 'smollm2:135m' } };
    const frame = (brief: string | Buffer, input = invocation) => workerStdinBytes(input, brief, adapter)!;
    expect(JSON.parse(frame(Buffer.from('雪\n"quoted"')).toString())).toEqual({ model: MODEL, prompt: '雪\n"quoted"', stream: false });
    expect(JSON.parse(frame('second', other).toString()).model).toBe('smollm2:135m');
    expect(JSON.parse(frame('first', invocation).toString()).model).toBe(MODEL);
    expect(() => workerStdinBytes({ stdin: 'adapter-frame' }, 'hi', adapter)).toThrow(/model/);
    expect(() => frame(Buffer.from([0xff]))).toThrow(/encoded data|UTF-8/);
    expect(() => frame('\ud800')).toThrow(/well-formed/);
    expect(() => frame('')).toThrow(/non-empty/);
    expect(() => frame('hi\0')).toThrow(/non-empty/);
    expect(() => frame('x'.repeat(OLLAMA_MAX_BRIEF_BYTES + 1))).toThrow(/bound/);
    expect(() => frame('雪'.repeat(OLLAMA_MAX_BRIEF_BYTES / 3 + 1))).toThrow(/bound/);
    expect(() => frame('\u0001'.repeat(OLLAMA_MAX_BRIEF_BYTES))).toThrow(/frame exceeds byte bound/);
    expect(() => adapter.buildWorkerStdinFrame('hi', { ...invocation, role: 'coding' })).toThrow(/coding/);
    expect(() => adapter.buildWorkerStdinFrame('hi', { selected: { model: MODEL, effort: { value: 'high' } } })).toThrow(/effort/);
  });

  it('the fake server port file is complete the moment it appears (CI 89131 race)', async () => {
    // Regression: the reader used to treat existence as readiness, so an
    // empty, still-being-written file produced the endpoint "127.0.0.1:".
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const root = await scratch();
      const portFile = path.join(root, `port-race-${attempt}.txt`);
      const child = spawn(process.execPath, [FAKE_SERVER, portFile], { stdio: ['ignore', 'ignore', 'pipe'] });
      children.add(child);
      try {
        const deadline = Date.now() + 5000;
        while (!existsSync(portFile)) {
          if (Date.now() > deadline) throw new Error('fake ollama server did not start in time');
          await new Promise(r => setImmediate(r));
        }
        expect(readFileSync(portFile, 'utf8')).toMatch(/^[1-9][0-9]{0,4}$/);
      } finally { child.kill('SIGTERM'); children.delete(child); }
    }
  });

  describe('T-OG-15/20 render and execute against a synthetic Ollama HTTP server', () => {
    it('OL04 a successful generate renders curl argv, posts the pure-built body, and parses an affirmative claims-bearing final', async () => {
      const root = await scratch();
      const server = await startFakeServer(root, 'success');
      const adapter = new OllamaAdapter();
      vi.stubEnv('OLLAMA_HOST', server.endpoint);
      const MARKER = 'OLLAMA-BRIEF-MARKER-9c2f1a';
      const claimsText = JSON.stringify({ version: 1, status: 'completed', summary: MARKER, claims: [], artifacts: [], checks: [], limitations: [] });
      const requestBody = buildOllamaGenerateBody({ model: MODEL, brief: claimsText });
      const argv = adapter.buildWorkerArgs({ cwd: root, selected: { model: MODEL, effort: { value: null } } }, null, {});
      expect(JSON.stringify(argv)).not.toContain(MARKER); // the brief/claims text never reaches argv
      try {
        const result = await run('curl', argv, { cwd: root, env: { PATH: process.env.PATH! }, stdinData: requestBody });
        expect(result.code, result.stderr).toBe(0);
        const final = adapter.parseOutput(result.stdout);
        expect(final).toMatchObject({ done: true, done_reason: 'stop' });
        expect(final!.response).toContain(MARKER);
        const claims = await adapter.parseWorkerFinal(result.stdout, { format: 'json', observation: { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: result.code } });
        expect(claims).toMatchObject({ status: 'completed', summary: MARKER });
        const record = JSON.parse(readFileSync(server.recordPath, 'utf8'));
        expect(record).toMatchObject({ method: 'POST', path: '/api/generate', headers: { 'content-type': 'application/json' } });
        expect(record.body).toMatchObject({ model: MODEL, stream: false });
      } finally { server.stop(); }
    });

    it.each([
      ['model-not-found', 404],
      ['no-prompt', 400],
      ['malformed', 200],
      ['error-field', 200],
      ['not-done', 200],
      ['empty-content', 200],
    ])('OL05 %s never produces an affirmative final, even with a non-exit-zero or exit-zero error response', async (scenario, _status) => {
      const root = await scratch();
      const server = await startFakeServer(root, scenario);
      const adapter = new OllamaAdapter();
      vi.stubEnv('OLLAMA_HOST', server.endpoint);
      const argv = adapter.buildWorkerArgs({ cwd: root, selected: { model: MODEL, effort: { value: null } } }, null, {});
      try {
        const result = await run('curl', argv, { cwd: root, env: { PATH: process.env.PATH! }, stdinData: buildOllamaGenerateBody({ model: MODEL, brief: 'hi' }) });
        expect(adapter.parseOutput(result.stdout)).toBeNull();
        await expect(adapter.parseWorkerFinal(result.stdout, { format: 'json', observation: { transport: 'shell', status: 'failed', termination: 'confirmed', exitCode: result.code } }))
          // Malformed bytes fail at envelope validation; every other shape fails the affirmative-success rules. Both fail closed.
          .rejects.toThrow(/missing, malformed, or not an affirmative success|envelope is malformed JSON/);
      } finally { server.stop(); }
    });

    it('OL06 an unreachable endpoint fails before any content is produced, like a stopped/excluded member', async () => {
      const root = await scratch();
      // No fixed-port assumption: the refusing endpoint is bound and owned by this test.
      const refused = await startRefusingEndpoint();
      const adapter = new OllamaAdapter();
      vi.stubEnv('OLLAMA_HOST', refused.endpoint);
      const argv = adapter.buildWorkerArgs({ cwd: root, selected: { model: MODEL, effort: { value: null } } }, null, {});
      try {
        const result = await run('curl', argv, { cwd: root, env: { PATH: process.env.PATH! }, stdinData: '{}', timeoutMs: 5000 });
        expect(result.code).not.toBe(0);
        expect(adapter.parseOutput(result.stdout)).toBeNull();
      } finally { refused.stop(); }
    });

    it('OL09 hostile proxy environment and a hostile curlrc do not change the destination: the fake server still receives the request', async () => {
      const root = await scratch();
      const server = await startFakeServer(root, 'success');
      // A curlrc that would redirect the request through a dead proxy if it were read.
      await writeFile(`${root}/.curlrc`, 'proxy = "http://127.0.0.1:1/"\nlocation\n');
      const adapter = new OllamaAdapter();
      vi.stubEnv('OLLAMA_HOST', server.endpoint);
      const MARKER = 'OLLAMA-PROXY-MARKER-7d3e9b';
      const claimsText = JSON.stringify({ version: 1, status: 'completed', summary: MARKER, claims: [], artifacts: [], checks: [], limitations: [] });
      const requestBody = buildOllamaGenerateBody({ model: MODEL, brief: claimsText });
      const argv = adapter.buildWorkerArgs({ cwd: root, selected: { model: MODEL, effort: { value: null } } }, null, {});
      try {
        const result = await run('curl', argv, { cwd: root, stdinData: requestBody, timeoutMs: 10_000, env: {
          PATH: process.env.PATH!,
          HOME: root, // the hostile .curlrc lives here; argv's -q must ignore it
          http_proxy: 'http://127.0.0.1:1/', https_proxy: 'http://127.0.0.1:1/',
          HTTP_PROXY: 'http://127.0.0.1:1/', HTTPS_PROXY: 'http://127.0.0.1:1/',
          ALL_PROXY: 'http://127.0.0.1:1/', all_proxy: 'http://127.0.0.1:1/',
        } });
        expect(result.code, result.stderr).toBe(0);
        const record = JSON.parse(readFileSync(server.recordPath, 'utf8'));
        expect(record).toMatchObject({ method: 'POST', path: '/api/generate' });
        expect(record.body).toMatchObject({ model: MODEL, stream: false });
        expect(adapter.parseOutput(result.stdout)).toMatchObject({ done: true, done_reason: 'stop' });
      } finally { server.stop(); }
    });

    it('OL10 the claims hook validates the original envelope bytes before extraction', async () => {
      const adapter = new OllamaAdapter();
      const claimsText = JSON.stringify({ version: 1, status: 'completed', summary: 'ENVELOPE-MARKER', claims: [], artifacts: [], checks: [], limitations: [] });
      const observation = (status: string) => ({ transport: 'shell', status, termination: 'confirmed', exitCode: 0 });
      const envelope = (response: string) => JSON.stringify({ model: MODEL, created_at: '2026-10-11T00:00:00Z',
        response, done: true, done_reason: 'stop' });
      // Duplicate `done`: JSON.parse would silently keep the last value; the hook rejects.
      const duplicateDone = `{"model":${JSON.stringify(MODEL)},"created_at":"2026-10-11T00:00:00Z",`
        + `"response":${JSON.stringify(claimsText)},"done":false,"done":true,"done_reason":"stop"}`;
      await expect(adapter.parseWorkerFinal(duplicateDone, { format: 'json', observation: observation('completed') }))
        .rejects.toThrow(/duplicate member name/);
      // Invalid UTF-8 inside the response is fatal, never silently replaced with U+FFFD.
      const invalidUtf8 = Buffer.from(envelope(claimsText), 'utf8');
      invalidUtf8[invalidUtf8.indexOf('ENVELOPE') + 2] = 0xff;
      await expect(adapter.parseWorkerFinal(invalidUtf8, { format: 'json', observation: observation('completed') }))
        .rejects.toThrow(/not valid UTF-8/);
      // An oversized envelope honours maxOutputBytes: a 1 MiB envelope fails against a 1024-byte bound.
      const oversized = envelope('y'.repeat(1024 * 1024));
      await expect(adapter.parseWorkerFinal(oversized, { format: 'json', observation: observation('completed'), maxOutputBytes: 1024 }))
        .rejects.toThrow(/exceeds byte bound/);
      // ...while the same oversized shape also fails the default envelope cap.
      await expect(adapter.parseWorkerFinal(oversized, { format: 'json', observation: observation('completed') }))
        .rejects.toThrow(/exceeds byte bound/);
      // A well-formed envelope still validates end to end through the shared strict claims hook.
      const claims = await adapter.parseWorkerFinal(envelope(claimsText), { format: 'json', observation: observation('completed') });
      expect(claims).toMatchObject({ status: 'completed', summary: 'ENVELOPE-MARKER' });
    });

    it('OL07 a hung server is bounded by --max-time, never a synthesized success', async () => {
      const root = await scratch();
      const server = await startFakeServer(root, 'hang');
      const adapter = new OllamaAdapter();
      vi.stubEnv('OLLAMA_HOST', server.endpoint);
      // Override the fixed 300s bound for this test only via a throwaway argv splice (the adapter's own constant stays untouched in production).
      const argv = adapter.buildWorkerArgs({ cwd: root, selected: { model: MODEL, effort: { value: null } } }, null, {});
      const boundedArgv = argv.map((value, index) => (argv[index - 1] === '--max-time' ? '1' : value));
      try {
        const result = await run('curl', boundedArgv, { cwd: root, env: { PATH: process.env.PATH! }, stdinData: '{}', timeoutMs: 5000 });
        expect(result.code).not.toBe(0); // curl's own --max-time exit (28), never 0
        expect(adapter.parseOutput(result.stdout)).toBeNull();
      } finally { server.stop(); }
    });
  });

  it('OL08 observeHealthEvent and getAbortInput stay minimal/unavailable, never invented', () => {
    const adapter = new OllamaAdapter();
    expect(adapter.observeHealthEvent({} as any)).toBeNull();
    expect(adapter.getAbortInput()).toBeNull();
    expect(adapter.getCapabilities()).toMatchObject({ streamJson: false, sessionResume: false, budgetControl: false, systemPrompt: false, agentMode: false, mcpConfig: false, maxTurns: false, rpcAbort: false });
  });
});

describe('T-OG-15 local-http through the production resolver and installed-module loader', () => {
  let installed: { owner: any; ids: string[] };
  beforeAll(async () => {
    const { packageRoot, writable } = await installPackage(readFileSync(MODULE));
    const ids = await loadInstalledWorkerAdapters({ registry: loadingRegistry(),
      modules: [{ ...APPROVED.entry, packageRoot }], workerWritableRoots: [writable], platform: 'linux' });
    installed = { owner: createProvider('local-http'), ids };
  });

  it('LH01 pins the one approved module digest and loads it through the production installed loader', () => {
    expect(installed.ids).toEqual(['local-http']);
    expect(installed.owner.getName()).toBe('local-http');
    expect(installed.owner.constructor.name).toBe('OllamaAdapter');
  });

  it('LH02 the bundled process/curl adapter-frame profile remains unqualified until host approval', () => {
    const adapter = resolveWorkerAdapter(loadProviderModelCapabilities(), 'workerAdapters:local-http');
    expect(adapter).toMatchObject({ runtimeDriver: 'installed:local-http', supportedVersions: '8.18.0',
      invocation: { kind: 'process', executable: 'curl', stdin: 'adapter-frame' }, qualification: { status: 'unqualified' } });
    expect(adapter.invocationProfiles!['direct-http'].health).toMatchObject({ coverage: 'degraded', progressEvidence: [], outputFraming: 'final-json' });
    expect(() => qualifyWorkerInvocationProfile(adapter, { profile: 'direct-http', transport: 'shell', cliVersion: '8.18.0' }))
      .toThrow('Worker transport/profile is unqualified');
    const host = structuredClone(adapter);
    host.qualification = { status: 'qualified', fixtureDigest: 'sha256:' + 'a'.repeat(64),
      verifiedAt: '2026-10-26T00:00:00Z', evidenceRef: 'fixture:synthetic-only' };
    expect(() => qualifyWorkerInvocationProfile(host, { profile: 'direct-http', transport: 'shell', cliVersion: '8.18.0' }))
      .toThrow(/external enforcing boundary/);
    expect(() => qualifyWorkerInvocationProfile(host, { profile: 'direct-http', transport: 'shell', cliVersion: '8.18.0',
      policy: DEFAULT_WORKER_SELECTION, permissions: { sandbox: 'external' }, effort: null,
      boundary: { kind: 'executor', identity: 'fixture:boundary', digest: 'sha256:' + 'b'.repeat(64), controls: ['sandbox'] } }))
      .toThrow(/matching installation qualification/);
  });

  it('normalizes the complete bounded curl version banner without widening other version patterns', () => {
    const adapter = resolveWorkerAdapter(loadProviderModelCapabilities(), 'workerAdapters:local-http');
    const pattern = adapter.invocation.kind === 'process' ? adapter.invocation.versionPattern : undefined;
    const banner = 'curl 8.18.0 (synthetic-linux) libcurl/8.18.0\nRelease-Date: 2026-01-07\nProtocols: http\nFeatures: ' + 'x'.repeat(512);
    expect(normalizeWorkerVersionBanner(banner, pattern)).toBe('8.18.0');
    expect(() => normalizeWorkerVersionBanner('curl default fake', pattern)).toThrow();
    expect(() => normalizeWorkerVersionBanner('curl 8.18.0 ' + 'x'.repeat(4096), pattern)).toThrow(/bound/);
    expect(() => compileWorkerVersionPattern('^x ([0-9.]{1,129})$')).toThrow(/Unsafe/);
    expect(() => compileWorkerVersionPattern('^x ([0-9.]{1,128}) [a-z]{1,4096}$')).toThrow(/Unsafe/);
  });

  it('LH03 the production resolver and attached launcher deliver the selected model and brief through adapter-frame stdin', async () => {
    const root = await scratch();
    await mkdir(path.join(root, 'work'));
    const MARKER = 'LOCAL-HTTP-BRIEF-MARKER-4e71b0';
    const claimsText = JSON.stringify({ version: 1, status: 'completed', summary: MARKER,
      claims: [], artifacts: [], checks: [], limitations: [] });
    const payload = `--leading 'quotes" 雪\n$(touch injected) ${MARKER}`;
    const { snapshot, drivers, request, now } = resolverFixture(root, installed.owner);
    await writeFile(request.brief, payload, { mode: 0o600 });
    const server = await startFakeServer(root, 'success', claimsText);
    vi.stubEnv('OLLAMA_HOST', server.endpoint);
    vi.stubEnv('AIWG_RESOLVE_IMPL_FROM', 'src');
    try {
      const plan = await resolveWorkerInvocation(snapshot, request, drivers, now);
      expect(plan.invocation, JSON.stringify(plan)).toBeDefined();
      const invocation = plan.invocation!;
      expect(invocation.stdin).toBe('adapter-frame');
      expect(invocation.selected.effort.value).toBeNull();
      expect(JSON.stringify(plan)).not.toContain(MARKER);
      expect(invocation.shellCommand).toContain(`'${MODEL}'`);
      const invocationPath = path.join(root, 'plan.json');
      await writeFile(invocationPath, JSON.stringify(plan), { mode: 0o600 });
      const launches: any[] = [];
      const runDir = path.join(root, 'run');
      const result: any = await new SessionLauncher().launchWorker({ invocationPath, runDir, inputs: { snapshot, drivers }, now,
        checkDispatch: () => ({ enabled: true, ok: true, failures: [] }),
        isolation: { mode: 'degraded', reason: 'synthetic: no systemd user manager' }, allowDegraded: true,
        launchIsolated: (options: any) => { launches.push(options); return launchIsolatedWorker(options); } });
      expect(result.exitCode ?? result.exit?.exitCode, JSON.stringify(result)).toBe(0);
      expect(launches).toHaveLength(1);
      expect(launches[0]).toMatchObject({ stdin: 'adapter-frame', args: invocation.argv.slice(1) });
      expect(JSON.stringify(launches[0].args)).not.toContain(MARKER);
      const record = JSON.parse(await readFile(server.recordPath, 'utf8'));
      expect(record).toMatchObject({ method: 'POST', path: '/api/generate',
        body: { model: MODEL, prompt: workerPromptBrief(payload, invocation.finalPath!).toString(), stream: false } });
      expect(Object.keys(record.body).sort()).toEqual(['model', 'prompt', 'stream']);
      const final = await installed.owner.parseWorkerFinal(await readFile(invocation.stdoutPath), {
        format: 'json', observation: { transport: 'shell', status: 'completed', termination: 'confirmed', exitCode: 0 } });
      expect(final).toMatchObject({ status: 'completed', summary: MARKER });
      for (const name of (await readdir(runDir)).filter(name => name.endsWith('.json'))) {
        expect(await readFile(path.join(runDir, name), 'utf8'), name).not.toContain(MARKER);
      }
    } finally { server.stop(); }
  });

  it('LH04 disabled members and coding requests cannot build a transport or start a service', async () => {
    const root = await scratch(); await mkdir(path.join(root, 'work'));
    await writeFile(path.join(root, 'brief.txt'), 'synthetic text', { mode: 0o600 });
    const disabled = resolverFixture(root, installed.owner);
    disabled.snapshot.config.parallelism!.clis!['local-http'].enabled = false;
    const build = vi.spyOn(disabled.drivers['local-http'], 'buildInvocation');
    const plan = await resolveWorkerInvocation(disabled.snapshot, disabled.request, disabled.drivers, disabled.now);
    expect(plan.invocation).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
    vi.stubEnv('OLLAMA_HOST', '127.0.0.1:1');
    const coding = resolverFixture(root, installed.owner, 'coding');
    const refused = await resolveWorkerInvocation(coding.snapshot, coding.request, coding.drivers, coding.now);
    expect(refused.invocation).toBeUndefined();
    expect(JSON.stringify(refused)).toContain('invocation_build_failed');
  });
});
