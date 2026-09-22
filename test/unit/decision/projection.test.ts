import { describe, expect, it } from 'vitest';
import { DecisionProjectionError, projectDecisionState, type DecisionProjectionPolicy } from '../../../src/decision/projection.js';

const policy = (): DecisionProjectionPolicy => ({
  version: '1.0.0', provider: 'typesafe', model: 'jev-1', origin: 'https://api.typesafe.ai', region: 'us',
  purpose: 'triage', allowIncompleteContext: false,
  fields: [
    { pointer: '/evidence', output: 'evidence', source: 'case-record', subject: 'case-7', trust: 'verified', sensitivity: 'internal',
      purpose: 'triage', retentionClass: 'ephemeral', allowedProviders: ['typesafe'], allowedRegions: ['us'] },
    { pointer: '/report', output: 'report', source: 'caller', subject: 'case-7', trust: 'untrusted', sensitivity: 'confidential',
      purpose: 'triage', retentionClass: 'ephemeral', allowedProviders: ['typesafe'], allowedRegions: ['us'] },
  ],
});

describe('decision state projection', () => {
  it('sends only allowlisted fields and records provenance without raw values', async () => {
    const projected = await projectDecisionState({ report: 'untrusted', evidence: { score: 2 }, secret: 'must-not-cross' }, policy());
    expect(projected.state).toEqual({ evidence: { score: 2 }, report: 'untrusted' });
    expect(JSON.stringify(projected.evidence)).not.toContain('must-not-cross');
    expect(projected.evidence).toMatchObject({ subject: 'case-7', incompleteContext: false, automaticActionAllowed: true });
    expect(projected.evidence.projectedDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([
    ['provider', (value: DecisionProjectionPolicy) => { value.provider = 'other'; }],
    ['region', (value: DecisionProjectionPolicy) => { value.region = 'eu'; }],
    ['purpose', (value: DecisionProjectionPolicy) => { value.purpose = 'training'; }],
  ])('denies an unauthorized %s before projection', async (_name, mutate) => {
    const value = policy(); mutate(value);
    await expect(projectDecisionState({ report: 'x', evidence: 'y' }, value)).rejects.toMatchObject({ reason: 'data-boundary-denied' });
  });

  it('fails closed for incomplete material context', async () => {
    await expect(projectDecisionState({ report: 'x', evidence: 'y' }, policy(), { incompleteContext: true }))
      .rejects.toEqual(expect.objectContaining<Partial<DecisionProjectionError>>({ reason: 'data-boundary-denied' }));
  });

  it('rejects mixed subjects and credential-bearing origins', async () => {
    const mixed = policy(); mixed.fields[1]!.subject = 'case-8';
    await expect(projectDecisionState({ report: 'x', evidence: 'y' }, mixed)).rejects.toMatchObject({ reason: 'invalid-policy' });
    const credentialed = policy(); credentialed.origin = 'https://token@example.test';
    await expect(projectDecisionState({ report: 'x', evidence: 'y' }, credentialed)).rejects.toMatchObject({ reason: 'invalid-policy' });
  });
});
