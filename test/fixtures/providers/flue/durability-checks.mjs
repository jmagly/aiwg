// Exercise independent runtime processes against the generated app database.
import assert from 'node:assert/strict';
import { readFile, readdir, cp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function assertDurability(root, fixture, check) {
  const worker = fileURLToPath(new URL('./durability-worker.mjs', import.meta.url));
  await cp(worker, path.join(root, 'durability-worker.mjs'));
  await writeFile(path.join(root, 'durability-options.json'), JSON.stringify({
    ...fixture.options, cwd: root,
    args: [fileURLToPath(new URL('./interrupted-server.mjs', import.meta.url))],
  }));
  const env = { PATH: path.dirname(process.execPath), HOME: path.join(root, 'home'), TMPDIR: root };
  function launch(mode, ipc = false) {
    const child = spawn(process.execPath, ['durability-worker.mjs', mode], {
      cwd: root, env, stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`${mode}: exit ${code}/${signal}\n${output}`));
        else resolve(output);
      });
    });
    return { child, done };
  }
  await check('conversation survives a process restart with the same id and transcript', async () => {
    await launch('first').done;
    await launch('restart').done;
  });
  const owner = launch('owner', true);
  // Attach a rejection handler immediately, including failures before ready.
  const ready = new Promise((resolve, reject) => {
    owner.child.once('message', resolve);
    owner.done.then(() => reject(new Error('Owner exited before ready')), reject);
  });
  try {
    await ready;
    await check('second live owner is fenced by the submission lease', () => launch('rival').done);
    await check('aborting an AIWG tool durably settles as aborted', async () => {
      owner.child.send({ abort: true });
      await owner.done;
    });
  } finally { if (owner.child.exitCode === null) owner.child.kill('SIGKILL'); }
  await check('restart read reconciles the aborted effect without replay', () => launch('reconcile').done);
  for (const name of ['code-reviewer', 'test-engineer']) {
    await check(`real task delegates to ${name} with inherited model and AIWG tools`, () => launch(name).done);
  }
  await check('state uses .flue-state/state.db and never node_modules/.cache', async () => {
    assert.equal((await readFile(path.join(root, '.flue-state/state.db'))).subarray(0, 16).toString(), 'SQLite format 3\0');
    // Dependencies are copied without the lab cache. Any new app cache is a failure.
    await assert.rejects(readdir(path.join(root, 'node_modules/.cache')), { code: 'ENOENT' });
  });
}
