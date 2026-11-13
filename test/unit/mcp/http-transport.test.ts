// Exercise the authenticated listener in process using the shared offline fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { launchHttp } from '../../fixtures/mcp/http-service.mjs';
import { startHttpServer } from '../../../src/mcp/http-transport.mjs';

let fixture: Awaited<ReturnType<typeof launchHttp>>;
afterEach(async () => {
  vi.unstubAllEnvs();
  await fixture?.close();
});
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'unit-http', version: '1' },
} };
async function launch(extra: string[] = [], options = {}) {
  fixture = await launchHttp(extra, { ...options, inProcess: true });
  return fixture.service;
}
async function request(body: unknown, headers = {}, method = 'POST', url = fixture.url) {
  // Node fetch replaces Host; use a real HTTP request for explicit authority checks.
  if ('Host' in headers) return new Promise<{ status: number; headers: Headers; text: string }>((resolve, reject) => {
    const req = http.request(url, { method, headers: {
      Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', ...headers,
    } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!,
        headers: new Headers(response.headers as Record<string, string>), text }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
  const response = await fetch(url, { method, headers: {
    Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', ...headers,
  }, ...(body === undefined || method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}
async function error(status: number, message: string, body?: unknown, headers = {}, method = 'POST', url = fixture.url) {
  const response = await request(method === 'POST' && body === undefined ? initialize : body, headers, method, url);
  expect(response.status).toBe(status);
  expect(JSON.parse(response.text)).toEqual({ error: message });
  expect(response.headers.get('cache-control')).toBe('no-store');
}
async function session(headers = {}) {
  const response = await request(initialize, headers);
  expect(response.status).toBe(200);
  expect(response.text).toContain('"protocolVersion":"2025-11-25"');
  const id = response.headers.get('mcp-session-id');
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  return id!;
}

it('requires the environment bearer on POST, GET and DELETE', async () => {
  const service = await launch();
  for (const method of ['POST', 'GET', 'DELETE']) {
    for (const Authorization of ['', 'Bearer wrong-token', 'Basic wrong-token']) {
      await error(401, 'Unauthorized', undefined, { Authorization }, method);
    }
  }
  expect(service.sessionCount()).toBe(0);
  // Environment sources are captured at startup, unlike rotating files.
  vi.stubEnv('AIWG_HTTP_FIXTURE_TOKEN', 'replacement-token');
  await session();
  await error(401, 'Unauthorized', initialize, { Authorization: 'Bearer replacement-token' });
});

it('enforces Host and Origin policy and accepts explicit proxy hosts', async () => {
  const service = await launch(['--allowed-host', 'proxy.test:8443']);
  for (const headers of [{ Host: 'rebind.invalid' }, { Origin: 'https://rebind.invalid' },
    { Origin: 'null' }, { Origin: 'http://127.0.0.1.evil.test' },
    { Host: 'proxy.test:443' }, { Origin: 'https://user@localhost' },
    { Origin: 'http://localhost/path' }, { Origin: 'ftp://localhost' }]) {
    await error(403, 'Host or Origin is not allowed', initialize, headers);
  }
  expect(service.sessionCount()).toBe(0);
  const ids = await Promise.all([
    session({ Origin: new URL(fixture.url).origin }),
    session({ Host: 'localhost', Origin: 'http://localhost' }),
    session({ Host: 'proxy.test:8443', Origin: 'https://proxy.test:8443' }),
  ]);
  expect(new Set(ids).size).toBe(3);
  expect(service.sessionCount()).toBe(3);
});

it('bounds concurrent sessions, deletes sessions and rejects unknown or reused IDs', async () => {
  const service = await launch(['--max-sessions', '2']);
  const [a, b] = await Promise.all([session(), session()]);
  expect(a).not.toBe(b);
  expect(service.sessionCount()).toBe(2);
  await error(503, 'Maximum sessions reached');
  await error(404, 'Unknown session; initialize again', {}, { 'mcp-session-id': 'unknown' });
  await error(404, 'Session ID cannot be reused for initialization', initialize, { 'mcp-session-id': a });
  const deleted = await request(undefined, { 'mcp-session-id': a }, 'DELETE');
  expect(deleted.status).toBe(200);
  expect(deleted.text).toBe('');
  await vi.waitFor(() => expect(service.sessionCount()).toBe(1));
  await error(404, 'Unknown session; initialize again', {}, { 'mcp-session-id': a });
  expect(await session()).not.toBe(a);
  const tools = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-session-id': b });
  expect(tools.status).toBe(200);
  expect(tools.text).toContain('"name":"discover"');
});

it('expires idle sessions and admits a fresh initialization', async () => {
  const service = await launch([], { idleTimeoutMs: 40 });
  const id = await session();
  await vi.waitFor(() => expect(service.sessionCount()).toBe(0));
  await error(404, 'Unknown session; initialize again', {}, { 'mcp-session-id': id });
  expect(await session()).not.toBe(id);
});

it('rereads synthetic token files, binds sessions to their token and fails closed if removed', async () => {
  const service = await launch([], { fileToken: true });
  const id = await session();
  const next = 'rotated-fixture-token';
  await fs.writeFile(fixture.tokenFile + '.next', next, { mode: 0o600 });
  await fs.rename(fixture.tokenFile + '.next', fixture.tokenFile);
  await error(401, 'Unauthorized', {}, { 'mcp-session-id': id });
  await error(404, 'Unknown session; initialize again', {}, { Authorization: `Bearer ${next}`, 'mcp-session-id': id });
  await session({ Authorization: `Bearer ${next}` });
  expect(service.sessionCount()).toBe(2);
  await fs.unlink(fixture.tokenFile);
  await error(401, 'Unauthorized', initialize, { Authorization: `Bearer ${next}` });
});

it('rejects wrong paths, methods, uninitialized requests, malformed and oversized bodies', async () => {
  const service = await launch();
  await error(404, 'Not found', initialize, {}, 'POST', new URL('/other', fixture.url).href);
  await error(405, 'Method not allowed', undefined, {}, 'PUT');
  for (const method of ['POST', 'GET', 'DELETE']) {
    await error(400, 'Initialize a new session first', method === 'POST' ? {} : undefined, {}, method);
  }
  await error(400, 'Only POST requests may carry a body', 'unexpected', {}, 'DELETE');
  await error(400, 'Invalid JSON', '{');
  await error(413, 'Request body exceeds 1 MiB', 'x'.repeat(1024 * 1024 + 1));
  // A stream has no Content-Length, exercising the incremental size limit.
  const response = await fetch(fixture.url, {
    method: 'POST', headers: { Authorization: `Bearer ${fixture.token}` },
    body: new ReadableStream({ start(controller) {
      for (let i = 0; i < 17; i++) controller.enqueue(new Uint8Array(65536));
      controller.close();
    } }), duplex: 'half',
  } as RequestInit);
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: 'Request body exceeds 1 MiB' });
  expect(service.sessionCount()).toBe(0);
  // SDK rejection must dispose a newly allocated but uninitialized server.
  const rejected = await request(initialize, { Accept: 'application/json' });
  expect(rejected.status).toBe(406);
  expect(JSON.parse(rejected.text).error.code).toBe(-32000);
  expect(service.sessionCount()).toBe(0);
  await session();
});

it('fails closed when the pinned project is replaced or disappears', async () => {
  await launch();
  await fs.rename(fixture.project, path.join(fixture.scratch, 'original-project'));
  await error(500, 'MCP transport failed');
  await fs.mkdir(fixture.project);
  await error(503, 'Pinned project changed; restart the listener');
});

it('rejects a file project and an unavailable artifact root before binding', async () => {
  await launch();
  const options = { projectDir: fixture.project, port: 0, tokenEnv: 'AIWG_HTTP_FIXTURE_TOKEN' };
  const file = path.join(fixture.scratch, 'file-project');
  await fs.writeFile(file, 'fixture');
  await expect(startHttpServer({ ...options, projectDir: file })).rejects.toThrow('--project must be a directory');
  await fs.rm(path.join(fixture.project, '.aiwg'), { recursive: true });
  await fs.writeFile(path.join(fixture.project, '.aiwg'), 'not a directory');
  await expect(startHttpServer(options)).rejects.toThrow('Project artifact root is unavailable');
});

it('closes active sessions and resolves closed; repeated close shares the same promise', async () => {
  const service = await launch();
  await session();
  const stopping = service.close();
  expect(service.close()).toBe(stopping);
  await stopping;
  await expect(service.closed).resolves.toBeUndefined();
  expect(service.sessionCount()).toBe(0);
  expect(service.listener.listening).toBe(false);
  await expect(fetch(fixture.url)).rejects.toThrow();
});

it('cleans up a warm server if the loopback port is already occupied', async () => {
  const service = await launch();
  await expect(startHttpServer({ projectDir: fixture.project, host: '127.0.0.1',
    port: service.listener.address().port, tokenEnv: 'AIWG_HTTP_FIXTURE_TOKEN' })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(service.listener.listening).toBe(true);
  await session();
});

it('refuses remote workers HTTP binds even with the general remote override', async () => {
  await expect(startHttpServer({ host: '0.0.0.0', allowRemoteBind: true, toolsets: 'workers' })).rejects.toThrow('localhost');
});

it('advertises the narrow verify-and-deliver endpoint on authenticated workers HTTP', async () => {
  await launch(['--toolsets', 'workers', '--tools', 'worker-verify-deliver']);
  const id = await session();
  const listed = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'Mcp-Session-Id': id });
  expect(listed.status).toBe(200);
  expect(listed.text).toContain('"name":"worker-verify-deliver"');
  expect(listed.text).not.toContain('"name":"worker-invoke"');
  expect(listed.text).not.toContain('"name":"artifact-write"');
});

it('serves worker launch and status on the authenticated localhost workers listener', async () => {
  await launch(['--toolsets', 'workers']);
  await error(401, 'Unauthorized', initialize, { Authorization: '' });
  const id = await session();
  const headers = { 'Mcp-Session-Id': id };
  const payload = (text: string) => JSON.parse(text.startsWith('event:') ? text.split('\n').find(line => line.startsWith('data:'))!.slice(5) : text);
  const listed = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, headers);
  const list = payload(listed.text).result.tools;
  const invoke = list.find((tool: { name: string }) => tool.name === 'worker-invoke');
  expect(invoke.inputSchema.properties.workdir).toBeDefined();
  expect(invoke.inputSchema.properties.project_dir).toBeUndefined();
  expect(list.some((tool: { name: string }) => tool.name === 'worker-verify-deliver')).toBe(true);
  expect(list.some((tool: { name: string }) => tool.name === 'artifact-write')).toBe(false);
  const status = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'worker-invoke', arguments: { operation: 'status' } } };
  await error(401, 'Unauthorized', status, { ...headers, Authorization: 'Bearer wrong' });
  const observed = await request(status, headers);
  expect(observed.status).toBe(200);
  expect(payload(observed.text).result.isError).not.toBe(true);
  const refused = await request({ ...status, id: 4, params: { name: 'worker-invoke', arguments: {
    operation: 'run', request_id: 'outside', role: 'coding', task: 'implementation', group: 'workers',
    workdir: '/outside', brief: '/outside/brief', final_output: '/outside/final', transport: 'shell',
  } } }, headers);
  expect(payload(refused.text).result.isError).toBe(true);
});
