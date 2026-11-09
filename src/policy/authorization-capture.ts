// Prepares bounded grants and digest-only human evidence for native MCP confirmation.
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { assertAuthorizationGrant, type AuthorizationGrant } from '../effects/authorization-grant.js';
import { effectSession, openLedger } from '../effects/host.js';
import { payloadDigest } from '../effects/identity.js';
import { recordAuthorizationGrant } from '../effects/authorization-store.js';
import { loadHitlLayers } from './hitl-config.js';
import { hitlPolicyVersion } from './hitl.js';

export interface GrantProposal {
  categories: string[]; targets: string[]; environments: string[]; resources: string[]; verbs: string[];
  maxImpact: 'low' | 'medium'; expiresAt: string; maxUses?: number;
}
export interface ConfirmationIdentity { id: string; sessionId: string }

export async function prepareAuthorizationGrant(projectDir: string, proposal: GrantProposal, identity: ConfirmationIdentity) {
  const loaded = await loadHitlLayers(projectDir);
  const root = await realpath(projectDir);
  if (root !== loaded.projectDir) throw new Error('Serve the AIWG project root to request a grant');
  const workspaces = new Set([root]);
  for (const layer of loaded.layers) {
    if (isAbsolute(layer.source)) workspaces.add(await realpath(dirname(dirname(layer.source))));
  }
  const grant: AuthorizationGrant = {
    apiVersion: 'authorization-grant.aiwg.io/v1', grantId: `grant-${randomUUID()}`,
    scope: { categories: [...proposal.categories], targets: [...new Set([...proposal.targets, ...[...workspaces].map(path => `workspace:${path}`)])],
      environments: [...proposal.environments], resources: [...proposal.resources], verbs: [...proposal.verbs] },
    constraints: { reversible: true, maxImpact: proposal.maxImpact,
      exclusions: ['secrets', 'destructive', 'production', 'policy-override'], conditions: [],
      ...(proposal.maxUses === undefined ? {} : { maxUses: proposal.maxUses }) },
    grantedBy: { kind: 'human', id: identity.id, issuer: 'aiwg-mcp', authenticationRef: 'pending-elicitation' },
    provenance: { provider: 'mcp', sessionId: identity.sessionId, userTurnDigest: payloadDigest('pending') },
    questionDigest: payloadDigest('pending'), policyVersion: hitlPolicyVersion(loaded.layers),
    createdAt: new Date().toISOString(), expiresAt: proposal.expiresAt, revocation: { state: 'active' },
  };
  // Validate before asking, including prohibited classes and medium-impact expiry bounds.
  assertAuthorizationGrant(grant);
  const list = (values: string[]) => values.map(value => JSON.stringify(value)).join(', ');
  const question = [
    'Allow AIWG to perform the following actions automatically in the future?',
    `Action categories: ${list(grant.scope.categories)}. Allowed verbs: ${list(grant.scope.verbs)}.`,
    `Only these targets (including workspace bindings): ${list(grant.scope.targets)}.`,
    `Only these environments: ${list(grant.scope.environments)}. Resource patterns: ${list(grant.scope.resources)}.`,
    `Actions must be reversible with at most ${grant.constraints.maxImpact} impact.`,
    'Secrets, destructive actions, production and policy overrides are excluded.',
    grant.expiresAt === 'until-revoked' ? 'Duration: until revoked.' : `Expires at ${JSON.stringify(grant.expiresAt)}.`,
    grant.constraints.maxUses === undefined ? 'No use-count limit.' : `At most ${grant.constraints.maxUses} uses.`,
    'Confirm to save this scope as a signed authorization grant, or decline to save nothing.',
  ].join('\n');
  grant.questionDigest = payloadDigest(question);
  return { grant, question };
}

/** Called only with a successful, explicit native confirmation, never model-supplied evidence. */
export async function recordConfirmedAuthorizationGrant(projectDir: string, grant: AuthorizationGrant, requestId: string, result: unknown) {
  const confirmation = result as { action?: unknown; content?: { confirm?: unknown } } | null;
  if (confirmation?.action !== 'accept' || confirmation.content?.confirm !== 'confirm') throw new Error('Native confirmation required');
  grant.grantedBy.authenticationRef = `mcp-elicitation:${grant.provenance.sessionId}:${requestId}`;
  grant.provenance.nativeEventRef = requestId;
  grant.provenance.userTurnDigest = payloadDigest(JSON.stringify(result));
  assertAuthorizationGrant(grant);
  if (grant.expiresAt !== 'until-revoked' && Date.now() >= Date.parse(grant.expiresAt)) throw new Error('Grant expired during confirmation');
  await recordAuthorizationGrant(openLedger(await effectSession(projectDir, 'custom')), grant);
  return { status: 'recorded', grantId: grant.grantId };
}
