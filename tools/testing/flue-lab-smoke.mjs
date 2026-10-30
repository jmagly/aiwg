#!/usr/bin/env node
// Load the generated tools with real Flue dependencies in an isolated, offline lab copy.
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const labFlag = process.argv.indexOf('--lab');
if (labFlag < 0 || !process.argv[labFlag + 1]) {
  throw new Error('Usage: TMPDIR=/var/tmp node tools/testing/flue-lab-smoke.mjs --lab <read-only Flue 2.3.0 project>');
}
const lab = path.resolve(process.argv[labFlag + 1]);
const root = await mkdtemp(path.join(tmpdir(), 'aiwg-flue-smoke-'));
try {
  const runtime = JSON.parse(await readFile(path.join(lab, 'node_modules/@flue/runtime/package.json'), 'utf8'));
  if (runtime.version !== '2.3.0') throw new Error(`Expected Flue 2.3.0, got ${runtime.version}`);
  // An explicit allowlist avoids reading .env, credentials, conversations or lab state.
  for (const file of ['package.json', 'package-lock.json', 'node_modules']) {
    await cp(path.join(lab, file), path.join(root, file), { recursive: true });
  }
  await mkdir(path.join(root, 'src/aiwg'), { recursive: true });
  await cp(path.join(repo, 'agentic/code/providers/flue/templates/aiwg/tools.ts'), path.join(root, 'src/aiwg/tools.ts'));
  const fixture = pathToFileURL(path.join(repo, 'test/fixtures/providers/flue/project.mjs')).href;
  const parity = pathToFileURL(path.join(repo, 'test/fixtures/providers/flue/schema-parity.mjs')).href;
  const runner = `
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMcpConnection } from '@flue/runtime';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';
import { createAiwgTools, AIWG_TOOL_NAMES } from './src/aiwg/tools.ts';
import { prepareProject } from ${JSON.stringify(fixture)};
import { assertSchemaParity } from ${JSON.stringify(parity)};
globalThis.fetch = () => { throw new Error('Network forbidden'); };
let passed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (error) { console.error('FAIL ' + name); throw error; }
}
const fixture = await prepareProject(import.meta.dirname);
const tools = createAiwgTools(fixture.options);
async function call(name, input) {
  const tool = tools[name];
  const data = v.parse(tool.input, input);
  return JSON.parse((await tool.run({ data, signal: new AbortController().signal })).output);
}
await check('template typechecks with the real app graph', () => {
  execFileSync(process.execPath, [${JSON.stringify(path.join(repo, 'node_modules/typescript/bin/tsc'))},
    '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'src/aiwg/tools.ts'],
    { cwd: import.meta.dirname, timeout: 30_000, stdio: 'inherit' });
});
await check('real Flue definitions load exactly three tools', () => {
  assert.deepEqual(Object.keys(tools), AIWG_TOOL_NAMES);
  for (const name of AIWG_TOOL_NAMES) assert.equal(tools[name].name, name);
});
await check('trusted-code custom/stdio transport falls through to HTTP', async () => {
  for (const transport of ['stdio', { start() { throw new Error('custom start called'); } }]) {
    let requests = 0;
    await assert.rejects(createMcpConnection({ name: 'spike', url: 'http://invalid.local/mcp', transport,
      fetch() { requests++; throw new Error('HTTP transport reached; no request sent'); },
    }), /HTTP transport reached/);
    assert.ok(requests > 0);
  }
});
await check('real Valibot/MCP schema parity over SDK 2 stdio', async () => {
  const client = new Client({ name: 'flue-parity-smoke', version: '1' });
  try {
    await client.connect(new StdioClientTransport(fixture.options));
    const listing = (await client.listTools()).tools;
    assertSchemaParity(Object.fromEntries(Object.entries(tools).map(([name, tool]) => [name, toJsonSchema(tool.input)])), listing);
  } finally { await client.close(); }
});
await check('discover returns matches', async () => {
  assert.equal((await call('aiwg_discover', { query: 'fixture', type: 'skill' })).matches[0].name, 'fixture-skill');
});
await check('show returns a card and governing rule bodies', async () => {
  const card = await call('aiwg_show', { type: 'skill', name: 'fixture-skill' });
  assert.equal(card.name, 'fixture-skill');
  assert.equal(card.governingRules[0].body, 'Keep artifacts contained.');
});
await check('show preserves the section drill-in', async () => {
  const card = await call('aiwg_show', { type: 'agent', name: 'fixture-agent', section: 'Procedure' });
  assert.equal(card.section, 'Procedure');
});
await check('artifact write uses the configured external root', async () => {
  const result = await call('aiwg_artifact_write', { path: 'smoke/result.md', content: 'contained' });
  assert.equal(result.status, 'success');
  assert.equal(await readFile(path.join(fixture.artifacts, 'smoke/result.md'), 'utf8'), 'contained');
  await assert.rejects(access(path.join(fixture.project, '.aiwg')), { code: 'ENOENT' });
});
await check('artifact write rejects traversal and absolute paths', async () => {
  for (const target of ['../escaped.md', path.join(import.meta.dirname, 'escaped.md'), '..\\\\escaped.md']) {
    await assert.rejects(call('aiwg_artifact_write', { path: target, content: 'escape' }), /Error writing artifact/);
  }
  await assert.rejects(access(path.join(import.meta.dirname, 'escaped.md')), { code: 'ENOENT' });
});
await check('MCP failure surfaces as a Flue tool error', async () => {
  await assert.rejects(call('aiwg_discover', { query: 'server-failure' }), /Synthetic discovery failure/);
});
await check('real Valibot rejects invalid tool data', () => {
  assert.throws(() => v.parse(tools.aiwg_discover.input, { query: 1 }));
  assert.throws(() => v.parse(tools.aiwg_show.input, { type: 'unknown', name: 'x' }));
});
await check('tool data cannot select another artifact project', async () => {
  await assert.rejects(call('aiwg_artifact_write', { path: 'fixed.md', content: 'fixed', project_dir: '/' }));
});
console.log('Flue 2.3.0 lab-copy smoke: ' + passed + ' passed, 0 failed (no model, no network).');
`;
  await writeFile(path.join(root, 'smoke.mjs'), runner);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['smoke.mjs'], {
      cwd: root, stdio: 'inherit',
      // Importing the app does not need any model environment settings.
      env: { PATH: path.dirname(process.execPath), HOME: path.join(root, 'home'), TMPDIR: root },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => signal ? reject(new Error(`Smoke killed by ${signal}`)) : resolve(code));
  });
  if (code !== 0) throw new Error(`Lab-copy smoke exited ${code}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
