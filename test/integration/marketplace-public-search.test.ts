// Exercise the built marketplace CLI with an offline recorded-response transport.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = path.resolve('.');
const preload = path.join(root, 'test/fixtures/marketplace-search/public/fetch-preload.cjs');
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-marketplace-cli-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
function run(command: string, flags: string[] = [], offline = false) {
  return spawnSync(process.execPath, ['--require', preload, path.join(root, 'bin/aiwg.mjs'), command,
    'search', 'social media', '--plugins', '--json', ...flags], {
    cwd: home, encoding: 'utf8', timeout: 30_000,
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, CI: '1',
      AIWG_ROOT: root, AIWG_CONFIG: path.join(home, '.aiwg'),
      AIWG_CACHE_DIR: path.join(home, '.aiwg/marketplace-cache'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
      XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
      AIWG_TEST_SEARCH_OFFLINE: offline ? '1' : '0',
    },
  });
}
describe('built marketplace public search', () => {
  it.each(['marketplace', 'market'])('refreshes dated observations and reuses them offline through %s', command => {
    const initial = run(command, [], true);
    expect(initial.status, initial.stderr).toBe(0);
    expect(JSON.parse(initial.stdout).results).toEqual([]);
    expect(fs.readdirSync(home)).toEqual([]);
    const refreshed = run(command, ['--refresh']);
    expect(refreshed.status, refreshed.stderr).toBe(0);
    const report = JSON.parse(refreshed.stdout);
    expect(report.coverage.filter((source: { mode: string }) => source.mode === 'refresh')).toHaveLength(3);
    expect(report.results).toHaveLength(4);
    expect(report.results[0].installs).toMatchObject({ value: 1400000, source: expect.stringContaining('skills.sh'), asOf: expect.any(String) });
    expect(report.warnings.join(' ')).toMatch(/implausible/i);
    const cached = run(command, [], true);
    expect(cached.status, cached.stderr).toBe(0);
    expect(JSON.parse(cached.stdout).results).toEqual(report.results);
    expect(cached.stderr).not.toMatch(/refresh failed|unexpected network/i);
  });
});
