#!/usr/bin/env node
/** Credential-gated live Grok Build smoke. No secret values enter output. */
import { importImpl } from '../_resolve-impl.mjs';
import { spawnSync } from 'node:child_process';
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
if (!process.env.XAI_API_KEY) {
  skipped('XAI_API_KEY unavailable');
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
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5_000, shell: false, killSignal: 'SIGKILL' });
if (version.status !== 0) {
  process.stderr.write('Grok Build binary version check failed\n');
  process.exit(1);
}

// Share parser, redaction and TERM-to-KILL cleanup with governed headless runs.
const { runGrokHeadless, GrokHeadlessError } = await importImpl(import.meta.url, 'providers/grok-build-headless.js');
let result = { events: [], stderr: '' };
let status = 'passed';
try {
  result = await runGrokHeadless({ command: binary, cwd: process.cwd(), env: process.env,
    prompt: 'Reply with the word OK only.', timeoutMs: 60_000, maxOutputBytes: 1024 * 1024,
    disableSubagents: true });
} catch (error) {
  status = 'failed';
  if (error instanceof GrokHeadlessError) result = error.result;
  // Provider diagnostics can contain credentials; report only status and counts.
  process.stderr.write('Grok Build live smoke failed\n');
  process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify({ provider: 'grok-build', status,
  eventCount: result.events.length,
  terminal: result.events.some(event => event.type === 'end' || event.type === 'error'),
  stderrBytes: Buffer.byteLength(result.stderr) })}\n`);
