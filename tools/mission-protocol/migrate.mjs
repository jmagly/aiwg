#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importImpl } from '../_resolve-impl.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TARGET_VERSION = 'mission.aiwg.io/v1';
const TOOL_VERSION = '1.0.0';
const STATE_DIR = '.aiwg/mission-migrations';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const iso = () => new Date().toISOString();

function migrationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error('Migration id must contain only letters, digits, dot, underscore, or hyphen (maximum 128 characters).');
  }
  return value;
}

async function atomicWrite(target, bytes) {
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, target);
}

function detectedVersion(value) {
  if (!value || typeof value !== 'object') return 'unknown';
  return value.apiVersion ?? value.api_version ?? value.schemaVersion ?? value.schema_version ?? 'unversioned';
}

function sourceFor(value) {
  const version = detectedVersion(value);
  if (version === TARGET_VERSION && value.kind === 'Mission') return 'canonical';
  if (typeof version === 'string' && /\/v([2-9]|\d{2,})(?:$|[.-])/.test(version)) return 'unsupported-major';
  if (value.checkpoint || value.activityLog) return 'mission-ledger';
  if (value.cycles || value.goal) return 'mission-plan';
  if (value.mission_id) return 'executor-v1';
  if (value.missionId || value.objective || value.id) return 'mission-control-session';
  return 'ambiguous';
}

async function codec() {
  return importImpl(import.meta.url, 'mission-protocol/index.js');
}

async function transformDocument(value) {
  const { decodeMission } = await codec();
  if (value?.apiVersion === TARGET_VERSION && value?.kind === 'Mission') return value;
  if (Array.isArray(value?.missions)) {
    const missions = [];
    for (const mission of value.missions) {
      const source = sourceFor(mission);
      if (source === 'unsupported-major') throw new Error(`unknown major version '${detectedVersion(mission)}'`);
      if (source === 'ambiguous') throw new Error('ambiguous Mission mapping');
      missions.push(decodeMission(mission, source).value);
    }
    return { ...value, schemaVersion: TARGET_VERSION, missions };
  }
  const source = sourceFor(value);
  if (source === 'unsupported-major') throw new Error(`unknown major version '${detectedVersion(value)}'`);
  if (source === 'ambiguous') throw new Error('ambiguous Mission mapping');
  return decodeMission(value, source).value;
}

async function walk(directory, output, depth = 0) {
  if (depth > 10) return;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target, output, depth + 1);
    else if (entry.name === 'session.json' || entry.name.endsWith('.mission.json')) output.push(target);
  }
}

async function approvedRoot(requested) {
  const workspace = await realpath(path.resolve(requested));
  return workspace;
}

export async function discoverMigration(requestedRoot = process.cwd()) {
  const root = await approvedRoot(requestedRoot);
  const targets = [];
  await walk(path.join(root, '.aiwg'), targets);
  const files = [];
  let requiredBytes = 0;
  for (const target of targets.sort()) {
    const bytes = await readFile(target);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { files.push({ path: path.relative(root, target), detectedVersion: 'corrupted', action: 'fail-closed', unknowns: ['invalid JSON'], bytes: bytes.length }); continue; }
    const source = Array.isArray(value?.missions) ? 'session-container' : sourceFor(value);
    const unknowns = ['unsupported-major', 'ambiguous'].includes(source) ? [source] : [];
    files.push({ path: path.relative(root, target), detectedVersion: detectedVersion(value), action: source === 'canonical' ? 'none' : unknowns.length ? 'fail-closed' : 'migrate', transformations: source === 'canonical' ? [] : ['decode legacy state', `encode ${TARGET_VERSION}`], unknowns, bytes: bytes.length });
    requiredBytes += bytes.length * 2;
  }
  return { root, targetVersion: TARGET_VERSION, files, requiredBytes, contentExcluded: true };
}

async function loadManifest(root, id) {
  return JSON.parse(await readFile(path.join(root, STATE_DIR, `${migrationId(id)}.json`), 'utf8'));
}

async function saveManifest(root, manifest) {
  await atomicWrite(path.join(root, STATE_DIR, `${migrationId(manifest.id)}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function applyMigration({ root: requestedRoot = process.cwd(), targetVersion, id = `mission-${Date.now()}`, interruptAfter } = {}) {
  if (targetVersion !== TARGET_VERSION) throw new Error(`Apply requires --target ${TARGET_VERSION}.`);
  migrationId(id);
  const discovery = await discoverMigration(requestedRoot);
  const root = discovery.root;
  try {
    const existing = await loadManifest(root, id);
    if (existing.targetVersion !== targetVersion) throw new Error(`Migration '${id}' already targets ${existing.targetVersion}.`);
    return resumeMigration({ root, id, interruptAfter });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const blocked = discovery.files.filter(file => file.unknowns.length);
  if (blocked.length) throw new Error(`Migration fails closed: ${blocked.map(file => `${file.path} (${file.unknowns.join(', ')})`).join(', ')}`);
  const stateRoot = path.join(root, STATE_DIR);
  const backupRoot = path.join(stateRoot, `${id}.backup`);
  await mkdir(stateRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: false }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const entries = [];
  for (const item of discovery.files.filter(file => file.action === 'migrate')) {
    const sourcePath = path.join(root, item.path);
    const before = await readFile(sourcePath);
    const after = Buffer.from(`${JSON.stringify(await transformDocument(JSON.parse(before.toString('utf8'))), null, 2)}\n`);
    const backupPath = path.join(backupRoot, `${entries.length}.bin`);
    await writeFile(backupPath, before, { flag: 'wx', mode: 0o600 });
    const backup = await readFile(backupPath);
    if (sha256(backup) !== sha256(before)) throw new Error(`Backup verification failed for ${item.path}.`);
    entries.push({ path: item.path, backup: path.relative(root, backupPath), sourceVersion: item.detectedVersion, targetVersion, toolVersion: TOOL_VERSION, timestamp: iso(), beforeDigest: sha256(before), afterDigest: sha256(after), status: 'prepared' });
  }
  const manifest = { schemaVersion: 'mission-migration.aiwg.io/v1', id, targetVersion, toolVersion: TOOL_VERSION, createdAt: iso(), state: 'prepared', entries };
  await saveManifest(root, manifest); // durable manifest exists before the first mutation
  return resumeMigration({ root, id, interruptAfter });
}

export async function resumeMigration({ root: requestedRoot = process.cwd(), id, interruptAfter } = {}) {
  const root = await approvedRoot(requestedRoot);
  const manifest = await loadManifest(root, id);
  let written = 0;
  for (const entry of manifest.entries) {
    const target = path.join(root, entry.path);
    const current = await readFile(target);
    if (sha256(current) === entry.afterDigest) { entry.status = 'applied'; continue; }
    if (sha256(current) !== entry.beforeDigest) throw new Error(`Resume refused: ${entry.path} differs from both before and after digests.`);
    const transformed = Buffer.from(`${JSON.stringify(await transformDocument(JSON.parse(current.toString('utf8'))), null, 2)}\n`);
    if (sha256(transformed) !== entry.afterDigest) throw new Error(`Non-deterministic transformation detected for ${entry.path}.`);
    await atomicWrite(target, transformed);
    entry.status = 'applied';
    manifest.state = 'applying';
    await saveManifest(root, manifest);
    written += 1;
    if (interruptAfter && written >= interruptAfter) throw new Error(`Migration interrupted after ${written} write(s); resume with --resume ${id}.`);
  }
  manifest.state = 'applied'; manifest.completedAt = iso();
  await saveManifest(root, manifest);
  return manifest;
}

export async function verifyMigration({ root: requestedRoot = process.cwd(), id }) {
  const root = await approvedRoot(requestedRoot);
  const manifest = await loadManifest(root, id);
  const failures = [];
  for (const entry of manifest.entries) if (sha256(await readFile(path.join(root, entry.path))) !== entry.afterDigest) failures.push(entry.path);
  return { id, valid: failures.length === 0, failures, entries: manifest.entries.length };
}

export async function rollbackMigration({ root: requestedRoot = process.cwd(), id }) {
  const root = await approvedRoot(requestedRoot);
  const manifest = await loadManifest(root, id);
  for (const entry of [...manifest.entries].reverse()) {
    const backup = await readFile(path.join(root, entry.backup));
    if (sha256(backup) !== entry.beforeDigest) throw new Error(`Rollback backup integrity failure for ${entry.path}.`);
    const target = path.join(root, entry.path);
    const currentDigest = sha256(await readFile(target));
    if (![entry.beforeDigest, entry.afterDigest].includes(currentDigest)) throw new Error(`Rollback refused: ${entry.path} was modified after migration.`);
    if (currentDigest !== entry.beforeDigest) await atomicWrite(target, backup);
    if (sha256(await readFile(target)) !== entry.beforeDigest) throw new Error(`Rollback verification failed for ${entry.path}.`);
    entry.status = 'rolled-back';
  }
  manifest.state = 'rolled-back'; manifest.rolledBackAt = iso();
  await saveManifest(root, manifest);
  return manifest;
}

async function main(args = process.argv.slice(2)) {
  const value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const root = value('--root') ?? process.cwd();
  let result;
  if (args.includes('--apply')) result = await applyMigration({ root, targetVersion: value('--target'), id: value('--id') });
  else if (args.includes('--verify')) result = await verifyMigration({ root, id: value('--verify') ?? value('--id') });
  else if (args.includes('--resume')) result = await resumeMigration({ root, id: value('--resume') ?? value('--id') });
  else if (args.includes('--rollback')) result = await rollbackMigration({ root, id: value('--rollback') ?? value('--id') });
  else result = await discoverMigration(root);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(error.message); process.exitCode = 1; });
