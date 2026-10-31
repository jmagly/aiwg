// Startup and header policy checks using only isolated IPv4 loopback sockets.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { parseHttpOptions, tokenSource, hostPolicy } from '../../../src/mcp/http-options.mjs';
import { startHttpServer } from '../../../src/mcp/http-transport.mjs';

let scratch: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
});
it('parses defaults, repeated allowed-host values and equals syntax', () => {
  expect(parseHttpOptions(['--project=/tmp/project', '--token-env', 'FIXTURE_TOKEN', '--allowed-host', 'proxy.test', '--allowed-host=another.test']))
    .toMatchObject({ projectDir: '/tmp/project', tokenEnv: 'FIXTURE_TOKEN', host: '127.0.0.1', port: 3100,
      maxSessions: 8, toolsets: '', allowedHosts: ['proxy.test', 'another.test'] });
});
it.each([['--token', 'secret'], ['--project'], ['--tools='], ['--host=x', '--host=y'], ['--allow-remote-bind=true']])('rejects malformed options %j', (...args) => {
  expect(() => parseHttpOptions(args)).toThrow();
});
it('requires exactly one nonempty credential source without echoing values', async () => {
  const token = randomBytes(32).toString('hex');
  vi.stubEnv('AIWG_HTTP_UNIT_TOKEN', token);
  for (const options of [{}, { tokenEnv: 'AIWG_HTTP_UNIT_TOKEN', tokenFile: '/unused' }, { tokenEnv: 'MISSING_HTTP_UNIT_TOKEN' }]) {
    await expect(tokenSource(options)).rejects.toThrow(/exactly one|nonempty/);
  }
  const authenticate = await tokenSource({ tokenEnv: 'AIWG_HTTP_UNIT_TOKEN' });
  expect(await authenticate(`Bearer ${token}`)).toBeInstanceOf(Buffer);
  expect(await authenticate(`Bearer ${token}x`)).toBeUndefined();
  expect(await authenticate('')).toBeUndefined();
});
it('refuses startup before listening when project, token, tool selection or bind policy is invalid', async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-http-options-'));
  const token = randomBytes(32).toString('hex');
  vi.stubEnv('AIWG_HTTP_UNIT_TOKEN', token);
  const options = { projectDir: scratch, tokenEnv: 'AIWG_HTTP_UNIT_TOKEN', port: 0 };
  await expect(startHttpServer({ ...options, projectDir: undefined })).rejects.toThrow('--project');
  await expect(startHttpServer({ ...options, host: '0.0.0.0' })).rejects.toThrow('--allow-remote-bind');
  await expect(startHttpServer({ ...options, maxSessions: 0 })).rejects.toThrow('--max-sessions');
  await expect(startHttpServer({ ...options, tools: ['command-run'] })).rejects.toThrow('--tools');
  await expect(startHttpServer({ ...options, tools: ['flow-show'] })).rejects.toThrow('--toolsets');
  await expect(startHttpServer({ ...options, tokenEnv: undefined })).rejects.toThrow('exactly one');
});
it('accepts only exact Host and Origin allowlist matches, including explicit ports', () => {
  const allowed = hostPolicy('127.0.0.1', ['proxy.test:8443']);
  expect(allowed({ host: '127.0.0.1:41001' })).toBe(true);
  expect(allowed({ host: 'localhost', origin: 'http://localhost' })).toBe(true);
  expect(allowed({ host: 'localhost:3100', origin: 'http://localhost:3100' })).toBe(true);
  expect(allowed({ host: 'proxy.test:8443', origin: 'https://proxy.test:8443' })).toBe(true);
  for (const headers of [{ host: 'proxy.test:443' }, { host: '127.0.0.1.evil.test' }, { host: 'localhost.evil.test' },
    { host: '127.0.0.1', origin: 'https://user@127.0.0.1' }, { host: '127.0.0.1', origin: 'http://127.0.0.1/a' },
    { host: '127.0.0.1', origin: 'null' }, { host: '127.0.0.1', origin: 'file://127.0.0.1' }]) expect(allowed(headers)).toBe(false);
  expect(() => hostPolicy('127.0.0.1', ['*'])).toThrow();
});

it.each(['::1', '[::1]'])('treats %s as loopback without remote opt-in or warning', async host => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'aiwg-http-ipv6-'));
  const artifactDir = path.join(scratch, '.aiwg');
  await fs.mkdir(artifactDir);
  vi.stubEnv('AIWG_HTTP_UNIT_TOKEN', randomBytes(32).toString('hex'));
  vi.stubEnv('AIWG_PROJECT_AIWG_DIR', artifactDir);
  const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
  const listen = http.Server.prototype.listen;
  // Assert IPv6 bind selection while keeping fixture sockets on permitted IPv4 loopback.
  const binding = vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (this: http.Server, ...args: any[]) {
    expect(args[1]).toBe('::1');
    return listen.call(this, args[0], '127.0.0.1', args[2]);
  });
  const service = await startHttpServer({ projectDir: scratch, host, port: 0, tokenEnv: 'AIWG_HTTP_UNIT_TOKEN' });
  try {
    expect(binding).toHaveBeenCalledOnce();
    expect(warning).not.toHaveBeenCalledWith(expect.stringContaining('WARNING: remote MCP bind'));
  } finally { await service.close(); }
  const allowed = hostPolicy(host);
  expect(allowed({ host: '[::1]', origin: 'http://[::1]' })).toBe(true);
  expect(allowed({ host: '[::1]:3100', origin: 'http://[::1]:3100' })).toBe(true);
  for (const headers of [{ host: '[::2]' }, { host: '[::1]', origin: 'http://[::2]' }, { host: '::1' }]) {
    expect(allowed(headers)).toBe(false);
  }
});
