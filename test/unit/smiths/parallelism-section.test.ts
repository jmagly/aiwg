/**
 * Unit tests for parallelism-section — context-file injector for the
 * project parallelism cap.
 *
 * @source @src/smiths/context-pipeline/parallelism-section.ts
 * @implements #1362
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import {
  buildParallelismSection,
  replaceOrAppendParallelismBlock,
  MAX_SHOWN_GROUPS,
  PARALLELISM_BLOCK_START,
  WORKER_HEALTH_DOC_POINTER,
  PARALLELISM_BLOCK_END,
  PARALLELISM_HEALTH_UNRESOLVED_NOTE,
} from '../../../src/smiths/context-pipeline/parallelism-section.js';
import { emptyConfig, writeAiwgConfig, getConfigPath, type AiwgConfig } from '../../../src/config/aiwg-config.js';
import { parseWorkerCommandArgs } from '../../../src/serve/worker-invocation.js';
import { createWorkerHealthObserver } from '../../../tools/ralph-external/lib/worker-health.mjs';
import { parseWorkerStatusArgs } from '../../../tools/ralph-external/index.mjs';
import { ConfigLoader } from '../../../src/models/config-loader.js';
import { resolveWorkerPlan } from '../../../src/models/resolver.js';
import { PROVIDER_IDS } from '../../../src/providers/provider-definitions.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

/** The worker-dispatch doc, whitespace-collapsed so assertions ignore line wrapping. */
function workerDispatchDoc(): string {
  return readFileSync(fileURLToPath(new URL('../../../docs/getting-started/worker-dispatch.md', import.meta.url)), 'utf8').replace(/\s+/g, ' ');
}

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => process.env.HOME! };
});

function makeTmpDir(): string {
  const dir = join(tmpdir(), `aiwg-parallelism-section-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write an aiwg.config file directly, bypassing `writeAiwgConfig`'s own
 * worker-model-defaults validation — used only by the AIWG_HOME-fallback
 * tests below, where that validation would otherwise require a real home
 * install that intentionally does not exist in the test fixture. */
function writeConfigFileDirect(projectDir: string, config: AiwgConfig): void {
  const path = getConfigPath(projectDir);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
}

/**
 * Detect any write (set or delete) to `process.env` during the wrapped
 * window, without the illegal `Object.defineProperty(process.env, key,
 * {get, set})` form (`process.env` rejects accessor descriptors). Swaps
 * `process.env` itself for a `Proxy` wrapping the real object, so every
 * read/write still behaves normally — only writes are additionally logged.
 */
function watchEnvWrites(): { log: Array<{ op: 'set' | 'delete'; key: string }>; restore: () => void } {
  const original = process.env;
  const log: Array<{ op: 'set' | 'delete'; key: string }> = [];
  const proxy = new Proxy(original, {
    set(target, prop, value) {
      log.push({ op: 'set', key: String(prop) });
      return Reflect.set(target, prop, value);
    },
    deleteProperty(target, prop) {
      log.push({ op: 'delete', key: String(prop) });
      return Reflect.deleteProperty(target, prop);
    },
  });
  Object.defineProperty(process, 'env', { value: proxy, configurable: true, enumerable: true, writable: true });
  return {
    log,
    restore: () => {
      Object.defineProperty(process, 'env', { value: original, configurable: true, enumerable: true, writable: true });
    },
  };
}

describe('buildParallelismSection (#1362)', () => {
  let tmpDir: string;
  const originalEnv = process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    delete process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT;
    // Locate the bundled model defaults from this checkout (same as
    // test/unit/models/resolver.test.ts); never the user's home install.
    vi.stubEnv('AIWG_HOME', process.cwd());
    vi.stubEnv('AIWG_CONFIG', join(tmpDir, 'aiwg-user-config'));
    vi.stubEnv('HOME', tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    if (originalEnv !== undefined) {
      process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT = originalEnv;
    } else {
      delete process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT;
    }
  });

  it('returns empty when no aiwg.config exists', async () => {
    const section = await buildParallelismSection(tmpDir);
    expect(section).toBe('');
  });

  it('returns empty when AIWG_HIDE_PARALLELISM_IN_CONTEXT=1 is set', async () => {
    process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT = '1';
    await writeAiwgConfig(tmpDir, emptyConfig(['claude']));
    const section = await buildParallelismSection(tmpDir);
    expect(section).toBe('');
  });

  it('includes provider-default labeling for claude', async () => {
    await writeAiwgConfig(tmpDir, emptyConfig(['claude']));
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('## Parallelism Cap');
    expect(section).toContain('follow the emitted provider-specific regeneration commands');
    expect(section).toContain('aiwg workspace-context doctor');
    expect(section).toContain('max_parallel_subagents');
    expect(section).toContain('4 (provider default for claude)');
    expect(section).toContain('2 (provider default for claude)'); // ralph loops
  });

  it('includes provider-default labeling for codex', async () => {
    await writeAiwgConfig(tmpDir, emptyConfig(['codex']));
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('10 (provider default for codex)');
    expect(section).toContain('3 (provider default for codex)'); // ralph loops
  });

  it('labels operator-overridden values', async () => {
    const cfg = emptyConfig(['claude']);
    cfg.parallelism = {
      max_parallel_subagents: 8, // override (claude default is 4)
      max_parallel_ralph_loops: 2,
      max_parallel_mc_missions: 4,
    };
    await writeAiwgConfig(tmpDir, cfg);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('8 (operator override)');
    // Non-overridden fields keep the provider-default label
    expect(section).toContain('2 (provider default for claude)');
  });

  it('includes rationale when present', async () => {
    const cfg = emptyConfig(['claude']);
    cfg.parallelism = {
      max_parallel_subagents: 4,
      max_parallel_ralph_loops: 2,
      max_parallel_mc_missions: 4,
      rationale: 'Anthropic Team plan',
    };
    await writeAiwgConfig(tmpDir, cfg);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('*Rationale*: Anthropic Team plan');
  });

  it('wraps content in managed-block markers', async () => {
    await writeAiwgConfig(tmpDir, emptyConfig(['claude']));
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain(PARALLELISM_BLOCK_START);
    expect(section).toContain(PARALLELISM_BLOCK_END);
    expect(section.indexOf(PARALLELISM_BLOCK_START)).toBeLessThan(
      section.indexOf(PARALLELISM_BLOCK_END),
    );
  });

  it('keeps project caps and provider facts while referring delegation policy to its rule', async () => {
    await writeAiwgConfig(tmpDir, emptyConfig(['codex']));
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('max_parallel_subagents');
    expect(section).toContain('aiwg show rule subagent-scoping');
    expect(section).toContain('native custom subagents');
    expect(section).not.toContain('take the MIN of');
    expect(section).not.toContain('The primary agent retains orchestration');
    expect(section).not.toContain('coordination costs');
  });

  it.each([
    ['warp', 'model selection is global/run-scoped'],
    ['hermes', 'model selection is global/run-scoped'],
    ['windsurf', 'portable subagent model selection is unsupported'],
    ['openhuman', 'wrapper roles compile to OpenHuman agent definitions'],
  ])('qualifies provider delegation for %s', async (provider, expected) => {
    await writeAiwgConfig(tmpDir, emptyConfig([provider]));
    expect(await buildParallelismSection(tmpDir)).toContain(expected);
  });

  // #3050 item 5: generated context must say the dispatch state plainly and
  // tell the agent to offer the opt-in rather than assume CLIs are unavailable.
  it('states direct worker dispatch is off and tells the agent to offer the opt-in', async () => {
    await writeAiwgConfig(tmpDir, emptyConfig(['claude']));
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('**Direct worker dispatch**: off (`parallelism.worker_dispatch`)');
    expect(section).toContain('Do not assume other worker CLIs are unavailable');
    expect(section).toContain('aiwg config set --project parallelism.worker_dispatch true');
  });

  it('states direct worker dispatch is on when enabled', async () => {
    const cfg = emptyConfig(['codex']);
    cfg.parallelism.worker_dispatch = true;
    await writeAiwgConfig(tmpDir, cfg);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('**Direct worker dispatch**: on (`parallelism.worker_dispatch`).');
    expect(section).not.toContain('Do not assume other worker CLIs are unavailable');
  });

  // #3050 review item 3: a recorded decline must not be rendered as if no
  // one had decided yet — the agent must not keep re-offering a settled no.
  it('states the decline plainly and drops the offer instruction once declined', async () => {
    const cfg = emptyConfig(['claude']);
    cfg.setup = { worker_dispatch_offer: 'declined' };
    await writeAiwgConfig(tmpDir, cfg);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('**Direct worker dispatch**: off (`parallelism.worker_dispatch`)');
    expect(section).toContain('a prior offer was declined');
    expect(section).toContain('setup.worker_dispatch_offer');
    expect(section).toContain('Do not re-offer it');
    expect(section).not.toContain('Do not assume other worker CLIs are unavailable');
  });
});

describe('orchestration groups block (#2893 / #2914)', () => {
  let tmpDir: string;
  const originalEnv = process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    delete process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT;
    // Locate the bundled model defaults from this checkout (same as
    // test/unit/models/resolver.test.ts); never the user's home install.
    vi.stubEnv('AIWG_HOME', process.cwd());
    vi.stubEnv('AIWG_CONFIG', join(tmpDir, 'aiwg-user-config'));
    vi.stubEnv('HOME', tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    if (originalEnv !== undefined) {
      process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT = originalEnv;
    } else {
      delete process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT;
    }
  });

  function groupConfig() {
    const cfg = emptyConfig(['codex']);
    cfg.parallelism.worker_dispatch = true;
    cfg.parallelism.groups = {
      'default': {
        members: [
          { id: 'codex-a', cli: 'codex', model: 'gpt-6.1-sol', roles: ['coding'] },
          { id: 'muse-b', cli: 'muse', model: 'muse-spark-1.3', roles: ['efficiency', 'coding'] },
        ],
        maxParallel: 2,
        requiredRoles: ['coding'],
      },
    };
    return cfg;
  }

  // Compact caps and authority pointer for emptyConfig(['codex']) after
  // Wave 4 deduplication, with dispatch disabled and no groups.
  const COMPACT_CAP_GOLDEN = `<!-- AIWG-PARALLELISM-CAP:START -->
## Parallelism Cap

This project caps parallel agent fan-out (#1359):

- **max_parallel_subagents**: 10 (provider default for codex)
- **max_parallel_ralph_loops**: 3 (provider default for codex)
- **max_parallel_mc_missions**: 6 (provider default for codex)

*Rationale*: Provider default for codex — adjust via 'aiwg config set --project parallelism.max_parallel_subagents N'

Delegation policy and model-worker selection: \`aiwg show rule subagent-scoping\`.
After changing project parallelism with \`aiwg config set/reset --project\`, follow the emitted provider-specific regeneration commands and run \`aiwg workspace-context doctor\`.

**Provider behavior (codex)**: native custom subagents can select the deployed model-worker wrapper. Verify the resolved model when provider or account policy may substitute it. Tier enforcement (generated wrapper defaults): pinned; effort: pinned via model_reasoning_effort (high/medium/low by wrapper). Native custom subagents carry explicit catalog model selectors. Explicit operator pins are preserved where supported. This is not a live resolved-model audit; provider/account policy may substitute models.

**Direct worker dispatch**: off (\`parallelism.worker_dispatch\`). Do not assume other worker CLIs are unavailable — detect them yourself and offer \`aiwg config set --project parallelism.worker_dispatch true\` to the user if it would help.

<!-- AIWG-PARALLELISM-CAP:END -->
`;

  it('dispatch disabled renders compact caps and the rule pointer', async () => {
    await writeAiwgConfig(tmpDir, emptyConfig(['codex']));
    expect(await buildParallelismSection(tmpDir)).toBe(COMPACT_CAP_GOLDEN);
  });

  it('dispatch explicitly false renders the same compact section even with groups configured', async () => {
    const cfg = groupConfig();
    cfg.parallelism.worker_dispatch = false;
    await writeAiwgConfig(tmpDir, cfg);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toBe(COMPACT_CAP_GOLDEN);
    expect(section).not.toContain('Orchestration groups');
  });

  it('dispatch enabled renders configured groups as configured, never labeled eligible/not-eligible, with a request-scoped resolve pointer', async () => {
    await writeAiwgConfig(tmpDir, groupConfig());
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('### Orchestration groups (group dispatch enabled)');
    expect(section).toContain('Configured groups:');
    expect(section).toContain('default (members: 2');
    expect(section).toContain('maxParallel: 2');
    expect(section).toContain('requiredRoles: coding');
    expect(section).toContain('; configured)');
    expect(section).not.toContain('eligible)');
    expect(section).not.toContain('not eligible');
    expect(section).toContain('is a static config read — not a live eligibility verdict');
    expect(section).toContain('resolved per (group, member, effort) tuple');
    expect(section).toContain('aiwg models resolve` below');
    expect(section).not.toContain('Available groups');
    expect(section.indexOf('### Orchestration groups')).toBeGreaterThan(
      section.indexOf(PARALLELISM_BLOCK_START),
    );
    expect(section.indexOf('### Orchestration groups')).toBeLessThan(
      section.indexOf(PARALLELISM_BLOCK_END),
    );
  });

  it('dispatch enabled with a disabled member lists that member excluded without excluding the whole group', async () => {
    const cfg = groupConfig();
    cfg.parallelism.groups!.stale = {
      members: [
        { id: 'codex-c', cli: 'codex', model: 'gpt-6.1-sol', roles: ['coding'] },
        { id: 'muse-d', cli: 'muse', model: 'muse-spark-1.3', roles: ['coding'], enabled: false },
      ],
    };
    await writeAiwgConfig(tmpDir, cfg);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('default (members: 2');
    expect(section).toContain('stale (members: 2');
    // The group itself is "configured" — only the disabled member is excluded.
    expect(section).toContain('stale (members: 2; clis: codex/muse; roles: coding; configured; excluded members: muse-d (member disabled))');
    expect(section).not.toContain('not eligible');
    expect(section).not.toContain('Available groups');
  });

  it('a config with an uncoverable required role is rejected before rendering (validateParallelismConfig OG_CONFIG_REFERENCE)', async () => {
    // Confirms the premise behind dropping "uncovered role" rendering: this
    // shape never reaches `groupSummaries()` because `writeAiwgConfig` (and
    // `buildParallelismSection`'s own `resolveParallelism()` call) reject it
    // first, every single enabled-member exclusion remains representable.
    const cfg = groupConfig();
    cfg.parallelism.groups!.default.members = [
      { id: 'codex-a', cli: 'codex', model: 'gpt-6.1-sol', roles: ['coding'], enabled: false },
    ];
    await expect(writeAiwgConfig(tmpDir, cfg)).rejects.toThrow('No enabled member covers coding');
  });

  it('dispatch enabled without groups keeps the native rubric and names no Available groups', async () => {
    const cfg = emptyConfig(['codex']);
    cfg.parallelism.worker_dispatch = true;
    await writeAiwgConfig(tmpDir, cfg);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('Configured groups: none');
    expect(section).toContain('the subagent-scoping rule applies');
    expect(section).not.toContain('Available groups');
    expect(section).not.toContain('keep work local or add a group');
  });

  it('overriding all five health settings changes the rendered numbers and shows project origin', async () => {
    const cfg = groupConfig();
    cfg.parallelism.health = {
      checkSeconds: 7, startupSeconds: 30, quietSeconds: 45, stallSeconds: 120, hardTimeoutSeconds: 600,
    };
    await writeAiwgConfig(tmpDir, cfg);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('check every 7s (project config)');
    expect(section).toContain('startup 30s (project config)');
    expect(section).toContain('quiet 45s (project config)');
    expect(section).toContain('stall 120s (project config)');
    expect(section).toContain('hard stop 600s (project config)');
    expect(section).not.toContain('every 15s');
    expect(section).not.toContain('(default)');
  });

  it('unconfigured health renders defaults with default origin', async () => {
    await writeAiwgConfig(tmpDir, groupConfig());
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('check every 15s (default)');
    expect(section).toContain('startup 60s (default)');
    expect(section).toContain('quiet 90s (default)');
    expect(section).toContain('stall 300s (default)');
    expect(section).toContain('hard stop 1800s (default)');
    expect(section).toContain('Resolved values win');
    expect(section).toContain('--format json');
    expect(section).toContain('invocation.health');
  });

  it('omits only the orchestration/health block with a one-line note when bundled defaults cannot be loaded, preserving caps and rubric', async () => {
    await writeAiwgConfig(tmpDir, groupConfig());
    const section = await buildParallelismSection(tmpDir, {
      validateWorkerConfig: () => Promise.reject(new Error('Failed to load AIWG default config: Error: ENOENT: no such file or directory')),
    });
    expect(section).toContain(PARALLELISM_BLOCK_START);
    expect(section).toContain(PARALLELISM_BLOCK_END);
    expect(section).toContain(PARALLELISM_HEALTH_UNRESOLVED_NOTE);
    // Everything that does not depend on the worker-model defaults still renders.
    expect(section).toContain('max_parallel_subagents');
    expect(section).toContain('*Rationale*:');
    expect(section).toContain('aiwg show rule subagent-scoping');
    expect(section).not.toContain('### Model-selected delegation rubric');
    expect(section).toContain('aiwg show rule subagent-scoping');
    expect(section).toContain('native custom subagents');
    // Only the orchestration/health details that need the defaults are omitted.
    expect(section).not.toContain('### Orchestration groups');
    expect(section).not.toContain('Configured groups:');
    expect(section).not.toContain('Configured health windows');
    const noteLines = section.split('\n').filter((line) => line.includes('could not be resolved'));
    expect(noteLines).toHaveLength(1);
  });

  it('propagates a worker-config validation error unrelated to bundled defaults instead of degrading', async () => {
    await writeAiwgConfig(tmpDir, groupConfig());
    await expect(buildParallelismSection(tmpDir, {
      validateWorkerConfig: () => Promise.reject(new Error('OG_CONFIG_REFERENCE: some unrelated fatal validation error')),
    })).rejects.toThrow('some unrelated fatal validation error');
  });

  it('every advertised CLI command parses in the real argument parsers', async () => {
    await writeAiwgConfig(tmpDir, groupConfig());
    const section = await buildParallelismSection(tmpDir);
    const resolveMatch = /`(aiwg models resolve [^`]+)`/.exec(section);
    expect(resolveMatch).not.toBeNull();
    const argv = resolveMatch![1].split(' ').slice(3).map((token) => token
      .replace('<role>', 'coding').replace('<class>', 'bugfix').replace('<group>', 'default')
      .replace('<file>', '/tmp/brief.md').replace('<tree>', '/tmp/tree'));
    const request = parseWorkerCommandArgs(argv);
    expect(request).toMatchObject({
      role: 'coding', task: 'bugfix', group: 'default', brief: '/tmp/brief.md',
      workdir: '/tmp/tree', final_output: '/tmp/brief.md', transport: 'shell', format: 'shell',
    });
    const jsonArgv = argv.map((token, index) => (token === 'shell' && argv[index - 1] === '--format' ? 'json' : token));
    expect(parseWorkerCommandArgs(jsonArgv).format).toBe('json');
    const statusMatch = /`(aiwg ralph-external --status --workers --runs-root [^`]+)`/.exec(section);
    expect(statusMatch).not.toBeNull();
    const statusArgv = statusMatch![1].split(' ').slice(2).map((token) => (token === '<dir>' ? '/tmp/runs' : token));
    expect(parseWorkerStatusArgs(statusArgv)).toMatchObject({ runsRoot: '/tmp/runs', json: true });
    expect(section).not.toContain('doctor --groups');
    expect(section).not.toContain('steward models --group');
  });

  it('100 groups render at most eight summaries with a +N more tail', async () => {
    const cfg = emptyConfig(['codex']);
    cfg.parallelism.worker_dispatch = true;
    cfg.parallelism.groups = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`g-${i}`, {
      members: [{ id: `m-${i}`, cli: 'codex', model: 'gpt-6.1-sol', roles: ['coding'] }],
    }]));
    await writeAiwgConfig(tmpDir, cfg);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('(+92 more)');
    expect((section.match(/\(members: /g) ?? []).length).toBe(MAX_SHOWN_GROUPS);
    expect(section.length).toBeLessThan(12000);
  });

  it('quiet-state guidance matches the observer: quiet never stops, only hung authorizes an owned stop', async () => {
    let now = 0;
    const observer = createWorkerHealthObserver({
      invocationId: 'guidance-quiet', now: () => now, wallNow: () => 0,
      launchTime: new Date(0).toISOString(), health: { handshake: 'process-only' },
    });
    observer.processStarted({ pid: 1, startTicks: 100, executable: '/usr/bin/codex' });
    now = 91_000;
    expect(observer.check(now).state).toBe('quiet');
    expect(observer.check(now).confidence).toBe('suspected');
    expect(observer.shouldStop()).toBe(false);
    now = 301_000;
    expect(observer.check(now).state).toBe('stalled');
    expect(observer.shouldStop()).toBe(false);
    now = 361_000;
    expect(observer.check(now).state).toBe('hung');
    expect(observer.shouldStop()).toBe(false);
    await writeAiwgConfig(tmpDir, groupConfig());
    const section = await buildParallelismSection(tmpDir);
    // #3451: AIWG.md keeps a one-line summary; the long supervision guidance
    // lives in the worker-dispatch doc, which the section points to by plain path.
    expect(section).toContain('only `hung` authorizes a no-progress stop');
    expect(section).toContain(WORKER_HEALTH_DOC_POINTER);
    expect(section).not.toContain('Supervise by observer state, never by suspicion');
    const doc = workerDispatchDoc();
    expect(doc).not.toContain('suspect transition');
    expect(doc).toContain('is not a stop');
    expect(doc).toContain('only `hung`');
    expect(doc).toContain('a no-progress stop');
    expect(doc).toContain('only a worker this conductor owns');
    expect(doc).toContain('Confirm the stop');
    expect(doc).toContain('preserve partial work');
    expect(doc).toContain('OBSERVER_GAP');
    expect(doc).toContain('unknown, never worker failure');
    expect(doc).toContain('Heartbeats and log bytes are not progress');
    // "only `hung`" is scoped to no-progress diagnosis; the launcher's other
    // independent stop conditions (session-launcher.mjs ~596) are named too.
    expect(doc).toContain('stops independently of progress state');
    expect(doc).toContain('failed-to-start');
    expect(doc).toContain('HARD_DEADLINE');
    expect(doc).toContain('STEP_LIMIT');
    expect(doc).toContain('fatal observer-record failure');
  });

  it('preserves caps and rubric alongside the dispatch block', async () => {
    await writeAiwgConfig(tmpDir, groupConfig());
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('max_parallel_subagents');
    expect(section).toContain('aiwg show rule subagent-scoping');
  });

  it('documents health-window scaling (largest factor, never a product; only the hard deadline is capped) in the worker-dispatch doc, not AIWG.md', async () => {
    await writeAiwgConfig(tmpDir, groupConfig());
    const section = await buildParallelismSection(tmpDir);
    expect(section).not.toContain('truncatedWindows');
    expect(section).not.toContain('112.5s/375s');
    expect(section).toContain(WORKER_HEALTH_DOC_POINTER);
    const doc = workerDispatchDoc();
    expect(doc).toContain('the single largest applicable role/effort/model factor, never their product');
    expect(doc).toContain('180s/600s from the 90s/300s defaults');
    expect(doc).toContain('112.5s/375s');
    expect(doc).toContain('Only the hard deadline and its diagnostic/termination grace periods are capped by the remaining wall-clock and transport ceilings');
    expect(doc).toContain('startup, quiet, and stall keep their configured or scaled values');
    expect(doc).toContain('truncatedWindows');
    expect(doc).not.toContain('cap every window');
  });

  it('never writes process.env.AIWG_HOME while resolving the config (no set/delete observed)', async () => {
    await writeAiwgConfig(tmpDir, groupConfig());
    const watch = watchEnvWrites();
    try {
      await buildParallelismSection(tmpDir);
    } finally {
      watch.restore();
    }
    expect(watch.log.filter((entry) => entry.key === 'AIWG_HOME')).toEqual([]);
  });

  it('two concurrent builds resolve independently without observing or mutating a shared AIWG_HOME', async () => {
    const dirA = makeTmpDir();
    const dirB = makeTmpDir();
    try {
      await writeAiwgConfig(dirA, groupConfig());
      await writeAiwgConfig(dirB, emptyConfig(['claude']));
      const watch = watchEnvWrites();
      let sectionA = '';
      let sectionB = '';
      try {
        [sectionA, sectionB] = await Promise.all([
          buildParallelismSection(dirA),
          buildParallelismSection(dirB),
        ]);
      } finally {
        watch.restore();
      }
      expect(sectionA).toContain('### Orchestration groups');
      expect(sectionB).not.toContain('### Orchestration groups');
      expect(sectionB).toContain('4 (provider default for claude)');
      expect(watch.log.filter((entry) => entry.key === 'AIWG_HOME')).toEqual([]);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

describe('T-OG-07/12/15/19 remaining parallelism policy facts (#2893)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    vi.stubEnv('HOME', tmpDir);
    vi.stubEnv('AIWG_HOME', process.cwd());
    vi.stubEnv('AIWG_CONFIG', join(tmpDir, 'user-config'));
    vi.stubEnv('AIWG_HIDE_PARALLELISM_IN_CONTEXT', '');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function writeFixture(f = workerResolutionFixture()) {
    writeConfigFileDirect(tmpDir, f.snapshot.config);
    writeFileSync(join(tmpDir, 'models.json'), JSON.stringify({ version: '2.0', defaults: { workerSelection: f.projectPolicy } }));
    mkdirSync(join(tmpDir, '.cache/aiwg'), { recursive: true });
    writeFileSync(join(tmpDir, '.cache/aiwg/model-catalog.v1.json'), JSON.stringify(f.snapshot.catalog));
    return f;
  }

  it('G01 renders real cached timestamps and ages without converting a cache read into eligibility', async () => {
    const f = writeFixture();
    const now = new Date(Date.parse(f.request.now) + 3600_000); f.snapshot.hostResources!.collectedAt = now.toISOString();
    const before = structuredClone(f);
    const section = await buildParallelismSection(tmpDir, { now: () => now });
    const selected = resolveWorkerPlan(f.snapshot, { ...f.request, now: now.toISOString() }).selected!;
    expect(section).toContain(`Cached model observations read at ${now.toISOString()}`);
    expect(section).toContain(`catalog fetchedAt: ${new Date(f.snapshot.catalog.discovery!.fetchedAt).toISOString()} (3600s old)`);
    expect(section).toContain(`observedAt: ${new Date(selected.observedAt).toISOString()} (3600s old)`);
    expect(section).toContain(`verifiedAt: ${new Date(selected.verifiedAt).toISOString()} (3600s old)`);
    expect(section).toContain('workers cached observations: 2/2 members');
    expect(section).toContain('no eligibility read is performed by context generation');
    expect(section).toContain('Ages are measured at this read and grow afterward');
    expect(f).toEqual(before);
  });

  it('G02 preserves mixed observation ages and reports missing or ambiguous member evidence as unknown', async () => {
    const f = workerResolutionFixture();
    const rows = f.snapshot.catalog.discovery!.instances!.codex.models;
    rows[1].worker!.observedAt = '2026-10-08T00:00:00Z';
    writeFixture(f);
    const deps = { now: () => new Date('2026-10-09T00:00:00Z') };
    expect(await buildParallelismSection(tmpDir, deps)).toContain('observedAt: 2026-10-07T00:00:00.000Z (172800s old) to 2026-10-08T00:00:00.000Z (86400s old)');
    rows.push(structuredClone(rows[0]));
    delete rows[1].worker;
    writeFixture(f);
    expect(await buildParallelismSection(tmpDir, deps)).toContain('workers cached observations: 0/2 members; observedAt: unknown; verifiedAt: unknown');
  });

  it.each(['missing', 'corrupt', 'invalid'] as const)('G03 reports unknown ages for a %s catalog', async kind => {
    writeFixture();
    const cache = join(tmpDir, '.cache/aiwg/model-catalog.v1.json');
    if (kind === 'missing') rmSync(cache);
    if (kind === 'corrupt') writeFileSync(cache, '{');
    if (kind === 'invalid') writeFileSync(cache, JSON.stringify({ version: '1', providers: {}, discovery: { fetchedAt: 'invented' } }));
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('catalog fetchedAt: unknown');
    expect(section).toContain('workers cached observations: 0/2 members; observedAt: unknown; verifiedAt: unknown');
    expect(section).not.toContain('invented');
  });

  it('G04 labels future evidence without inventing a nonnegative age and the resolver blocks it', async () => {
    const f = writeFixture();
    const now = new Date(Date.parse(f.request.now) - 1000);
    const section = await buildParallelismSection(tmpDir, { now: () => now });
    expect(section).toContain('future timestamp; age unavailable');
    expect(section).toContain('Future-dated evidence is blocked');
    expect(resolveWorkerPlan(f.snapshot, { ...f.request, now: now.toISOString() }).selected).toBeNull();
  });

  it('G05 renders merged freshness limits and matches resolver warning/block boundaries', async () => {
    const f = workerResolutionFixture();
    f.projectPolicy.freshness = { warnHours: 1, blockHours: 2, policyDays: 3 };
    writeFixture(f);
    const models = await new ConfigLoader(tmpDir).load(f.snapshot.config.parallelism);
    f.snapshot.models = models;
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('observation warning after 1 hours; observation blocked after 2 hours; verification blocked after 3 days');
    const resolveAt = (hours: number) => resolveWorkerPlan(f.snapshot, {
      ...f.request, now: f.snapshot.hostResources!.collectedAt = new Date(Date.parse(f.request.now) + hours * 3600_000).toISOString(),
    });
    expect(resolveAt(1).selected?.diagnostics).toEqual([]);
    expect(resolveAt(1.5).selected?.diagnostics).toContainEqual(expect.objectContaining({ blocking: false }));
    expect(resolveAt(2).selected).not.toBeNull();
    expect(resolveAt(2.01).selected).toBeNull();
    for (const row of f.snapshot.catalog.discovery!.instances!.codex.models) row.worker!.verifiedAt = '2026-10-03T00:00:00Z';
    expect(resolveAt(0).selected).toBeNull();
  });

  it('G06 explains required cross-family review and matches missing, same, unknown and conflicting lineage guards', async () => {
    const f = writeFixture();
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain('reviewer must use a different observed model family from the writer');
    expect(section).toContain('Different CLI names do not prove different families');
    expect(section).toContain('direct CLI does not accept review-lineage flags');
    expect(section).toContain('Family diversity does not establish independent errors');
    expect(section).toContain('same-vendor or cross-vendor agreement is not proof');
    expect(section).toContain('Consequential claims require an executable check or human acceptance');
    f.request.requireDifferentFamily = true;
    expect(resolveWorkerPlan(f.snapshot, f.request).selected).toBeNull();
    f.request.reviewOf = { ...structuredClone(f.observation), cliId: 'muse' };
    expect(resolveWorkerPlan(f.snapshot, f.request).selected).toBeNull();
    f.snapshot.catalog.discovery!.instances!.codex.models[1].worker!.family = 'independent-family';
    expect(resolveWorkerPlan(f.snapshot, f.request).selected?.member).toBe('alternate');
    f.request.reviewOf.family = 'unknown';
    expect(resolveWorkerPlan(f.snapshot, f.request).selected).toBeNull();
    f.request.reviewOf = { ...structuredClone(f.observation), conflicts: [{ field: '/family', evidence: ['a', 'b'].map(value => ({
      value, source: 'fixture:family', pointer: '/family', observedAt: f.request.now, digest: f.observation.provenance[0].digest,
    })) }] };
    expect(resolveWorkerPlan(f.snapshot, f.request).selected).toBeNull();
    const argv = ['--role', 'coding', '--task', 'implementation', '--group', 'workers', '--brief', '/tmp/brief', '--workdir', '/tmp/tree', '--final-output', '/tmp/final'];
    for (const flag of ['--review-of', '--require-different-family']) expect(() => parseWorkerCommandArgs([...argv, flag, 'synthetic'])).toThrow('Unsupported');
  });

  it.each(['groupCaps', 'memberCaps', 'cliCaps', 'modelCaps', 'quotaCaps'] as const)('G07 renders %s and matches the resolver minimum for local processing', async field => {
    const f = workerResolutionFixture();
    const p = f.snapshot.config.parallelism!;
    p.max_parallel_subagents = 12;
    p.groups!.workers.maxParallel = 10;
    p.clis = { codex: { adapter: 'providers:codex', accountScope: 'synthetic', quotaScope: 'local-shared' } };
    for (const row of f.snapshot.catalog.discovery!.instances!.codex.models) row.worker!.dataUse.processing = 'local';
    const keys = { groupCaps: 'workers', memberCaps: 'workers/primary', cliCaps: 'codex', modelCaps: 'vendor/synthetic%2Fa%25b', quotaCaps: 'local-shared' };
    p.admission = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, { [key]: name === field ? 1 : 9 }]));
    writeFixture(f);
    const section = await buildParallelismSection(tmpDir);
    expect(section).toContain(`${field}: ${keys[field]}=1`);
    expect(section).toContain('Local/self-hosted models obey these same ceilings');
    expect(section).toContain('Tier 0 conductors must self-count active workers');
    expect(section).toContain('outside your own harness sandbox');
    expect(section).toContain('`sandbox.excludedCommands` or an unsandboxed Bash call');
    expect(section).toContain('never nest sandboxes');
    expect(section).not.toContain('your own harness sandbox applies');
    expect(resolveWorkerPlan(f.snapshot, f.request).selected?.effectiveMaxParallel).toBe(1);
    f.request.maxParallel = 0;
    expect(section).toContain('a current/request capacity ceiling of zero blocks selection');
    expect(resolveWorkerPlan(f.snapshot, f.request).selected).toBeNull();
  });

  it.each(PROVIDER_IDS)('G08 renders identical group policy facts for conductor %s', async provider => {
    const f = writeFixture();
    const deps = { now: () => new Date(f.request.now) };
    const baseline = await buildParallelismSection(tmpDir, deps);
    f.snapshot.config.providers = [provider];
    writeFixture(f);
    const section = await buildParallelismSection(tmpDir, deps);
    const groupBlock = (text: string) => text.slice(text.indexOf('### Orchestration groups'));
    expect(groupBlock(section)).toBe(groupBlock(baseline));
    const original = `Operator introduction\n${baseline}\nOperator closing text`;
    const replaced = replaceOrAppendParallelismBlock(original, section);
    expect(replaced).toContain('Operator introduction');
    expect(replaced).toContain('Operator closing text');
    expect(replaced.split(PARALLELISM_BLOCK_START)).toHaveLength(2);
  });

  it('G09 hiding guidance leaves resolver review and capacity guards intact and reads no catalog', async () => {
    const f = writeFixture();
    const readCatalog = vi.fn();
    vi.stubEnv('AIWG_HIDE_PARALLELISM_IN_CONTEXT', '1');
    expect(await buildParallelismSection(tmpDir, { readCatalog })).toBe('');
    expect(readCatalog).not.toHaveBeenCalled();
    f.request.requireDifferentFamily = true;
    expect(resolveWorkerPlan(f.snapshot, f.request).selected).toBeNull();
    delete f.request.requireDifferentFamily;
    f.request.maxParallel = 0;
    expect(resolveWorkerPlan(f.snapshot, f.request).selected).toBeNull();
  });
});

describe('AIWG_HOME bundled-defaults fallback with no env mutation (#1362 fix-first review item 1)', () => {
  let projectDir: string;
  let emptyHomeDir: string;
  const originalAiwgHome = process.env.AIWG_HOME;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    projectDir = makeTmpDir();
    emptyHomeDir = makeTmpDir();
    delete process.env.AIWG_HIDE_PARALLELISM_IN_CONTEXT;
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(emptyHomeDir, { recursive: true, force: true });
    if (originalAiwgHome !== undefined) process.env.AIWG_HOME = originalAiwgHome;
    else delete process.env.AIWG_HOME;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it('resolves bundled defaults via findPackageRoot when AIWG_HOME is unset and HOME is an empty temp dir', async () => {
    delete process.env.AIWG_HOME;
    process.env.HOME = emptyHomeDir; // no `.local/share/ai-writing-guide` exists here
    const cfg = emptyConfig(['codex']);
    cfg.parallelism.worker_dispatch = true;
    cfg.parallelism.groups = {
      default: { members: [{ id: 'codex-a', cli: 'codex', model: 'gpt-6.1-sol', roles: ['coding'] }] },
    };
    // Bypass writeAiwgConfig's own validation: it resolves ConfigLoader's
    // default location directly from AIWG_HOME/HOME with no bundled-defaults
    // fallback, so it would fail here even though the generator should not.
    writeConfigFileDirect(projectDir, cfg);
    const section = await buildParallelismSection(projectDir);
    expect(section).not.toContain(PARALLELISM_HEALTH_UNRESOLVED_NOTE);
    expect(section).toContain('### Orchestration groups (group dispatch enabled)');
    expect(section).toContain('check every 15s (default)');
    expect(section).toContain('hard stop 1800s (default)');
  });
});

describe('replaceOrAppendParallelismBlock (#1362)', () => {
  const FAKE_SECTION = [
    PARALLELISM_BLOCK_START,
    '## Parallelism Cap',
    'fake',
    PARALLELISM_BLOCK_END,
    '',
  ].join('\n');

  it('appends section to content with no existing block', () => {
    const original = '# Some doc\n\nbody content';
    const result = replaceOrAppendParallelismBlock(original, FAKE_SECTION);
    expect(result).toContain('# Some doc');
    expect(result).toContain(PARALLELISM_BLOCK_START);
    expect(result.endsWith(FAKE_SECTION)).toBe(true);
  });

  it('replaces existing block in-place', () => {
    const original = `# Doc\n${PARALLELISM_BLOCK_START}\nOLD\n${PARALLELISM_BLOCK_END}\n\nrest of doc`;
    const result = replaceOrAppendParallelismBlock(original, FAKE_SECTION);
    expect(result).not.toContain('OLD');
    expect(result).toContain('fake');
    expect(result).toContain('rest of doc');
    // Block appears exactly once
    const startMatches = result.split(PARALLELISM_BLOCK_START).length - 1;
    expect(startMatches).toBe(1);
  });

  it('strips existing block when new section is empty', () => {
    const original = `# Doc\n\n${PARALLELISM_BLOCK_START}\nOLD\n${PARALLELISM_BLOCK_END}\n\nrest`;
    const result = replaceOrAppendParallelismBlock(original, '');
    expect(result).not.toContain(PARALLELISM_BLOCK_START);
    expect(result).not.toContain(PARALLELISM_BLOCK_END);
    expect(result).toContain('# Doc');
    expect(result).toContain('rest');
  });

  it('returns content unchanged when no block and section is empty', () => {
    const original = '# Doc\n\nbody';
    const result = replaceOrAppendParallelismBlock(original, '');
    expect(result).toBe(original);
  });

  it('preserves content before and after a regenerated block', () => {
    const original = `# Doc\nintro\n\n${PARALLELISM_BLOCK_START}\nOLD\n${PARALLELISM_BLOCK_END}\n\noutro`;
    const result = replaceOrAppendParallelismBlock(original, FAKE_SECTION);
    expect(result).toMatch(/^# Doc\nintro/);
    expect(result).toContain('outro');
  });
});
