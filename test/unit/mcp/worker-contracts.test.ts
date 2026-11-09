import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { fixtureJson, materialize, validators, type ContractVector } from '../../conformance/mission-v1/worker-contract-fixtures.js';

const { cli, projectRoot } = vi.hoisted(() => ({ cli: vi.fn(), projectRoot: vi.fn() }));
vi.mock('../../../src/mcp/helpers.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/mcp/helpers.mjs')>(), runAiwgCli: cli, findProjectRoot: projectRoot,
}));
vi.mock('../../../src/mcp/tools/worker-stdin-runtime.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/mcp/tools/worker-stdin-runtime.mjs')>(), sweepWorkerStdin: vi.fn(),
}));
// @ts-expect-error — source module is intentionally ESM JavaScript
import { createServer } from '../../../src/mcp/server.mjs';

// @ts-expect-error — .mjs untyped, matching the orchestration test lane
import { registerMissionToolset, registerWorkerResolveTool } from '../../../src/mcp/tools/orchestration.mjs';

const vocabulary = fixtureJson('public-vocabulary.json');
const vectors: ContractVector[] = fixtureJson('mission-vectors.json');
const { draft2020 } = validators();
const resolveDescriptor = vocabulary.mcp.find((tool: any) => tool.name === 'worker-resolve');
const invokeDescriptor = vocabulary.mcp.find((tool: any) => tool.name === 'worker-invoke');
const validateResolve = draft2020.compile(resolveDescriptor.inputSchema);
const validateInvoke = draft2020.compile(invokeDescriptor.inputSchema);
const value = (id: string) => materialize(vectors.find(v => v.id === id)!, vectors);

describe('frozen worker MCP descriptors (T-OG-17; B-OG-35 runtime handoff)', () => {
  afterEach(() => cli.mockReset());

  it('worker-resolve enforces the frozen input and delegates exact values as CLI data', async () => {
    let descriptor: any;
    let handler: any;
    registerWorkerResolveTool({ registerTool(name: string, d: any, h: any) {
      expect(name).toBe('worker-resolve'); descriptor = d; handler = h;
    } });
    expect(descriptor.annotations).toEqual(resolveDescriptor.annotations);
    const request = { ...vocabulary.cli.cases[1].request, brief: "/brief '雪\n$(echo data).md" };
    expect(descriptor.inputSchema.safeParse(request).success).toBe(true);
    expect(descriptor.inputSchema.safeParse({ ...request, server_url: 'unregistered' }).success).toBe(false);
    cli.mockResolvedValueOnce({ stdout: JSON.stringify({ invocation: value('resolved-mcp') }), stderr: '', code: 0 });
    const response = await handler(request);
    expect(response.isError).not.toBe(true);
    expect(cli.mock.calls.at(-1)[0]).toContain(`--brief=${request.brief}`);
    expect(cli.mock.calls.at(-1)[0]).not.toContain('mc');
    cli.mockResolvedValueOnce({ stdout: JSON.stringify({ status: 'blocked', diagnostics: [{ pointer: '/request/brief' }] }), stderr: '', code: 2 });
    const blocked = await handler(request);
    expect(blocked.isError).toBe(true);
    expect(JSON.parse(blocked.content[0].text).diagnostics).toEqual([{ pointer: '/request/brief' }]);
    cli.mockClear();
  });

  it.each(['shell', 'json', undefined])('honours the requested %s format through the shared CLI renderer', async format => {
    let handler: any;
    registerWorkerResolveTool({ registerTool(_name: string, _descriptor: any, h: any) { handler = h; } });
    const request = { ...vocabulary.cli.cases[0].request, format };
    const invocation = value('resolved-shell');
    const stdout = format === 'shell' ? invocation.shellCommand : JSON.stringify({ invocation });
    cli.mockResolvedValueOnce({ stdout, stderr: '', code: 0 });

    const response = await handler(request);

    expect(cli.mock.calls[0][0]).toContain(`--format=${format ?? 'json'}`);
    expect(response.isError).not.toBe(true);
    if (format === 'shell') expect(response.content[0].text).toBe(invocation.shellCommand);
    else expect(JSON.parse(response.content[0].text)).toEqual({ invocation });
  });

  it('preserves shell-format failure diagnostics and the nonzero result', async () => {
    let handler: any;
    registerWorkerResolveTool({ registerTool(_name: string, _descriptor: any, h: any) { handler = h; } });
    const diagnostics = [{ code: 'OG_CONFIG_REFERENCE', pointer: '/request/brief', message: 'Prepare the brief and resolve again.' }];
    cli.mockResolvedValueOnce({ stdout: '', stderr: JSON.stringify({ status: 'blocked', diagnostics }), code: 2 });

    const response = await handler({ ...vocabulary.cli.cases[0].request, format: 'shell' });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toEqual({ status: 'blocked', diagnostics });
  });
  it.each(vocabulary.cli.cases)('$id resolves a typed request without a Mission session', fixture => {
    expect(validateResolve(fixture.request), JSON.stringify(validateResolve.errors)).toBe(true);
    expect(resolveDescriptor.annotations.readOnlyHint).toBe(true);
    expect(cli).not.toHaveBeenCalled();
  });

  it.each([
    { transport: 'msp' }, { transport: 'acp' }, { transport: 'http' },
    { format: 'powershell' }, { group: 'fixture; touch injected' },
    { session_id: 'forbidden-managed-prerequisite' }, { server_url: 'https://arbitrary.invalid' },
  ])('rejects unsupported resolve syntax or task-supplied authority %j', patch => {
    expect(validateResolve({ ...vocabulary.cli.cases[0].request, ...patch })).toBe(false);
    expect(cli).not.toHaveBeenCalled();
  });

  it.each(['resolved-shell', 'resolved-mcp'])('%s invokes the typed direct brief without session, lease or verification', id => {
    expect(validateInvoke({ invocation: value(id), brief: value('direct-brief-no-lease') }), JSON.stringify(validateInvoke.errors)).toBe(true);
    expect(invokeDescriptor.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(invokeDescriptor.workerOutputDefinition).toBe('workerClaims');
    expect(invokeDescriptor.observedOutputDefinition).toBe('workerExecution');
  });

  it.each([
    { command: 'echo forbidden' }, { session_id: 'forbidden-session' },
    { verification: { status: 'accepted' } }, { server_url: 'https://arbitrary.invalid' },
  ])('rejects raw command or fabricated managed/conductor authority %j', patch => {
    expect(validateInvoke({ invocation: value('resolved-shell'), brief: value('direct-brief-no-lease'), ...patch })).toBe(false);
  });

  it('rejects a preparatory descriptor and preserves pinned MCP transport fields', () => {
    const invocation = value('preparatory-without-brief-digest');
    expect(validateInvoke({ invocation, brief: value('direct-brief-no-lease') })).toBe(false);
    for (const field of ['inputSchemaDigest', 'outputSchemaDigest', 'sessionIsolation']) {
      const mcp = value('resolved-mcp');
      delete mcp.mcp[field];
      expect(validateInvoke({ invocation: mcp, brief: value('direct-brief-no-lease') })).toBe(false);
    }
  });

  it('keeps the existing mission-dispatch descriptor separate and unchanged', () => {
    const tools = new Map<string, any>();
    registerMissionToolset({ registerTool(name: string, descriptor: any) { tools.set(name, descriptor); } });
    const actual = tools.get('mission-dispatch');
    const frozen = vocabulary.mcp.find((tool: any) => tool.name === 'mission-dispatch');
    expect(Object.keys(actual.inputSchema)).toEqual(frozen.properties);
    expect(Object.entries(actual.inputSchema).filter(([, schema]) => !(schema as z.ZodType).safeParse(undefined).success).map(([key]) => key)).toEqual(frozen.required);
    expect(actual.annotations).toEqual(frozen.annotations);
    // Resolve is nonlaunching; attached invocation remains B-OG-35.
    expect(tools.has('worker-resolve')).toBe(true);
    expect(tools.has('worker-invoke')).toBe(false);
    expect(cli).not.toHaveBeenCalled();
  });
});


// Normalize only equivalent JSON Schema representations: local references and
// nullable primitive unions. Every validation keyword remains part of the test.
function schemaMeaning(value: any, root = value): any {
  if (Array.isArray(value)) return value.map(child => schemaMeaning(child, root));
  if (!value || typeof value !== 'object') return value;
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/')) {
    const referenced = value.$ref.slice(2).split('/').reduce((node: any, key: string) => node[key.replaceAll('~1', '/').replaceAll('~0', '~')], root);
    return schemaMeaning(referenced, root);
  }
  const normalized = Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, schemaMeaning(child, root)]));
  if (normalized.anyOf?.every((branch: any) => branch.type && Object.keys(branch).length === 1)) {
    normalized.type = normalized.anyOf.flatMap((branch: any) => branch.type);
    delete normalized.anyOf;
  }
  if (Array.isArray(normalized.type)) normalized.type.sort();
  return normalized;
}

describe('native Zod MCP schema contracts', () => {
  let root: string | undefined;
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    projectRoot.mockReset();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('preserves all 89 registered input and output JSON Schemas', async () => {
    root = mkdtempSync(join(tmpdir(), 'aiwg-mcp-schema-contract-'));
    mkdirSync(join(root, '.aiwg'));
    projectRoot.mockResolvedValue(root);
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.stubEnv('AIWG_MCP_TOOLSETS', 'all,workers');
    const baseline = JSON.parse(readFileSync(new URL('../../fixtures/mcp/tool-json-schema.v3.json', import.meta.url), 'utf8'));
    const server = await createServer();
    try {
      const listed = await server.server._requestHandlers.get('tools/list')({ method: 'tools/list' }, {});
      expect(listed.tools).toHaveLength(89);
      const shapes = server._registeredTools;
      expect(shapes['worker-invoke'].inputSchema.shape.invocation_id.safeParse('00000000-0000-0000-0000-000000000001').success).toBe(true);
      expect(shapes['sandbox-fleet-reconcile-preview'].inputSchema.shape.before_revision.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(true);
      expect(shapes['sandbox-activity-timeline'].inputSchema.shape.filter.unwrap().shape.since.safeParse('2026-10-25T13:00Z').success).toBe(true);

      expect(listed.tools.map((tool: any) => tool.name).sort()).toEqual(Object.keys(baseline).sort());
      for (const tool of listed.tools) {
        const registered = server._registeredTools[tool.name];
        expect(registered.inputSchema).toBeInstanceOf(z.ZodObject);
        expect(schemaMeaning(tool.inputSchema), `${tool.name} input`).toEqual(schemaMeaning(baseline[tool.name].input));
        if (tool.outputSchema) {
          expect(registered.outputSchema).toBeInstanceOf(z.ZodObject);
          expect(schemaMeaning(tool.outputSchema), `${tool.name} output`).toEqual(schemaMeaning(baseline[tool.name].output));
        } else expect(baseline[tool.name].output).toBeUndefined();
      }
    } finally { await server.close(); }
  });
});
