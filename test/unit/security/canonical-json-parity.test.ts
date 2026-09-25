import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createDecisionRecord, digestDecisionContext, type OperatorDecisionInput } from '../../../src/audit/operator-decision.js';
import { canonicalJson as marketplaceCanonicalJson } from '../../../src/marketplace/provenance.js';
import { canonicalJson as rfc8785 } from '../../../src/security/artifact-trust.js';

const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

// JSON-native values: no undefined, no non-finite numbers, no toJSON, no array-index keys.
const NATIVE_FIXTURES: unknown[] = [
  null, true, false, 0, -0, 1.5, 1e21, 1e-7, -12345678901234, '', 'plain', '\u00e9\u2028\u0000"\\', '\ud83d\ude00',
  [], [1, [2, [3]]], {},
  { b: 1, a: 2, B: 3, _c: 4, 'a-b': 5, ab: 6, '': 7, '\u00e9': 8, '\ud83d\ude00': 9, '\uffff': 10, '01': 11, '-1': 12, '1.5': 13 },
  { nested: { z: [{ y: null, x: false }], a: { '~': 1, '!': 2 } }, schema: 'aiwg.x.v1' },
];

describe('canonical JSON implementations (#2716)', () => {
  it('marketplace canonical JSON is byte-identical to RFC 8785 for JSON-native values', () => {
    for (const fixture of NATIVE_FIXTURES) expect(marketplaceCanonicalJson(fixture)).toBe(rfc8785(fixture));
  });

  it('pins the marketplace handling of values RFC 8785 refuses', () => {
    expect(marketplaceCanonicalJson({ b: undefined, a: 1 })).toBe('{"a":1}');
    expect(marketplaceCanonicalJson([undefined, Number.NaN, Number.POSITIVE_INFINITY])).toBe('[null,null,null]');
    expect(() => rfc8785({ b: undefined, a: 1 })).toThrow(/cannot encode undefined/);
    expect(() => rfc8785([Number.NaN])).toThrow(/non-finite/);
    // Array-index keys: rebuilding the object makes JavaScript enumerate them first,
    // in numeric order, so the marketplace form is not RFC 8785 for such keys.
    expect(marketplaceCanonicalJson({ '10': 1, '9': 2, a: 3, '': 4 })).toBe('{"9":2,"10":1,"":4,"a":3}');
    expect(rfc8785({ '10': 1, '9': 2, a: 3, '': 4 })).toBe('{"":4,"10":1,"9":2,"a":3}');
  });

  it('pins the operator-decision localeCompare ordering and its RFC 8785 divergence', () => {
    const context = { B: 1, a: 2, _c: 3, 'a-b': 4, ab: 5, nested: [{ Y: 1, x: 2 }] };
    // Captured from the implementation before #2716.
    const golden = 'sha256:9c805914d4efdf85e9604f5002830de4729fbf4b8326b27a71d486509ef2b06c';
    expect(digestDecisionContext(context)).toBe(golden);
    expect(hash('{"_c":3,"a":2,"a-b":4,"ab":5,"B":1,"nested":[{"x":2,"Y":1}]}')).toBe(golden);
    expect(rfc8785(context)).toBe('{"B":1,"_c":3,"a":2,"a-b":4,"ab":5,"nested":[{"Y":1,"x":2}]}');
    expect(hash(rfc8785(context))).not.toBe(golden);
  });

  it('keeps the existing operator-decision fixture hash unchanged', () => {
    const input: OperatorDecisionInput = {
      kind: 'approval',
      outcome: 'approved',
      actor: { id: 'alice@example.com', type: 'human', authentication: 'os-keychain', roles: ['release-manager'] },
      reason: 'Release evidence reviewed',
      context: { prompt: 'deploy?', token: 'secret-value' },
      classification: 'confidential',
      correlation: {
        mission_id: 'mission-1', flow_id: 'flow-release', provider_id: 'codex', sandbox_task_id: 'task-1',
        issue_id: '1567', pull_request_id: '42', prompt_id: 'prompt-1', trace_id: 'trace-1',
      },
      runtime: { runtime_kind: 'vm', isolation: 'hardware', transport_mode: 'vsock', transport_trust: 'mtls' },
      timestamp: '2026-08-03T12:00:00.000Z',
      event_id: 'event-1',
    } as OperatorDecisionInput;
    const record = createDecisionRecord(input, null);
    expect(record.record_hash).toBe('sha256:52de976c0e3f99a7589947c21e5a5b048d7f68fe2d4fa4e74bb9730686cf71bb');
    expect(record.context_digest).toBe('sha256:a08fc58e787ebedb38b17708111bce3a06b6ddf0d3ce9b2308c1b8b072cac720');
    // This fixture has no case- or punctuation-sensitive sibling keys, so both orderings agree on it.
    const { record_hash: _recordHash, ...unsigned } = record;
    expect(hash(rfc8785(unsigned))).toBe(record.record_hash);
  });
});
