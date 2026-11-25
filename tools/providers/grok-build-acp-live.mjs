#!/usr/bin/env node
// Manual-only managed ACP dispatch smoke; every execution uses a disposable Git project.
import { importImpl } from '../_resolve-impl.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

const skip = reason => {
  process.stdout.write(`${JSON.stringify({ provider: 'grok-build', transport: 'acp', status: 'skipped', reason })}\n`);
  process.exit(0);
};
if (['CI', 'GITHUB_ACTIONS', 'GITEA_ACTIONS'].some(key => process.env[key] && process.env[key] !== 'false')) {
  skip('Live ACP dispatch is manual-only; CI is disabled');
}
if (process.env.AIWG_GROK_BUILD_LIVE_SMOKE !== '1') skip('AIWG_GROK_BUILD_LIVE_SMOKE is not enabled');
const requested = process.env.AIWG_GROK_BUILD_BIN || 'grok';
const located = isAbsolute(requested) ? (existsSync(requested) ? requested : undefined)
  : (process.env.PATH || '').split(delimiter).map(dir => join(dir, requested)).find(existsSync);
if (!located) skip('Grok Build binary unavailable');
// Credentials: an xAI API key, or an explicit declaration that the run uses the
// operator's cached `grok login` (the ACP client then selects `cached_token`).
const useCachedLogin = process.env.AIWG_GROK_BUILD_AUTH === 'login';
if (!process.env.XAI_API_KEY && !useCachedLogin) skip('No Grok credential: set XAI_API_KEY or AIWG_GROK_BUILD_AUTH=login');
const binary = realpathSync(located);
const expectedHash = process.env.AIWG_GROK_BUILD_EXPECTED_SHA256;
if (!expectedHash || !/^[0-9a-f]{64}$/i.test(expectedHash)) {
  process.stderr.write('Grok Build live ACP requires AIWG_GROK_BUILD_EXPECTED_SHA256\n');
  process.exit(1);
}
if (createHash('sha256').update(readFileSync(binary)).digest('hex') !== expectedHash.toLowerCase()) {
  process.stderr.write('Grok Build binary SHA-256 mismatch\n');
  process.exit(1);
}
const version = spawnSync(binary, ['--version'], {
  encoding: 'utf8', timeout: 5_000, shell: false, killSignal: 'SIGKILL',
});
if (version.status !== 0) {
  process.stderr.write('Grok Build binary version check failed\n');
  process.exit(1);
}

const { GrokBuildDispatcher } = await importImpl(import.meta.url, 'providers/grok-build-dispatch.js');
const project = await mkdtemp(join(tmpdir(), 'aiwg-grok-acp-live-'));
const report = { provider: 'grok-build', transport: 'acp', status: 'failed', stopReason: null,
  finalText: '', cap: 1, slotAcquired: false, slotReleased: false, cleanup: false };
let session;
let dispatcher;
const slots = () => readdir(join(project, '.git', 'aiwg-grok-dispatch-slots'));
try {
  execFileSync('git', ['init', '-q', project], { timeout: 5_000, killSignal: 'SIGKILL' });
  await mkdir(join(project, '.aiwg'));
  await writeFile(join(project, '.aiwg', 'aiwg.config'), JSON.stringify({ parallelism: { max_parallel_subagents: 1 } }));
  dispatcher = await GrokBuildDispatcher.forProject(project);
  session = await dispatcher.openAcp({ projectRoot: project, command: binary, timeoutMs: 60_000,
    authorize: () => true, budgetRemaining: () => true });
  report.slotAcquired = dispatcher.activeDispatches === 1 && (await slots()).includes('0.json');
  const result = await session.client.prompt('Reply with exactly: acp-dispatch-ok');
  report.stopReason = result.stopReason ?? null;
  report.finalText = result.text;
  if (report.slotAcquired && result.stopReason === 'end_turn' && result.text.trim() === 'acp-dispatch-ok') report.status = 'passed';
} catch {
  // Provider diagnostics can contain credentials; the client already redacts final text.
  process.stderr.write('Grok Build live ACP dispatch failed\n');
} finally {
  try {
    if (session) await session.close();
    if (dispatcher) report.slotReleased = dispatcher.activeDispatches === 0 && (await slots()).length === 0;
  } catch {
    report.status = 'failed';
    process.stderr.write('Grok Build live ACP slot cleanup failed\n');
  }
  await rm(project, { recursive: true, force: true });
  report.cleanup = !existsSync(project);
}
if (!report.slotReleased || !report.cleanup) report.status = 'failed';
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== 'passed') process.exitCode = 1;
