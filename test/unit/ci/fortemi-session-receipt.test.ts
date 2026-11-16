import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packTarGz, unpackTarGz } from '@fortemi/core';
import {
  digest, validateReceiptSchema, validateSessionPair, verifyApiObservations, verifySessionArchive, verifySessionReexport, describeRecordChange, isDestinationDefaultEmbeddingConfig,
} from '../../../tools/ci/verify-aiwg-fortemi-session-receipt.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixtureRoot = resolve(root, 'test/fixtures/fortemi-shard');
const readReceipt = (phase: string) => JSON.parse(readFileSync(
  resolve(fixtureRoot, `aiwg-session-full-v1.${phase}.receipt.json`), 'utf8',
));
const archive = readFileSync(resolve(fixtureRoot, 'aiwg-session-full-v1.shard'));
const files = unpackTarGz(archive);
const jsonLines = (name: string) => Buffer.from(files.get(name)!).toString().split('\n').filter(Boolean).map((line) => JSON.parse(line));

// Fake native API responses; no database, Docker, model, or network access.
function apiResponses() {
  const activities = jsonLines('provenance_activities.jsonl');
  return jsonLines('notes.jsonl').map((note) => ({
    note: {
      note: { id: note.id, title: note.title, metadata: note.metadata },
      original: { content: note.original_content }, tags: note.tags,
    },
    provenance: { all_activities: activities.filter((activity) => activity.note_id === note.id) },
  }));
}

describe('session full-v1 receipt bindings (offline)', () => {
  it('validates both pending fixtures through the existing strict receipt schema', () => {
    const producer = readReceipt('producer'), consumer = readReceipt('consumer');
    expect(validateSessionPair(producer, consumer)).toBe(consumer);
    expect(consumer.consumers.fortemi.status).toBe('pending');
    expect(consumer.consumers.fortemi).not.toHaveProperty('semantic_reexport');
    expect(consumer.consumers.session).toMatchObject({ session_count: 2, event_count: 3 });
  });

  it.each(['producer', 'consumer'])('rejects a malformed %s revision', (phase) => {
    const producer = readReceipt('producer'), consumer = readReceipt('consumer');
    (phase === 'producer' ? producer : consumer).consumer.commit = 'unbound';
    expect(() => validateSessionPair(producer, consumer)).toThrow(/schema/);
  });

  it('rejects a receipt pair pinned to a different real consumer', () => {
    const producer = readReceipt('producer'), consumer = readReceipt('consumer');
    producer.consumers.fortemi.commit = 'a'.repeat(40);
    consumer.consumers.fortemi.commit = producer.consumers.fortemi.commit;
    expect(() => validateSessionPair(producer, consumer)).toThrow(/consumer commit/);
  });

  it('rejects mismatched producer and consumer archives', () => {
    const producer = readReceipt('producer'), consumer = readReceipt('consumer');
    consumer.archive.sha256 = '0'.repeat(64);
    expect(() => validateSessionPair(producer, consumer)).toThrow(/bindings differ/);
  });

  it.each(['semantic_reexport', 'clean_destination', 'runtime_receipt'])('rejects a pending receipt claiming %s', (field) => {
    const producer = readReceipt('producer'), consumer = readReceipt('consumer');
    consumer.consumers.fortemi[field] = field === 'runtime_receipt' ? { path: 'fake', sha256: 'a'.repeat(64) } : true;
    expect(() => validateSessionPair(producer, consumer)).toThrow(/schema/);
  });

  it('rejects a passed claim without runtime evidence', () => {
    const producer = readReceipt('producer'), consumer = readReceipt('consumer');
    consumer.consumers.fortemi.status = 'passed';
    expect(() => validateSessionPair(producer, consumer)).toThrow(/schema/);
  });

  it('accepts a schema-bound runtime receipt only with all success evidence', () => {
    const consumer = readReceipt('consumer');
    Object.assign(consumer.consumers.fortemi, {
      status: 'passed', runtime_receipt: { path: 'runtime.json', sha256: 'a'.repeat(64) },
      clean_destination: true, semantic_reexport: true, repeated_imports: 2,
      zero_mutation_on_failure: true, component_count: 33,
    });
    expect(() => validateReceiptSchema(consumer)).not.toThrow();
    consumer.consumers.fortemi.repeated_imports = 1;
    expect(() => validateReceiptSchema(consumer)).toThrow(/schema/);
  });

  it('rejects a lossy conversion even when both receipts agree', () => {
    const producer = readReceipt('producer'), consumer = readReceipt('consumer');
    producer.conversion.lossless = consumer.conversion.lossless = false;
    expect(() => validateSessionPair(producer, consumer)).toThrow(/declares loss/);
  });

  it('validates the genuine six-note archive and a semantic re-export', async () => {
    await expect(verifySessionArchive(archive, readReceipt('consumer'))).resolves.toBeInstanceOf(Map);
    await expect(verifySessionReexport(archive, archive)).resolves.toBeUndefined();
  });

  it('rejects archive checksum drift and wrong session/event counts', async () => {
    await expect(verifySessionArchive(archive.subarray(1), readReceipt('consumer'))).rejects.toThrow(/SHA-256/);
    const receipt = readReceipt('consumer');
    receipt.consumers.session.event_count++;
    await expect(verifySessionArchive(archive, receipt)).rejects.toThrow(/event count/);
  });

  it('rejects a re-export with internally valid checksums but changed event text', async () => {
    const changed = new Map(files);
    const notes = jsonLines('notes.jsonl');
    notes.find((note) => note.metadata.aiwg_source.record_type === 'aiwg.session-event').original_content = 'Lost analysis';
    const bytes = Buffer.from(notes.map((note) => JSON.stringify(note)).join('\n'));
    changed.set('notes.jsonl', bytes);
    const manifest = JSON.parse(Buffer.from(files.get('manifest.json')!).toString());
    manifest.checksums['notes.jsonl'] = digest(bytes);
    changed.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    await expect(verifySessionReexport(archive, packTarGz(changed))).rejects.toThrow(/notes.jsonl/);
  });

  it('names the records a re-export removed or added (#4217)', () => {
    expect(describeRecordChange([], [{ name: 'default', model: 'seeded-model', dimension: 768 }]))
      .toBe('removed=[] added=[{"dimension":768,"model":"seeded-model","name":"default"}]');
    expect(describeRecordChange([{ id: 1 }, { id: 2 }], [{ id: 2 }])).toBe('removed=[{"id":1}] added=[]');
    expect(describeRecordChange([], [{ text: 'x'.repeat(100) }], 40)).toMatch(/^removed=\[\] added=\[\{"text":"x+\.\.\. \(\d+ chars\)$/);
  });

  // Fortemi's seeded default embedding configuration, as returned by run 108354 (#4217).
  const destinationDefault = {"benchmark_scores":{"context_length":8192,"mteb_classification":0.723,"mteb_clustering":0.491,"mteb_retrieval":0.537},"chunk_overlap":200,"chunk_size":1500,"content_types":[],"created_at":"2026-11-16T21:46:35.075Z","default_truncate_dim":256,"description":"Default embedding configuration using nomic-embed-text (768 dimensions)","dimension":768,"document_composition":{},"hnsw_ef_construction":64,"hnsw_m":16,"id":"01a1e653-82c5-7229-baba-96997c774000","is_available":true,"is_default":true,"ivfflat_lists":100,"limitations":["Large model size (~1GB)"],"matryoshka_dims":[768,512,256,128,64],"model":"nomic-embed-text","name":"default","provider":"ollama","provider_config":{},"recommended_for":["general-search","long-documents","semantic-dedup"],"strengths":["long-context","symmetric","general-purpose"],"supports_mrl":true,"updated_at":"2026-11-16T21:46:35.075Z"};

  it('allows only the destination default embedding config as a re-export addition (#4217)', () => {
    expect(isDestinationDefaultEmbeddingConfig('embedding_configs.json', [], [destinationDefault])).toBe(true);
    expect(isDestinationDefaultEmbeddingConfig('embedding_configs.json', [], [{ ...destinationDefault, is_default: false }])).toBe(false);
    expect(isDestinationDefaultEmbeddingConfig('embedding_configs.json', [], [destinationDefault, destinationDefault])).toBe(false);
    expect(isDestinationDefaultEmbeddingConfig('embedding_configs.json', [{ name: 'source' }], [destinationDefault])).toBe(false);
    expect(isDestinationDefaultEmbeddingConfig('embedding_sets.json', [], [destinationDefault])).toBe(false);
  });

  it('accepts a re-export that only adds the destination default embedding config', async () => {
    const changed = new Map(files);
    const bytes = Buffer.from(JSON.stringify([destinationDefault]));
    changed.set('embedding_configs.json', bytes);
    const manifest = JSON.parse(Buffer.from(files.get('manifest.json')!).toString());
    manifest.checksums['embedding_configs.json'] = digest(bytes);
    manifest.counts.embedding_configs = 1;
    changed.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    await expect(verifySessionReexport(archive, packTarGz(changed))).resolves.toBeUndefined();
  });

  it('still rejects a re-export that adds a non-default embedding config', async () => {
    const changed = new Map(files);
    const bytes = Buffer.from(JSON.stringify([{ ...destinationDefault, is_default: false }]));
    changed.set('embedding_configs.json', bytes);
    const manifest = JSON.parse(Buffer.from(files.get('manifest.json')!).toString());
    manifest.checksums['embedding_configs.json'] = digest(bytes);
    manifest.counts.embedding_configs = 1;
    changed.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    await expect(verifySessionReexport(archive, packTarGz(changed))).rejects.toThrow(/changed embedding_configs\.json/);
  });

  it('includes the record change in the re-export failure message', async () => {
    const changed = new Map(files);
    const notes = jsonLines('notes.jsonl');
    notes.find((note) => note.metadata.aiwg_source.record_type === 'aiwg.session-event').original_content = 'Lost analysis';
    const bytes = Buffer.from(notes.map((note) => JSON.stringify(note)).join('\n'));
    changed.set('notes.jsonl', bytes);
    const manifest = JSON.parse(Buffer.from(files.get('manifest.json')!).toString());
    manifest.checksums['notes.jsonl'] = digest(bytes);
    changed.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    await expect(verifySessionReexport(archive, packTarGz(changed))).rejects.toThrow(/changed notes\.jsonl: removed=\[.+\] added=\[.+Lost analysis/);
  });
});

describe('native session/event note and analysis API observations (offline)', () => {
  it('accepts complete note, tag, identity and provenance responses', () => {
    expect(() => verifyApiObservations(archive, apiResponses())).not.toThrow();
  });

  it('rejects missing session/event notes and duplicate responses', () => {
    expect(() => verifyApiObservations(archive, apiResponses().slice(1))).toThrow(/note count/);
    const duplicate = apiResponses();
    duplicate[0] = duplicate[1];
    expect(() => verifyApiObservations(archive, duplicate)).toThrow(/duplicate API/);
  });

  it.each(['text', 'tags', 'identity', 'analysis'])('rejects lost %s in native API responses', (field) => {
    const responses = apiResponses();
    const event = responses.find((item) => item.note.note.metadata.aiwg_source.record_type === 'aiwg.session-event')!;
    if (field === 'text') event.note.original.content = '';
    if (field === 'tags') event.note.tags = [];
    if (field === 'identity') event.note.note.metadata.aiwg_source.record_id = 'wrong';
    if (field === 'analysis') event.provenance.all_activities = [];
    expect(() => verifyApiObservations(archive, responses)).toThrow(/API/);
  });
});
