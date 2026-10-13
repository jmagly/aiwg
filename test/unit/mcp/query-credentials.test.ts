import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../../src/mcp/cli.mjs';
import { assertProjectCredentials } from '../../../src/mcp/config-file.mjs';
import { assertCredentialPolicy, credentialLikeQueryParams, credentialLikeArgs, redactCredentialArgs, redactCredentialText, redactCredentialRecord, urlCarriesUserinfo, credentialPolicyViolations } from '../../../src/mcp/credentials.mjs';
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
  it.each(['options[api_key][service_name]', 'credentials.token.name'])('refuses and redacts credential ancestors in %s', key => {
    const url = `https://host/?${key}=${secret}`;
    const server = { name: 'nested', url };
    expect(credentialLikeQueryParams(url)).toEqual([key]);
    for (const policy of ['references', 'none'] as const) {
      expect(credentialPolicyViolations(server, policy)).toEqual(['url query credentials']);
      expect(() => assertCredentialPolicy([server], policy)).toThrow(/query credentials/);
    }
    expect(() => assertProjectCredentials([server], join(project, '.mcp.json'))).toThrow(/URL query credentials/);
    expect(redactCredentialText(url)).toBe(`https://host/?${key}=***`);
    expect(redactCredentialArgs([url])).toEqual([`https://host/?${key}=***`]);
    expect(redactCredentialRecord(server)).toEqual({ name: 'nested', url: `https://host/?${key}=***` });
  });

  it.each(['private_key', 'signing.key', 'encryption-key', 'privatekey', 'clientsecret', 'secretkey', 'apitoken', 'pwd', 'passcode', 'session_id', 'sessionid', 'API_TOKEN', 'options[privateKey]', 'token', 'token[]', 'auth[token]', 'options[token][]', 'options[key]', 'options[sig]', 'options.key', 'options.sig', 'options.nested.key', 'options.nested.sig', '%74oken%5B%5D', 'options%5Btoken%5D', 'key', 'secret', 'password', 'passwd', 'auth', 'authorization', 'signature', 'sig', 'jwt', 'bearer', 'api_key', 'apikey', 'apiKey', 'access_key', 'accessKey', 'access_token', 'clientSecret', 'X-Amz-Signature', 'X-Amz-Credential', '%74oken'])('refuses %s in project writes and restrictive policies without echoing the secret', key => {
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

  it.each(['#access_token=', '#?password=', '#/callback?private_key=', '#options.key=', '#options.sig='])('refuses fragment assignments %s without echoing values', fragment => {
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
  expect(output).toContain('token=***&view=full');
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

const credentialArgs = [
  ['-H', `Authorization: Bearer ${secret}`],
  ['--header', `Authorization: Bearer ${secret}`],
  [`--header=Authorization: Bearer ${secret}`],
  [`-HAuthorization: Bearer ${secret}`],
  [`API_TOKEN=${secret}`],
  [`https://user:${secret}@example.test/mcp`],
  [`--url=https://user:${secret}@example.test/mcp`],
  [`https:/user:${secret}@example.test/mcp`],
  [`--url=https:/user:${secret}@example.test/mcp`],
  [`https://example.test/#access_token=${secret}`],
  [`https://example.test/#access_token=${secret}?view=full`],
  [`https://example.test/#access_token=?${secret}`],
  [`https://example.test/#access_token=\${TOKEN}?${secret}`],
  [`https://example.test/#access_token=?${secret}?view=full`],
  [`https://example.test/#access_token=\${TOKEN}?${secret}?view=full`],
  [`https://example.test/?options.key=${secret}`],
  [`https://example.test/#options.sig=${secret}`],
];

it.each(['https:/', 'https:', 'https:\\', 'https:///', 'https:/\t', 'https://'])('refuses and redacts parser-recognized userinfo after %s', prefix => {
  const url = `${prefix}user:${secret}@example.test/mcp`;
  expect(new URL(url).password).toBe(secret);
  expect(urlCarriesUserinfo(url)).toBe(true);
  for (const fields of [
    { url },
    ...(['auth', 'oauth'] as const).flatMap(field =>
      ['tokenUrl', 'redirectUri', 'resource'].map(key => ({ [field]: { [key]: url } }))),
  ]) {
    const server = { name: 'userinfo', ...fields };
    for (const policy of ['references', 'none'] as const) {
      expect(credentialPolicyViolations(server, policy).some(field => field.includes('userinfo'))).toBe(true);
      expect(() => assertCredentialPolicy([server], policy)).toThrow(/userinfo/);
    }
    expect(() => assertProjectCredentials([server], join(project, '.mcp.json'))).toThrow();
    try { assertProjectCredentials([server], join(project, '.mcp.json')); } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    expect(JSON.stringify(redactCredentialRecord(server))).not.toContain(secret);
  }
  expect(redactCredentialText(url)).toContain('***@example.test');
  expect(redactCredentialText(url)).not.toContain(secret);
});

it('uses parser-aware userinfo spans even when the password contains whitespace', () => {
  const url = `https:/user:first ${secret}@example.test/mcp`;
  expect(new URL(url).password).toContain(secret);
  expect(urlCarriesUserinfo(url)).toBe(true);
  expect(() => assertProjectCredentials([{ name: 'userinfo', url }], join(project, '.mcp.json'))).toThrow(/userinfo/);
  expect(credentialLikeArgs([`--url=${url}`])).toHaveLength(1);
  expect(redactCredentialText(url)).toBe('https:/***@example.test/mcp');
  expect(redactCredentialArgs([`--url=${url}`])).toEqual(['--url=https:/***@example.test/mcp']);
});

it('retains userinfo refusal and redaction for malformed hosts', () => {
  const url = `https://user:${secret}@bad host/mcp`;
  expect(urlCarriesUserinfo(url)).toBe(true);
  expect(() => assertProjectCredentials([{ name: 'malformed', url }], join(project, '.mcp.json'))).toThrow(/userinfo/);
  expect(redactCredentialText(url)).not.toContain(secret);
});

it.each([
  `?${secret}`, `\${TOKEN}?${secret}`, `?${secret}?view=full`, `\${TOKEN}?${secret}?view=full`,
  `%24%7BTOKEN%7D?${secret}?view=full`,
])('classifies complete fragment assignment values containing question marks: %s', value => {
  for (const route of ['#', '#/callback?']) {
    const url = `https://example.test/${route}access_token=${value}&view=full`;
    const server = { name: 'fragment-value', url };
    for (const policy of ['references', 'none'] as const) {
      expect(credentialPolicyViolations(server, policy)).toEqual(['url fragment credentials']);
      expect(() => assertCredentialPolicy([server], policy)).toThrow(/fragment credentials/);
    }
    expect(() => assertProjectCredentials([server], join(project, '.mcp.json'))).toThrow(/fragment credentials/);
    try { assertProjectCredentials([server], join(project, '.mcp.json')); } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    expect(redactCredentialText(url)).toBe(`https://example.test/${route}access_token=***&view=full`);
    expect(JSON.stringify(redactCredentialRecord(server))).not.toContain(secret);
  }
});

it.each([
  ['TOKEN_FILE=/run/secrets/api-token'],
  ['SECRET_NAME=production-service'],
  ['-H', 'X-Auth-Mode: anonymous'],
  ['https://host/?sort.key=name'],
  ['API_TOKEN_PATH=/run/secrets/token'],
  ['--header=X-Authorization-Type: anonymous'],
  ['https://host/?options.tokenFile=/run/secrets/token'],
  ['https://host/#options.secretName=production-service'],
].map(args => ({ args })))('preserves nonsecret location and mode settings $args in refusal and display', ({ args }) => {
  const server = { name: 'nonsecret', args };
  expect(credentialLikeArgs(args)).toEqual([]);
  expect(redactCredentialArgs(args)).toEqual(args);
  for (const arg of args) expect(redactCredentialText(arg)).toBe(arg);
  expect(redactCredentialRecord(server)).toEqual(server);
  for (const policy of ['references', 'none'] as const) expect(credentialPolicyViolations(server, policy)).toEqual([]);
  expect(() => assertProjectCredentials([server], join(project, '.mcp.json'))).not.toThrow();
});

it('preserves nonsecret URL query values in refusal and display', () => {
  const server = { name: 'sort', url: 'https://host/?sort.key=name&options.tokenFile=/run/secrets/token' };
  expect(credentialLikeQueryParams(server.url)).toEqual([]);
  expect(redactCredentialRecord(server)).toEqual(server);
  expect(() => assertProjectCredentials([server], join(project, '.mcp.json'))).not.toThrow();
});

it.each(credentialArgs.map((args, index) => ({ args, index })))('uses the same refusal and redaction scanner for argv case $index', ({ args }) => {
  const server = { name: 'scanner', command: 'helper', args };
  expect(credentialLikeArgs(args).length).toBeGreaterThan(0);
  expect(redactCredentialArgs(args)?.join(' ')).not.toContain(secret);
  expect(redactCredentialArgs(args)?.join(' ')).toContain('***');
  for (const policy of ['references', 'none'] as const) {
    expect(credentialPolicyViolations(server, policy)).toContain('args');
    expect(() => assertCredentialPolicy([server], policy)).toThrow(/args/);
  }
  try {
    assertProjectCredentials([server], join(project, '.mcp.json'));
    throw new Error('credential accepted');
  } catch (error) {
    expect(String(error)).toContain('credential-like args');
    expect(String(error)).not.toContain(secret);
  }
});

it.each(['#access_token=', '#access_token=', '#options.key=', '#options.sig='].map((fragment, index) => ({ fragment, suffix: index === 1 ? '?view=full' : '' })))('refuses and redacts fragment $fragment$suffix in URL fields', ({ fragment, suffix }) => {
  const url = `https://example.test/${fragment}${secret}${suffix}`;
  const server = { name: 'fragment', url };
  expect(credentialPolicyViolations(server, 'references')).toEqual(['url fragment credentials']);
  expect(() => assertProjectCredentials([server], join(project, '.mcp.json'))).toThrow(/fragment credentials/);
  expect(redactCredentialText(url)).not.toContain(secret);
});

it('preserves supported argv references and noncredential arguments', () => {
  const args = ['-H', 'Authorization: Bearer ${TOKEN}', 'API_TOKEN=${TOKEN}', '--token=${TOKEN}',
    'https://example.test/?options.key=%24%7BTOKEN%7D', 'sort_key=name', '--secret-file', '/tmp/token'];
  expect(credentialLikeArgs(args)).toEqual([]);
  expect(redactCredentialArgs(args)).toEqual(args);
  expect(credentialPolicyViolations({ name: 'refs', args }, 'none')).toContain('args');
});

it.each([false, true])('in-project ephemeral --out refuses credentials before changing any files (dryRun=%s)', async dryRun => {
  const out = join(project, 'nested', 'ephemeral.json');
  await writeFile(join(config, 'mcp-servers.json'), JSON.stringify({ servers: {
    local: { name: 'local', type: 'stdio', command: 'helper', args: ['-H', `Authorization: Bearer ${secret}`] },
  } }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await expect(main(['inject', '--provider', 'claude', '--project', project, '--ephemeral', '--out', out,
    ...(dryRun ? ['--dry-run'] : [])])).rejects.toThrow(/credential-like args/);
  expect(log.mock.calls.flat().join(' ')).not.toContain(secret);
  expect(await readdir(project)).toEqual([]);
});

it('allows explicit external ephemeral destinations under the existing literal policy', async () => {
  const out = join(root, 'ephemeral.json');
  await writeFile(join(config, 'mcp-servers.json'), JSON.stringify({ servers: {
    local: { name: 'local', type: 'stdio', command: 'helper', args: [`API_TOKEN=${secret}`] },
  } }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await main(['inject', '--provider', 'claude', '--project', project, '--ephemeral', '--out', out]);
  expect(JSON.parse(await readFile(out, 'utf8')).mcpServers.local.args).toEqual([`API_TOKEN=${secret}`]);
  expect(await readdir(project)).toEqual([]);
});

it.each(['profile show', 'profile show json', 'profile list', 'list', 'update args', 'update url'])('redacts scanner findings in %s displays', async command => {
  await writeFile(join(config, 'mcp-servers.json'), JSON.stringify({ servers: {
    local: { name: 'local', type: 'stdio', command: 'helper', args: credentialArgs.flat() },
    remote: { name: 'remote', type: 'http', url: `https://example.test/#access_token=${secret}?view=full` },
    userinfo: { name: 'userinfo', type: 'http', url: `https:/user:${secret}@example.test/mcp` },
    emptyPrefix: { name: 'emptyPrefix', type: 'http', url: `https://example.test/#access_token=?${secret}?view=full` },
    referencePrefix: { name: 'referencePrefix', type: 'http', url: `https://example.test/#access_token=\${TOKEN}?${secret}?view=full` },
  } }));
  await writeFile(join(config, 'mcp-profiles.json'), JSON.stringify({ profiles: {
    demo: { name: 'demo', servers: ['local', 'remote', 'userinfo', 'emptyPrefix', 'referencePrefix'], description: `https:/user:${secret}@example.test/mcp`,
      metadata: { args: credentialArgs.flat(), env: { API_TOKEN: secret }, headers: { Authorization: secret } } },
  } }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const args = command === 'profile show json' ? ['profile', 'show', 'demo', '--json']
    : command === 'profile show' ? ['profile', 'show', 'demo']
    : command === 'profile list' ? ['profile', 'list']
    : command === 'update args' ? ['update', 'local', '--args', credentialArgs.flat().join(',')]
    : command === 'update url' ? ['update', 'remote', '--url', `https://example.test/#access_token=${secret}?view=full`]
    : ['list'];
  await main(args);
  const output = log.mock.calls.map(call => call.join(' ')).join('\n');
  expect(output).not.toContain(secret);
  expect(output).toContain('***');
  if (command === 'profile show json') {
    const displayed = JSON.parse(output);
    expect(displayed.name).toBe('demo');
    expect(displayed.metadata.env.API_TOKEN).toBe('***');
    expect(displayed.metadata.headers.Authorization).toBe('***');
    expect(displayed.metadata.args).toEqual(redactCredentialArgs(credentialArgs.flat()));
  }
});

it.skipIf(process.platform === 'win32')('classifies ephemeral --out against the real project directory through a project alias', async () => {
  const alias = join(root, 'project-alias');
  await symlink(project, alias, 'dir');
  await writeFile(join(config, 'mcp-servers.json'), JSON.stringify({ servers: {
    local: { name: 'local', type: 'stdio', command: 'helper', env: { API_TOKEN: secret } },
  } }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await expect(main(['inject', '--provider', 'claude', '--project', alias, '--ephemeral', '--out', join(project, 'out.json')]))
    .rejects.toThrow(/literal env values/);
  expect(await readdir(project)).toEqual([]);
});

it('redacts complete credential values that contain a question mark', () => {
  for (const separator of ['?', '#']) {
    const url = `https://example.test/${separator}access_token=first?${secret}`;
    expect(redactCredentialText(url)).not.toContain(secret);
    expect(redactCredentialArgs([url])?.[0]).not.toContain(secret);
  }
});
