import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const script = resolve(__dirname, '../../../tools/providers/grok-build-native-smoke.mjs');

describe('Grok Build live smoke gate', () => {
  it('skips without opt-in or a provisioned binary', () => {
    const env = { ...process.env };
    delete env.AIWG_GROK_BUILD_LIVE_SMOKE;
    const off = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 30_000 });
    expect(off.status).toBe(0);
    expect(JSON.parse(off.stdout)).toMatchObject({ status: 'skipped' });
    const missing = spawnSync(process.execPath, [script], {
      env: { ...env, AIWG_GROK_BUILD_LIVE_SMOKE: '1', AIWG_GROK_BUILD_BIN: '/nonexistent/grok' }, encoding: 'utf8', timeout: 30_000,
    });
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({ status: 'skipped', reason: 'Grok Build binary unavailable' });
  });

  it('refuses an unpinned binary before execution', () => {
    const result = spawnSync(process.execPath, [script], {
      env: {
        ...process.env, AIWG_GROK_BUILD_LIVE_SMOKE: '1',
        AIWG_GROK_BUILD_BIN: process.execPath, XAI_API_KEY: 'fixture-not-a-secret',
        AIWG_GROK_BUILD_EXPECTED_SHA256: '0'.repeat(64),
      }, encoding: 'utf8', timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SHA-256 mismatch');
    expect(result.stdout).not.toContain('fixture-not-a-secret');
  });
});
