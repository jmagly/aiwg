import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../../src/mcp/cli.mjs';
import { assertProjectCredentials } from '../../../src/mcp/config-file.mjs';
import { assertCredentialPolicy, credentialLikeQueryParams, credentialPolicyViolations } from '../../../src/mcp/credentials.mjs';
import { McpServerRegistry, injectServers } from '../../../src/mcp/registry.js';
import { McpServerRegistry as RuntimeRegistry, injectServers as runtimeInjectServers } from '../../../src/mcp/registry.mjs';

let root: string;
let project: string;
let config: string;
let home: string;
const secret = 'SYNTHETIC-QUERY-CREDENTIAL';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiwg-query-credentials-'));
  project = join(root, 'project');
  config = join(root, 'config');
  home = join(root, 'home');
  for (const dir of [project, config, home]) await mkdir(dir);
  vi.stubEnv('AIWG_CONFIG', config);
  vi.stubEnv('AIWG_CONFIG_LAYERS', '');
  vi.stubEnv('AIWG_MCP_CREDENTIAL_POLICY', '');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('credential-like URL queries', () => {
  it.each(['private_key', 'signing.key', 'encryption-key', 'privatekey', 'clientsecret', 'secretkey', 'apitoken', 'pwd', 'passcode', 'session_id', 'sessionid', 'API_TOKEN', 'options[privateKey]', 'token', 'token[]', 'auth[token]', 'options[token][]', 'options[key]', 'options[sig]', '%74oken%5B%5D', 'options%5Btoken%5D', 'key', 'secret', 'password', 'passwd', 'auth', 'authorization', 'signature', 'sig', 'jwt', 'bearer', 'api_key', 'apikey', 'apiKey', 'access_key', 'accessKey', 'access_token', 'clientSecret', 'X-Amz-Signature', 'X-Amz-Credential', '%74oken'])('refuses %s in project writes and restrictive policies without echoing the secret', key => {
    const server = { name: 'query', url: `https://example.test/mcp?view=full&${key}=${secret}` };
    expect(credentialLikeQueryParams(server.url)).toHaveLength(1);
    for (const policy of ['references', 'none'] as const) {
      expect(credentialPolicyViolations(server, policy)).toEqual(['url query credentials']);
      expect(() => assertCredentialPolicy([server], policy)).toThrow(/query credentials/);
      try { assertCredentialPolicy([server], policy); } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
    }
    expect(credentialPolicyViolations(server, 'literal')).toEqual([]);
    expect(() => assertProjectCredentials([server], join(project, '.mcp.json'))).toThrow(/URL query credentials/);
    try { assertProjectCredentials([server], join(project, '.mcp.json')); } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('detects encoded values, repeated keys, and queries on malformed hosts', () => {
    for (const url of [
      `https://example.test/mcp?token=&token=${encodeURIComponent(secret)}#ignored`,
      `https://bad host/mcp?token=${secret}`,
      `https://example.test/mcp?\nto\tken=${secret}`,
    ]) {
      expect(credentialLikeQueryParams(url)).toEqual(['token']);
    }
  });

  it('allows noncredential queries and empty values', () => {
    const server = { name: 'clean', url: 'https://example.test/mcp?view=full&monkey=banana&sort_key=name&cache-key=public&sort_sig=asc&options[sort_key]=name&token=#section' };
    expect(credentialLikeQueryParams(server.url)).toEqual([]);
    expect(credentialPolicyViolations(server, 'none')).toEqual([]);
    expect(() => assertProjectCredentials([server], join(project, '.mcp.json'))).not.toThrow();
  });

  it.each(['${MCP_TOKEN}', '${env:MCP_TOKEN}', '{env:MCP_TOKEN}'])('treats %s as a reference, including percent encoding', reference => {
    for (const key of ['token', 'token[]', 'auth[token]', 'options[key]']) {
      for (const value of [reference, encodeURIComponent(reference)]) {
        const server = { name: 'reference', url: `https://example.test/mcp?${key}=${value}` };
        expect(credentialPolicyViolations(server, 'references')).toEqual([]);
        expect(credentialPolicyViolations(server, 'none')).toEqual(['url query credentials']);
        expect(() => assertProjectCredentials([server], join(project, '.mcp.json'))).not.toThrow();
      }
    }
  });

  it.each(['auth', 'oauth'] as const)('checks credential queries in %s URLs', field => {
    for (const key of ['tokenUrl', 'redirectUri', 'resource']) {
      const server = { name: 'oauth-query', [field]: { [key]: `https://example.test/mcp?token=${secret}` } };
      for (const policy of ['references', 'none'] as const) {
        expect(credentialPolicyViolations(server, policy)).toContain(`${field}.${key} query credentials`);
        expect(() => assertProjectCredentials([server], join(project, '.mcp.json'))).toThrow(`literal ${field} values (${key})`);
      }
    }
  });

  it.each(['#access_token=', '#?password=', '#/callback?private_key='])('refuses fragment assignments %s without echoing values', fragment => {
    const server = { name: 'fragment', url: `https://example.test/mcp${fragment}${secret}` };
    for (const policy of ['references', 'none'] as const) {
      expect(credentialPolicyViolations(server, policy)).toEqual(['url fragment credentials']);
      expect(() => assertCredentialPolicy([server], policy)).toThrow(/fragment credentials/);
    }
    expect(() => assertProjectCredentials([server], join(project, '.mcp.json'))).toThrow(/URL fragment credentials/);
    try { assertProjectCredentials([server], join(project, '.mcp.json')); } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('checks fragment references according to policy and ignores ordinary anchors', () => {
    const reference = { name: 'reference', url: 'https://example.test/#access_token=%24%7BTOKEN%7D' };
    expect(credentialPolicyViolations(reference, 'references')).toEqual([]);
    expect(credentialPolicyViolations(reference, 'none')).toEqual(['url fragment credentials']);
    expect(() => assertProjectCredentials([reference], join(project, '.mcp.json'))).not.toThrow();
    expect(credentialPolicyViolations({ name: 'anchor', url: 'https://example.test/#password-reset' }, 'none')).toEqual([]);
  });

  it.each(['auth', 'oauth'] as const)('checks fragments in all %s URL fields', field => {
    for (const key of ['tokenUrl', 'redirectUri', 'resource']) {
      const server = { name: 'oauth-fragment', [field]: { [key]: `https://example.test/#access_token=${secret}` } };
      expect(credentialPolicyViolations(server, 'references')).toContain(`${field}.${key} fragment credentials`);
      expect(() => assertProjectCredentials([server], join(project, '.mcp.json'))).toThrow(`literal ${field} values (${key})`);
    }
  });
});

describe.each([
  { implementation: 'TypeScript', Registry: McpServerRegistry, inject: injectServers },
  { implementation: 'runtime', Registry: RuntimeRegistry, inject: runtimeInjectServers },
])('$implementation injection', ({ Registry, inject }) => {
  it.each([
    { auth: { type: 'oauth' as const, tokenUrl: `https://example.test/?token=${secret}` } },
    { auth: { type: 'oauth' as const, resource: `https://example.test/?private_key=${secret}` } },
    { oauth: { redirectUri: `https://example.test/?clientsecret=${secret}` } },
  ])('refuses OAuth URL credentials before changing the OMP project config: %j', async fields => {
    const registry = new Registry(config);
    await registry.add({ name: 'query', type: 'http', url: 'https://example.test/mcp', ...fields });
    await expect(inject(registry as never, 'omp', { projectDir: project })).rejects.toThrow(/literal (auth|oauth) values/);
    expect(await readdir(project)).toEqual([]);
  });

  it('refuses fragment credentials before changing a project config', async () => {
    const registry = new Registry(config);
    await registry.add({ name: 'fragment', type: 'http', url: `https://example.test/#access_token=${secret}` });
    await expect(inject(registry as never, 'claude-code', { projectDir: project })).rejects.toThrow(/fragment credentials/);
    expect(await readdir(project)).toEqual([]);
  });

  it.each(['token', 'token[]', 'auth[token]'])('refuses %s before changing a shared project config', async key => {
    const registry = new Registry(config);
    await registry.add({ name: 'query', type: 'http', url: `https://example.test/mcp?${key}=${secret}` });
    const file = join(project, '.mcp.json');
    const original = '{"mcpServers":{"existing":{"command":"keep"}}}';
    await writeFile(file, original);
    await expect(inject(registry as never, 'claude-code', { projectDir: project })).rejects.toThrow(/URL query credentials/);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await readdir(project)).toEqual(['.mcp.json']);
  });

  it.each([
    { key: 'token', credentialPolicy: 'references' },
    { key: 'token', credentialPolicy: 'none' },
    { key: 'token[]', credentialPolicy: 'references' },
    { key: 'token[]', credentialPolicy: 'none' },
    { key: 'auth[token]', credentialPolicy: 'references' },
    { key: 'auth[token]', credentialPolicy: 'none' },
  ] as const)('refuses $key under $credentialPolicy for a private destination', async ({ key, credentialPolicy }) => {
    const registry = new Registry(config);
    await registry.add({ name: 'query', type: 'http', url: `https://example.test/mcp?${key}=${secret}` });
    await expect(inject(registry as never, 'claude-code', { projectDir: project, scope: 'user', credentialPolicy }))
      .rejects.toThrow(/query credentials/);
    expect(await readdir(home)).toEqual([]);
  });
});

it('profile show redacts split/equal credential args, URL userinfo and query values', async () => {
  await writeFile(join(config, 'mcp-servers.json'), JSON.stringify({ servers: {
    local: { name: 'local', type: 'stdio', command: 'helper', args: ['--token', 'SYNTHETIC-ARGV-TOKEN', '--api-key=SYNTHETIC-ARGV-KEY', '--verbose', '--secret-file', '/tmp/secret-file'] },
    remote: { name: 'remote', type: 'http', url: 'https://SYNTHETIC-USER:SYNTHETIC-PASSWORD@example.test/mcp?token=SYNTHETIC-QUERY-TOKEN&view=full' },
  } }));
  await writeFile(join(config, 'mcp-profiles.json'), JSON.stringify({ profiles: {
    demo: { name: 'demo', servers: ['local', 'remote'] },
  } }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await main(['profile', 'show', 'demo']);
  const output = log.mock.calls.map(args => args.join(' ')).join('\n');
  expect(output).not.toContain('SYNTHETIC-');
  expect(output).toContain('--token *** --api-key=*** --verbose --secret-file /tmp/secret-file');
  expect(output).toContain('token=***&view=***');
});

it.each(['--strict-credentials', '--no-credentials'])('CLI injection %s refuses query credentials without logging them or creating project files', async flag => {
  await writeFile(join(config, 'mcp-servers.json'), JSON.stringify({ servers: {
    query: { name: 'query', type: 'http', url: `https://example.test/mcp?token=${secret}` },
  } }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(main(['inject', '--provider', 'claude-code', '--project', project, flag]))
    .rejects.toThrow(/query credentials/);
  expect([...log.mock.calls, ...errorLog.mock.calls].flat().join(' ')).not.toContain(secret);
  expect(await readdir(project)).toEqual([]);
});
