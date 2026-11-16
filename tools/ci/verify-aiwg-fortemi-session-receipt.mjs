#!/usr/bin/env node
// Bind synthetic CLI session exports to receipts and pinned native Fortemi APIs.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import { unpackTarGz, validateFullV1ShardArchive } from '@fortemi/core';
import { boundedSpawnSync } from '../../src/process/bounded-child-process.mjs';
import { buildSessionFixture, fixtureClock, sessionFixture } from './fortemi-session-fixture.mjs';

const root = resolve(import.meta.dirname, '../..');
const fixtureRoot = 'test/fixtures/fortemi-shard';
const producerPath = `${fixtureRoot}/aiwg-session-full-v1.producer.receipt.json`;
const consumerPath = `${fixtureRoot}/aiwg-session-full-v1.consumer.receipt.json`;
const schemaPath = 'schemas/artifacts/aiwg-fortemi-full-v1-consumer-receipt.v1.schema.json';
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(`Fortemi session receipt: ${message}`); };

function run(command, args, options = {}) {
  const { tier = 'quick', ...spawnOptions } = options;
  const result = boundedSpawnSync(command, args, tier, { cwd: root, encoding: 'utf8', ...spawnOptions });
  assert(!result.error && result.status === 0,
    `${command} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout;
}

export function validateSessionPair(producer, consumer) {
  // The existing schema has a registered strictRequired exception for legacy
  // allOf declarations; all other strict checks remain enabled.
  for (const [phase, receipt] of [['producer', producer], ['consumer', consumer]]) {
    validateReceiptSchema(receipt);
    assert(receipt.consumers.session?.phase === phase, `${phase} receipt phase mismatch`);
    assert(receipt.consumers.session.clock === fixtureClock, 'fixture clock mismatch');
    assert(receipt.advertisement.advertised === false, 'main CI verification is still pending');
    assert(receipt.conversion.contract_valid === true && receipt.conversion.lossless === true
      && receipt.conversion.losses.length === 0, 'conversion receipt declares loss or invalid contract');
    assert(receipt.conversion.schema_version === 'fortemi.aiwg-full-v1-conversion-receipt.v1'
      && receipt.conversion.source_schema_version === 'aiwg.fortemi.index.export.v2', 'conversion schema mismatch');
  }
  const expected = structuredClone(producer);
  expected.consumers.session.phase = 'consumer';
  assert(isDeepStrictEqual(expected, consumer), 'producer/consumer receipt bindings differ');
  const artifact = readJson(`${fixtureRoot}/aiwg-full-v1.consumer.receipt.json`);
  assert(consumer.consumers.fortemi.commit === artifact.consumers.fortemi.commit, 'consumer commit differs from artifact lane');
  assert(isDeepStrictEqual(consumer.converter, artifact.converter), 'converter pin differs from artifact lane');
  assert(isDeepStrictEqual(consumer.authority, artifact.authority), 'authority pin differs from artifact lane');
  assert(consumer.source.path === sessionFixture, 'session source fixture mismatch');
  return consumer;
}

export function validateReceiptSchema(receipt) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  const validate = ajv.compile(readJson(schemaPath));
  assert(validate(receipt), `receipt schema: ${ajv.errorsText(validate.errors)}`);
}

export async function verifySessionArchive(archive, receipt) {
  assert(digest(archive) === receipt.archive.sha256, 'archive SHA-256 mismatch');
  assert(archive.length === receipt.archive.bytes, 'archive byte count mismatch');
  const validated = await validateFullV1ShardArchive(archive);
  assert(validated.valid, `archive contract: ${validated.errors.join('; ')}`);
  const files = unpackTarGz(archive);
  const manifest = JSON.parse(Buffer.from(files.get('manifest.json')).toString());
  const expected = receipt.archive.manifest;
  assert(manifest.profile === 'full-v1' && manifest.version === '2.0.0', 'archive tuple mismatch');
  assert(manifest.format === expected.format && manifest.profile === expected.profile
    && manifest.version === expected.version, 'receipt archive tuple mismatch');
  assert(manifest.components.length === 33 && new Set(manifest.components).size === 33
    && expected.components === 33, 'archive component inventory mismatch');
  assert(digest(files.get('manifest.json')) === expected.manifest_sha256, 'manifest digest mismatch');
  const notes = records(files, 'notes.jsonl');
  for (const [type, count] of [['aiwg.session', receipt.consumers.session.session_count],
    ['aiwg.session-event', receipt.consumers.session.event_count]]) {
    assert(notes.filter((note) => note.metadata?.aiwg_source?.record_type === type).length === count,
      `${type} count mismatch`);
  }
  return files;
}

function records(files, name) {
  const text = Buffer.from(files.get(name) ?? []).toString('utf8');
  return name.endsWith('.jsonl') ? text.split('\n').filter(Boolean).map((line) => JSON.parse(line)) : JSON.parse(text);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
    && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return value;
}

const unordered = (values) => values.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

// Names the records a re-export removed or added (canonical JSON, bounded) so CI shows the change (#4217).
export function describeRecordChange(before, after, limit = 4096) {
  const asList = (value) => (Array.isArray(value) ? value : [value]).map((item) => JSON.stringify(canonical(item)));
  const was = asList(before), now = asList(after);
  const removed = was.filter((item) => !now.includes(item)), added = now.filter((item) => !was.includes(item));
  const text = `removed=[${removed.join(',')}] added=[${added.join(',')}]`;
  return text.length > limit ? `${text.slice(0, limit)}... (${text.length} chars)` : text;
}

export async function verifySessionReexport(source, reexported) {
  const validation = await validateFullV1ShardArchive(reexported);
  assert(validation.valid, `native re-export contract: ${validation.errors.join('; ')}`);
  const before = unpackTarGz(source), after = unpackTarGz(reexported);
  const manifest = JSON.parse(Buffer.from(before.get('manifest.json')).toString());
  const actual = JSON.parse(Buffer.from(after.get('manifest.json')).toString());
  assert(actual.profile === 'full-v1' && actual.version === '2.0.0', 'native re-export tuple mismatch');
  assert(isDeepStrictEqual(unordered(manifest.components), unordered(actual.components)), 'native component inventory mismatch');
  for (const name of Object.keys(manifest.checksums)) {
    assert(after.has(name), `native re-export missing ${name}`);
    const was = records(before, name), now = records(after, name);
    if (!isDeepStrictEqual(Array.isArray(was) ? unordered(was) : canonical(was), Array.isArray(now) ? unordered(now) : canonical(now))) {
      assert(false, `native semantic re-export changed ${name}: ${describeRecordChange(was, now)}`);
    }
  }
}

export function verifyApiObservations(archive, observations) {
  const files = unpackTarGz(archive);
  const notes = records(files, 'notes.jsonl');
  const activities = records(files, 'provenance_activities.jsonl');
  assert(Array.isArray(observations) && observations.length === notes.length, 'API note count mismatch');
  assert(new Set(observations.map((item) => item.note?.note?.id)).size === notes.length, 'duplicate API notes');
  for (const expected of notes) {
    const observed = observations.find((item) => item.note?.note?.id === expected.id);
    assert(observed, `API missing note ${expected.id}`);
    assert(isDeepStrictEqual(observed.note.note.metadata?.aiwg_source, expected.metadata.aiwg_source), 'API source identity mismatch');
    assert(observed.note.note.title === expected.title && observed.note.original?.content === expected.original_content,
      'API session/event content mismatch');
    assert(Array.isArray(observed.note.tags) && isDeepStrictEqual(unordered(observed.note.tags), unordered(expected.tags)), 'API tags mismatch');
    for (const activity of activities.filter((item) => item.note_id === expected.id)) {
      const exposed = observed.provenance?.all_activities?.find((item) => item.id === activity.id);
      assert(exposed?.activity_type === activity.activity_type
        && isDeepStrictEqual(exposed.metadata, activity.metadata), 'API analysis provenance missing or changed');
    }
  }
}

function verifyPins(receipt) {
  const locked = readJson('package-lock.json').packages['node_modules/@fortemi/core'];
  const installed = readJson('node_modules/@fortemi/core/package.json');
  assert(installed.version === receipt.converter.package.version && locked.version === installed.version
    && locked.integrity === receipt.converter.package.integrity, 'installed/locked Core pin mismatch');
  const revision = receipt.consumer;
  assert(run('git', ['rev-parse', `${revision.commit}^{commit}`]).trim() === revision.commit, 'producer commit unavailable');
  const packageIdentity = JSON.parse(run('git', ['show', `${revision.commit}:package.json`]));
  assert(packageIdentity.name === revision.package.name && packageIdentity.version === revision.package.version,
    'immutable producer package mismatch');
  for (const reference of [receipt.source, ...receipt.consumers.session.producer_sources]) {
    assert(digest(readFileSync(resolve(root, reference.path))) === reference.sha256, `source digest mismatch: ${reference.path}`);
    assert(digest(run('git', ['show', `${revision.commit}:${reference.path}`], { encoding: null })) === reference.sha256,
      `immutable producer source mismatch: ${reference.path}`);
  }
}

async function verifyNative(checkout, archive) {
  assert(process.env.DATABASE_URL, '--server-checkout requires an isolated DATABASE_URL');
  const pin = readJson(consumerPath).consumers.fortemi.commit;
  assert(run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).trim() === pin, 'Fortemi checkout commit mismatch');
  assert(run('git', ['status', '--porcelain'], { cwd: checkout }).trim() === '', 'Fortemi checkout must be clean');
  const directory = mkdtempSync(join(tmpdir(), 'aiwg-session-consumer-'));
  try {
    // Compile the same pinned source plus a test-only include in a disposable
    // copy. No handlers or production behavior are patched in the consumer.
    run('git', ['archive', '--format=tar', `--output=${join(directory, 'source.tar')}`, pin], { cwd: checkout });
    run('tar', ['-xf', join(directory, 'source.tar'), '-C', directory]);
    const main = join(directory, 'crates/matric-api/src/main.rs');
    const source = readFileSync(main, 'utf8');
    const anchor = '    #[tokio::test]\n    async fn shard_schema_2_clean_destinations_preserve_independent_full_v1_archives()';
    assert(source.split(anchor).length === 2, 'pinned native test insertion anchor changed');
    const harness = join(directory, 'aiwg-session-api-test.rs');
    writeFileSync(harness, readFileSync(resolve(root, 'tools/ci/fortemi-session-api-test.rs')));
    writeFileSync(main, source.replace(anchor, `    include!(${JSON.stringify(harness)});\n\n${anchor}`));
    writeFileSync(join(directory, 'session.shard'), archive);
    const reexportPath = join(directory, 'reexport.shard');
    const observationsPath = join(directory, 'api.json');
    run('cargo', ['test', '--locked', '-p', 'matric-api', '--bin', 'matric-api',
      'tests::aiwg_session_full_v1_api_conformance', '--', '--exact', '--nocapture'], {
      cwd: directory, tier: 'long', stdio: 'inherit',
      env: { ...process.env, CARGO_TARGET_DIR: join(checkout, 'target'),
        AIWG_SESSION_SHARD: join(directory, 'session.shard'), AIWG_SESSION_REEXPORT: reexportPath,
        AIWG_SESSION_API_OBSERVATIONS: observationsPath },
    });
    const observations = JSON.parse(readFileSync(observationsPath, 'utf8'));
    verifyApiObservations(archive, observations);
    await verifySessionReexport(archive, readFileSync(reexportPath));
    assert(run('git', ['status', '--porcelain'], { cwd: checkout }).trim() === '', 'Fortemi checkout changed');
    return { status: 'passed', consumer_commit: pin, archive_sha256: digest(archive),
      clean_destination: true, semantic_reexport: true, repeated_imports: 2,
      zero_mutation_on_failure: true, component_count: 33, api_notes: observations.length };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function writeFixtures() {
  const template = readJson(`${fixtureRoot}/aiwg-full-v1.consumer.receipt.json`);
  const generated = buildSessionFixture(root);
  const manifest = JSON.parse(Buffer.from(unpackTarGz(generated.archive).get('manifest.json')).toString());
  const archivePath = `${fixtureRoot}/aiwg-session-full-v1.shard`;
  writeFileSync(resolve(root, archivePath), generated.archive);
  const producer = {
    schema_version: template.schema_version,
    consumer: { ...template.consumer, commit: run('git', ['rev-parse', 'HEAD']).trim(),
      package: { name: readJson('package.json').name, version: readJson('package.json').version } },
    converter: template.converter, authority: template.authority,
    source: { path: sessionFixture, sha256: digest(readFileSync(resolve(root, sessionFixture))) },
    archive: { path: archivePath, sha256: digest(generated.archive), bytes: generated.archive.length,
      manifest: { format: manifest.format, version: manifest.version, profile: manifest.profile, components: manifest.components.length,
        manifest_sha256: generated.receipt.fortemiReceipt.manifest_sha256 } },
    conversion: { schema_version: generated.receipt.fortemiReceipt.schema_version,
      source_schema_version: generated.receipt.indexSchemaVersion, contract_valid: generated.receipt.fortemiReceipt.contract_valid,
      lossless: generated.receipt.lossless, losses: generated.receipt.losses },
    consumers: {
      session: { phase: 'producer', clock: fixtureClock,
        // Bind the shard producer itself, not the CLI router, which changes for unrelated verbs.
        producer_sources: ['src/sessions/fortemi-export-mapping.ts', 'src/sessions/fortemi-shard-recovery.ts'].map((path) => ({ path, sha256: digest(readFileSync(resolve(root, path))) })),
        session_count: generated.receipt.totals.sessionCount, event_count: generated.receipt.totals.eventCount },
      fortemi: { repository: template.consumers.fortemi.repository, commit: template.consumers.fortemi.commit,
        status: 'pending', reason: 'Native Docker consumer verification and the main CI run are pending; no consumer success is claimed.' },
    },
    advertisement: { advertised: false, default_profile: 'full-v1',
      reason: 'Verified (CI job producer-consumer-receipt) applies only once the job main run passes.' },
    coordination: { aiwg_issue: 'https://git.integrolabs.net/roctinam/aiwg/issues/2570' },
  };
  const consumer = structuredClone(producer);
  consumer.consumers.session.phase = 'consumer';
  validateSessionPair(producer, consumer);
  writeFileSync(resolve(root, producerPath), `${JSON.stringify(producer, null, 2)}\n`);
  writeFileSync(resolve(root, consumerPath), `${JSON.stringify(consumer, null, 2)}\n`);
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--write-fixtures')) await writeFixtures();
  const receipt = validateSessionPair(readJson(producerPath), readJson(consumerPath));
  verifyPins(receipt);
  const archive = readFileSync(resolve(root, receipt.archive.path));
  await verifySessionArchive(archive, receipt);
  const fresh = buildSessionFixture(root);
  await verifySessionArchive(fresh.archive, receipt);
  assert(fresh.receipt.lossless === true && fresh.receipt.losses.length === 0, 'fresh CLI conversion is lossy');
  assert(fresh.receipt.fortemiReceipt.authority_commit === receipt.authority.commit
    && fresh.receipt.fortemiReceipt.authority_contract_sha256 === receipt.authority.contract_sha256
    && fresh.receipt.fortemiReceipt.authority_schema_bundle_sha256 === receipt.authority.schema_bundle_sha256,
  'fresh CLI conversion authority mismatch');
  const flag = args.indexOf('--server-checkout');
  let runtime = { status: 'pending', reason: receipt.consumers.fortemi.reason };
  if (flag >= 0) {
    assert(args[flag + 1], '--server-checkout requires a path');
    runtime = await verifyNative(resolve(args[flag + 1]), fresh.archive);
    const output = mkdtempSync(join(tmpdir(), 'aiwg-session-receipts-'));
    const runtimeBytes = Buffer.from(`${JSON.stringify(runtime, null, 2)}\n`);
    const runtimePath = join(output, 'runtime.json');
    writeFileSync(runtimePath, runtimeBytes);
    const delivered = structuredClone(receipt);
    delivered.consumers.fortemi = {
      repository: receipt.consumers.fortemi.repository, commit: runtime.consumer_commit,
      status: 'passed', reason: 'Native import, note/provenance APIs and semantic re-export passed.',
      runtime_receipt: { path: runtimePath, sha256: digest(runtimeBytes), bytes: runtimeBytes.length },
      clean_destination: true, semantic_reexport: true, repeated_imports: 2,
      zero_mutation_on_failure: true, component_count: 33,
    };
    validateReceiptSchema(delivered);
    const deliveredPath = join(output, 'consumer.receipt.json');
    writeFileSync(deliveredPath, `${JSON.stringify(delivered, null, 2)}\n`);
    runtime = { ...runtime, schemaValidatedReceipt: deliveredPath, receipt: delivered };
  }
  console.log(JSON.stringify({ producerReceipt: producerPath, consumerReceipt: consumerPath, ...runtime }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `\nSession full-v1 consumer: ${runtime.status}. Main-run success is required before marking documentation Verified.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
