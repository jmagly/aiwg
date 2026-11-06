/** Materialize bounded artifacts; quarantine entries before checking ownership or removing them. */
import { constants } from 'node:fs';
import { open, mkdir, mkdtemp, lstat, readdir, unlink, rmdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';
import { workerPromptArtifacts } from './worker-prompt.mjs';

const { validateWorkerArtifacts } = await importImpl(import.meta.url, 'serve/worker-artifacts.mjs');
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

export async function materializeWorkerArtifacts(invocation, runDir, prompt) {
  invocation = workerPromptArtifacts(invocation, prompt);
  const artifacts = validateWorkerArtifacts(invocation);
  const targets = new Map(artifacts.map(artifact => [artifact.name, artifact.location === 'workspace-relative'
    ? path.join(invocation.cwd, artifact.relativePath) : path.join(runDir, `artifact-${artifact.name}`)]));
  const argv = invocation.argv.map(token => {
    if (!token.includes('${artifact:')) return token;
    const match = /^\$\{artifact:([A-Za-z0-9][A-Za-z0-9_-]{0,63})\}$/.exec(token);
    if (!match || !targets.has(match[1])) throw new Error('Undeclared worker artifact placeholder');
    return targets.get(match[1]);
  });
  const handles = [], created = [], directories = [], filenames = new Map();
  let cleaned = false, quarantine, quarantinePath, sequence = 0;
  const remember = (handle, filename) => { handles.push(handle); if (filename) filenames.set(handle, filename); return handle; };
  // Linux can address relocated pinned parents. Other POSIX hosts use checked
  // paths, retaining artifacts if a parent's identity cannot be recovered.
  const childPath = (parent, name) => process.platform === 'linux'
    ? `/proc/self/fd/${parent.fd}/${name}` : path.join(filenames.get(parent), name);
  async function pinDirectory(filename) {
    if (!path.isAbsolute(filename) || path.normalize(filename) !== filename || filename.includes('\0')) throw new Error('Invalid worker artifact root');
    let directory = remember(await open('/', directoryFlags), '/');
    for (const component of filename.split('/').filter(Boolean)) {
      const target = childPath(directory, component), resolved = path.join(filenames.get(directory), component);
      directory = remember(await open(target, directoryFlags), resolved);
    }
    return directory;
  }
  async function rewalk(cwd, chain) {
    let directory = await pinDirectory(cwd);
    if (!sameFile(await directory.stat({ bigint: true }), chain[0].stat)) throw new Error('cwd changed');
    for (const entry of chain.slice(1)) {
      const target = childPath(directory, entry.component), filename = path.join(filenames.get(directory), entry.component);
      const next = remember(await open(target, directoryFlags), filename);
      if (!sameFile(await next.stat({ bigint: true }), entry.stat)
        || !sameFile(await lstat(target, { bigint: true }), entry.stat)) throw new Error('ancestor changed');
      directory = next;
    }
    return directory;
  }
  async function workspaceParent(root, relativePath) {
    let directory = root;
    const rootStat = await root.stat({ bigint: true });
    const quarantineStat = await quarantine.stat({ bigint: true });
    if (rootStat.dev !== quarantineStat.dev) throw new Error('Worker artifact quarantine must be on the cwd filesystem');
    const chain = [{ stat: rootStat }];
    const components = relativePath.split('/').slice(0, -1);
    for (const [i, component] of components.entries()) {
      const target = childPath(directory, component);
      const invocationDirectory = i === components.length - 1;
      let made = false;
      // Rewalk BEFORE mkdir too; a pinned parent alone is not cwd authority.
      await rewalk(invocation.cwd, chain);
      try { await mkdir(target, { mode: 0o700 }); made = true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (invocationDirectory) throw Object.assign(new Error('Worker artifact directory collision (existing entry preserved)'), { code: 'EEXIST' });
      }
      const before = await lstat(target, { bigint: true });
      const next = remember(await open(target, directoryFlags), path.join(filenames.get(directory), component));
      const stat = await next.stat({ bigint: true });
      try {
        if (!before.isDirectory() || !sameFile(before, stat)) throw new Error('directory substituted');
        if (made && (await readdir(childPath(next, '.'))).length) throw new Error('new directory is not empty');
        const checkedParent = await rewalk(invocation.cwd, chain);
        if (!sameFile(await lstat(childPath(checkedParent, component), { bigint: true }), stat)
          || !sameFile(await lstat(target, { bigint: true }), stat)) throw new Error('directory substituted');
      } catch (cause) { throw new Error('Worker artifact path changed; directory identity verification failed (unproven entry retained)', { cause }); }
      if (stat.dev !== quarantineStat.dev) throw new Error('Worker artifact quarantine must share every parent filesystem');
      // Only the verified invocation directory is owned. Leave shared prefixes.
      if (invocationDirectory) directories.push({ target, stat, parent: directory });
      chain.push({ component, stat });
      directory = next;
    }
    return { directory, chain };
  }
  async function verifyPath(cwd, chain, leaf, identity) {
    try {
      // Re-open cwd from / as well: a relocated cwd descriptor is not authority.
      const directory = await rewalk(cwd, chain);
      const file = remember(await open(childPath(directory, leaf), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
      if (!sameFile(await file.stat({ bigint: true }), identity)) throw new Error('leaf changed');
    } catch (cause) { throw new Error('Worker artifact path changed; containment verification failed', { cause }); }
  }
  async function quarantineEntry(entry, directory = false) {
    if (process.platform !== 'linux') {
      try {
        const current = await pinDirectory(filenames.get(entry.parent));
        if (!sameFile(await current.stat({ bigint: true }), await entry.parent.stat({ bigint: true }))) throw new Error('parent identity mismatch');
      } catch (cause) { throw new Error('Worker artifact parent changed; artifact retained', { cause }); }
    }
    const captured = childPath(quarantine, `entry-${sequence++}`);
    // The source can change up to rename; inspect only the privately captured entry.
    await rename(entry.target, captured);
    if (!sameFile(await lstat(captured, { bigint: true }), entry.stat)) {
      throw new Error(`Worker artifact replacement preserved in quarantine: ${quarantinePath}/${path.basename(captured)}`);
    }
    if (directory) await rmdir(captured); else await unlink(captured);
  }
  const closeHandles = async () => {
    const results = await Promise.allSettled(handles.reverse().map(handle => handle.close()));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Worker artifact descriptor close failed');
  };
  const cleanup = async ({ confirmedStop = true } = {}) => {
    if (cleaned) return;
    cleaned = true;
    if (!confirmedStop) {
      await closeHandles();
      return { status: 'retained', reason: 'stop-proof-uncertain', paths: [...targets.values()] };
    }
    const errors = [];
    try {
      for (const [entries, directory] of [[created, false], [directories, true]]) {
        for (const entry of entries.reverse()) {
          try { await quarantineEntry(entry, directory); }
          catch (error) { if (error.code !== 'ENOENT') errors.push(error); }
        }
      }
      if (quarantinePath) {
        try { await rmdir(quarantinePath); }
        catch (error) { if (error.code !== 'ENOTEMPTY') errors.push(error); }
      }
    } finally {
      try { await closeHandles(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, `Worker artifact cleanup failed; preserved entries: ${quarantinePath}`);
  };
  try {
    const run = await pinDirectory(runDir);
    const stat = await run.stat();
    if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Worker artifact directory must be private and owned');
    if (artifacts.length) {
      quarantinePath = await mkdtemp(childPath(run, '.artifact-quarantine-'));
      quarantine = remember(await open(quarantinePath, directoryFlags), path.join(runDir, path.basename(quarantinePath)));
      // Keep the diagnostic path meaningful after descriptors close.
      quarantinePath = path.join(runDir, path.basename(quarantinePath));
    }
    let workspace;
    for (const artifact of artifacts) {
      let parent = run, chain;
      let leaf = `artifact-${artifact.name}`;
      if (artifact.location === 'workspace-relative') {
        if (!workspace) {
          const { realBeneath } = await importImpl(import.meta.url, 'serve/worker-invocation-paths.js');
          if (await realBeneath(invocation.cwd, runDir)) throw new Error('Worker artifact quarantine must be outside worker-writable cwd');
          workspace = await pinDirectory(invocation.cwd);
        }
        ({ directory: parent, chain } = await workspaceParent(workspace, artifact.relativePath));
        leaf = path.basename(artifact.relativePath);
      }
      const target = childPath(parent, leaf);
      let handle;
      try { handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw Object.assign(new Error(`Worker artifact collision: ${targets.get(artifact.name)} (existing file preserved)`), { code: 'EEXIST' });
        throw error;
      }
      // Keep the descriptor until cleanup so an unlinked inode cannot be reused.
      remember(handle);
      const identity = await handle.stat({ bigint: true });
      created.push({ target, stat: identity, parent });
      if (chain) await verifyPath(invocation.cwd, chain, leaf, identity);
      await handle.writeFile(artifact.content); await handle.sync();
      if (chain) await verifyPath(invocation.cwd, chain, leaf, identity);
    }
    return { argv, cleanup, declarations: artifacts };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], `${error.message}; worker artifact creation and cleanup failed`); }
    throw error;
  }
}

/** Gate artifact removal on launcher-owned stop evidence and report retention. */
export class WorkerArtifactLifecycle {
  constructor(invocation, invocationId = invocation.invocationId) {
    this.invocationId = invocationId;
    this.invocation = invocation;
    this.confirmedStop = true; // Materialization precedes any dispatch.
    this.result = null;
  }
  spawning() { this.confirmedStop = false; }
  observe(name, value) {
    if (name !== 'exit.json') return;
    this.confirmedStop = value.invocationId === this.invocationId && value.termination === 'confirmed';
    this.result = value;
    if (this.invocation.artifacts?.length) value.artifactCleanup = this.status();
  }
  status() {
    return this.confirmedStop ? { status: 'eligible' }
      : { status: 'retained', reason: 'stop-proof-uncertain' };
  }
  failure(error) {
    if (this.invocation.artifacts?.length && !this.confirmedStop) error.artifactCleanup = this.status();
  }
  async finish(artifacts) {
    if (this.result?.termination === 'uncertain') this.confirmedStop = false;
    if (this.result && this.invocation.artifacts?.length) this.result.artifactCleanup = this.status();
    return artifacts?.cleanup({ confirmedStop: this.confirmedStop });
  }
}
