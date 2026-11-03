// Preserve one-shot attempt captures as read-only snapshots bound to the terminal run record.
import { constants } from 'node:fs';
import { mkdir, open, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { withWorkerPath } from './worker-inputs.mjs';
import { importImpl } from '../../_resolve-impl.mjs';

const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const reservationPath = filename => `${filename}.launch-owner`;
const directoryPath = runDir => join(dirname(runDir), `.captures-${basename(runDir)}`);
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

export async function assertWorkerCapturePathsAvailable(paths, inspect, { runDir, writableRoots }) {
  const { realBeneath } = await importImpl(import.meta.url, 'serve/worker-invocation-paths.js');
  for (const root of writableRoots) {
    if (await realBeneath(root, directoryPath(runDir))) throw new Error('Sealed captures must be outside worker-writable roots');
  }
  const filenames = Object.values(paths);
  if (filenames.some(filename => filenames.includes(reservationPath(filename)))) {
    throw new Error('Worker output paths collide with capture reservations');
  }
  for (const filename of filenames) {
    // A removed live capture still belongs to the attempt whose snapshot survives beside its run directory.
    if (await inspect(directoryPath(dirname(filename)), 'directory')) throw new Error('Worker output path belongs to an earlier attempt capture directory');
    if (await inspect(reservationPath(filename), 'output')) throw new Error('Worker output path belongs to an earlier attempt');
  }
}

async function ownedFile(filename, operation) {
  return withWorkerPath(filename, async target => {
    const handle = await open(target, fileFlags);
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid())) throw new Error('Capture must be an owned unaliased regular file');
      const result = await operation(handle, stat);
      const after = await handle.stat({ bigint: true });
      if (stat.size !== after.size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs
        || !sameFile(after, await lstat(target, { bigint: true }))) {
        throw new Error('Capture changed while sealing or verifying');
      }
      return result;
    } finally { await handle.close(); }
  });
}

async function digestFile(filename, expectedMode) {
  return ownedFile(filename, async (handle, stat) => {
    if (expectedMode !== undefined && Number(stat.mode & 0o777n) !== expectedMode) throw new Error('Sealed capture is not read-only');
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) digest.update(chunk);
    return { digest: `sha256:${digest.digest('hex')}`, byteLength: Number(stat.size) };
  });
}

export class WorkerCaptureOwner {
  constructor({ runDir, paths, captures, inspect, invocationId }) {
    Object.assign(this, { runDir, paths, captures, inspect, invocationId });
    this.directory = directoryPath(runDir);
    this.sources = { ...Object.fromEntries(Object.entries(paths).map(([key, value]) => [`output-${key}`, value])),
      ...Object.fromEntries(Object.entries(captures).map(([key, value]) => [`capture-${key}`, value])) };
  }

  writer(writeRecord, publishSeal = writeRecord) {
    this.publishSeal = publishSeal;
    return async (runDir, name, value, inspect) => {
      if (name === 'invocation.json') {
        // Exclusive even if a conductor has deleted the old mutable run directory.
        await withWorkerPath(this.directory, target => mkdir(target, { mode: 0o700 }));
        this.started = true;
        value.captureDirectory = this.directory;
        this.invocationRecord = value;
      }
      if (name === 'exit.json') this.result = value;
      return writeRecord(runDir, name, value, inspect);
    };
  }

  async reserveOutput(filename) {
    if (Object.values(this.paths).includes(filename)) {
      const marker = reservationPath(filename);
      await this.inspect(marker, 'output');
      const handle = await withWorkerPath(marker, target => open(target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
      try { await handle.writeFile(JSON.stringify({ invocationId: this.invocationId, runDir: this.runDir })); await handle.sync(); }
      finally { await handle.close(); }
    }
  }

  async finish() {
    if (!this.started) return;
    const files = [];
    for (const [name, source] of Object.entries(this.sources)) {
      const path = join(this.directory, name);
      if (!await this.inspect(source, 'file')) { files.push({ source, path, missing: true }); continue; }
      const recorded = await ownedFile(source, async (input, stat) => {
        const output = await withWorkerPath(path, target => open(target,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
        const digest = createHash('sha256');
        try {
          for await (const chunk of input.createReadStream({ autoClose: false, start: 0 })) {
            digest.update(chunk); await output.writeFile(chunk);
          }
          await output.chmod(0o400); await output.sync();
          return { digest: `sha256:${digest.digest('hex')}`, byteLength: Number(stat.size) };
        } finally { await output.close(); }
      });
      files.push({ source, path, ...recorded });
    }
    await withWorkerPath(this.directory, async target => {
      const directory = await open(target, directoryFlags);
      try { await directory.chmod(0o500); await directory.sync(); } finally { await directory.close(); }
    });
    // A capture-setup exception can precede exit.json; retain its seal in the invocation record.
    const record = this.result ?? this.invocationRecord;
    record.captureSeal = { directory: this.directory, sealedAt: new Date().toISOString(), files,
      digest: hash(JSON.stringify(files)) };
    await this.publishSeal(this.runDir, this.result ? 'exit.json' : 'invocation.json', record, this.inspect);
  }
}

export async function verifyWorkerCaptureSeal(runDir, invocation, exit, inspect) {
  // Pre-sealing launcher records remain readable; every new invocation declares its capture directory.
  if (invocation.captureDirectory === undefined && exit.captureSeal === undefined) return;
  const seal = exit.captureSeal;
  if (invocation.captureDirectory !== directoryPath(runDir) || seal?.directory !== invocation.captureDirectory
    || !Array.isArray(seal.files) || seal.digest !== hash(JSON.stringify(seal.files))) throw new Error('Capture seal is missing or invalid');
  const expected = { ...Object.fromEntries(Object.entries(invocation.paths).map(([key, value]) => [`output-${key}`, value])),
    ...Object.fromEntries(Object.entries(invocation.captures).map(([key, value]) => [`capture-${key}`, value])) };
  if (seal.files.length !== Object.keys(expected).length) throw new Error('Capture seal omits attempt paths');
  await withWorkerPath(seal.directory, async target => {
    const directory = await open(target, directoryFlags);
    try {
      const stat = await directory.stat();
      if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o500) throw new Error('Capture directory is not sealed read-only');
      const names = (await readdir(target)).sort();
      const present = seal.files.filter(file => !file.missing).map(file => Object.keys(expected).find(name => file.path === join(seal.directory, name))).sort();
      if (JSON.stringify(names) !== JSON.stringify(present)) throw new Error('Sealed capture directory entries changed');
    } finally { await directory.close(); }
  });
  const seen = new Set();
  for (const file of seal.files) {
    const name = Object.keys(expected).find(key => file.path === join(seal.directory, key));
    if (!name || seen.has(name) || file.source !== expected[name]) throw new Error('Capture seal path binding mismatch');
    seen.add(name);
    if (file.missing) {
      if (await inspect(file.source, 'file')) throw new Error('Previously missing capture has changed');
      continue;
    }
    for (const [filename, mode] of [[file.path, 0o400], [file.source, undefined]]) {
      const actual = await digestFile(filename, mode);
      if (actual.digest !== file.digest || actual.byteLength !== file.byteLength) throw new Error(`Capture digest mismatch: ${filename}`);
    }
  }
}
