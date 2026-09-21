#!/usr/bin/env node
/** Credential-gated live Grok Build smoke. No secret values enter output. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

const skipped = (reason) => {
  process.stdout.write(`${JSON.stringify({ provider: 'grok-build', status: 'skipped', reason })}\n`);
};

if (process.env.AIWG_GROK_BUILD_LIVE_SMOKE !== '1') {
  skipped('AIWG_GROK_BUILD_LIVE_SMOKE is not enabled');
  process.exit(0);
}
const requestedBinary = process.env.AIWG_GROK_BUILD_BIN || 'grok';
const binaryPath = isAbsolute(requestedBinary)
  ? (existsSync(requestedBinary) ? requestedBinary : undefined)
  : (process.env.PATH || '').split(delimiter).map(dir => join(dir, requestedBinary)).find(existsSync);
if (!binaryPath) {
  skipped('Grok Build binary unavailable');
  process.exit(0);
}
const binary = realpathSync(binaryPath);
const expectedHash = process.env.AIWG_GROK_BUILD_EXPECTED_SHA256;
if (!expectedHash || !/^[0-9a-f]{64}$/i.test(expectedHash)) {
  process.stderr.write('Grok Build live smoke requires AIWG_GROK_BUILD_EXPECTED_SHA256\n');
  process.exit(1);
}
const actualHash = createHash('sha256').update(readFileSync(binary)).digest('hex');
if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
  process.stderr.write('Grok Build binary SHA-256 mismatch\n');
  process.exit(1);
}
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5_000, shell: false });
if (version.status !== 0) {
  process.stderr.write('Grok Build binary version check failed\n');
  process.exit(1);
}
if (!process.env.XAI_API_KEY) {
  skipped('XAI_API_KEY unavailable');
  process.exit(0);
}

const child = spawn(binary, ['--no-auto-update', '-p', 'Reply with the word OK only.', '--output-format', 'streaming-json'], {
  cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  detached: process.platform !== 'win32',
});
let pending = '';
let events = 0;
let terminal = false;
let errorEvent = false;
let stderrBytes = 0;
const stop = () => {
  if (child.pid && process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGTERM'); return; } catch { /* already exited */ }
  }
  child.kill('SIGTERM');
};
const timeout = setTimeout(() => {
  stop();
  process.stderr.write('Grok Build live smoke timed out\n');
  process.exitCode = 1;
}, 60_000);
child.stdout.on('data', chunk => {
  pending += chunk.toString('utf8');
  if (Buffer.byteLength(pending) > 1024 * 1024) {
    stop();
    process.stderr.write('Grok Build live smoke output limit exceeded\n');
    process.exitCode = 1;
    return;
  }
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end).trim();
    pending = pending.slice(end + 1);
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      events++;
      if (['result', 'complete', 'completed', 'error'].includes(event.type || event.event)) terminal = true;
      if (event.error || event.is_error === true || event.type === 'error') errorEvent = true;
    } catch {
      stop();
      process.stderr.write('Grok Build live smoke received invalid JSON event\n');
      process.exitCode = 1;
    }
  }
});
child.stderr.on('data', chunk => {
  stderrBytes += chunk.length;
  // Native stderr can contain credentials; report only the byte count.
  if (stderrBytes > 1024 * 1024) { stop(); process.exitCode = 1; }
});
child.on('error', () => { clearTimeout(timeout); process.stderr.write('Grok Build live smoke launch failed\n'); process.exitCode = 1; });
child.on('close', code => {
  clearTimeout(timeout);
  const status = process.exitCode || code !== 0 || errorEvent || !terminal ? 'failed' : 'passed';
  process.stdout.write(`${JSON.stringify({ provider: 'grok-build', status, eventCount: events, terminal, stderrBytes })}\n`);
  if (status === 'failed') process.exitCode = 1;
});
