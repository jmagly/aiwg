// Replay conductor captures and bind each matrix surface to its actual native contract.
import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProviderCapabilities } from '../../../src/providers/capability-matrix.js';
import { runGrokHeadless } from '../../../src/providers/grok-build-headless.js';
import { parseGrokNativeWorktreeList } from '../../../src/providers/grok-build-dispatch.js';

const root = new URL('../../fixtures/providers/grok-build/captured-20261124/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, root), 'utf8');
const json = (name: string) => JSON.parse(fixture(name));
const rows = (name: string) => fixture(name).trim().split('\n').map(line => JSON.parse(line));
const tools = new Map<string, any>(json('tools-default.json').map((tool: any) => [tool.function.name, tool.function]));
const contract = JSON.parse(readFileSync(new URL('../../../docs/providers/grok-build-qualification.json', import.meta.url), 'utf8'));
const matrix = getProviderCapabilities('grok-build')!;

async function replay(name: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'aiwg-grok-capture-'));
  try {
    return await runGrokHeadless({ cwd, command: process.execPath,
      prefixArgs: ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1]))', fileURLToPath(new URL(name, root)), '--'],
      env: {}, prompt: 'offline replay', timeoutMs: 3_000 });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

function surface(name: string, native: boolean) {
  expect(matrix.native_features[name as keyof typeof matrix.native_features]).toBe(native);
  expect(contract.surfaces[name].status).toBe(native ? 'native' : 'deferred');
  expect(contract.surfaces[name].tests).toContain('test/unit/providers/grok-build-capabilities.test.ts');
}

describe('Grok Build 1.0.92 captured capabilities', () => {
  it('completes two native subagents with overlapping lifetimes without claiming team lifecycle', async () => {
    const { events, stopReason } = await replay('sub-on-run.jsonl');
    const calls = events.filter(e => e.toolName === 'spawn_subagent');
    expect(calls).toHaveLength(2);
    const done = events.filter(e => e.status === 'completed' && (e.rawOutput as any)?.type === 'SubagentCompleted');
    expect(done.map(e => (e.rawOutput as any).output)).toEqual(['3', '2']);
    expect(new Set(done.map(e => (e.rawOutput as any).subagent_id)).size).toBe(2);
    expect(events.indexOf(calls[1])).toBeLessThan(events.indexOf(done[0]));
    expect(events.filter(e => e.type === 'text').map(e => e.data).join('')).toContain('a=3 b=2');
    expect(stopReason).toBe('end_turn');
    expect(tools.get('spawn_subagent').parameters.properties.isolation.enum).toContain('worktree');
    expect(tools.has('team_create')).toBe(false);
    surface('agent_teams', false);
  });

  it('removes spawn_subagent and workflow with the old bans while leaving the scheduler available', async () => {
    const off = rows('sub-off.jsonl');
    expect(off.filter(e => e.type === 'tool_call').map(e => e.toolName)).toEqual(['run_terminal_command']);
    expect(off.at(-1).stopReason).toBe('cancelled');
    await expect(replay('sub-off.jsonl')).rejects.toMatchObject({ result: { stopReason: 'cancelled' } });
    const banned = json('tools-banned.json').map((t: any) => t.function.name);
    expect([...tools.keys()].filter(name => !banned.includes(name)).sort()).toEqual(['spawn_subagent', 'workflow']);
    expect(banned.filter((name: string) => !tools.has(name))).toEqual([]);
    // Scheduling is a distinct possible child path, not covered by this two-tool diff.
    expect(banned).toContain('scheduler_create');
    expect(tools.get('scheduler_create').description).toContain('starts a background subagent');
    expect(tools.get('workflow').description).toContain('many subagents');
    const { events, stopReason } = await replay('combined.jsonl');
    expect(events.filter(e => e.type === 'tool_call').some(e => ['spawn_subagent', 'workflow'].includes(String(e.toolName)))).toBe(false);
    expect(stopReason).toBe('end_turn');
  });

  it('replays successful scheduler creation despite the old fan-out ban', async () => {
    const { events, stopReason } = await replay('sched-run.jsonl');
    const call = events.find(e => e.toolName === 'scheduler_create');
    expect(call).toMatchObject({ rawInput: { interval: '1m', prompt: 'count the lines in a.txt' } });
    expect(events).toContainEqual(expect.objectContaining({ toolCallId: call!.toolCallId,
      status: 'completed', rawOutput: expect.objectContaining({ type: 'SchedulerCreate', humanSchedule: 'every 1 minute' }) }));
    expect(stopReason).toBe('end_turn');
    // Creation is observed; this short session does not establish a fired run.
    expect(tools.get('scheduler_create').description).toContain('starts a background subagent');
  });

  it('removes all five native fan-out tools with the comma-separated scheduler ban', async () => {
    const banned = json('tools-banned-scheduler.json').map((t: any) => t.function.name);
    const removed = ['scheduler_create', 'scheduler_delete', 'scheduler_list', 'spawn_subagent', 'workflow'];
    expect(banned).toHaveLength(20);
    expect([...tools.keys()].filter(name => !banned.includes(name)).sort()).toEqual(removed);
    expect(banned.filter((name: string) => !tools.has(name))).toEqual([]);
    const { events, stopReason } = await replay('sched-banned.jsonl');
    const inventories = events.filter(e => e.type === 'available_commands');
    expect(inventories.length).toBeGreaterThan(0);
    for (const inventory of inventories) expect((inventory as any).tools).toEqual(banned);
    expect(events.filter(e => e.type === 'tool_call').some(e => removed.includes(String(e.toolName)))).toBe(false);
    expect(stopReason).toBe('end_turn');
    surface('cron', true);
  });

  it('preserves the compiled role while reporting exactly the explicit CLI model', async () => {
    const result = await replay('agent-run.jsonl');
    expect(Object.keys(result.modelUsage!)).toEqual(['grok-4.7-build-fast']);
    expect(result.modelUsage!['grok-4.7-build-fast']).toMatchObject({ modelCalls: 3 });
    expect(result.stopReason).toBe('end_turn');
  });

  it('records the native standalone copy, dirty refusal and explicit force-removal lifecycle', async () => {
    expect(parseGrokNativeWorktreeList(fixture('wt-list-before.json'))).toEqual([]);
    // Expand only the sanitization placeholder for the production absolute-path parser.
    const [copy] = parseGrokNativeWorktreeList(fixture('wt-list-after.json').replaceAll('$HOME', '/home/synthetic'));
    expect(copy).toMatchObject({ kind: 'fork', creation_mode: 'standalone', source_repo: '/absolute/temp/project',
      path: '/home/synthetic/.grok/worktrees/tmp-project/aiwg-probe', metadata: { label: 'aiwg-probe' } });
    const result = await replay('wt-session.jsonl');
    expect(result.events.at(-1)?.cwd).toBe('$HOME/.grok/worktrees/tmp-project/aiwg-probe');
    expect(fixture('wt-rm.out')).toContain('unsaved work: dirty');
    expect(fixture('wt-rm.out')).toContain('1 of 1 worktree removals failed');
    expect(fixture('wt-rm-force.out')).toContain('removed: $HOME/.grok/worktrees/tmp-project/aiwg-probe');
    expect(parseGrokNativeWorktreeList(fixture('wt-list-final.json'))).toEqual([]);
  });

  it('supports session-bound recurring loops with explicit expiry and missed-run limits', () => {
    expect(tools.get('scheduler_create').description).toContain('repeating interval');
    expect(tools.get('scheduler_create').description).toContain('expire 7 days');
    expect(tools.get('scheduler_create').description).toContain('only while this session is open');
    expect(tools.get('scheduler_list').description).toContain('next run times');
    expect(tools.get('scheduler_delete').parameters.required).toEqual(['task_id']);
    surface('cron', true);
  });

  it('supports focused subtask dispatch as well as editable task-list status', () => {
    expect(tools.get('spawn_subagent').parameters.properties.background.default).toBe(true);
    expect(rows('sub-on-run.jsonl').filter(e => e.status === 'completed' && e.rawOutput?.type === 'SubagentCompleted')).toHaveLength(2);
    expect(tools.get('todo_write').description).toContain('task list');
    expect(tools.get('todo_write').parameters.properties.todos.items.properties.status.enum)
      .toEqual(['pending', 'in_progress', 'completed', 'cancelled', null]);
    surface('tasks', true);
  });

  it('keeps mission controls, persistent behaviors and resident daemon lifecycle unproven', () => {
    expect(tools.get('monitor').description).toContain('watch its output');
    expect(tools.get('workflow').description).toContain('pause, stop, or resume');
    const variants = tools.get('workflow').parameters.properties.source.oneOf;
    expect(variants.map((v: any) => v.properties.type.const)).toEqual(['name', 'script', 'script_path', 'resume', 'pause', 'stop']);
    expect(variants[3].properties.resume_from_run_id.description).toContain('from this session');
    for (const name of ['mission_control', 'behaviors', 'daemon']) {
      expect(tools.has(name)).toBe(false);
      surface(name, false);
      expect(contract.surfaces[name].reason).toBeTruthy();
    }
    expect(matrix.daemon_tier).toBe('unsupported');
  });

  it('refuses untrusted project MCP but connects the user server and calls search_tool then use_tool', async () => {
    expect(json('mcp-list.json')[0]).toMatchObject({ name: 'aiwg', scope: 'project', command: 'aiwg' });
    expect(json('mcp-doctor.json').servers[0]).toMatchObject({ healthy: false, checks: [{
      passed: false, detail: 'repo-local (project-scoped) server not started for an untrusted folder',
      hint: 're-run with --trust to allow repo-local servers',
    }] });
    const doctor = json('mcp-user-doctor.json');
    expect(doctor).toMatchObject({ healthy_count: 1, failing_count: 0 });
    expect(doctor.servers[0].checks).toContainEqual({ label: '19 tools discovered', passed: true, detail: '' });
    const { events } = await replay('mcp-session.jsonl');
    const calls = events.filter(e => e.type === 'tool_call');
    expect(calls.map(e => e.toolName)).toEqual(['search_tool', 'use_tool']);
    expect(calls[1].rawInput).toMatchObject({ tool_name: 'aiwg__discover' });
    for (const call of calls) expect(events).toContainEqual(expect.objectContaining({
      toolCallId: call.toolCallId, status: 'completed',
    }));
    expect(events.filter(e => e.type === 'text').map(e => e.data).join('')).toContain('top=Bug Report');
    surface('mcp', true);
    expect(contract.surfaces.mcp.qualification.kind).toBe('live-evidenced');
  });
});
