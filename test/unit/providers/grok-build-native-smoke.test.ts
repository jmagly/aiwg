import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const script = resolve(__dirname, '../../../tools/providers/grok-build-native-smoke.mjs');
const fixture = readFileSync(new URL('../../fixtures/providers/grok-build/health/stream.ndjson', import.meta.url), 'utf8');
const end = JSON.stringify({ type: 'end', stopReason: 'end_turn' });
const stream = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n');

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

  it.each([
    [fixture, 'passed'],
    [end, 'passed'],
    ...['max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].map(stopReason => [stream({ type: 'end', stopReason }), 'failed']),
    ...['tool_call', 'tool_call_update'].map(type => [stream({ type, toolCallId: 't1', status: 'failed' }) + '\n' + end, 'failed']),
    [stream({ type: 'error', message: 'synthetic failure' }) + '\n' + end, 'failed'],
    ...['message', 'result', 'unknown'].map(type => [stream({ type }) + '\n' + end, 'failed']),
    [stream({ text: 'JSON result', stopReason: 'end_turn' }) + '\n' + end, 'failed'],
    ['null\n' + end, 'failed'],
    ['[]\n' + end, 'failed'],
    ['not json\n' + end, 'failed'],
    [end + '\n' + stream({ type: 'text', data: 'late' }), 'failed'],
    [stream({ type: 'text', data: 'no end' }), 'failed'],
  ])('parses synthetic ACP smoke stream %j as %s', (wire, status) => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-grok-smoke-'));
    try {
      // A local executable with synthetic stream output, never a model CLI.
      const binary = join(root, 'fake-grok');
      const body = `#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('grok 1.0.50 synthetic');}else{console.log(${JSON.stringify(wire)});}`;
      writeFileSync(binary, body, { mode: 0o700 });
      const result = spawnSync(process.execPath, [script], {
        cwd: root, env: { PATH: process.env.PATH, AIWG_GROK_BUILD_LIVE_SMOKE: '1', AIWG_GROK_BUILD_BIN: binary,
          AIWG_GROK_BUILD_EXPECTED_SHA256: createHash('sha256').update(body).digest('hex'), XAI_API_KEY: 'synthetic' },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status).toBe(status === 'passed' ? 0 : 1);
      expect(JSON.parse(result.stdout)).toMatchObject({ status });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
