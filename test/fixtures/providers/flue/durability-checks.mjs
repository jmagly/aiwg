// Exercise independent runtime processes against the generated app database.
import assert from 'node:assert/strict';
import { readFile, readdir, cp, writeFile, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function assertDurability(root, fixture, check) {
  const worker = fileURLToPath(new URL('./durability-worker.mjs', import.meta.url));
  async function prepare(directory) {
    await cp(worker, path.join(directory, 'durability-worker.mjs'));
    await writeFile(path.join(directory, 'durability-options.json'), JSON.stringify({
      ...fixture.options, cwd: directory,
      args: [fileURLToPath(new URL('./interrupted-server.mjs', import.meta.url))],
    }));
  }
  await prepare(root);
  const env = { PATH: path.dirname(process.execPath), HOME: path.join(root, 'home'), TMPDIR: root };
  function launch(mode, ipc = false, directory = root) {
    const child = spawn(process.execPath, ['durability-worker.mjs', mode], {
      cwd: directory, env, stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
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
    await check('second live owner is fenced by the submission lease', () => launch('lease-rival').done);
    await check('aborting an AIWG tool durably settles as aborted', async () => {
      owner.child.send({ abort: true });
      await owner.done;
    });
  } finally { if (owner.child.exitCode === null) owner.child.kill('SIGKILL'); }
  await check('restart read reconciles the aborted effect without replay', () => launch('reconcile').done);
  await check('rival dispatch stays queued behind the live owner without model execution', async () => {
    // Admission acquires a new conversation producer in Flue 2.3.0, fencing the
    // old writer (conversation-stream-store-CXrgv-b0.mjs:5768-5795). Keep the
    // competing-dispatch store separate from the abort/reconciliation lifetime.
    const directory = path.join(root, 'dispatch-fencing');
    await mkdir(directory);
    await cp(path.join(root, 'src'), path.join(directory, 'src'), { recursive: true });
    await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    await prepare(directory);
    const competitor = launch('fencing-owner', true, directory);
    const ready = new Promise((resolve, reject) => {
      competitor.child.once('message', resolve);
      competitor.done.then(() => reject(new Error('Fencing owner exited before ready')), reject);
    });
    try {
      await ready;
      await launch('rival', false, directory).done;
    } finally {
      if (competitor.child.connected) competitor.child.send({ stop: true });
      await competitor.done;
    }
  });
  for (const name of ['code-reviewer', 'test-engineer']) {
    await check(`real task delegates to ${name} with inherited model and AIWG tools`, () => launch(name).done);
  }
  await check('state uses .flue-state/state.db and never node_modules/.cache', async () => {
    assert.equal((await readFile(path.join(root, '.flue-state/state.db'))).subarray(0, 16).toString(), 'SQLite format 3\0');
    // Dependencies are copied without the lab cache. Any new app cache is a failure.
    await assert.rejects(readdir(path.join(root, 'node_modules/.cache')), { code: 'ENOENT' });
  });
}
