// Exercise the milestone preview through its shipped skill script without worker or tracker access.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const skillRoot = path.resolve('agentic/code/frameworks/sdlc-complete/skills/address-issues');
const planner = path.join(skillRoot, 'scripts/milestone-plan.mjs');
const temporary: string[] = [];
const issue = (id: string, overrides = {}) => ({
  id, title: `Fix ${id}`, status: 'ready', reason: 'Preflight safe; independent change',
  paths: [`src/${id}.ts`], dependsOn: [], role: 'coding', task: 'implementation',
  brief: `briefs/${id}.md`, workdir: `trees/${id}`, finalOutput: `finals/${id}.md`,
  effectiveMaxParallel: 3, ...overrides,
});
const input = (overrides = {}) => ({
  milestone: '2026.11.3', group: 'engineering',
  resources: { ok: true, slots: 3, freshness: { status: 'fresh' } },
  remaining: { project: 3, group: 3, context: 3 },
  issues: [issue('17'), issue('18', { status: 'blocked', reason: 'External dependency' }),
    issue('19', { status: 'needs-input', reason: 'Operator must choose API' }), issue('20')],
  ...overrides,
});

function preview(value: unknown, flags = ['--dry-run']) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'aiwg-milestone-'));
  temporary.push(tmp);
  const file = path.join(tmp, 'triage.json');
  writeFileSync(file, JSON.stringify(value));
  const result = spawnSync(process.execPath, [planner, '--input-json', file, ...flags], {
    cwd: tmp, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: tmp, AIWG_ROOT: tmp, PATH: tmp },
  });
  return { ...result, tmp };
}

afterEach(() => { for (const tmp of temporary.splice(0)) rmSync(tmp, { recursive: true, force: true }); });

describe('address-issues milestone dry-run (#3916)', () => {
  it('prints all triage rows and bounded dispatch without launching or writing', () => {
    const result = preview(input());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('| 17 | ready |');
    expect(result.stdout).toContain('| 18 | blocked |');
    expect(result.stdout).toContain('| 19 | needs-input |');
    expect(result.stdout).toContain('Planned dispatch (2)');
    expect(result.stdout).toContain('| 17 | coding | engineering | briefs/17.md | trees/17 | finals/17.md |');
    expect(result.stdout).toContain('No workers launched');
    expect(existsSync(path.join(result.tmp, 'trees'))).toBe(false);
    expect(existsSync(path.join(result.tmp, '.aiwg'))).toBe(false);
  });

  it.each(['project', 'group', 'context'] as const)('uses remaining %s capacity after active workers are counted', cap => {
    const result = preview(input({ remaining: { project: 3, group: 3, context: 3, [cap]: 1 } }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Planned dispatch (1)');
    expect(result.stdout).toContain('capacity exhausted');
  });

  it('intersects host slots and the resolver effectiveMaxParallel', () => {
    const result = preview(input({ issues: [issue('17', { effectiveMaxParallel: 1 }), issue('20', { effectiveMaxParallel: 1 })] }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Planned dispatch (1)');
    const host = preview(input({ resources: { ok: true, slots: 1, freshness: { status: 'fresh' } } }));
    expect(host.stdout).toContain('Planned dispatch (1)');
  });

  it.each([
    { ok: false, slots: 3, freshness: { status: 'fresh' } },
    { ok: true, slots: 3, freshness: { status: 'stale' } },
    { ok: true, slots: 0, freshness: { status: 'fresh' } },
    undefined,
  ])('fails closed on unavailable or refused host admission: %j', resources => {
    const result = preview(input({ resources }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Planned dispatch (0)');
    expect(result.stdout).toContain('host admission unavailable');
  });

  it('queues dependent or overlapping changes and continues to an independent issue', () => {
    const result = preview(input({ issues: [issue('17', { paths: ['src/area'] }),
      issue('20', { paths: ['src/area/file.ts'] }), issue('21', { dependsOn: ['17'] }), issue('22')] }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Planned dispatch (2)');
    expect(result.stdout).toContain('overlapping ownership');
    expect(result.stdout).toContain('unresolved dependencies: 17');
    expect(result.stdout).toContain('| 22 | coding |');
  });

  it.each([
    input({ remaining: { project: -1, group: 1, context: 1 } }),
    input({ issues: [issue('17'), issue('17')] }),
    input({ issues: [issue('17', { status: 'surprise' })] }),
    input({ issues: [issue('17', { brief: '' })] }),
    input({ issues: [issue('17', { paths: ['../escape'] })] }),
    input({ issues: [issue('17', { effectiveMaxParallel: null })] }),
  ])('rejects malformed planning inputs without a dispatch table', value => {
    const result = preview(value);
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('Planned dispatch');
    expect(result.stderr).toContain('milestone-plan:');
  });

  it('requires explicit dry-run and never offers a launch path', () => {
    const result = preview(input(), ['--launch']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--dry-run');
  });

  it('ships bounded briefs and an independent verification/CI contract', () => {
    const skill = readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    expect(skill).toContain('## Output template');
    expect(skill).toContain('--milestone');
    expect(skill).toContain('references/milestone.md');
    const flow = readFileSync(path.join(skillRoot, 'references/milestone.md'), 'utf8');
    for (const text of ['aiwg doctor --resources', 'aiwg models resolve', 'aiwg checkpoint',
      'PR body', 'signed local merge', 'post-merge CI', 'fix forward', 'archive']) expect(flow).toContain(text);
    for (const file of ['milestone-worker-brief.md', 'verification-oracle-checklist.md']) {
      expect(skill).toContain(`../../templates/management/${file}`);
      const template = readFileSync(path.resolve(skillRoot, `../../templates/management/${file}`), 'utf8');
      expect(template).toContain('verificationOracle');
    }
  });

  it('packages the mode, planner and templates identically in both SDLC plugins', () => {
    for (const plugin of ['sdlc', 'codex-sdlc']) {
      const root = path.resolve(`agentic/code/plugins/${plugin}`);
      for (const relative of ['scripts/milestone-plan.mjs', 'references/milestone.md']) {
        expect(readFileSync(path.join(root, 'skills/address-issues', relative), 'utf8'))
          .toBe(readFileSync(path.join(skillRoot, relative), 'utf8'));
      }
      for (const name of ['milestone-worker-brief.md', 'verification-oracle-checklist.md']) {
        expect(readFileSync(path.join(root, 'templates/management', name), 'utf8'))
          .toBe(readFileSync(path.resolve(skillRoot, '../../templates/management', name), 'utf8'));
      }
    }
  });
});
