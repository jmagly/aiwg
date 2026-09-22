import { describe, expect, it, vi } from 'vitest';
import {
  DecisionProjectionError, dispatchProjectedDecisionState, projectDecisionState,
  type DecisionProjectionPolicy,
} from '../../../src/decision/projection.js';

const policy = (): DecisionProjectionPolicy => ({
  version: '1.0.0', provider: 'typesafe', model: 'jev-1', origin: 'https://api.typesafe.ai', region: 'us',
  purpose: 'triage', allowIncompleteContext: false,
  fields: [
    { pointer: '/evidence', output: 'evidence', source: 'case-record', subject: 'case-7', trust: 'verified', sensitivity: 'internal',
      purpose: 'triage', retentionClass: 'ephemeral', accessScopes: ['decision-runtime'], exportPolicy: 'sanitized',
      deletionPolicy: 'erase', backupPolicy: 'not-persisted', allowedProviders: ['typesafe'], allowedModels: ['jev-1'],
      allowedOrigins: ['https://api.typesafe.ai'], allowedRegions: ['us'] },
    { pointer: '/report', output: 'report', source: 'caller', subject: 'case-7', trust: 'untrusted', sensitivity: 'confidential',
      purpose: 'triage', retentionClass: 'ephemeral', accessScopes: ['decision-runtime'], exportPolicy: 'denied',
      deletionPolicy: 'erase', backupPolicy: 'not-persisted', allowedProviders: ['typesafe'], allowedModels: ['jev-1'],
      allowedOrigins: ['https://api.typesafe.ai'], allowedRegions: ['us'] },
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
    ['model', (value: DecisionProjectionPolicy) => { value.model = 'other'; }],
    ['origin', (value: DecisionProjectionPolicy) => { value.origin = 'https://other.example'; }],
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

  it('projects before credentials and sends only minimized state to dispatch', async () => {
    const resolveCredential = vi.fn(async () => 'logical-credential-result');
    const dispatch = vi.fn(async request => request.state);
    const input = { report: 'untrusted', evidence: { score: 2 }, adjacentSecret: 'must-not-cross' };
    await expect(dispatchProjectedDecisionState(input, policy(), { resolveCredential, dispatch })).resolves.toEqual({
      evidence: { score: 2 }, report: 'untrusted',
    });
    expect(resolveCredential).toHaveBeenCalledOnce();
    expect(resolveCredential.mock.calls[0]).toEqual([]);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(JSON.stringify(dispatch.mock.calls[0]?.[0])).not.toContain('must-not-cross');
  });

  it('makes zero credential and dispatch calls when destination authorization fails', async () => {
    const resolveCredential = vi.fn(async () => 'credential');
    const dispatch = vi.fn(async () => undefined);
    const denied = policy(); denied.model = 'unapproved-model';
    await expect(dispatchProjectedDecisionState({ report: 'x', evidence: 'y' }, denied, { resolveCredential, dispatch }))
      .rejects.toMatchObject({ reason: 'data-boundary-denied' });
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('denies incomplete lifecycle metadata and portable secret material', async () => {
    const incomplete = policy(); incomplete.fields[0]!.accessScopes = [];
    await expect(projectDecisionState({ report: 'x', evidence: 'y' }, incomplete))
      .rejects.toMatchObject({ reason: 'invalid-policy' });

    const secret = policy();
    (secret.fields[0] as unknown as Record<string, unknown>).credentialHash = `sha256:${'a'.repeat(64)}`;
    await expect(projectDecisionState({ report: 'x', evidence: 'y' }, secret))
      .rejects.toThrow(/unsupported control fields/);

    const locator = policy(); locator.fields[0]!.source = 'vault://private/team/key';
    await expect(projectDecisionState({ report: 'x', evidence: 'y' }, locator))
      .rejects.toThrow(/forbidden credential/);
  });
});
