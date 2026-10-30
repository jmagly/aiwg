// Exercise the generated tool callbacks against a real, fixture-backed AIWG MCP child.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prepareProject } from '../../fixtures/providers/flue/project.mjs';
import { assertSchemaParity } from '../../fixtures/providers/flue/schema-parity.mjs';

let root: string;
let fixture: Awaited<ReturnType<typeof prepareProject>>;
let module: any;
let tools: any;
let listing: any[];
const fixtures = path.resolve('test/fixtures/providers/flue');

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aiwg-flue-tools-'));
  fixture = await prepareProject(root);
  let source = await readFile('agentic/code/providers/flue/templates/aiwg/tools.ts', 'utf8');
  // Framework builders are unit doubles; no optional Flue packages are required
  // in AIWG itself. The separate smoke runs these same wrappers with SDK 2/Flue/Valibot.
  for (const [specifier, target] of Object.entries({
    '@flue/runtime': path.join(fixtures, 'runtime-double.mjs'),
    valibot: path.join(fixtures, 'valibot-double.mjs'),
    '@modelcontextprotocol/client': path.join(fixtures, 'client-double.mjs'),
    '@modelcontextprotocol/client/stdio': import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js'),
  })) {
    source = source.replace(`'${specifier}'`, JSON.stringify(target.startsWith('file:') ? target : pathToFileURL(target).href));
  }
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const generated = path.join(root, 'tools.mjs');
  await writeFile(generated, compiled.outputText);
  module = await import(pathToFileURL(generated).href);
  tools = module.createAiwgTools(fixture.options);
  const client = new Client({ name: 'flue-schema-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport(fixture.options));
    listing = (await client.listTools()).tools;
  } finally { await client.close(); }
});

afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function invoke(name: string, data: unknown, signal?: AbortSignal) {
  const tool = tools[name];
  const validate = new Ajv().compile(tool.input.jsonSchema);
  if (!validate(data)) throw new Error('Invalid tool input');
  const result = await tool.run({ data, signal });
  return JSON.parse(result.output);
}

describe('generated Flue AIWG tools', () => {
  it('exports exactly the three promised tool definitions and reusable names', () => {
    expect(Object.keys(tools)).toEqual(module.AIWG_TOOL_NAMES);
    for (const name of module.AIWG_TOOL_NAMES) expect(module[name].name).toBe(name);
  });
  it('mirrors the authoritative MCP input schema projections', () => {
    assertSchemaParity(Object.fromEntries(Object.entries(tools).map(([name, tool]: [string, any]) => [name, tool.input.jsonSchema])), listing);
  });
  it('detects MCP schema drift in types, required fields and extra-property policy', () => {
    const inputs = Object.fromEntries(Object.entries(tools).map(([name, tool]: [string, any]) => [name, tool.input.jsonSchema]));
    for (const mutate of [
      (schema: any) => { schema.properties.phrase.type = 'number'; },
      (schema: any) => { schema.required = []; },
      (schema: any) => { schema.additionalProperties = true; },
    ]) {
      const changed = structuredClone(listing);
      mutate(changed.find(tool => tool.name === 'discover').inputSchema);
      expect(() => assertSchemaParity(inputs, changed)).toThrow();
    }
  });
  it('finds matches with an optional type filter', async () => {
    expect((await invoke('aiwg_discover', { query: 'fixture' })).matches[0].name).toBe('fixture-skill');
    expect((await invoke('aiwg_discover', { query: 'find rules', type: 'rule' })).matches[0]).toMatchObject({ type: 'rule', summary: 'find rules' });
  });
  it.each(['skill', 'agent', 'command', 'rule'])('shows a %s card and full governing rules', async type => {
    const card = await invoke('aiwg_show', { type, name: 'fixture-skill' });
    expect(card).toMatchObject({ type, name: 'fixture-skill', governingRules: [{ body: 'Keep artifacts contained.' }] });
  });
  it('maps a section into the MCP repeatable heading drill-in', async () => {
    expect(await invoke('aiwg_show', { type: 'skill', name: 'fixture-skill', section: 'Procedure' })).toMatchObject({ section: 'Procedure' });
  });
  it('writes only through artifact-write to the configured external root', async () => {
    expect(await invoke('aiwg_artifact_write', { path: 'nested/result.md', content: 'contained' })).toMatchObject({ status: 'success' });
    expect(await readFile(path.join(fixture.artifacts, 'nested/result.md'), 'utf8')).toBe('contained');
    await expect(access(path.join(fixture.project, '.aiwg'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['../escaped.md', '/tmp/escaped.md', '..\\escaped.md'])('refuses an outside path: %s', async file => {
    await expect(invoke('aiwg_artifact_write', { path: file, content: 'escape' })).rejects.toThrow(/Error writing artifact/);
    await expect(access(path.join(root, 'escaped.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses an escaping artifact symlink', async () => {
    const outside = path.join(root, 'outside.md');
    await writeFile(outside, 'original');
    await symlink(outside, path.join(fixture.artifacts, 'link.md'));
    await expect(invoke('aiwg_artifact_write', { path: 'link.md', content: 'escape' })).rejects.toThrow(/Error writing artifact/);
    expect(await readFile(outside, 'utf8')).toBe('original');
  });
  it('surfaces an MCP server failure as a tool error', async () => {
    await expect(invoke('aiwg_discover', { query: 'server-failure' })).rejects.toThrow(/Synthetic discovery failure/);
  });
  it('surfaces a child startup failure', async () => {
    const failed = module.createAiwgTools({ ...fixture.options, command: path.join(root, 'missing-executable') });
    await expect(failed.aiwg_discover.run({ data: { query: 'fixture' } })).rejects.toThrow(/ENOENT/);
  });
  it('rejects cancellation before creating a child', async () => {
    await expect(invoke('aiwg_discover', { query: 'fixture' }, AbortSignal.abort())).rejects.toThrow();
  });
  it.each([
    ['aiwg_discover', { query: 1 }], ['aiwg_discover', { query: 'x', type: 'invalid' }],
    ['aiwg_show', { type: 'skill', name: 'x', section: [] }],
    ['aiwg_artifact_write', { path: 'x', content: 'x', project_dir: '/' }],
  ])('rejects invalid exchanged inputs for %s', async (name, input) => {
    await expect(invoke(name as string, input)).rejects.toThrow(/Invalid tool input/);
  });
});
