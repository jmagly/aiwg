import {
  existsSync, mkdtempSync, mkdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFeaturesRoot } from '../../src/features/paths.js';

const root = resolve('.');
const bin = resolve(root, 'bin/aiwg.mjs');
const router = resolve(root, 'dist/src/cli/router.js');
const corpus = resolve(root, 'test/fixtures/sessions/regression-v1');
const missingBuild = !existsSync(router);
let temporaryRoot = '';
let workspace = '';
let database = '';

const sources = [
  ['claude', 'claude/family.jsonl'],
  ['codex', 'codex/rollout-2026-01-02T09-00-00-019d0000-0000-7000-8000-000000000101.jsonl'],
  ['cursor', 'cursor/agent-transcripts/shared-session/shared-session.jsonl'],
  ['factory', 'factory/current.jsonl'],
] as const;

describe.skipIf(missingBuild)('spawned session regression CLI', () => {
  beforeAll(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'aiwg-session-cli-'));
    workspace = join(temporaryRoot, 'workspace');
    database = join(temporaryRoot, 'catalog', 'sessions.sqlite');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(dirname(database), { recursive: true });
  });

  afterAll(() => {
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('imports and replays the corpus through bin/aiwg.mjs', () => {
    for (const [provider, fixture] of sources) {
      const args = [
        'sessions', 'import', resolve(corpus, fixture),
        '--provider', provider,
        '--source-id', `regression-cli-${provider}`,
        '--workspace', workspace,
        '--db', database,
        '--json',
      ];
      const first = runCli(args);
      expect(first.error).toBeUndefined();
      expect(first.status, first.stderr).toBe(0);
      expect(parse(first.stdout)).toMatchObject({
        status: 'ok',
        data: {
          sourceId: `regression-cli-${provider}`,
          totals: { eventsInserted: expect.any(Number) },
        },
      });
      expect(parse(first.stdout).data.totals.eventsInserted).toBeGreaterThan(0);

      const replay = runCli(args);
      expect(replay.error).toBeUndefined();
      expect(replay.status, replay.stderr).toBe(0);
      expect(parse(replay.stdout)).toMatchObject({
        status: 'ok',
        data: {
          totals: { sessionsInserted: 0, eventsInserted: 0 },
        },
      });
    }

    const listed = runCli([
      'sessions', 'list',
      '--workspace', workspace,
      '--db', database,
      '--limit', '20',
      '--json',
    ]);
    expect(listed.error).toBeUndefined();
    expect(listed.status, listed.stderr).toBe(0);
    const output = parse(listed.stdout);
    expect(output).toMatchObject({
      status: 'ok',
      data: {
        page: { total: 4 },
      },
    });
    expect(new Set(output.data.items.map((item: { provider: string }) => item.provider)))
      .toEqual(new Set(sources.map(([provider]) => provider)));
  }, 60_000);
});

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    timeout: 30_000,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: temporaryRoot,
      USERPROFILE: temporaryRoot,
      // Dependency code may live outside the base install. Keep the selected
      // read-only package location while isolating all mutable CLI state.
      AIWG_FEATURES_HOME: getFeaturesRoot(),
      AIWG_LOG_DISABLE: '1',
      NO_UPDATE_NOTIFIER: '1',
      AIWG_NO_UPDATE_CHECK: '1',
      NO_COLOR: '1',
    },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    error: result.error,
  };
}

function parse(output: string): any {
  return JSON.parse(output);
}
