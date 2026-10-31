// Pinned Flue connection and adapter checks; no runtime/model/provider calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { launchHttp } from '../fixtures/mcp/http-service.mjs';

const root = path.resolve(import.meta.dirname, '../..');
let service: Awaited<ReturnType<typeof launchHttp>>;
let connection: any;
afterEach(async () => { await connection?.close(); await service?.close(); });

it('connects Flue 2.3.0, invokes real discovery/show/artifact tools and measures tools-only adaptation', async () => {
  const dependencies = path.resolve(process.env.AIWG_FLUE_DEPENDENCIES || path.join(root, 'examples/flue-node'), 'node_modules');
  const runtime = path.join(dependencies, '@flue/runtime');
  expect(JSON.parse(await fs.readFile(path.join(runtime, 'package.json'), 'utf8')).version).toBe('2.3.0');
  const { createMcpConnection } = await import(pathToFileURL(path.join(runtime, 'dist/index.mjs')).href);
  // Flue's public tool.run deliberately throws; the runtime executes a prepared
  // adapter. Inspect that pinned adapter directly to avoid a model or database.
  const resultModule = (await fs.readdir(path.join(runtime, 'dist'))).find(name => /^result-.*\.mjs$/.test(name))!;
  const resultPath = path.join(runtime, 'dist', resultModule);
  const resultSource = await fs.readFile(resultPath, 'utf8');
  const adapterExport = resultSource.match(/getPreparedToolAdapter as (\w+)/)![1];
  const getAdapter = (await import(pathToFileURL(resultPath).href))[adapterExport];
  service = await launchHttp();
  const requests: string[] = [];
  let initializeCapabilities: object | undefined;
  const localFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    expect(new URL(url).origin).toBe(new URL(service.url).origin);
    if (typeof init?.body === 'string') {
      const message = JSON.parse(init.body);
      if (message.method) requests.push(message.method);
      if (message.method === 'initialize') initializeCapabilities = message.params.capabilities;
    }
    return fetch(input, init);
  };
  connection = await createMcpConnection({ name: 'aiwg', url: service.url, auth: service.token,
    tools: ['discover', 'skill-show', 'artifact-write'], fetch: localFetch });
  expect(connection.tools.map((tool: any) => tool.name)).toEqual([
    'mcp__aiwg__discover', 'mcp__aiwg__skill-show', 'mcp__aiwg__artifact-write',
  ]);
  const call = (index: number, args: object) => getAdapter(connection.tools[index]).execute(args, new AbortController().signal);
  expect(await call(0, { phrase: 'sdlc-quickref', type: 'skill' })).toContain('sdlc-quickref');
  expect(await call(1, { name: 'sdlc-quickref', rules: true })).toContain('sdlc-orchestration');
  expect(await call(2, { path: 'flue/result.md', content: 'Flue remote write' })).toContain('success');
  expect(await fs.readFile(path.join(service.project, '.aiwg/flue/result.md'), 'utf8')).toBe('Flue remote write');
  await expect(call(2, { path: 'escape', content: 'bad', project_dir: service.scratch })).rejects.toThrow();
  expect(Object.keys(connection).sort()).toEqual(['close', 'name', 'tools']);
  expect(requests).toEqual(expect.arrayContaining(['initialize', 'tools/list', 'tools/call']));
  expect(requests).not.toContain('resources/list');
  expect(requests).not.toContain('prompts/list');
  expect(initializeCapabilities).toBeDefined();
  expect(initializeCapabilities).not.toHaveProperty('elicitation');
  // The connection advertises no elicitation callback and mounts no ask-user tool.
  const mcpModule = (await fs.readdir(path.join(runtime, 'dist'))).find(name => /^mcp-.*\.mjs$/.test(name))!;
  const source = await fs.readFile(path.join(runtime, 'dist', mcpModule), 'utf8');
  expect(source).not.toContain('elicitation');
  await expect(createMcpConnection({ name: 'aiwg', url: service.url, auth: service.token,
    tools: ['command-run'], fetch: localFetch })).rejects.toThrow(/does not expose/);
}, 30_000);
