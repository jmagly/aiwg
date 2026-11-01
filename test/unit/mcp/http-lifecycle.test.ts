// Exercise serveHttp signal ownership with real loopback listeners and synthetic signals.
import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { launchHttp } from '../../fixtures/mcp/http-service.mjs';
import { serveHttp } from '../../../src/mcp/http-transport.mjs';

let fixture: Awaited<ReturnType<typeof launchHttp>>;
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture?.close();
});

it.each(['SIGTERM', 'SIGINT'])('serves until %s and removes both signal handlers after closing', async signal => {
  fixture = await launchHttp([], { inProcess: true });
  const callbacks = new Map<string, () => void>();
  const originalOnce = process.once;
  vi.spyOn(process, 'once').mockImplementation(function (event, callback) {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      callbacks.set(event, callback);
      return this;
    }
    return originalOnce.call(this, event, callback);
  });
  const remove = vi.spyOn(process, 'removeListener');
  const output = vi.spyOn(console, 'error').mockImplementation(() => {});
  let listener: http.Server | undefined;
  const originalListen = http.Server.prototype.listen;
  vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (...args: any[]) {
    listener = this;
    return originalListen.apply(this, args);
  });
  const serving = serveHttp(['--project', fixture.project, '--port', '0', '--token-env', 'AIWG_HTTP_FIXTURE_TOKEN']);
  try {
    await vi.waitFor(() => expect(callbacks.size).toBe(2));
    const address = listener!.address() as { address: string; port: number };
    expect(address.address).toBe('127.0.0.1');
    expect(output).toHaveBeenCalledWith(`AIWG MCP HTTP listening on 127.0.0.1:${address.port}/mcp`);
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    callbacks.get(signal)!();
    await serving;
    expect(listener!.listening).toBe(false);
    for (const name of ['SIGTERM', 'SIGINT']) {
      expect(remove).toHaveBeenCalledWith(name, callbacks.get(name));
      expect(process.listeners(name)).not.toContain(callbacks.get(name));
    }
    await expect(fetch(`http://127.0.0.1:${address.port}/mcp`)).rejects.toThrow();
  } finally {
    callbacks.get('SIGTERM')?.();
    await serving;
  }
});
