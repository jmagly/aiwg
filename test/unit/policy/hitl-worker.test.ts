// A dispatched worker must read the workspace ledger, never a parent's in-memory approval.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { hitlDigest } from '../../../src/policy/hitl.js';
import { emptyConfig } from '../../../src/config/aiwg-config.js';
import { processGrant, processProject } from '../../fixtures/policy/process-authorization.js';

const execute = promisify(execFile);
describe('dispatched worker authorization lookup', () => {
  let dir: string; let other: string;
  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AIWG_EFFECT_LEDGER_TEST_KEY', 'a'.repeat(64));
    dir = await processProject(); other = await processProject();
  });
  afterEach(async () => {
    vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); await rm(other, { recursive: true, force: true });
  });
  async function dispatch(cli: string, cwd: string) {
    const { stdout } = await execute(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'),
      resolve('test/fixtures/policy/authorization-worker.mts'), cli], {
      cwd, env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'), AIWG_RESOLVE_IMPL_FROM: 'src' }, timeout: 20_000,
    });
    return JSON.parse(stdout);
  }
  it.each(['codex', 'muse'])('honours the same signed grant in a fresh %s worker in this workspace', async cli => {
    const grant = await processGrant(dir);
    const checked = await dispatch(cli, dir);
    expect(checked).toMatchObject({ decision: 'auto-authorized', provenance: 'durable-user',
      authorizationGrant: { grantId: grant.grantId }, receipt: { effectId: expect.any(String) } });
    expect(JSON.parse(await readFile(checked.receipt.file, 'utf8'))).toMatchObject({ action: { actorDigest: hitlDigest(`worker:${cli}`) } });
  });
  it.each(['codex', 'muse'])('retains review in a different workspace even if %s receives a copied ledger', async cli => {
    await processGrant(dir);
    await cp(join(dir, '.aiwg'), join(other, '.aiwg'), { recursive: true });
    await writeFile(join(other, '.aiwg/aiwg.config'), JSON.stringify({ ...emptyConfig(), effects: { project: basename(dir) } }));
    const checked = await dispatch(cli, other);
    expect(checked).toMatchObject({ decision: 'escalate', nearestGrant: { fields: ['workspace'] } });
    expect(checked).not.toHaveProperty('receipt');
  });
});
