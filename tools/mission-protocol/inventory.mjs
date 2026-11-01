#!/usr/bin/env node
// Inventory current Mission surfaces, including unstaged changes discovered through Git.
import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importImpl } from '../_resolve-impl.mjs';

const { boundedExecFileSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baselinePath = path.join(root, 'schemas/mission-protocol/inventory-v1.json');
const marker = /\b(?:CanonicalMission|MissionPlan|MissionLedger|MissionProjection|UhpMissionEvidence|MISSION_API_VERSION|mission\.aiwg\.io\/v1|mission[_-]?id|missionId|mission control|executor\.aiwg\.io\/v1|fleet-workload\/v1)\b/i;
const roots = ['src/', 'schemas/', 'test/', 'tools/', 'docs/', 'apps/', 'agentic/code/'];
const requiredSurfaces = new Set([
  'src/a2a/types.ts', 'src/flow/graph-metadata.ts', 'src/mission-protocol/types.ts', 'src/mission-protocol/codecs.ts',
  'schemas/mission-v1.schema.json', 'schemas/mission-protocol/consumer-matrix-v1.json',
  'tools/mission-protocol/inventory.mjs', 'tools/mission-protocol/contract-diff.mjs',
  'tools/mission-protocol/migrate.mjs', 'docs/mission-protocol-migration.md',
  'docs/architecture/adr-mission-protocol-v1.md',
]);

function trackedFiles() {
  let output;
  try {
    output = boundedExecFileSync(process.env.AIWG_RG_BIN || 'rg', ['--files', ...roots], 'quick', { cwd: root, encoding: 'utf8' });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    output = boundedExecFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...roots], 'quick', { cwd: root, encoding: 'utf8' });
  }
  return output
    .split('\n').filter(Boolean)
    .filter(file => file !== 'schemas/mission-protocol/inventory-v1.json')
    .filter(file => /\.(?:ts|tsx|js|mjs|json|md|ya?ml)$/.test(file))
    .filter(file => !file.includes('/node_modules/') && !file.includes('/dist/'))
    .sort();
}

function classify(file, text) {
  const generated = file.includes('/plugins/');
  const role = file.includes('/test/') || file.startsWith('test/') ? 'fixture-or-test'
    : file.startsWith('schemas/') || /schema/i.test(path.basename(file)) ? 'schema'
      : /cockpit|apps\/web/.test(file) ? 'consumer-projection'
        : /conductor|bridge|handler|server|router/.test(file) ? 'producer-consumer'
          : file.endsWith('.md') ? 'documentation-example' : 'producer-consumer';
  const canonical = file === 'schemas/mission-v1.schema.json' || file.startsWith('src/mission-protocol/');
  const version = canonical || text.includes('mission.aiwg.io/v1') ? 'mission.aiwg.io/v1'
    : text.includes('executor.aiwg.io/v1') ? 'executor.aiwg.io/v1'
      : text.includes('fleet-workload/v1') ? 'fleet-workload/v1'
        : text.includes('graph.flow.aiwg.io/v1') ? 'graph.flow.aiwg.io/v1'
          : text.includes('2026-08-11') && /uhp/i.test(text) ? 'UHP 2026-08-11' : 'unversioned';
  const vocabulary = [...new Set([...text.matchAll(/['"](pending|running|working|completed|done|failed|incomplete|cancelled|canceled|aborted|unknown|operator-review-required|input-required)['"]/g)].map(match => match[1]))].sort();
  const migrationAction = generated ? 'retain' : canonical ? 'canonicalize' : role === 'documentation-example' ? 'adapt' : role === 'fixture-or-test' ? 'retain' : 'adapt';
  return {
    path: file,
    owner: file.split('/').slice(0, file.startsWith('agentic/') ? 4 : 2).join('/'),
    role,
    currentVersion: version,
    statusVocabulary: vocabulary,
    serialization: file.endsWith('.json') ? 'json' : file.endsWith('.jsonl') ? 'jsonl' : file.endsWith('.md') ? 'markdown' : 'typescript/javascript',
    migrationAction,
    migrationReason: migrationAction === 'canonicalize'
      ? 'Canonical Mission Protocol v1 source or contract.'
      : migrationAction === 'adapt'
        ? 'Legacy or transport-specific shape remains behind the versioned Mission codec adapter during the compatibility window.'
        : generated
          ? 'Generated provider copy remains byte-derived from its canonical source and is not edited independently.'
          : 'Compatibility fixture or test remains to prove legacy reads and mixed-version behavior.',
    ...(generated ? {
      canonicalSource: file
        .replace('/plugins/codex-sdlc/', '/frameworks/sdlc-complete/')
        .replace('/plugins/sdlc/', '/frameworks/sdlc-complete/')
        .replace('/plugins/agent-loop/', '/addons/agent-loop/')
        .replace('/plugins/utils/', '/addons/aiwg-utils/'),
    } : {}),
  };
}

export async function readInventorySource(directory, file) {
  try { return await readFile(path.join(directory, file), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function buildInventory() {
  const entries = [];
  for (const file of trackedFiles()) {
    const text = await readInventorySource(root, file);
    if (text === null) continue; // The Git index can still name unstaged deletions.
    if (file.startsWith('src/mission-protocol/') || file.startsWith('test/conformance/mission-v1/') || marker.test(text) || requiredSurfaces.has(file)) entries.push(classify(file, text));
  }
  return { schemaVersion: 'mission-inventory.aiwg.io/v1', generatedBy: 'tools/mission-protocol/inventory.mjs', entries };
}

async function persistedSummary(requestedRoot = root) {
  const approved = await realpath(root);
  const candidate = await realpath(path.resolve(requestedRoot));
  if (candidate !== approved && !candidate.startsWith(`${approved}${path.sep}`)) throw new Error('Persisted-state discovery root is outside the approved workspace.');
  let count = 0;
  const versions = new Map();
  function recordVersion(value) {
    const version = typeof value === 'string' && value.length <= 128 ? value : 'unversioned';
    versions.set(version, (versions.get(version) ?? 0) + 1);
  }
  async function inspectVersion(target, jsonl) {
    const info = await stat(target);
    if (info.size > 1024 * 1024) { recordVersion('unknown-oversized'); return; }
    try {
      const text = await readFile(target, 'utf8');
      const records = jsonl ? text.split(/\r?\n/).filter(Boolean).slice(0, 50).map(line => JSON.parse(line)) : [JSON.parse(text)];
      const record = records.find(value => value && typeof value === 'object') ?? {};
      recordVersion(record.apiVersion ?? record.api_version ?? record.schemaVersion ?? record.schema_version ?? record.version);
    } catch { recordVersion('unknown-invalid'); }
  }
  async function visit(directory, depth) {
    if (depth > 8) return;
    let children = [];
    try { children = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const child of children.slice(0, 10000)) {
      const target = path.join(directory, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) await visit(target, depth + 1);
      else if (child.name === 'session.json' || child.name.endsWith('.jsonl')) { count += 1; await inspectVersion(target, child.name.endsWith('.jsonl')); }
    }
  }
  const sessions = path.join(candidate, '.aiwg/ralph-external/mc/sessions');
  try { if ((await stat(sessions)).isDirectory()) await visit(sessions, 0); } catch { /* absent is a valid zero count */ }
  return { root: path.relative(approved, candidate) || '.', recordCount: count, versions: [...versions].map(([version, records]) => ({ version, records })).sort((a, b) => a.version.localeCompare(b.version)) };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--persisted-summary')) {
    const rootIndex = args.indexOf('--root');
    const rootArg = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
    console.log(JSON.stringify(await persistedSummary(rootArg || root), null, 2));
    return;
  }
  const inventory = await buildInventory();
  if (args.includes('--write')) {
    await writeFile(baselinePath, `${JSON.stringify(inventory, null, 2)}\n`);
    console.log(`Wrote ${inventory.entries.length} Mission contract entries to ${path.relative(root, baselinePath)}`);
    return;
  }
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  if (JSON.stringify(inventory) !== JSON.stringify(baseline)) {
    const known = new Set(baseline.entries.map(entry => entry.path));
    const added = inventory.entries.filter(entry => !known.has(entry.path)).map(entry => entry.path);
    throw new Error(`Mission inventory drift detected${added.length ? `; unclassified: ${added.join(', ')}` : ''}. Run with --write and review classifications.`);
  }
  console.log(`Mission inventory: OK (${inventory.entries.length} classified entries)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(error.message); process.exitCode = 1; });
