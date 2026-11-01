// Gate the paid runner and send interrupts to its cleanup owner without Vitest's exit timer.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireDeployedOptIn } from '../../test/helpers/flue-cloudflare-deployed-process.mjs';

const root = path.resolve(import.meta.dirname, '../..');
export function runDeployedVitest({ env = process.env, signals = process, stdio = 'inherit',
  executable = path.join(root, 'node_modules/vitest/vitest.mjs') } = {}) {
  requireDeployedOptIn(env);
  const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-flue-cf-runner-'));
  const controlPath = path.join(controlDir, 'owner.json');
  const child = spawn(process.execPath, [executable, 'run', '--config', 'config/vitest.flue-cloudflare-deployed.config.js'], {
    cwd: root, env: { ...env, AIWG_FLUE_CF_CONTROL: controlPath }, stdio, detached: true,
  });
  let pendingSignal, timer;
  function forward(signal) {
    if (pendingSignal) return;
    pendingSignal = signal;
    // The worker publishes its PID before starting resources. Signal that owner
    // directly so Vitest cannot kill it while Wrangler deletion is still running.
    const deadline = Date.now() + 30_000;
    timer = setInterval(() => {
      try {
        const { pid } = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
        process.kill(pid, signal);
        clearInterval(timer);
      } catch (error) {
        if (error.code === 'ENOENT' && Date.now() < deadline) return;
        clearInterval(timer);
        try { process.kill(-child.pid, signal); } catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
      }
    }, 25);
  }
  const onInt = () => forward('SIGINT'), onTerm = () => forward('SIGTERM');
  signals.on('SIGINT', onInt);
  signals.on('SIGTERM', onTerm);
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(pendingSignal ? (pendingSignal === 'SIGINT' ? 130 : 143) : code ?? (signal === 'SIGINT' ? 130 : 143)));
  }).finally(() => {
    clearInterval(timer);
    signals.removeListener('SIGINT', onInt);
    signals.removeListener('SIGTERM', onTerm);
    fs.rmSync(controlDir, { recursive: true, force: true });
  });
  return { child, completed, controlPath };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await runDeployedVitest().completed; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
