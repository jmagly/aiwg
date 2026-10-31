// SDK protocol and security checks against the dedicated remote MCP CLI.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { launchHttp } from '../fixtures/mcp/http-service.mjs';

let service: Awaited<ReturnType<typeof launchHttp>>;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(client => client.close()));
  await service?.close();
});
async function connect(token = service.token) {
  const client = new Client({ name: 'offline-http-test', version: '1' });
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(service.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, transport };
}
function raw(body: unknown, headers: Record<string, string> = {}, method = 'POST', url = service.url) {
  return new Promise<{ status: number; body: { cancel: () => void } }>((resolve, reject) => {
    const request = http.request(url, { method, headers: {
      Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', ...headers,
    } }, response => {
      response.resume();
      resolve({ status: response.statusCode!, body: { cancel: () => response.destroy() } });
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)));
  });
}
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-test', version: '1' },
} };
async function marker(name: string) {
  for (let i = 0; i < 100; i++) {
    const value = await fs.readFile(path.join(service.project, name), 'utf8').catch(() => undefined);
    if (value) return value;
    await delay(20);
  }
  throw new Error(`Missing CLI marker ${name}`);
}

describe('remote AIWG MCP protocol', () => {
  it('initializes, discovers, shows and writes to the pinned project with concurrent clients', async () => {
    service = await launchHttp();
    const [a, b] = await Promise.all([connect(), connect()]);
    expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
    expect(a.transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const listing = await a.client.listTools();
    expect(listing.tools.map(tool => tool.name).sort()).toEqual([
      'agent-show', 'artifact-write', 'command-show', 'discover', 'rule-show', 'skill-show', 'template-show',
    ]);
    for (const tool of listing.tools) {
      expect(tool.inputSchema.properties).not.toHaveProperty('project_dir');
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    const results = await Promise.all([
      a.client.callTool({ name: 'discover', arguments: { phrase: 'sdlc-quickref', type: 'skill' } }),
      b.client.callTool({ name: 'skill-show', arguments: { name: 'sdlc-quickref', rules: true } }),
      b.client.callTool({ name: 'artifact-write', arguments: { path: 'remote/result.md', content: 'project-bound' } }),
    ]);
    for (const result of results) expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(JSON.stringify(results[0])).toContain('sdlc-quickref');
    expect(JSON.stringify(results[1])).toContain('sdlc-orchestration');
    expect(await fs.readFile(path.join(service.project, '.aiwg/remote/result.md'), 'utf8')).toBe('project-bound');
    expect(await fs.readdir(service.scratch)).not.toContain('.aiwg');
    expect((await a.client.listResources()).resources.length).toBeGreaterThan(0);
    expect((await a.client.listPrompts()).prompts.length).toBeGreaterThan(0);
    expect(a.client.getServerCapabilities()).not.toHaveProperty('elicitation');
  }, 30_000);

  it('requires authentication on POST, GET and DELETE, and rejects bad Host/Origin', async () => {
    service = await launchHttp();
    for (const method of ['POST', 'GET', 'DELETE']) {
      for (const authorization of ['', `Bearer ${randomBytes(32).toString('hex')}`]) {
        expect((await raw(method === 'POST' ? initialize : undefined, { Authorization: authorization }, method)).status).toBe(401);
      }
    }
    for (const headers of [ { Host: 'rebind.invalid' }, { Origin: 'https://rebind.invalid' },
      { Origin: 'null' }, { Origin: 'http://127.0.0.1.evil.test' } ]) {
      expect((await raw(initialize, headers)).status).toBe(403);
    }
    const accepted = await raw(initialize, { Origin: new URL(service.url).origin });
    expect(accepted.status).toBe(200);
    await accepted.body?.cancel();
    expect(service.logs()).not.toContain(service.token);
  });

  it('fails closed on unauthorized tools, scope injections, traversal and artifact symlinks', async () => {
    service = await launchHttp();
    const { client } = await connect();
    for (const name of ['command-run', 'worker-invoke', 'artifact-read', 'flow-show']) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('not found');
    }
    expect((await client.callTool({ name: 'skill-show', arguments: {
      name: 'sdlc-quickref', section: ['--resource-source=web'],
    } })).isError).toBe(true);
    const outside = path.join(service.scratch, 'outside');
    await fs.mkdir(outside);
    for (const scope of ['project_dir', 'cwd', 'projectRoot', 'artifact_root', 'scope']) {
      const result = await client.callTool({ name: 'artifact-write', arguments: { path: 'escape', content: 'bad', [scope]: outside } });
      expect(result.isError).toBe(true);
    }
    for (const target of ['../outside/escape', '/outside/escape']) {
      expect((await client.callTool({ name: 'artifact-write', arguments: { path: target, content: 'bad' } })).isError).toBe(true);
    }
    await fs.symlink(outside, path.join(service.project, '.aiwg/link'));
    expect((await client.callTool({ name: 'artifact-write', arguments: { path: 'link/escape', content: 'bad' } })).isError).toBe(true);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('accepts localhost Host and matching Origin on the default bind', async () => {
    service = await launchHttp();
    for (const host of ['localhost', `localhost:${new URL(service.url).port}`]) {
      expect((await raw(initialize, { Host: host, Origin: `http://${host}` })).status).toBe(200);
    }
  });

  it('never logs rejected request bodies with bad auth or a bad Host', async () => {
    service = await launchHttp();
    const canary = `private-body-${randomBytes(32).toString('hex')}`;
    expect((await raw({ canary }, { Authorization: 'Bearer invalid' })).status).toBe(401);
    expect((await raw({ canary }, { Host: 'rebind.invalid' })).status).toBe(403);
    await service.close(); // Wait for all stdout/stderr to arrive before checking logs.
    expect(service.logs()).not.toContain(canary);
    expect(service.logs()).not.toContain(service.token);
  });

  it('rejects GET and DELETE bodies and paths other than /mcp', async () => {
    service = await launchHttp();
    const body = JSON.stringify({ payload: 'unexpected' });
    for (const method of ['GET', 'DELETE']) {
      expect((await raw(body, { 'Content-Length': String(Buffer.byteLength(body)) }, method)).status).toBe(400);
    }
    expect((await raw(initialize, {}, 'POST', new URL('/other', service.url).href)).status).toBe(404);
  });

  it('retains artifact identity across sessions and refuses a replaced project', async () => {
    service = await launchHttp();
    const a = await connect();
    await fs.rename(path.join(service.project, '.aiwg'), path.join(service.scratch, 'original-artifacts'));
    await fs.mkdir(path.join(service.project, '.aiwg'));
    const b = await connect();
    for (const { client } of [a, b]) {
      expect((await client.callTool({ name: 'artifact-write', arguments: { path: 'escape', content: 'bad' } })).isError).toBe(true);
    }
    expect(await fs.readdir(path.join(service.project, '.aiwg'))).toEqual([]);
    await fs.rename(service.project, path.join(service.scratch, 'original-project'));
    await fs.mkdir(service.project);
    expect((await raw(initialize)).status).toBe(503);
  });

  it('bounds sessions, rejects unknown/deleted IDs and admits new initialization after disconnect', async () => {
    service = await launchHttp(['--max-sessions', '2']);
    const [a, b] = await Promise.all([connect(), connect()]);
    expect((await raw(initialize)).status).toBe(503);
    expect((await raw({}, { 'mcp-session-id': randomBytes(32).toString('hex') })).status).toBe(404);
    const id = a.transport.sessionId!;
    expect((await raw(initialize, { 'mcp-session-id': id })).status).toBe(404);
    await a.transport.terminateSession();
    expect((await raw({}, { 'mcp-session-id': id })).status).toBe(404);
    const c = await connect();
    expect(c.transport.sessionId).not.toBe(id);
    expect((await b.client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('rereads a replaced token file, binds sessions to tokens, and refuses missing token files', async () => {
    service = await launchHttp([], { fileToken: true });
    const { transport } = await connect();
    const next = randomBytes(32).toString('hex');
    await fs.writeFile(service.tokenFile + '.next', next, { mode: 0o600 });
    await fs.rename(service.tokenFile + '.next', service.tokenFile);
    expect((await raw({}, { 'mcp-session-id': transport.sessionId! })).status).toBe(401);
    expect((await raw({}, { Authorization: `Bearer ${next}`, 'mcp-session-id': transport.sessionId! })).status).toBe(404);
    expect((await (await connect(next)).client.listTools()).tools.length).toBeGreaterThan(0);
    await fs.unlink(service.tokenFile);
    expect((await raw(initialize, { Authorization: `Bearer ${next}` })).status).toBe(401);
  });

  it('enforces a 1 MiB body limit for fixed-length and chunked requests', async () => {
    service = await launchHttp();
    expect((await raw('x'.repeat(1024 * 1024 + 1), { 'Content-Length': String(1024 * 1024 + 1) })).status).toBe(413);
    const status = await new Promise(resolve => {
      const request = http.request(service.url, { method: 'POST', headers: {
        Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'Transfer-Encoding': 'chunked',
      } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', () => {});
      for (let i = 0; i < 17; i++) request.write('x'.repeat(65536));
      request.end();
    });
    expect(status).toBe(413);
    expect((await (await connect()).client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('narrows tools, permits explicit opt-in show tools and accepts configured proxy hosts', async () => {
    service = await launchHttp(['--tools', 'discover,flow-show', '--toolsets', 'flows', '--allowed-host', 'proxy.test']);
    expect((await (await connect()).client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['discover', 'flow-show']);
    const accepted = await raw(initialize, { Host: 'proxy.test', Origin: 'https://proxy.test' });
    expect(accepted.status).toBe(200);
    await accepted.body?.cancel();
  });

  it('expires idle sessions and requires reinitialization', async () => {
    service = await launchHttp([], { idleTimeoutMs: 200 });
    const { transport } = await connect();
    const id = transport.sessionId!;
    await delay(400);
    expect((await raw({}, { 'mcp-session-id': id })).status).toBe(404);
    expect((await (await connect()).client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('maps MCP cancellation to the real CLI subprocess and keeps the session usable', async () => {
    service = await launchHttp([], { idleTimeoutMs: 200 });
    const { client } = await connect();
    const controller = new AbortController();
    const result = client.callTool({ name: 'discover', arguments: { phrase: '__wait_for_cancel__' } }, undefined, { signal: controller.signal });
    const rejected = expect(result).rejects.toThrow();
    await marker('cli-started');
    await delay(400); // Active tool work must not be treated as an idle session.
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    controller.abort();
    await rejected;
    expect(await marker('cli-cancelled')).toBe('cancelled');
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('drains sessions, cancels work and closes the listener on %s', async signal => {
    service = await launchHttp();
    const { client } = await connect();
    const result = client.callTool({ name: 'discover', arguments: { phrase: '__wait_for_cancel__' } });
    const rejected = expect(result).rejects.toThrow();
    await marker('cli-started');
    service.child.kill(signal);
    expect(await service.exited).toEqual({ code: 0, signal: null });
    // SSE clients may retry a dropped stream; explicitly close the disconnected client.
    await client.close();
    await rejected;
    expect(await marker('cli-cancelled')).toBe('cancelled');
    await expect(fetch(service.url)).rejects.toThrow();
  });
});
