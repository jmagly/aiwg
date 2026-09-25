/**
 * Effect ledger v1 contract conformance (offline).
 *
 * Proves the schemas accept every positive fixture and reject every negative
 * fixture, recomputes the pinned identity vectors, verifies fixture signatures,
 * chains and checkpoints, scans fixtures for restricted material, and checks
 * the documented exit-code table against the ADR.
 *
 * @see docs/contracts/effect-ledger.v1.md
 * @see docs/architecture/adr-effect-ledger.md
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileSchemaCatalog, SchemaResolver, SchemaValidator } from '../../../src/schema/index.js';
import { canonicalJson, dssePae, publicKeyFingerprint, verifyBytes } from '../../../src/security/artifact-trust.js';
import { ARTIFACT_VERIFICATION_EXIT_CODES } from '../../../src/security/artifact-verifier.js';
import { assertReviewProjection, reviewDigest } from '../../../src/decision/review/validate.js';
import { buildEffectFixtures, CHECKPOINT_PAYLOAD_TYPE, ROTATION_PAYLOAD_TYPE, STATEMENT_PAYLOAD_TYPE } from '../../fixtures/effects/build-fixtures.js';

const rootDir = process.cwd();
const fixtureDir = 'test/fixtures/effects';
const read = (file: string) => JSON.parse(readFileSync(path.join(rootDir, file), 'utf8'));
const readText = (file: string) => readFileSync(path.join(rootDir, file), 'utf8');
const manifest = read('schemas/catalog/domains/effects.json');
const compiled = compileSchemaCatalog({ schemaVersion: '1', domains: [manifest] }, [manifest], { rootDir, inventoryRoots: [] });
const validator = new SchemaValidator(new SchemaResolver(compiled.catalog!, { rootDir }), { rootDir });
const sha256Hex = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const listDir = (kind: 'valid' | 'invalid') => readdirSync(path.join(rootDir, fixtureDir, kind)).filter(f => f.endsWith('.json')).sort().map(f => `${fixtureDir}/${kind}/${f}`);

const ARTIFACTS: Record<string, string> = {
  'record.': 'effects.record',
  'checkpoint.': 'effects.checkpoint',
  'keyring.': 'effects.keyring',
  'verifier-result.': 'effects.verifier-result',
};
const artifactFor = (file: string) => {
  const base = path.basename(file);
  const prefix = Object.keys(ARTIFACTS).find(candidate => base.startsWith(candidate));
  if (!prefix) throw new Error(`Unrouted effect fixture ${file}`);
  return ARTIFACTS[prefix];
};

/** Independent unpadded lowercase RFC 4648 base32 (bit-string implementation). */
function base32(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bits = [...bytes].map(byte => byte.toString(2).padStart(8, '0')).join('');
  const padded = bits.padEnd(Math.ceil(bits.length / 5) * 5, '0');
  return (padded.match(/.{5}/g) ?? []).map(chunk => alphabet[parseInt(chunk, 2)]).join('');
}

const EFFECT_ID_V1 = /^eff1_[a-z2-7]{51}[aq]$/;
const D13_ID = /^sha256:[a-f0-9]{64}$/;
const keyring = read(`${fixtureDir}/valid/keyring.rotated.json`);
const keyFor = (keyid: string) => keyring.keys.find((key: { keyid: string }) => key.keyid === keyid);
const decodePayload = (line: any) => Buffer.from(line.envelope.payload, 'base64');
const withinWindow = (key: any, at: string) => at >= key.validFrom && (!key.validUntil || at < key.validUntil);

describe('effect ledger v1 schema catalog', () => {
  it('EFF-CAT-01 registers the effects domain with the four v1 authorities', () => {
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    expect(read('schemas/catalog/catalog.json').domains).toContain('domains/effects.json');
    expect(manifest.artifacts.map((entry: any) => entry.logicalName).sort()).toEqual(Object.values(ARTIFACTS).sort());
    expect(readdirSync(path.join(rootDir, 'schemas/effects')).sort()).toEqual([
      'EffectCheckpoint.v1.schema.json', 'EffectKeyring.v1.schema.json', 'EffectRecord.v1.schema.json', 'EffectVerifierResult.v1.schema.json',
    ]);
  });

  it('EFF-CAT-02 lists every fixture file exactly once under its routed artifact', () => {
    for (const kind of ['valid', 'invalid'] as const) {
      const listed = manifest.artifacts.flatMap((entry: any) => entry.fixtures[kind].map((file: string) => {
        expect(artifactFor(file), file).toBe(entry.logicalName);
        return file;
      })).sort();
      expect(listed).toEqual(listDir(kind));
    }
  });

  it.each(listDir('valid'))('EFF-SCHEMA-01 accepts %s', file => {
    const result = validator.validate(artifactFor(file), read(file));
    expect(result.valid, JSON.stringify(result.diagnostics)).toBe(true);
  });

  it.each(listDir('invalid'))('EFF-SCHEMA-02 rejects %s', file => {
    const result = validator.validate(artifactFor(file), read(file));
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'SCHEMA_INSTANCE_INVALID' }));
  });

  it('EFF-SCHEMA-03 covers the required negative categories', () => {
    const names = listDir('invalid').map(file => path.basename(file));
    for (const required of [
      'record.segment-line.missing-keyid.json',
      'record.statement.unknown-phase.json',
      'record.statement.raw-body.json',
      'record.statement.malformed-effect-id-uppercase.json',
      'checkpoint.missing-root.json',
      'keyring.rotation-not-signed-by-prior.json',
    ]) expect(names).toContain(required);
  });

  it('EFF-SCHEMA-04 fixtures are reproducible byte-for-byte from the deterministic builder', () => {
    const built = buildEffectFixtures();
    const onDisk = [...listDir('valid'), ...listDir('invalid'), `${fixtureDir}/vectors/identity.v1.json`]
      .map(file => file.slice(fixtureDir.length + 1)).sort();
    expect([...built.keys()].sort()).toEqual(onDisk);
    for (const [file, body] of built) expect(readText(`${fixtureDir}/${file}`), file).toBe(body);
  });
});

describe('effect ledger v1 identity vectors', () => {
  const vectors = read(`${fixtureDir}/vectors/identity.v1.json`);

  it('EFF-ID-01 base32 matches RFC 4648 section 10 test vectors (lowercase, unpadded)', () => {
    const cases: Array<[string, string]> = [['', ''], ['f', 'my'], ['fo', 'mzxq'], ['foo', 'mzxw6'], ['foob', 'mzxw6yq'], ['fooba', 'mzxw6ytb'], ['foobar', 'mzxw6ytboi']];
    for (const [input, expected] of cases) expect(base32(Buffer.from(input))).toBe(expected);
  });

  it.each(vectors.effectIds.map((vector: any) => [vector.name, vector]))('EFF-ID-02 recomputes eff1_ vector %s byte-for-byte', (_name, vector: any) => {
    expect(vector.derivation).toBe('aiwg.effect/v1');
    expect(Object.keys(vector.input).sort()).toEqual(['context', 'kind', 'scope', 'target', 'v']);
    expect(vector.input.v).toBe(1);
    const canonical = canonicalJson(vector.input);
    expect(canonical).toBe(vector.canonical);
    const hash = createHash('sha256').update(canonical, 'utf8').digest();
    expect(hash.toString('hex')).toBe(vector.sha256);
    const id = `eff1_${base32(hash)}`;
    expect(id).toBe(vector.expected);
    expect(id).toHaveLength(57);
    expect(id).toMatch(EFFECT_ID_V1);
  });

  it('EFF-ID-03 canonicalization sorts keys by UTF-16 code unit and keeps non-ASCII literal', () => {
    const vector = vectors.effectIds.find((entry: any) => entry.name === 'key-order-and-unicode');
    expect(vector.canonical).toContain('"context":{"Zeta":"café","alpha":true,"beta":2}');
  });

  it.each(vectors.d13ReviewIds.map((vector: any) => [vector.name, vector]))('EFF-ID-04 D13 vector %s equals reviewDigest exactly', (_name, vector: any) => {
    expect(vector.derivation).toBe('d13.review/v1');
    expect(Object.keys(vector.input).sort()).toEqual(['continuationId', 'proposalVersion', 'reviewId']);
    expect(canonicalJson(vector.input)).toBe(vector.canonical);
    expect(reviewDigest(vector.input)).toBe(vector.expected);
    expect(`sha256:${sha256Hex(vector.canonical)}`).toBe(vector.expected);
    expect(vector.expected).toMatch(D13_ID);
  });

  it('EFF-ID-05 every non-tombstone eff1_ record binds its ID to its signed identity fields', () => {
    for (const file of listDir('valid').filter(name => path.basename(name).startsWith('record.statement.'))) {
      const { predicate, subject } = read(file);
      if (predicate.phase === 'tombstone') continue;
      const input = { v: 1, scope: predicate.scope, kind: predicate.kind, target: predicate.target, context: predicate.context };
      const expected = predicate.idDerivation === 'd13.review/v1'
        ? reviewDigest(predicate.context)
        : `eff1_${base32(createHash('sha256').update(canonicalJson(input)).digest())}`;
      expect(predicate.effectId, file).toBe(expected);
      expect(subject).toEqual([{ name: predicate.target, digest: { sha256: sha256Hex(predicate.target) } }]);
    }
  });
});

describe('effect ledger v1 signatures, chain and checkpoint', () => {
  const lines = listDir('valid').filter(file => path.basename(file).startsWith('record.segment-')).map(read);

  it('EFF-SIG-01 keyids are sha256 of the SPKI public key and the rotation is signed by prior and successor keys', () => {
    for (const key of keyring.keys) expect(key.keyid).toBe(`sha256:${publicKeyFingerprint(key.publicKey)}`);
    for (const rotation of keyring.rotations) {
      const { signatures, ...body } = rotation;
      const pae = dssePae(ROTATION_PAYLOAD_TYPE, Buffer.from(canonicalJson(body), 'utf8'));
      const prior = signatures.find((entry: any) => entry.role === 'prior');
      const successor = signatures.find((entry: any) => entry.role === 'successor');
      expect(prior.keyid).toBe(rotation.from);
      expect(successor.keyid).toBe(rotation.to);
      expect(verifyBytes('ed25519', keyFor(rotation.from).publicKey, pae, Buffer.from(prior.sig, 'base64'))).toBe(true);
      expect(verifyBytes('ed25519', keyFor(rotation.to).publicKey, pae, Buffer.from(successor.sig, 'base64'))).toBe(true);
      expect(keyFor(rotation.from).validUntil).toBe(rotation.effectiveAt);
      expect(keyFor(rotation.to).validFrom).toBe(rotation.effectiveAt);
    }
  });

  it('EFF-SIG-02 the invalid rotation fixture also fails semantic prior-key verification', () => {
    const invalid = read(`${fixtureDir}/invalid/keyring.rotation-not-signed-by-prior.json`);
    for (const rotation of invalid.rotations) {
      const { signatures, ...body } = rotation;
      const pae = dssePae(ROTATION_PAYLOAD_TYPE, Buffer.from(canonicalJson(body), 'utf8'));
      const priorVerified = signatures.some((entry: any) => entry.keyid === rotation.from
        && verifyBytes('ed25519', keyFor(rotation.from).publicKey, pae, Buffer.from(entry.sig, 'base64')));
      expect(priorVerified).toBe(false);
    }
  });

  it('EFF-SIG-03 every segment line verifies: signature, key window, writer/seq binding and chain', () => {
    const heads = new Map<string, { seq: number; hash: string }>();
    for (const line of [...lines].sort((a, b) => a.writer.localeCompare(b.writer) || a.seq - b.seq)) {
      const payload = decodePayload(line);
      const statement = JSON.parse(payload.toString('utf8'));
      expect(canonicalJson(statement)).toBe(payload.toString('utf8'));
      expect(validator.validate('effects.record', statement).valid).toBe(true);
      const { predicate } = statement;
      expect([predicate.writer, predicate.seq]).toEqual([line.writer, line.seq]);
      const pae = dssePae(STATEMENT_PAYLOAD_TYPE, payload);
      if (predicate.phase === 'tombstone') {
        expect(predicate.tombstone.originalRecordHash).toBe(line.recordHash);
        expect(keyFor(predicate.tombstone.originalKeyid)).toBeDefined();
        expect(statement.subject[0].name).toBe(`aiwg-effect:${predicate.effectId}`);
      } else {
        expect(line.recordHash).toBe(`sha256:${sha256Hex(pae)}`);
      }
      const signedAt = predicate.phase === 'tombstone' ? predicate.tombstone.purgedAt : predicate.recordedAt;
      for (const signature of line.envelope.signatures) {
        const key = keyFor(signature.keyid);
        expect(key, signature.keyid).toBeDefined();
        expect(withinWindow(key, signedAt)).toBe(true);
        expect(verifyBytes('ed25519', key.publicKey, pae, Buffer.from(signature.sig, 'base64'))).toBe(true);
      }
      const head = heads.get(line.writer);
      expect(predicate.prev).toBe(head ? head.hash : null);
      expect(line.seq).toBe(head ? head.seq + 1 : 0);
      heads.set(line.writer, { seq: line.seq, hash: line.recordHash });
    }
    expect(read(`${fixtureDir}/valid/record.statement.intent.json`)).toEqual(JSON.parse(decodePayload(lines.find(line => line.writer === 'writer-a' && line.seq === 0)).toString('utf8')));
    expect(read(`${fixtureDir}/valid/record.statement.completed.json`)).toEqual(JSON.parse(decodePayload(lines.find(line => line.writer === 'writer-a' && line.seq === 1)).toString('utf8')));
    expect(read(`${fixtureDir}/valid/record.statement.tombstone.json`)).toEqual(JSON.parse(decodePayload(lines.find(line => line.writer === 'writer-b' && line.seq === 1)).toString('utf8')));
  });

  it('EFF-SIG-04 a tampered payload fails signature verification', () => {
    const line = lines.find(entry => entry.writer === 'writer-a' && entry.seq === 1);
    const statement = JSON.parse(decodePayload(line).toString('utf8'));
    statement.predicate.payloadDigest = `sha256:${'0'.repeat(64)}`;
    const pae = dssePae(STATEMENT_PAYLOAD_TYPE, Buffer.from(canonicalJson(statement), 'utf8'));
    const signature = line.envelope.signatures[0];
    expect(verifyBytes('ed25519', keyFor(signature.keyid).publicKey, pae, Buffer.from(signature.sig, 'base64'))).toBe(false);
  });

  it('EFF-SIG-05 the checkpoint root, heads, keyring digest and signature verify', () => {
    const checkpoint = read(`${fixtureDir}/valid/checkpoint.initial.json`);
    const { signatures, ...body } = checkpoint;
    expect(checkpoint.writers.map((entry: any) => entry.writer)).toEqual([...checkpoint.writers.map((entry: any) => entry.writer)].sort());
    expect(checkpoint.root).toBe(`sha256:${sha256Hex(canonicalJson(checkpoint.writers))}`);
    expect(checkpoint.keyringDigest).toBe(`sha256:${sha256Hex(canonicalJson(keyring))}`);
    for (const writer of checkpoint.writers) {
      const segment = lines.filter(line => line.writer === writer.writer);
      expect(segment).toHaveLength(writer.count);
      expect(segment.sort((a, b) => a.seq - b.seq).at(-1).recordHash).toBe(writer.headHash);
      expect(writer.segment).toBe(`segments/${writer.writer}.jsonl`);
    }
    const pae = dssePae(CHECKPOINT_PAYLOAD_TYPE, Buffer.from(canonicalJson(body), 'utf8'));
    for (const signature of signatures) {
      const key = keyFor(signature.keyid);
      expect(withinWindow(key, checkpoint.createdAt)).toBe(true);
      expect(verifyBytes('ed25519', key.publicKey, pae, Buffer.from(signature.sig, 'base64'))).toBe(true);
    }
  });
});

describe('effect ledger v1 digest-only fixtures', () => {
  const allFixtures = [...listDir('valid'), ...listDir('invalid'), `${fixtureDir}/vectors/identity.v1.json`];
  const decodedPayloads = allFixtures.map(read).filter(value => value?.envelope?.payload)
    .map(value => JSON.parse(Buffer.from(value.envelope.payload, 'base64').toString('utf8')));

  it('EFF-SCAN-01 the reused D13 restricted-material scanner is live', () => {
    expect(() => assertReviewProjection({ vaultLocator: 'x' })).toThrow();
    expect(() => assertReviewProjection({ note: 'vault://kv/ledger' })).toThrow();
    expect(() => assertReviewProjection({ apiKey: 'x' })).toThrow();
  });

  it.each(allFixtures)('EFF-SCAN-02 %s carries no secret, vault locator or restricted key', file => {
    expect(() => assertReviewProjection(read(file))).not.toThrow();
    expect(readText(file)).not.toMatch(/PRIVATE KEY|MC4CAQAwBQYDK2Vw/);
  });

  it('EFF-SCAN-03 decoded envelope payloads pass the same scan', () => {
    expect(decodedPayloads.length).toBeGreaterThan(0);
    for (const payload of decodedPayloads) expect(() => assertReviewProjection(payload)).not.toThrow();
  });

  it('EFF-SCAN-04 valid fixtures contain no raw body or payload field outside the DSSE envelope', () => {
    const rawKeys = /^(?:body|rawBody|raw_body|content|text|request|response|payload)$/;
    const visit = (value: unknown, where: string, parent?: string): void => {
      if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${where}/${index}`, parent));
      else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          if (!(key === 'payload' && parent === 'envelope')) expect(rawKeys.test(key), `${where}/${key}`).toBe(false);
          visit(child, `${where}/${key}`, key);
        }
      }
    };
    for (const file of listDir('valid')) {
      const value = read(file);
      visit(value, file);
      if (value.envelope) visit(JSON.parse(decodePayload(value).toString('utf8')), `${file}#payload`);
    }
  });
});

describe('effect ledger v1 documentation contract', () => {
  const contractSource = readText('docs/contracts/effect-ledger.v1.md');
  const contract = contractSource.replace(/\s+/g, ' ');
  const adr = readText('docs/architecture/adr-effect-ledger.md').replace(/\s+/g, ' ');
  const PINNED = { 0: 'present or recorded', 3: 'absent', 4: 'unknown', 5: 'conflict', 6: 'integrity failure' } as const;
  const ENVIRONMENT = { 1: 'internal error', 2: 'usage error', 7: 'artifact root unavailable' } as const;
  const exitTable = (text: string) => {
    const section = text.split('<!-- effect-exit-codes:begin -->')[1]?.split('<!-- effect-exit-codes:end -->')[0] ?? '';
    return Object.fromEntries([...section.matchAll(/^\|\s*`?(\d+)`?\s*\|\s*([^|]+?)\s*\|/gm)].map(match => [Number(match[1]), match[2].toLowerCase()]));
  };

  it('EFF-DOC-01 names the predicate type, phases, canonicalizer and the D13 replay rule', () => {
    expect(contract).toContain('https://aiwg.io/attestations/effect/v1');
    expect(contract).toContain('`intent|completed|failed|reconciled|tombstone`');
    expect(contract).toContain('artifact-trust.canonicalJson');
    expect(contract).toMatch(/`absent` never authorizes a D13 replay by itself/);
    expect(contract).toContain('^eff1_[a-z2-7]{51}[aq]$');
    expect(contract).toContain('`d13.review/v1`');
  });

  it('EFF-DOC-02 the contract exit-code table matches the ADR and the pinned outcome set', () => {
    const table = exitTable(contractSource);
    for (const [code, label] of Object.entries(PINNED)) expect(table[Number(code)]).toBe(label);
    for (const [code, label] of Object.entries(ENVIRONMENT)) expect(table[Number(code)]).toBe(label);
    expect(Object.keys(table).map(Number).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(adr).toContain('0 = present or recorded, 3 = absent, 4 = unknown, 5 = conflict, 6 = integrity failure');
    expect(adr).toContain('1 = internal error, 2 = usage error, 7 = artifact root unavailable');
  });

  it('EFF-DOC-03 usage and artifact-root codes do not collide with outcome codes or aiwg verify codes', () => {
    const verifyCodes = new Set<number>(Object.values(ARTIFACT_VERIFICATION_EXIT_CODES));
    for (const code of Object.keys(ENVIRONMENT).map(Number)) {
      expect(Object.keys(PINNED).map(Number)).not.toContain(code);
      expect(verifyCodes.has(code)).toBe(false);
    }
    for (const code of [3, 4, 5, 6]) expect(verifyCodes.has(code)).toBe(false);
  });
});
