// Force slow ownership publication and retain final-capture diagnostics for #4144.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { publishWorkerRecord } from '../../tools/ralph-external/session-launcher.mjs';

export const identityPublicationPauseMs = (recordedAt, now) => Math.max(0, 2300 - (now - recordedAt));

export function slowIdentityPublication(configPath) {
  let delayed = false;
  return async (runDir, name, value, inspect) => {
    if (!delayed && name === 'process.json' && value.identityObservation === 'stable-owned-group') {
      delayed = true;
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      // Start the delay after the child has read its config and recorded its
      // invocation, immediately before it begins waiting for process.json.
      const deadline = Date.now() + 5000;
      let recordedAt;
      for (;;) {
        try { recordedAt = (await stat(config.recordPath)).mtimeMs; break; }
        catch (error) {
          if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error;
          await pause(10);
        }
      }
      // The child starts readiness immediately after writing this record.
      // Polling/scheduling time consumes the delay rather than extending it.
      await pause(identityPublicationPauseMs(recordedAt, Date.now()));
    }
    return publishWorkerRecord(runDir, name, value, inspect);
  };
}

async function readEvidence(filename, parse = false) {
  try {
    const text = await readFile(filename, 'utf8');
    return parse ? JSON.parse(text) : text;
  } catch (error) { return { path: filename ?? null, error: error.code ?? error.message }; }
}

export async function finalCaptureEvidence(...attempts) {
  return JSON.stringify(await Promise.all(attempts.map(async attempt => {
    const config = await readEvidence(attempt.configPath, true);
    const invocation = await readEvidence(attempt.invocationPath, true);
    const files = { exit: join(attempt.runDir, 'exit.json'),
      process: join(attempt.runDir, 'process.json'), finalEvidence: join(attempt.runDir, 'final-evidence.json'),
      final: invocation?.invocation?.finalPath, stderr: join(attempt.runDir, 'stderr.log'), record: config?.recordPath };
    const evidence = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, filename]) =>
      [name, await readEvidence(filename)])));
    return { runDir: attempt.runDir, config, invocation, ...evidence };
  })), null, 2);
}
