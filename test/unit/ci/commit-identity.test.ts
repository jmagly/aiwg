// Verify only newly pushed commits against the workspace identity policy (#3838).
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { checkPush, formatReport, runCheck } from '../../../tools/ci/check-commit-identity.mjs';

const BEFORE = 'a'.repeat(40);
const AFTER = 'b'.repeat(40);
const SIDE = 'c'.repeat(40);
const ZERO = '0'.repeat(40);
const KEY = '25BEE160811F66FD6F7B1BF0454C68C4A2174CE9';
const NAME = 'Joseph Magly';
const EMAIL = '1159087+jmagly@users.noreply.github.com';
const good = [AFTER, NAME, EMAIL, NAME, EMAIL, 'U', KEY, '', 'subject\n'];

function fixture(rows: string[][] = [good], parents = `${AFTER} ${BEFORE}`) {
  const calls: string[][] = [];
  const git = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'rev-list' && args.includes('--parents')) return parents;
    if (args[0] === 'rev-list') return rows.map(row => row[0]).join('\n');
    const row = rows.find(row => args.includes(row[0]));
    if (!row) throw new Error(`Unexpected git call: ${args.join(' ')}`);
    return row.join('\0');
  };
  return { git, calls };
}

describe('push commit identity checker (#3838)', () => {
  it.each(['G', 'U'])('accepts a valid %s signature from the approved key', status => {
    const row = [...good]; row[5] = status;
    const { git, calls } = fixture([row]);
    const result = checkPush({ before: BEFORE, after: AFTER }, git);
    expect(result.commits).toHaveLength(1);
    expect(result.violations).toEqual([]);
    expect(calls[0]).toEqual(['rev-list', '--reverse', `${BEFORE}..${AFTER}`, '--']);
    expect(formatReport(result)).toContain('passed: 1 commit');
  });

  it('accepts a signing subkey of the approved primary key', () => {
    const row = [...good]; row[6] = SIDE; row[7] = KEY;
    expect(checkPush({ before: BEFORE, after: AFTER }, fixture([row]).git).violations).toEqual([]);
  });

  it.each([1, 2, 3, 4])('rejects an incorrect identity field %i', field => {
    const row = [...good]; row[field] = 'impostor';
    expect(checkPush({ before: BEFORE, after: AFTER }, fixture([row]).git).violations).toHaveLength(1);
  });

  it.each(['B', 'E', 'N', 'X', 'Y', 'R', ''])('rejects signature status %j', status => {
    const row = [...good]; row[5] = status;
    expect(checkPush({ before: BEFORE, after: AFTER }, fixture([row]).git).violations).toHaveLength(1);
  });

  it('rejects a good signature from another key', () => {
    const row = [...good]; row[6] = SIDE; row[7] = BEFORE;
    expect(checkPush({ before: BEFORE, after: AFTER }, fixture([row]).git).violations).toHaveLength(1);
  });

  it.each(['Co-Authored-By: Someone <s@example.test>', 'generated with [Claude', 'Generated with Codex'])
  ('reuses the push helper attribution rule: %s', body => {
    const row = [...good]; row[8] = `subject\n\n${body}\n`;
    expect(checkPush({ before: BEFORE, after: AFTER }, fixture([row]).git).violations).toHaveLength(1);
  });

  it('reports every bad commit with full identity and signature details, including a side branch', () => {
    const merge = [AFTER, 'Roctinam User', '1+roctinam@noreply.localhost', 'Roctinam User', '1+roctinam@noreply.localhost', 'N', '', '', 'merge'];
    const side = [...good]; side[0] = SIDE; side[5] = 'B';
    const result = checkPush({ before: BEFORE, after: AFTER }, fixture([side, merge]).git);
    expect(result.violations).toHaveLength(2);
    const report = formatReport(result);
    for (const sha of [SIDE, AFTER]) expect(report).toContain(sha);
    expect(report).toContain(`author: ${NAME} <${EMAIL}>`);
    expect(report).toContain('committer: Roctinam User <1+roctinam@noreply.localhost>');
    expect(report).toContain('signature: B');
    expect(report).toContain('signature: N');
    expect(report).toContain('WORKSPACE.md');
    expect(report).toContain('Commit identity and attribution');
    expect(report).toContain('tools/git/push-origin-as-roctinam.sh');
    expect(report).toContain('local');
    expect(report).toContain('--no-ff');
    expect(report).toContain('aiwg run skill aiwg-pr -- merge');
  });

  it.each([ZERO, '', undefined])('uses only the first parent when before is %j', before => {
    const { git, calls } = fixture([good], `${AFTER} ${BEFORE} ${SIDE}`);
    expect(checkPush({ before, after: AFTER }, git).violations).toEqual([]);
    expect(calls).toContainEqual(['rev-list', '--reverse', `${BEFORE}..${AFTER}`, '--']);
    expect(calls.some(args => args.includes('--first-parent'))).toBe(false);
  });

  it('checks a root head once when a new branch has no first parent', () => {
    const { git, calls } = fixture([good], AFTER);
    expect(checkPush({ before: ZERO, after: AFTER }, git).commits).toHaveLength(1);
    expect(calls).toContainEqual(['rev-list', '--reverse', AFTER, '--']);
  });

  it('does not inspect an empty range or a deleted ref', () => {
    const { git, calls } = fixture([]);
    expect(checkPush({ before: BEFORE, after: BEFORE }, git).commits).toEqual([]);
    const beforeDelete = calls.length;
    expect(checkPush({ before: BEFORE, after: ZERO }, git).commits).toEqual([]);
    expect(calls).toHaveLength(beforeDelete);
  });

  it('fails closed when the nonzero event base is unavailable', () => {
    expect(() => checkPush({ before: BEFORE, after: AFTER }, () => { throw new Error('missing object'); }))
      .toThrow('missing object');
  });

  it.each([{ before: '--all', after: AFTER }, { before: BEFORE, after: '' }, { before: BEFORE, after: 'HEAD' }])
  ('rejects malformed event revisions: %j', event => {
    expect(() => checkPush(event, () => { throw new Error('must not call git'); })).toThrow(/push.*SHA/i);
  });

  it('resolves a real synthetic graph without rechecking the old unsigned root', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-commit-identity-'));
    const git = (args: string[], input?: string) => execFileSync('git', args, {
      cwd: root, input, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' },
    }).trim();
    try {
      git(['init', '--quiet']);
      const tree = git(['mktree'], '');
      const object = (parents: string[], name = NAME) => git(['hash-object', '-t', 'commit', '-w', '--stdin'],
        `tree ${tree}\n${parents.map(p => `parent ${p}\n`).join('')}author ${name} <${EMAIL}> 1700000000 +0000\ncommitter ${name} <${EMAIL}> 1700000000 +0000\n\nsynthetic\n`);
      const old = object([], 'Legacy User');
      const side = object([old]);
      const head = object([old, side], 'Roctinam User');
      for (const before of [old, ZERO]) {
        const result = checkPush({ before, after: head }, git);
        expect(result.commits.map(commit => commit.sha).sort()).toEqual([side, head].sort());
        expect(result.violations).toHaveLength(2); // Both unsigned; the old root is excluded.
      }
      mkdirSync(join(root, '.gitea/keys'), { recursive: true });
      copyFileSync('.gitea/keys/maintainers.asc', join(root, '.gitea/keys/maintainers.asc'));
      expect(runCheck({ before: old, after: head, cwd: root }).violations).toHaveLength(2);
      const cli = (before: string, after: string) => spawnSync(process.execPath,
        [resolve('tools/ci/check-commit-identity.mjs')], {
          cwd: root, encoding: 'utf8', timeout: 10_000,
          env: { ...process.env, AIWG_PUSH_BEFORE: before, AIWG_PUSH_AFTER: after },
        });
      const rejected = cli(old, head);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain(head);
      expect(rejected.stderr).toContain(side);
      expect(rejected.stderr).not.toContain(old);
      const accepted = cli(head, head);
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).toContain('passed: 0 commit');
      const missingBase = cli(BEFORE, head);
      expect(missingBase.status).toBe(1);
      expect(missingBase.stderr).toContain('could not complete');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('CI Test job identity gate', () => {
  it('checks push events immediately after a full-history checkout, before dependency installation', () => {
    const workflow = parse(readFileSync('.gitea/workflows/ci.yml', 'utf8'));
    const steps = workflow.jobs.test.steps;
    expect(steps[0].uses).toMatch(/^actions\/checkout@/);
    expect(steps[0].with['fetch-depth']).toBe(0);
    const gate = steps[1];
    expect(gate.if).toBe("gitea.event_name == 'push'");
    expect(gate.run).toBe('node tools/ci/check-commit-identity.mjs');
    expect(gate.env.AIWG_PUSH_BEFORE).toBe('${{ gitea.event.before }}');
    expect(gate.env.AIWG_PUSH_AFTER).toBe('${{ gitea.event.after }}');
    expect(gate['continue-on-error']).toBeUndefined();
    expect(steps[2].run).toBe('npm ci');
  });
});
