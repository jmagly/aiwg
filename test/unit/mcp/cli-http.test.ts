// Drive CLI HTTP dispatch and help in process without opening a listener.
import { afterEach, expect, it, vi } from 'vitest';
import { main } from '../../../src/mcp/cli.mjs';
import { serveHttp } from '../../../src/mcp/http-transport.mjs';
import { startServer } from '../../../src/mcp/server.mjs';

vi.mock('../../../src/mcp/http-transport.mjs', () => ({ serveHttp: vi.fn() }));
vi.mock('../../../src/mcp/server.mjs', () => ({ startServer: vi.fn(), createServer: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); });

it.each([['--transport', 'http'], ['--transport=http']])('dispatches HTTP options unchanged: %j', async (...transport) => {
  const options = [...transport, '--project', '/synthetic/project', '--port', '0', '--token-env', 'FIXTURE_TOKEN',
    '--allowed-host', 'proxy.test', '--max-sessions', '2', '--tools', 'discover', '--toolsets', 'flows'];
  await main(['serve', ...options]);
  expect(serveHttp).toHaveBeenCalledExactlyOnceWith(options);
  expect(startServer).not.toHaveBeenCalled();
});

it('awaits HTTP startup and propagates startup failures', async () => {
  const failure = new Error('synthetic HTTP startup refusal');
  vi.mocked(serveHttp).mockRejectedValueOnce(failure);
  await expect(main(['serve', '--transport=http'])).rejects.toBe(failure);
  expect(startServer).not.toHaveBeenCalled();
});

it.each([[], ['--transport', 'stdio']])('keeps stdio dispatch for %j', async (...transport) => {
  vi.stubEnv('AIWG_MCP_TOOLSETS', '');
  await main(['serve', ...transport, '--toolsets', 'flows']);
  expect(startServer).toHaveBeenCalledExactlyOnceWith();
  expect(serveHttp).not.toHaveBeenCalled();
  expect(process.env.AIWG_MCP_TOOLSETS).toBe('flows');
});

it('prints exact HTTP security options in help', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await main(['--help']);
  expect(output).toHaveBeenCalledOnce();
  const text = output.mock.calls[0][0];
  for (const line of [
    '  --transport <type>   Transport type: stdio (default), http',
    '  --project <dir>      Required HTTP project; pinned at startup',
    '  --token-env <NAME>   HTTP bearer token environment variable (choose one source)',
    '  --token-file <path>  HTTP bearer token file; re-read per request for rotation',
    '  --host <address>    HTTP bind address (default: 127.0.0.1)',
    '  --allow-remote-bind  Required for non-loopback binds; emits a warning',
    '  --allowed-host <h>   Additional HTTP Host/Origin hostname (repeatable)',
    '  --max-sessions <n>   HTTP session cap (default: 8; idle timeout: 300 seconds)',
    '  --tools <csv>        Narrow HTTP tools: discover, *-show, artifact-write',
  ]) expect(text.split('\n')).toContain(line);
  expect(serveHttp).not.toHaveBeenCalled();
  expect(startServer).not.toHaveBeenCalled();
});

// The changed switch owns every command outcome in the coverage gate.
it('refuses an invalid install scope before resolving a destination', async () => {
  await expect(main(['install', 'omp', '--scope', 'invalid'])).rejects.toThrow(new Error('Scope must be project or user'));
  expect(serveHttp).not.toHaveBeenCalled();
  expect(startServer).not.toHaveBeenCalled();
});

it.each([
  ['add', 'Usage: aiwg mcp add <name> --url <url> [--type http|stdio|sse] [--command <cmd>] [--args <a,b>]'],
  ['remove', 'Usage: aiwg mcp remove <name>'],
  ['update', 'Usage: aiwg mcp update <name> --url <url> [--type <type>] ...'],
])('refuses %s without a server name before accessing the registry', async (command, usage) => {
  const refusal = new Error('synthetic process exit');
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw refusal; });
  const output = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(main([command])).rejects.toBe(refusal);
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(output).toHaveBeenCalledExactlyOnceWith(usage);
  expect(serveHttp).not.toHaveBeenCalled();
  expect(startServer).not.toHaveBeenCalled();
});
