import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readdir as outerReaddir, readFile as outerReadFile, writeFile as outerWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as outerJoin } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const smokeUrl = pathToFileURL(outerJoin(root, 'apps/cockpit/bridge/src/smoke.mjs')).href;
const bridgeUrl = pathToFileURL(outerJoin(root, 'apps/cockpit/bridge/src/server.mjs')).href;

function permissionFlagFromHelp(help) {
  const advertised = new Set();
  // Node22 prints aliases together: --experimental-permission, --permission.
  for (const line of help.split('\n')) {
    const header = line.match(/^[\t ]+(--[a-z0-9-]+(?:=[^\s,]+)?(?:,[\t ]+--[a-z0-9-]+(?:=[^\s,]+)?)*)/);
    if (header) for (const option of header[1].matchAll(/--[a-z0-9-]+/g)) advertised.add(option[0]);
  }
  if (!advertised.has('--allow-fs-read') || !advertised.has('--allow-fs-write')) {
    throw new Error('Cockpit isolation requires advertised filesystem permission flags; refusing unprotected execution');
  }
  if (advertised.has('--permission')) return '--permission';
  if (advertised.has('--experimental-permission')) return '--experimental-permission';
  throw new Error('Cockpit isolation requires an advertised permission mode; refusing unprotected execution');
}

let runtimePermissionFlag;
function getRuntimePermissionFlag() {
  if (runtimePermissionFlag) return runtimePermissionFlag;
  const help = spawnSync(process.execPath, ['--help'], {
    env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
    encoding: 'utf8', timeout: 5_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (help.error || help.signal || help.status !== 0) {
    throw new Error(`Cannot inspect Node permission support (${process.version}): ${help.error?.message ?? help.signal ?? help.status}; refusing unprotected execution`);
  }
  runtimePermissionFlag = permissionFlagFromHelp(help.stdout);
  return runtimePermissionFlag;
}
// Outer imports use distinct aliases: Vitest must not rewrite names serialized in child recipes.
// Each scenario gets fresh mock module state and a Node-enforced write boundary (defense in depth, not an OS sandbox).
// Permission-denied/setup failures are failures, never successful negative controls.
async function scenario(body, extraEnv = {}) {
  const temporaryParent = await mkdtemp(outerJoin(tmpdir(), 'aiwg-smoke-regression-'));
  try {
    const childEnv = { ...extraEnv };
    const canaryPaths = [];
    for (const [key, name] of [['AIWG_COCKPIT_EXECUTOR_TOKEN_FILE', 'executor-canary'], ['AIWG_COCKPIT_MCP_TOKEN_FILE', 'mcp-canary']]) {
      if (childEnv[key] === '__OWNED_CANARY__') {
        const canary = outerJoin(temporaryParent, name);
        await outerWriteFile(canary, 'owned-smoke-credential-sentinel', { mode: 0o600 });
        childEnv[key] = canary;
        canaryPaths.push(canary);
      }
    }
    const expectedEntries = canaryPaths.map((p) => p.slice(temporaryParent.length + 1)).sort();
    const code = `
      import assert from 'node:assert/strict';
      import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
      import { existsSync } from 'node:fs';
      import { join, parse, dirname } from 'node:path';
      import { once } from 'node:events';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const temporaryParent = process.argv[1];
      const canonicalSkillPath = ${JSON.stringify(outerJoin(root, 'agentic/code/frameworks/sdlc-complete/skills/flow-deploy-to-production/SKILL.md'))};
      const canaryPaths = ${JSON.stringify(canaryPaths)};
      const credentialAccessAttempts = [];
      // Install observation before dynamic target imports bind builtin exports.
      for (const operation of ['stat', 'readFile']) {
        const original = fs.promises[operation];
        fs.promises[operation] = function (target, ...args) {
          if (canaryPaths.includes(String(target))) credentialAccessAttempts.push({ operation, target: String(target) });
          return original.call(this, target, ...args);
        };
      }
      syncBuiltinESMExports();
      const { createBridge } = await import(${JSON.stringify(bridgeUrl)});
      const { withSmokeFixture, exerciseLibraryRoundTrip, createSmokeCliFixture, runBridgeSmoke } = await import(${JSON.stringify(smokeUrl)});
      const fixture = (fn) => withSmokeFixture(fn, { temporaryParent });
      const clone = (f, name, sourcePath) => f('/api/library/clone?' + new URLSearchParams({ type: 'skill', name, path: sourcePath }), { method: 'POST' });
      await (${body.toString()})();
      assert.deepEqual(credentialAccessAttempts, [], 'explicit empty credential options perform no canary stat/read');
      assert.deepEqual((await readdir(temporaryParent)).sort(), ${JSON.stringify(expectedEntries)}, 'only parent-owned canaries remain');
      console.log('SCENARIO PASS');
    `;
    const child = spawnSync(process.execPath, [
      getRuntimePermissionFlag(),
      `--allow-fs-read=${outerJoin(root, 'apps/cockpit')}`,
      `--allow-fs-read=${outerJoin(root, 'agentic/code')}`,
      `--allow-fs-read=${outerJoin(root, 'package.json')}`,
      `--allow-fs-read=${temporaryParent}`,
      `--allow-fs-write=${temporaryParent}`,
      '--input-type=module', '-e', code, temporaryParent,
    ], {
      cwd: temporaryParent,
      // No HOME override and no inherited NODE_OPTIONS, credential or provider hooks.
      // Isolation is enforced by --permission, not by these deterministic defaults.
      env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...childEnv },
      encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    });
    // The outer runner's retained stdout is a raw receipt for every real child.
    console.log(JSON.stringify({ event: 'cockpit-smoke-child', status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr, error: child.error?.message ?? null }));
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.signal, child.stderr).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout, child.stderr).toContain('SCENARIO PASS');
    expect((await outerReaddir(temporaryParent)).sort()).toEqual(expectedEntries);
    for (const canary of canaryPaths) expect(await outerReadFile(canary, 'utf8')).toBe('owned-smoke-credential-sentinel');
    return child.stdout;
  } finally {
    await rm(temporaryParent, { recursive: true, force: true });
  }
}

describe('Cockpit smoke isolation and ownership', () => {
  it('selects advertised permission flags and fails closed on incomplete help', () => {
    const filesystem = '  --allow-fs-read=...  Allow read\n  --allow-fs-write=...  Allow write\n';
    expect(permissionFlagFromHelp(filesystem + '  --permission  Enable permissions\n')).toBe('--permission');
    expect(permissionFlagFromHelp(filesystem + '  --experimental-permission  Enable permissions\n')).toBe('--experimental-permission');
    expect(permissionFlagFromHelp(filesystem + '  --experimental-permission  Alias\n  --permission  Stable\n')).toBe('--permission');
    expect(permissionFlagFromHelp(filesystem + '  --experimental-permission, --permission\n      Enable permission model\n')).toBe('--permission');
    expect(() => permissionFlagFromHelp(filesystem)).toThrow(/refusing unprotected execution/);
    expect(() => permissionFlagFromHelp('  --permission  Enable permissions\n')).toThrow(/filesystem permission flags/);
    expect(() => permissionFlagFromHelp(filesystem + '  Documentation mentions --permission but does not advertise it\n')).toThrow(/permission mode/);
  });
  it('keeps library and audit state separate across concurrent bridge instances', async () => {
    await scenario(async () => {
      await fixture(async (a) => fixture(async (b) => {
        const responses = await Promise.all([clone(a.f, 'same-name', a.skillPath), clone(b.f, 'same-name', b.skillPath)]);
        assert.deepEqual(responses.map((r) => r.status), [201, 201]);
        await writeFile(join(a.libraryDir, 'same-name', 'sentinel.txt'), 'A-owned-by-first');
        await writeFile(join(b.libraryDir, 'same-name', 'sentinel.txt'), 'B-owned-by-second');
        await Promise.all([a, b].map((x, i) => x.f('/api/audit/intent', { method: 'POST', body: JSON.stringify({ event: i === 0 ? 'first-only' : 'second-only' }) })));
        assert.equal(await readFile(join(a.libraryDir, 'same-name', 'sentinel.txt'), 'utf8'), 'A-owned-by-first');
        assert.equal(await readFile(join(b.libraryDir, 'same-name', 'sentinel.txt'), 'utf8'), 'B-owned-by-second');
        assert.deepEqual((await (await a.f('/api/audit')).json()).audit.map((x) => x.event), ['first-only']);
        assert.deepEqual((await (await b.f('/api/audit')).json()).audit.map((x) => x.event), ['second-only']);
        assert.equal((await a.f('/api/library/same-name', { method: 'DELETE' })).status, 200);
        assert.equal(await readFile(join(b.libraryDir, 'same-name', 'sentinel.txt'), 'utf8'), 'B-owned-by-second');
      }));
    });
  });

  it('rejects invalid supplied isolation options without home fallback', async () => {
    await scenario(async () => {
      const invalid = [
        { libraryDir: '' }, { libraryDir: null }, { libraryDir: 'relative' }, { libraryDir: parse(temporaryParent).root },
        { auditDir: '' }, { auditDir: null }, { auditDir: 'relative' },
        { corpusRoots: [] }, { corpusRoots: ['relative'] }, { corpusRoots: null },
        { contributionDirs: [] }, { contributionDirs: ['relative'] },
        { localDockerFallback: 'false' }, { localLibvirtFallback: 0 }, { mcpTokenFile: null }, { aiwgCommand: null },
      ];
      for (const options of invalid) assert.throws(() => createBridge(options), TypeError, JSON.stringify(options));
    });
  });

  it('copies caller path arrays so later mutation cannot reroute a bridge', async () => {
    await scenario(async () => {
      await fixture(async (a) => {
        const corpusRoots = [a.fixtureRoot], contributionDirs = [a.auditDir];
        const server = createBridge({ executorUrl: a.executorUrl, allowMockExecutor: true, requireSandboxMtls: false, a2aProtocolPolicy: '0.3', allowA2AProtocolFallback: false, localDockerFallback: false, localLibvirtFallback: false, libraryDir: a.libraryDir, auditDir: a.auditDir, corpusRoots, contributionDirs, executorTokenFile: '', mcpTokenFile: '', aiwgCommand: async () => { throw new Error('no command expected'); } });
        await writeFile(join(a.fixtureRoot, 'allowed.md'), 'first-root-body');
        await writeFile(join(a.auditDir, 'manifest.json'), JSON.stringify({ id: 'original-contribution', version: '1.0.0', contributes: {} }));
        await writeFile(join(a.libraryDir, 'manifest.json'), JSON.stringify({ id: 'rerouted-contribution', version: '1.0.0', contributes: {} }));
        corpusRoots[0] = a.auditDir;
        contributionDirs[0] = a.libraryDir;
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        try {
          const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/show?path=' + encodeURIComponent(join(a.fixtureRoot, 'allowed.md')), { headers: { authorization: 'Bearer ' + server.cockpitToken } });
          const shown = await response.json();
          assert.equal(response.status, 200, JSON.stringify(shown));
          assert.equal(shown.body, 'first-root-body');
          const contributions = await fetch('http://127.0.0.1:' + server.address().port + '/api/contributions', { headers: { authorization: 'Bearer ' + server.cockpitToken } });
          const contributionBody = await contributions.json();
          assert.equal(contributions.status, 200, JSON.stringify(contributionBody));
          assert.deepEqual(contributionBody.sources.map((x) => x.id), ['original-contribution']);
        } finally { await new Promise((r, j) => server.close((e) => e ? j(e) : r())); }
      });
    });
  });

  it('preserves a pre-existing asset when the actual smoke clone helper conflicts', async () => {
    await scenario(async () => {
      await fixture(async (a) => {
        await mkdir(join(a.libraryDir, 'preexisting'));
        await writeFile(join(a.libraryDir, 'preexisting', 'sentinel.txt'), 'operator-sentinel-independent-bytes');
        const requests = [];
        const f = (p, options) => { requests.push([p, options?.method ?? 'GET']); return a.f(p, options); };
        await assert.rejects(exerciseLibraryRoundTrip({ f, sourcePath: a.skillPath, name: 'preexisting' }), /clone returns 201/);
        assert.equal(requests.filter((x) => x[1] === 'DELETE').length, 0, 'conflict never confers ownership');
        assert.equal(await readFile(join(a.libraryDir, 'preexisting', 'sentinel.txt'), 'utf8'), 'operator-sentinel-independent-bytes');
        assert.deepEqual(await readdir(join(a.libraryDir, 'preexisting')), ['sentinel.txt']);
      });
    });
  });

  it('creates lists and deletes only a fresh smoke-owned asset', async () => {
    await scenario(async () => {
      await fixture(async (a) => {
        await writeFile(join(a.libraryDir, 'sibling.md'), 'sibling-preserve');
        assert.equal(await readFile(a.skillPath, 'utf8'), await readFile(canonicalSkillPath, 'utf8'), 'owned source matches independently located canonical bytes');
        const nestedSource = join(dirname(a.skillPath), 'nested');
        await mkdir(nestedSource);
        await writeFile(join(nestedSource, 'marker.txt'), 'independent-recursive-copy-marker');
        await exerciseLibraryRoundTrip({ f: a.f, sourcePath: a.skillPath, name: 'fresh-owned', afterCreate: async () => {
          assert.equal(await readFile(join(a.libraryDir, 'fresh-owned', 'SKILL.md'), 'utf8'), await readFile(canonicalSkillPath, 'utf8'));
          assert.equal(await readFile(join(a.libraryDir, 'fresh-owned', 'nested', 'marker.txt'), 'utf8'), 'independent-recursive-copy-marker');
          assert.equal(JSON.parse(await readFile(join(a.libraryDir, 'fresh-owned', '.cockpit-origin.json'), 'utf8')).source_path, a.skillPath);
        } });
        assert.equal(existsSync(join(a.libraryDir, 'fresh-owned')), false);
        assert.equal(await readFile(join(a.libraryDir, 'sibling.md'), 'utf8'), 'sibling-preserve');
      });
    });
  });

  it('cleans owned roots and listeners when failure occurs before clone', async () => {
    await scenario(async () => {
      let observed;
      await assert.rejects(fixture(async (a) => { observed = a; throw new Error('deliberate-before-clone'); }), /deliberate-before-clone/);
      assert.equal(existsSync(observed.fixtureRoot), false);
      assert.equal(observed.mock.listening, false);
      assert.equal(observed.bridge.listening, false);
      await assert.rejects(fetch(observed.base + '/healthz'));
    });
  });

  it('cleans endpoint-owned assets after failure following clone', async () => {
    await scenario(async () => {
      let observed;
      await assert.rejects(fixture(async (a) => {
        observed = a;
        await assert.rejects(exerciseLibraryRoundTrip({ f: a.f, sourcePath: a.skillPath, name: 'failure-owned', afterCreate: async () => { throw new Error('deliberate-after-clone'); } }), /deliberate-after-clone/);
        assert.equal(existsSync(join(a.libraryDir, 'failure-owned')), false, 'endpoint cleanup happens before outer root cleanup');
        throw new Error('propagate-after-clone');
      }), /propagate-after-clone/);
      assert.equal(existsSync(observed.fixtureRoot), false);
      assert.equal(observed.mock.listening, false);
      assert.equal(observed.bridge.listening, false);
    });
  });

  it('retains cleanup ownership when a 201 response has malformed JSON', async () => {
    await scenario(async () => {
      await fixture(async (a) => {
        const f = async (p, options) => {
          const response = await a.f(p, options);
          return p.startsWith('/api/library/clone?') && response.status === 201
            ? { status: 201, json: async () => { throw new Error('malformed-clone-json'); } } : response;
        };
        await assert.rejects(exerciseLibraryRoundTrip({ f, sourcePath: a.skillPath, name: 'malformed-owned' }), /malformed-clone-json/);
        assert.equal(existsSync(join(a.libraryDir, 'malformed-owned')), false);
      });
    });
  });

  it('keeps the original callback failure when server close also fails', async () => {
    await scenario(async () => {
      let observed;
      await assert.rejects(fixture(async (a) => {
        observed = a;
        const realClose = a.bridge.close.bind(a.bridge);
        a.bridge.close = (callback) => realClose(() => callback(new Error('deliberate-close-failure')));
        throw new Error('original-callback-failure');
      }), (error) => {
        assert(error instanceof AggregateError);
        assert.equal(error.cause.message, 'original-callback-failure');
        assert.deepEqual(error.errors.map((x) => x.message), ['original-callback-failure', 'deliberate-close-failure']);
        return true;
      });
      assert.equal(existsSync(observed.fixtureRoot), false);
      assert.equal(observed.mock.listening, false);
      assert.equal(observed.bridge.listening, false);
    });
  });

  it('uses explicit empty credentials and disabled local fallbacks with hostile defaults', async () => {
    await scenario(async () => {
      await fixture(async (a) => {
        assert.equal((await a.f('/api/inventory')).status, 200);
        const mcp = await a.f('/api/mcp', { method: 'POST', body: '{}' });
        assert.equal(mcp.status, 503);
        assert.deepEqual(await mcp.json(), { error: 'mcp_token_file_unconfigured', message: 'Bridge MCP proxy requires AIWG_COCKPIT_MCP_TOKEN_FILE.' });
        const reconnect = await a.f('/api/instances/550e8400-e29b-41d4-a716-446655440000/reconnect', { method: 'POST' });
        assert.equal(reconnect.status, 409);
        assert.equal((await reconnect.json()).error, 'local_docker_fallback_disabled');
        const vmReconnect = await a.f('/api/instances/7c1f0b2a-3d4e-4f5a-9b8c-1d2e3f4a5b6c/reconnect', { method: 'POST' });
        assert.equal(vmReconnect.status, 409);
        assert.equal((await vmReconnect.json()).error, 'local_libvirt_fallback_disabled');
      });
    }, { AIWG_COCKPIT_EXECUTOR_TOKEN_FILE: '__OWNED_CANARY__', AIWG_COCKPIT_MCP_TOKEN_FILE: '__OWNED_CANARY__', AIWG_COCKPIT_LOCAL_DOCKER_FALLBACK: '1', AIWG_COCKPIT_LOCAL_LIBVIRT_FALLBACK: '1', AIWG_COCKPIT_REQUIRE_SANDBOX_MTLS: '1', AIWG_COCKPIT_A2A_PROTOCOL_POLICY: '1.0' });
  });

  it('enforces independent CLI argv expectations and missing-show HTTP mapping', async () => {
    await scenario(async () => {
      await fixture(async (a) => {
        assert.equal((await a.f('/api/capabilities?q=deploy%20production&limit=4')).status, 200);
        assert.equal((await a.f('/api/show?type=skill&name=flow-deploy-to-production')).status, 200);
        assert.equal((await a.f('/api/show?type=agent&name=__definitely_not_a_real_artifact__')).status, 404);
        assert.deepEqual(a.cliCalls, [
          ['discover', 'deploy production', '--json', '--limit', '4'],
          ['show', 'skill', 'flow-deploy-to-production'],
          ['show', 'agent', '__definitely_not_a_real_artifact__'],
        ]);
        const unexpected = await a.f('/api/capabilities?q=unexpected&limit=4');
        assert.equal(unexpected.status, 502);
        assert.equal((await unexpected.json()).message, 'Bridge request failed.');
        await assert.rejects(createSmokeCliFixture()(['mc', 'run', 'forbidden']), /Unexpected smoke CLI command/);
      });
    });
  });

  it('imports smoke without direct bridge startup or generated state', async () => {
    await scenario(async () => {
      assert.deepEqual(await readdir(temporaryParent), []);
      assert.equal(typeof runBridgeSmoke, 'function');
    });
  });

  it('runs the complete isolated smoke in a fresh permission-limited process', async () => {
    const output = await scenario(async () => { await runBridgeSmoke({ temporaryParent }); });
    expect(output).toContain('SMOKE OK');
    expect(output).toContain('CLI contract fixture');
  }, 30_000);
});
