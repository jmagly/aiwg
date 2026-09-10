import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { z } from 'zod';

const fixture = vi.hoisted(() => ({
  root: '/synthetic-aiwg-flow-corpus',
  directories: new Map<string, string[]>(),
  files: new Map<string, string>(),
  access: vi.fn(), readdir: vi.fn(), readFile: vi.fn(), cli: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ default: {
  access: fixture.access, readdir: fixture.readdir, readFile: fixture.readFile,
} }));
vi.mock('../../../src/mcp/helpers.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/mcp/helpers.mjs')>(),
  AIWG_ROOT: fixture.root,
  runAiwgCli: fixture.cli,
}));
// @ts-expect-error — .mjs untyped
import { registerFlowToolset, registerMissionToolset } from '../../../src/mcp/tools/orchestration.mjs';

const frameworks = path.join(fixture.root, 'agentic/code/frameworks');
const yaml = 'apiVersion: workflow.aiwg.io/v1\nkind: WorkflowPlaybook\nmetadata:\n  name: alpha\n  labels:\n    audience: test\nspec:\n  steps:\n    - id: prepare\n      kind: command\n      capability: synthetic-prepare\n    - id: check\n      kind: gate\n      depends_on: [prepare]\n';
const alphaPath = path.join(frameworks, 'first/flows/nested/recipe.playbook.yaml');
const wrapperPath = path.join(frameworks, 'first/skills/alpha/SKILL.md');

function addFile(file: string, content: string) {
  fixture.files.set(file, content);
  let child = file;
  while (child !== frameworks) {
    const parent = path.dirname(child);
    const children = fixture.directories.get(parent) || [];
    if (!children.includes(path.basename(child))) children.push(path.basename(child));
    fixture.directories.set(parent, children);
    child = parent;
  }
}

beforeEach(() => {
  fixture.files.clear();
  fixture.directories.clear();
  fixture.directories.set(frameworks, []);
  for (const fn of [fixture.access, fixture.readdir, fixture.readFile, fixture.cli]) fn.mockReset();
  fixture.access.mockImplementation(async (file: string) => {
    if (!fixture.files.has(file) && !fixture.directories.has(file)) throw new Error(`Missing fixture: ${file}`);
  });
  fixture.readdir.mockImplementation(async (directory: string) => {
    const children = fixture.directories.get(directory);
    if (!children) throw new Error(`Missing directory: ${directory}`);
    return children.map(name => ({ name, isDirectory: () => fixture.directories.has(path.join(directory, name)) }));
  });
  fixture.readFile.mockImplementation(async (file: string) => {
    if (!fixture.files.has(file)) throw new Error(`Missing file: ${file}`);
    return fixture.files.get(file);
  });
  fixture.cli.mockImplementation(() => { throw new Error('Flow tools must not spawn a CLI'); });
  // Insert reverse lexical order to make sorting independently observable.
  addFile(path.join(frameworks, 'second/flows/zeta.playbook.yaml'), 'metadata:\n  name: zeta\n');
  addFile(alphaPath, yaml);
  addFile(wrapperPath, 'Synthetic wrapper instructions');
  addFile(path.join(frameworks, 'first/docs/ignored.playbook.yaml'), 'metadata:\n  name: ignored\n');
  addFile(path.join(frameworks, 'first/flows/ignored.txt'), 'Not a playbook');
});

function invoke(name: string, input: Record<string, unknown> = {}) {
  const tools = new Map<string, any>();
  registerFlowToolset({ registerTool(key: string, config: any, handler: any) { tools.set(key, { config, handler }); } });
  registerMissionToolset({ registerTool(key: string, config: any, handler: any) { tools.set(key, { config, handler }); } });
  const tool = tools.get(name);
  return tool.handler(z.object(tool.config.inputSchema).parse(input));
}
const decode = (result: any) => JSON.parse(result.content[0].text);

describe('MCP flow tools with a controlled corpus', () => {
  it('recurses, excludes unrelated files, sorts names, and omits source text from list summaries', async () => {
    const result = await invoke('flow-list');
    expect(result.isError).not.toBe(true);
    const body = decode(result);
    expect(body.count).toBe(2);
    expect(body.flows.map((flow: any) => flow.name)).toEqual(['alpha', 'zeta']);
    expect(body.flows[0]).toEqual({
      name: 'alpha', framework: 'first', apiVersion: 'workflow.aiwg.io/v1', kind: 'WorkflowPlaybook',
      labels: { audience: 'test' }, step_count: 2,
      steps: [
        { id: 'prepare', kind: 'command', capability: 'synthetic-prepare', depends_on: [] },
        { id: 'check', kind: 'gate', capability: null, depends_on: ['prepare'] },
      ],
      path: alphaPath, relative_path: path.join('frameworks', 'first/flows/nested/recipe.playbook.yaml'),
      wrapper_skill: { name: 'alpha', path: wrapperPath, exists: true },
    });
    expect(body.flows[1].wrapper_skill.exists).toBe(false);
    expect(fixture.cli).not.toHaveBeenCalled();
  });

  it.each([
    [{ framework: 'first' }, ['alpha']],
    [{ framework: 'second' }, ['zeta']],
    [{ filter: 'alpha' }, ['alpha']],
    [{ filter: 'nested/recipe' }, ['alpha']],
    [{ framework: 'second', filter: 'alpha' }, []],
    [{ filter: 'absent' }, []],
  ])('applies framework and name/path filters %j', async (input, names) => {
    const body = decode(await invoke('flow-list', input));
    expect(body.flows.map((flow: any) => flow.name)).toEqual(names);
    expect(body.count).toBe(names.length);
  });

  it.each(['alpha', 'recipe.playbook.yaml', 'recipe'])('resolves flow-show by %s and returns exact source', async name => {
    const result = await invoke('flow-show', { name, framework: 'first' });
    expect(result.isError).not.toBe(true);
    expect(decode(result).content).toBe(yaml);
    expect(decode(result).path).toBe(alphaPath);
  });

  it.each(['flow-show', 'flow-run'])('%s reports a missing flow rather than a success envelope', async tool => {
    const result = await invoke(tool, { name: 'missing', confirmed: true });
    expect(result.isError).toBe(true);
    expect(decode(result)).toEqual({ error: `${tool}: flow not found: missing` });
  });

  it('refuses unconfirmed flow-run before reading the corpus', async () => {
    const result = await invoke('flow-run', { name: 'alpha' });
    expect(result.isError).toBe(true);
    expect(decode(result).requires_confirmation).toBe(true);
    expect(fixture.access).not.toHaveBeenCalled();
    expect(fixture.readFile).not.toHaveBeenCalled();
    expect(fixture.cli).not.toHaveBeenCalled();
  });

  it('returns a host-execution envelope with exact wrapper, arguments and project without executing', async () => {
    const result = await invoke('flow-run', { name: 'alpha', confirmed: true, project_dir: '/synthetic-project', args: ['--dry-run', 'two words'] });
    expect(result.isError).not.toBe(true);
    const body = decode(result);
    expect(body.status).toBe('ready_for_host_execution');
    expect(body.project_dir).toBe('/synthetic-project');
    expect(body.args).toEqual(['--dry-run', 'two words']);
    expect(body.flow.content).toBe(yaml);
    expect(body.wrapper_skill_content).toBe('Synthetic wrapper instructions');
    expect(fixture.cli).not.toHaveBeenCalled();
  });

  it('handles a flow without a wrapper and supplies default arguments and working directory', async () => {
    const result = await invoke('flow-run', { name: 'zeta', confirmed: true });
    expect(result.isError).not.toBe(true);
    const body = decode(result);
    expect(body.wrapper_skill_content).toBeNull();
    expect(body.flow.wrapper_skill.exists).toBe(false);
    expect(body.args).toEqual([]);
    expect(body.project_dir).toBe(process.cwd());
    expect(fixture.cli).not.toHaveBeenCalled();
  });

  it.each(['flow-list', 'flow-show', 'flow-run'])('%s reports malformed YAML as an MCP error', async tool => {
    fixture.files.set(alphaPath, 'metadata: [');
    const result = await invoke(tool, { name: 'alpha', confirmed: true });
    expect(result.isError).toBe(true);
    expect(decode(result).error).toMatch(new RegExp(`^${tool}:`));
    expect(decode(result).error).toContain('Flow sequence');
    expect(fixture.cli).not.toHaveBeenCalled();
  });
});

describe('MCP mission guide and status response boundaries', () => {
  const guideRelative = 'agentic/code/addons/aiwg-utils/skills/aiwg-mission/SKILL.md';

  it('reads the guide from the configured corpus before considering the working directory', async () => {
    const configured = path.join(fixture.root, guideRelative);
    fixture.files.set(configured, 'Configured synthetic guide');
    fixture.files.set(path.join(process.cwd(), guideRelative), 'Fallback synthetic guide');
    const result = await invoke('mission-guide');
    expect(result.isError).not.toBe(true);
    expect(decode(result)).toEqual({ path: configured, content: 'Configured synthetic guide' });
    expect(fixture.readFile.mock.calls).toEqual([[configured, 'utf-8']]);
    expect(fixture.cli).not.toHaveBeenCalled();
  });

  it('falls back to the working directory when the configured guide is missing', async () => {
    const fallback = path.join(process.cwd(), guideRelative);
    fixture.files.set(fallback, 'Fallback synthetic guide');
    const result = await invoke('mission-guide');
    expect(result.isError).not.toBe(true);
    expect(decode(result)).toEqual({ path: fallback, content: 'Fallback synthetic guide' });
    expect(fixture.readFile.mock.calls).toEqual([
      [path.join(fixture.root, guideRelative), 'utf-8'], [fallback, 'utf-8'],
    ]);
  });

  it('returns an explicit error when neither candidate contains the guide', async () => {
    const result = await invoke('mission-guide');
    expect(result.isError).toBe(true);
    expect(decode(result)).toEqual({ error: 'mission-guide: Could not locate aiwg-mission SKILL.md under AIWG_ROOT or current working directory.' });
    expect(fixture.cli).not.toHaveBeenCalled();
  });

  it('decodes successful current-session status and forwards the requested project directory', async () => {
    fixture.cli.mockResolvedValueOnce({ code: 0, stdout: '{"sessionId":"synthetic-current","missions":[]}', stderr: '' });
    const result = await invoke('mission-status', { project_dir: '/synthetic-project' });
    expect(result.isError).not.toBe(true);
    expect(decode(result)).toEqual({ sessionId: 'synthetic-current', missions: [] });
    expect(fixture.cli.mock.calls).toEqual([[['mc', 'status', '--json'], { cwd: '/synthetic-project', timeoutMs: 30_000 }]]);
  });

  it('preserves unparseable successful status output and diagnostics rather than inventing parsed state', async () => {
    fixture.cli.mockResolvedValueOnce({ code: 0, stdout: 'Synthetic legacy status', stderr: 'Synthetic warning' });
    const result = await invoke('mission-status');
    expect(result.isError).not.toBe(true);
    expect(decode(result)).toEqual({ stdout: 'Synthetic legacy status', stderr: 'Synthetic warning' });
    expect(fixture.cli).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Synthetic failure', 'ignored stdout', 'Synthetic failure'],
    ['', 'Synthetic stdout failure', 'Synthetic stdout failure'],
  ])('reports nonzero status with stderr=%j and stdout=%j', async (stderr, stdout, diagnostic) => {
    fixture.cli.mockResolvedValueOnce({ code: 7, stdout, stderr });
    const result = await invoke('mission-status');
    expect(result.isError).toBe(true);
    expect(decode(result)).toEqual({ error: `mission-status failed (exit 7): ${diagnostic}` });
    expect(fixture.cli).toHaveBeenCalledTimes(1);
  });

  it('returns status transport rejection as an MCP error without retrying', async () => {
    fixture.cli.mockRejectedValueOnce(new Error('Synthetic transport rejection'));
    const result = await invoke('mission-status');
    expect(result.isError).toBe(true);
    expect(decode(result)).toEqual({ error: 'mission-status: Synthetic transport rejection' });
    expect(fixture.cli).toHaveBeenCalledTimes(1);
  });
});
