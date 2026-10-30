// Check bounded initialization and child reaping with either real SDK generation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function assertConnectLifecycle(createAiwgTools, options, root, mode) {
  const pidFile = path.join(root, `silent-${mode}.pid`);
  const tools = createAiwgTools({ ...options, command: process.execPath,
    args: [fileURLToPath(new URL('./silent-child.mjs', import.meta.url)), pidFile] });
  const controller = new AbortController();
  const started = performance.now();
  // Observe rejection immediately, including an unexpected early startup failure.
  const outcome = tools.aiwg_discover.run({ data: { query: 'fixture' }, signal: controller.signal })
    .then(() => undefined, error => error);
  let pid;
  let reaped = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { pid = Number(await readFile(pidFile, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(20);
    }
    assert.ok(pid > 0, 'Fixture child must have started');
    if (mode === 'abort') controller.abort(new Error('fixture cancellation'));
    const error = await outcome;
    assert.match(String(error), mode === 'abort' ? /fixture cancellation/ : /connect timed out after 10000 ms/);
    assert.ok(performance.now() - started < (mode === 'abort' ? 7000 : 15000), 'Connect must fail within its cleanup bound');
    // SIGKILL cleanup can resolve just before the OS reports process exit.
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') { reaped = true; return; } throw error; }
      await delay(20);
    }
    assert.fail(`Silent child ${pid} is still running`);
  } finally {
    controller.abort(new Error('fixture cleanup'));
    await outcome;
    if (pid && !reaped) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}
