/**
 * Unit tests for resolveRlmParallel — RLM CLI --parallel/--max-parallel
 * resolution against the aiwg.config parallelism cap.
 *
 * @source @src/rlm/cli.ts
 * @implements #1360
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveRlmParallel } from '../../../src/rlm/cli.js';
import { emptyConfig, writeAiwgConfig } from '../../../src/config/aiwg-config.js';

const ARTIFACT_ENV_KEYS = [
  'AIWG_ARTIFACTS_PATH',
  'AIWG_PROJECT_ARTIFACTS_PATH',
  'AIWG_PROJECT_AIWG_DIR',
] as const;

describe('resolveRlmParallel (#1360)', () => {
  let tmpDir: string;
  let originalArtifactEnv: Array<string | undefined>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aiwg-rlm-parallel-'));
    originalArtifactEnv = ARTIFACT_ENV_KEYS.map(key => process.env[key]);
    for (const key of ARTIFACT_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } finally {
      ARTIFACT_ENV_KEYS.forEach((key, index) => {
        const original = originalArtifactEnv[index];
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
      });
    }
  });

  describe('without aiwg.config', () => {
    it('uses fallback default when no user value and no config', async () => {
      const r = await resolveRlmParallel(undefined, 5, tmpDir);
      expect(r.effective).toBe(5);
      expect(r.source).toBe('fallback-default');
      expect(r.warning).toBeUndefined();
    });

    it('uses user value when below RLM hard cap', async () => {
      const r = await resolveRlmParallel(3, 5, tmpDir);
      expect(r.effective).toBe(3);
      expect(r.source).toBe('user-flag');
    });

    it('clamps user value to RLM hard cap of 7 when no config', async () => {
      const r = await resolveRlmParallel(20, 5, tmpDir);
      expect(r.effective).toBe(7);
      expect(r.source).toBe('rlm-hard-cap');
      expect(r.warning).toMatch(/RLM Rule 8 hard cap/);
    });
  });

  describe('with aiwg.config parallelism block', () => {
    it('uses provider cap as default when no user flag', async () => {
      const cfg = emptyConfig(['claude']); // claude default = 4
      await writeAiwgConfig(tmpDir, cfg);
      const r = await resolveRlmParallel(undefined, 5, tmpDir);
      expect(r.effective).toBe(4);
      expect(r.source).toBe('provider-default');
    });

    it('uses codex cap=10, then clamps to RLM hard cap of 7', async () => {
      const cfg = emptyConfig(['codex']); // codex default = 10
      await writeAiwgConfig(tmpDir, cfg);
      const r = await resolveRlmParallel(undefined, 5, tmpDir);
      // min(10, 7) = 7
      expect(r.effective).toBe(7);
      expect(r.source).toBe('rlm-hard-cap');
    });

    it('clamps user value when above provider cap', async () => {
      const cfg = emptyConfig(['claude']); // cap = 4
      await writeAiwgConfig(tmpDir, cfg);
      const r = await resolveRlmParallel(10, 5, tmpDir);
      expect(r.effective).toBe(4);
      expect(r.source).toBe('provider-cap-clamp');
      expect(r.warning).toMatch(/parallelism\.max_parallel_subagents=4/);
    });

    it('honors user value when below provider cap', async () => {
      const cfg = emptyConfig(['claude']); // cap = 4
      await writeAiwgConfig(tmpDir, cfg);
      const r = await resolveRlmParallel(2, 5, tmpDir);
      expect(r.effective).toBe(2);
      expect(r.source).toBe('user-flag');
      expect(r.warning).toBeUndefined();
    });

    it('honors operator override over provider default', async () => {
      const cfg = emptyConfig(['claude']);
      cfg.parallelism = {
        max_parallel_subagents: 6,
        max_parallel_ralph_loops: 2,
        max_parallel_mc_missions: 4,
      };
      await writeAiwgConfig(tmpDir, cfg);
      const r = await resolveRlmParallel(undefined, 5, tmpDir);
      expect(r.effective).toBe(6);
      expect(r.source).toBe('provider-default');
    });

    it('clamps operator override above 7 to RLM hard cap', async () => {
      const cfg = emptyConfig(['claude']);
      cfg.parallelism = {
        max_parallel_subagents: 15,
        max_parallel_ralph_loops: 2,
        max_parallel_mc_missions: 4,
      };
      await writeAiwgConfig(tmpDir, cfg);
      const r = await resolveRlmParallel(undefined, 5, tmpDir);
      expect(r.effective).toBe(7);
      expect(r.source).toBe('rlm-hard-cap');
    });
  });
});
