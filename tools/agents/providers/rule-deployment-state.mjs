// Own immutable input pools and serializable deployment plan state.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAiwgRoot } from './base.mjs';
import { fileDigest, resolveProjectAiwgDir, trackTemporaryDirectory } from './rule-delivery-surface.mjs';
import { createStagedDirectoryReference } from './staged-directory-reference.mjs';

// Plans contain only JSON values and a scratch directory. The preparing process
// owns that directory until disposal; cross-process transfer needs a separate lease.
export const stagedCleanups = new Map();
export class RuleDeploymentStaleError extends Error {
  constructor(message, paths = []) {
    super(message);
    this.name = 'RuleDeploymentStaleError';
    this.code = 'AIWG_RULE_DEPLOYMENT_STALE';
    this.paths = paths;
  }
}
export function capturePreimage(file, ancestors = new Set()) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(file);
    const resolved = path.resolve(path.dirname(file), target);
    if (ancestors.has(resolved)) throw new Error(`Cyclic deployment preimage: ${file}`);
    return { kind: 'symlink', mode, target, resolved: capturePreimage(resolved, new Set([...ancestors, resolved])) };
  }
  if (stat.isFile()) return { kind: 'file', mode, digest: fileDigest(file) };
  if (stat.isDirectory()) return { kind: 'directory', mode, entries: fs.readdirSync(file).sort().map(name => [name, capturePreimage(path.join(file, name), new Set([...ancestors, path.resolve(file)]))]) };
  // Runtime IPC and other opaque entries are sealed by type, never read/copied.
  return { kind: 'special', mode, type: stat.mode & fs.constants.S_IFMT };
}
// Materialize regular content only. Retain link/special-shaped live preimages
// for commit drift, but omit dangling links and opaque entries from the stage.
export function materializeInput(from, to, ancestors = new Set(), parentReady = false) {
  let stat;
  try { stat = fs.statSync(from); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isDirectory()) {
    // Only directories can lead back to an ancestor. Resolve them once and
    // share the immutable ancestry set with their children, including aliases.
    const real = fs.realpathSync(from);
    if (ancestors.has(real)) throw new Error(`Cyclic deployment input: ${from}`);
    const children = new Set([...ancestors, real]);
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) materializeInput(path.join(from, name), path.join(to, name), children, true);
    fs.chmodSync(to, stat.mode & 0o7777);
  } else if (stat.isFile()) {
    if (!parentReady) fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to); fs.chmodSync(to, stat.mode & 0o7777);
  }
}
export function materializedPreimage(state) {
  if (state.kind === 'symlink') return materializedPreimage(state.resolved);
  if (state.kind === 'special') return { kind: 'missing' };
  if (state.kind === 'directory') return { ...state, entries: state.entries
    .map(([name, child]) => [name, materializedPreimage(child)])
    .filter(([, child]) => child.kind !== 'missing') };
  return state;
}
export function snapshotPreimages(paths) {
  return [...new Set(paths.map(file => path.resolve(file)))].map(file => ({ path: file, state: capturePreimage(file) }));
}
export function planSeal(plan) { return createHash('sha256').update(JSON.stringify(plan)).digest('hex'); }
export function planOwner(plan) {
  const owner = stagedCleanups.get(plan?.lease);
  return owner && owner.seal === planSeal(plan) ? owner : null;
}
export function disposeRuleDeploymentPlan(plan) {
  const owner = planOwner(plan);
  if (owner) { stagedCleanups.delete(plan.lease); owner.cleanup(); }
}

/** Release process-local ownership while retaining a coordinator-owned stage. */
export function detachRuleDeploymentPlan(plan) {
  const owner = planOwner(plan);
  if (!owner || !owner.transferable) throw new Error('Rule deployment plan is not transferable');
  stagedCleanups.delete(plan.lease);
  owner.detach();
  return plan;
}
export function captureAnchors(paths) {
  const names = new Set();
  for (const name of paths) {
    let current = path.resolve(name);
    for (;;) {
      names.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...names].sort().map(file => {
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      return { path: file, dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
        link: stat.isSymbolicLink() ? fs.readlinkSync(file) : null, real: fs.realpathSync(file) };
    } catch (error) {
      if (error.code === 'ENOENT') return { path: file, missing: true };
      throw error;
    }
  });
}

// Opaque coordinator-owned input pool. A plan retains a lease until committed or
// disposed, so disposing the creator's handle cannot invalidate active stages.
export const inputPools = new WeakMap();
// Executable links are identity-bound but their installed code is trusted host
// state. Data files, modes, directory membership, and links are sealed in full.
export function poolInventory(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) return { kind: 'symlink', mode, target: fs.readlinkSync(file) };
  if (stat.isFile()) return { kind: 'file', mode, digest: fileDigest(file) };
  if (stat.isDirectory()) return { kind: 'directory', mode, entries: fs.readdirSync(file).sort().map(name => [name, poolInventory(path.join(file, name))]) };
  throw new Error(`Unsupported shared input pool entry: ${file}`);
}
export function setPoolWritable(file, writable) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory() && writable) fs.chmodSync(file, (stat.mode & 0o7777) | 0o700);
  if (stat.isDirectory()) for (const name of fs.readdirSync(file)) setPoolWritable(path.join(file, name), writable);
  if (!writable) fs.chmodSync(file, (stat.mode & 0o7777) & ~0o222);
}
export function verifyInputPool(pool) {
  try {
    if (planSeal(poolInventory(pool.snapshotRoot)) === pool.inventorySeal &&
      JSON.stringify(captureAnchors(pool.execAnchors.map(anchor => anchor.path))) === JSON.stringify(pool.execAnchors)) return;
  } catch (error) { throw new Error(`Shared input pool changed: ${error.message}`); }
  throw new Error('Shared input pool changed');
}

export function createRuleDeploymentInputPool(srcRoot) {
  const corpusRoot = resolveAiwgRoot(srcRoot) || srcRoot;
  const sourceTree = fs.existsSync(path.join(corpusRoot, 'agentic', 'code')) ? path.join(corpusRoot, 'agentic', 'code') : srcRoot;
  const isCorpusTree = path.relative(corpusRoot, sourceTree) === path.join('agentic', 'code');
  const paths = [sourceTree, path.join(corpusRoot, 'prebuilt', 'framework-relations'), path.join(corpusRoot, 'package.json'), path.join(corpusRoot, 'schemas')];
  const preimages = snapshotPreimages(paths);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-rule-input-'));
  const cleanup = trackTemporaryDirectory(temp);
  try {
    const snapshotRoot = path.join(temp, 'input');
    const snapshotTree = isCorpusTree ? path.join(snapshotRoot, 'agentic', 'code') : snapshotRoot;
    materializeInput(sourceTree, snapshotTree);
    if (JSON.stringify(capturePreimage(snapshotTree)) !== JSON.stringify(materializedPreimage(preimages[0].state))) throw new Error('Source changed while preparing immutable snapshot');
    const trustedExec = [];
    if (isCorpusTree) {
      for (const rel of ['package.json', 'prebuilt/framework-relations', 'schemas']) {
        const from = path.join(corpusRoot, rel), to = path.join(snapshotRoot, rel);
        materializeInput(from, to);
        const expected = preimages.find(item => item.path === path.resolve(from));
        if (JSON.stringify(capturePreimage(to)) !== JSON.stringify(materializedPreimage(expected.state))) throw new Error(`Package input changed while preparing snapshot: ${from}`);
      }
      for (const rel of ['tools', 'dist', 'node_modules', 'src']) {
        const from = path.join(corpusRoot, rel), to = path.join(snapshotRoot, rel);
        if (fs.existsSync(from)) { createStagedDirectoryReference(from, to); trustedExec.push(from); }
      }
    }
    setPoolWritable(snapshotRoot, false);
    const inventorySeal = planSeal(poolInventory(snapshotRoot));
    const execAnchors = captureAnchors(trustedExec);
    const safeCleanup = () => { setPoolWritable(snapshotRoot, true); cleanup(); };
    const token = Object.freeze({});
    inputPools.set(token, { corpusRoot: path.resolve(corpusRoot), sourceTree: path.resolve(sourceTree), snapshotRoot, snapshotTree, isCorpusTree, preimages, inventorySeal, execAnchors, refs: 1, closed: false, cleanup: safeCleanup, transferable: true });
    return token;
  } catch (error) { setPoolWritable(path.join(temp, 'input'), true); cleanup(); throw error; }
}
export function releaseInputPool(pool) { if (--pool.refs === 0) pool.cleanup(); }
export function disposeRuleDeploymentInputPool(token) {
  const pool = inputPools.get(token);
  if (pool && !pool.closed) { pool.closed = true; releaseInputPool(pool); }
}

/** A descriptor contains immutable snapshot identity, never its cleanup lease. */
export function describeRuleDeploymentInputPool(token) {
  const pool = inputPools.get(token);
  if (!pool || pool.closed || !pool.transferable) throw new Error('Invalid or closed rule deployment input pool');
  verifyInputPool(pool);
  return {
    version: 1,
    corpusRoot: pool.corpusRoot,
    sourceTree: pool.sourceTree,
    snapshotRoot: pool.snapshotRoot,
    snapshotTree: pool.snapshotTree,
    isCorpusTree: pool.isCorpusTree,
    inventorySeal: pool.inventorySeal,
    execAnchors: pool.execAnchors,
  };
}

/** Import a read-only pool view in a preparation worker. The coordinator keeps
 * the only cleanup lease and later restores the live-source preimages. */
export function importRuleDeploymentInputPool(descriptor) {
  if (!descriptor || descriptor.version !== 1 || typeof descriptor.inventorySeal !== 'string' ||
      !Array.isArray(descriptor.execAnchors)) throw new Error('Invalid rule deployment input pool descriptor');
  for (const key of ['corpusRoot', 'sourceTree', 'snapshotRoot', 'snapshotTree']) {
    if (typeof descriptor[key] !== 'string' || !path.isAbsolute(descriptor[key])) throw new Error('Invalid rule deployment input pool descriptor');
  }
  const token = Object.freeze({});
  const pool = { ...descriptor, corpusRoot: path.resolve(descriptor.corpusRoot), sourceTree: path.resolve(descriptor.sourceTree),
    snapshotRoot: path.resolve(descriptor.snapshotRoot), snapshotTree: path.resolve(descriptor.snapshotTree), preimages: [],
    refs: 1, closed: false, cleanup: () => {}, transferable: false };
  verifyInputPool(pool);
  inputPools.set(token, pool);
  return token;
}

export function within(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function safeRelative(root, name) {
  return typeof name === 'string' && name !== '' && name !== '.' && path.normalize(name) === name && !path.isAbsolute(name) && within(root, path.join(root, name));
}

export function exactObjectKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function validPreimageState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.kind !== 'string') return false;
  if (state.kind === 'missing') return Object.keys(state).length === 1;
  if (!Number.isSafeInteger(state.mode) || state.mode < 0) return false;
  if (state.kind === 'special') return Object.keys(state).length === 3 && Number.isSafeInteger(state.type)
    && state.type === (state.type & fs.constants.S_IFMT)
    && ![fs.constants.S_IFREG, fs.constants.S_IFDIR, fs.constants.S_IFLNK].includes(state.type);
  if (state.kind === 'file') return Object.keys(state).length === 3 && /^[a-f0-9]{64}$/.test(state.digest);
  if (state.kind === 'symlink') return Object.keys(state).length === 4 && typeof state.target === 'string' && validPreimageState(state.resolved);
  return state.kind === 'directory' && Object.keys(state).length === 3 && Array.isArray(state.entries) && state.entries.every(entry =>
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && entry[0] !== '' && !entry[0].includes(path.sep) && validPreimageState(entry[1]));
}

export function expectedAnchorPaths(paths) {
  const names = new Set();
  for (const name of paths) {
    let current = path.resolve(name);
    for (;;) {
      names.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...names].sort();
}

/** Adopt a detached worker plan into the coordinator's process-local lease. */
export function adoptRuleDeploymentPlan(detached, { scratch, target, inputPool, cleanup }) {
  const invalid = () => { throw new Error('Invalid transferred rule deployment plan'); };
  if (!exactObjectKeys(detached, ['version', 'lease', 'temp', 'target', 'stage', 'rootNames', 'workspaceDirs', 'preimages', 'poolSeal', 'anchors', 'snapshotRoot', 'corpusRoot', 'sourceMappings', 'staged', 'report', 'mappings', 'contextWrites']) ||
      detached.version !== 1 || typeof detached.lease !== 'string' || !(detached.poolSeal === null || typeof detached.poolSeal === 'string') ||
      !detached.report || typeof detached.report !== 'object' || Array.isArray(detached.report) || typeof scratch !== 'string' || typeof target !== 'string' || typeof cleanup !== 'function') invalid();
  const root = path.resolve(scratch), expectedTarget = path.resolve(target);
  if (path.resolve(detached.temp || '') !== root || path.resolve(detached.stage || '') !== path.join(root, 'project') || path.resolve(detached.target || '') !== expectedTarget) invalid();
  if (!Array.isArray(detached.contextWrites) || detached.contextWrites.some(file => typeof file !== 'string' || !within(root, file)) || !Array.isArray(detached.staged) || !Array.isArray(detached.mappings) || !Array.isArray(detached.rootNames) || !Array.isArray(detached.preimages) ||
      !Array.isArray(detached.workspaceDirs) || !Array.isArray(detached.anchors) || !Array.isArray(detached.sourceMappings) ||
      typeof detached.snapshotRoot !== 'string' || !path.isAbsolute(detached.snapshotRoot) || typeof detached.corpusRoot !== 'string' || !path.isAbsolute(detached.corpusRoot)) invalid();
  if (detached.rootNames.some(name => !safeRelative(expectedTarget, name))) invalid();
  const pool = inputPool && inputPools.get(inputPool);
  if (inputPool && (!pool || pool.closed || !pool.transferable)) invalid();
  if (pool) {
    verifyInputPool(pool);
    if (detached.poolSeal !== pool.inventorySeal || path.resolve(detached.snapshotRoot || '') !== pool.snapshotRoot) invalid();
  } else if (detached.poolSeal) invalid();
  const expectedArtifactRoot = path.resolve(resolveProjectAiwgDir(expectedTarget));
  const validSourceMapping = item => within(root, item.to) || (pool && within(pool.snapshotRoot, item.to)) ||
    (path.resolve(item.from) === path.join(expectedTarget, '.aiwg') && path.resolve(item.to) === expectedArtifactRoot);
  if (detached.workspaceDirs.some(name => !safeRelative(expectedTarget, name)) ||
      detached.preimages.some(item => !item || Object.keys(item).length !== 2 || typeof item.path !== 'string' || !path.isAbsolute(item.path) || !validPreimageState(item.state)) ||
      detached.staged.some(item => !item || Object.keys(item).length !== 2 || typeof item.path !== 'string' || !within(root, item.path) || !validPreimageState(item.state)) ||
      detached.sourceMappings.some(item => !item || Object.keys(item).length !== 2 || typeof item.from !== 'string' || !path.isAbsolute(item.from) ||
        typeof item.to !== 'string' || !path.isAbsolute(item.to) || !validSourceMapping(item)) ||
      detached.mappings.some(item => !item || Object.keys(item).length !== 3 || typeof item.from !== 'string' || !path.isAbsolute(item.from) ||
        typeof item.to !== 'string' || !within(root, item.to) || within(root, item.from) || !Array.isArray(item.before) || item.before.some(entry =>
          !Array.isArray(entry) || entry.length !== 2 || !safeRelative(item.to, entry[0]) || !/^[a-f0-9]{64}$/.test(entry[1])))) invalid();
  const expectedStaged = [path.join(root, 'project'), ...detached.mappings.map(item => path.resolve(item.to))].sort();
  if (JSON.stringify(detached.staged.map(item => path.resolve(item.path)).sort()) !== JSON.stringify([...new Set(expectedStaged)])) invalid();
  const anchorPaths = expectedAnchorPaths([expectedTarget, ...detached.mappings.map(item => item.from), ...detached.workspaceDirs.map(name => path.join(expectedTarget, name))]);
  if (detached.anchors.some(item => !item || typeof item.path !== 'string' || !path.isAbsolute(item.path) ||
      (item.missing === true ? Object.keys(item).length !== 2 : Object.keys(item).sort().join(',') !== 'dev,ino,link,mode,path,real' ||
        !['dev', 'ino', 'mode', 'real'].every(key => typeof item[key] === 'string') || !(item.link === null || typeof item.link === 'string'))) ||
      JSON.stringify(detached.anchors.map(item => path.resolve(item.path)).sort()) !== JSON.stringify(anchorPaths)) invalid();
  const plan = structuredClone(detached);
  plan.lease = randomUUID();
  if (pool) {
    const existing = new Set(plan.preimages.map(item => path.resolve(item.path)));
    plan.preimages.unshift(...pool.preimages.filter(item => !existing.has(path.resolve(item.path))));
    pool.refs++;
  }
  const ownerCleanup = () => { try { cleanup(); } finally { if (pool) releaseInputPool(pool); } };
  stagedCleanups.set(plan.lease, { temp: root, cleanup: ownerCleanup, pool, seal: planSeal(plan), transferable: false, detach: () => {} });
  return plan;
}
