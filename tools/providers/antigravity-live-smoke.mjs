#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

if (process.env.AIWG_ANTIGRAVITY_LIVE_SMOKE !== '1') {
  console.error('Refusing live Antigravity smoke: set AIWG_ANTIGRAVITY_LIVE_SMOKE=1 after explicit authorization.');
  process.exit(2);
}

const version = execFileSync('agy', ['--version'], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' }).trim();
if (version !== '1.1.26') throw new Error(`Expected Antigravity CLI 1.1.26, received ${version}`);
console.log(JSON.stringify({ provider: 'antigravity', binary: 'agy', version, check: 'version-only', authenticatedCall: false }));
