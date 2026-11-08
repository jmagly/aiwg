import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { collectHeadroom, formatHeadroom } from '../../../tools/ci/runner-headroom.mjs';

describe('tools/ci/runner-headroom.mjs (#2553)', () => {
  it('collects every headroom row as a non-empty string', () => {
    const rows = collectHeadroom(process.cwd());
    const labels = rows.map(([label]) => label);
    expect(labels).toEqual([
      'disk free',
      'disk total',
      'inodes free',
      'inodes total',
      'inotify max_user_watches',
      'inotify max_user_instances',
      'inotify max_queued_events',
      'memory free',
      'memory total',
      'cpus',
      'load average (1m)',
    ]);
    for (const [, value] of rows) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
    expect(rows.find(([label]) => label === 'disk free')?.[1]).toMatch(/^\d+\.\d{2} GiB$|^unavailable$/);
    expect(rows.find(([label]) => label === 'cpus')?.[1]).toMatch(/^\d+$/);
  });

  it('marks an unreadable path unavailable instead of throwing', () => {
    const rows = collectHeadroom('/definitely/not/a/mounted/path');
    expect(rows.find(([label]) => label === 'disk free')?.[1]).toBe('unavailable');
    expect(rows.find(([label]) => label === 'inodes total')?.[1]).toBe('unavailable');
    // Non-filesystem rows are still reported.
    expect(rows.find(([label]) => label === 'cpus')?.[1]).toMatch(/^\d+$/);
  });

  it('formats an aligned, labelled report', () => {
    const output = formatHeadroom([['disk free', '1.00 GiB'], ['inotify max_user_watches', '8192']], '/work');
    expect(output.split('\n')).toEqual([
      'Runner headroom for /work (#2553)',
      '  disk free                 1.00 GiB',
      '  inotify max_user_watches  8192',
    ]);
  });
});

describe('CI Test job headroom placement (#3977)', () => {
  it('records headroom before measured coverage and keeps the later step before the watcher tests', () => {
    const workflow = parse(readFileSync('.gitea/workflows/ci.yml', 'utf8'));
    const steps: Array<{ name?: string; run?: string }> = workflow.jobs.test.steps;
    const headroom = steps.flatMap((step, index) => (step.run === 'node tools/ci/runner-headroom.mjs .' ? [index] : []));
    const coverage = steps.findIndex(step => step.name === 'Enforce measured testing-quality and audit-foundation coverage');
    expect(coverage).toBeGreaterThan(0);
    expect(headroom.some(index => index < coverage)).toBe(true);
    expect(headroom.some(index => index > coverage)).toBe(true);
  });
});
