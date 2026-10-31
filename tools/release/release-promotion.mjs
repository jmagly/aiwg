#!/usr/bin/env node
// Stable promotion of an exact retained RC bundle. The checked-in policy is
// binds authenticated release evidence and approval to the signed policy.
// No serialized receipt is authority.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { importImpl } from '../_resolve-impl.mjs';
import { SURFACES, sha256 } from './release-candidate.mjs';
import {
  acquireGithubProductionReleaseEvidence,
  assertProductionReleaseEvidence,
  verifyStableReleaseApproval,
  verifySignedTagPair,
} from './release-evidence.mjs';

const { boundedSpawnSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');
const ROOT = path.resolve(import.meta.dirname, '../..');
export const PROMOTION_POLICY = 'config/release-promotion-policy.json';
export const PROMOTION_SCHEMA = 'aiwg-release-promotion-policy/v2';
export const PROMOTION_DECISION_SCHEMA = 'aiwg-release-promotion-decision/v2';
const SHA256 = /^[a-f0-9]{64}$/;
const canonicalPolicies = new WeakSet();
const signedPolicyBindings = new WeakMap();
const promotionDecisions = new WeakSet();

const plainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const exactKeys = (value, keys) => plainObject(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const digest = (algorithm, input) => createHash(algorithm).update(input).digest('hex');
const hashJson = value => digest('sha256', JSON.stringify(value));
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validateRegistry(name, value) {
  if (!exactKeys(value, ['url', 'tag', 'access', 'provenance']) || !nonempty(value.url)
    || !nonempty(value.tag) || value.access !== 'public' || typeof value.provenance !== 'boolean') {
    throw new Error(`Invalid ${name} release registry policy`);
  }
  let url;
  try { url = new URL(value.url); } catch { throw new Error(`Invalid ${name} release registry URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new Error(`Invalid ${name} release registry URL`);
  }
  if (name === 'npmjs' && (url.origin !== 'https://registry.npmjs.org' || value.provenance !== true)) {
    throw new Error('npmjs release policy must retain the OIDC provenance registry');
  }
  if (name === 'gitea' && (url.origin !== 'https://git.integrolabs.net' || value.provenance !== false)) {
    throw new Error('Gitea release policy must retain the internal registry');
  }
}

function validatePolicy(value) {
  if (!exactKeys(value, ['schema', 'enabled', 'repository', 'rc_workflow_id',
    'github_api_actor_ids', 'github_transport_trust', 'github_evidence_credential_kind', 'allowed_approval_issuer_ids', 'required_validation_profile', 'publication']) || value.schema !== PROMOTION_SCHEMA
    || typeof value.enabled !== 'boolean' || value.repository !== 'jmagly/aiwg'
    || !Array.isArray(value.github_api_actor_ids) || value.required_validation_profile !== 'routine-release-v1') throw new Error('Invalid release promotion policy');
  if (!Array.isArray(value.allowed_approval_issuer_ids)
    || new Set(value.allowed_approval_issuer_ids.map(String)).size !== value.allowed_approval_issuer_ids.length
    || new Set(value.github_api_actor_ids.map(String)).size !== value.github_api_actor_ids.length) throw new Error('Invalid approval issuer policy');
  if (!exactKeys(value.publication, ['order', 'registries'])
    || JSON.stringify(value.publication.order) !== JSON.stringify(['npmjs', 'gitea'])
    || !exactKeys(value.publication.registries, ['npmjs', 'gitea'])) throw new Error('Invalid publication order policy');
  validateRegistry('npmjs', value.publication.registries.npmjs);
  validateRegistry('gitea', value.publication.registries.gitea);
  return value;
}

function activationProblems(policy) {
  const problems = [];
  if (!policy.enabled) problems.push('The versioned release-promotion policy is disabled.');
  if (!Number.isSafeInteger(policy.rc_workflow_id) || policy.rc_workflow_id < 1) problems.push('No trusted RC workflow ID is configured.');
  if (!policy.github_api_actor_ids.length || policy.github_api_actor_ids.some(id => !Number.isSafeInteger(id) || id < 1)) problems.push('No qualified GitHub API actor IDs are configured.');
  if (policy.github_transport_trust !== 'github-authenticated-user-api') problems.push('The authenticated GitHub user API transport trust level is not approved.');
  if (!['fine-grained-personal-access-token', 'classic-personal-access-token', 'github-app-user-access-token'].includes(policy.github_evidence_credential_kind)) problems.push('No supported dedicated GitHub evidence credential kind is configured.');
  if (!policy.allowed_approval_issuer_ids.length || policy.allowed_approval_issuer_ids.some(id => !Number.isSafeInteger(id) || id < 1)) problems.push('No authenticated approval issuer IDs are configured.');
  return problems;
}

/** Configuration-only preflight; it grants no publication capability. */
export function assessPromotionPolicyConfiguration(value) {
  const policy = validatePolicy(structuredClone(value));
  const unmetRequirements = activationProblems(policy);
  return deepFreeze({ ready: unmetRequirements.length === 0, unmet_requirements: unmetRequirements });
}

/** Load only the policy versioned beside this implementation. */
export function loadCanonicalPromotionPolicy() {
  const file = path.join(ROOT, PROMOTION_POLICY);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Release promotion policy must be a regular repository file');
  const bytes = fs.readFileSync(file);
  const policy = validatePolicy(JSON.parse(bytes));
  const receipt = deepFreeze({ ...policy, source: PROMOTION_POLICY, sha256: digest('sha256', bytes) });
  canonicalPolicies.add(receipt);
  return receipt;
}

function signedPolicyBytes(root, commit, spawn = boundedSpawnSync) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Invalid signed policy commit');
  const result = spawn('git', ['show', `${commit}:${PROMOTION_POLICY}`], 'long', {
    cwd: root, encoding: 'buffer', timeout: 120000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error('Cannot read release-promotion policy from the signed release commit');
  }
  return result.stdout;
}

/** Pure commit-binding check; this receipt is diagnostic and grants no authority. */
export function verifyPromotionPolicyCommitBinding({ root = ROOT, commit, expectedSha256, spawn = boundedSpawnSync } = {}) {
  if (!SHA256.test(expectedSha256 ?? '')) throw new Error('Invalid expected release-policy digest');
  const file = path.join(root, PROMOTION_POLICY), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Release promotion policy must be a regular repository file');
  const current = fs.readFileSync(file), signed = signedPolicyBytes(root, commit, spawn);
  validatePolicy(JSON.parse(current)); validatePolicy(JSON.parse(signed));
  const currentSha256 = digest('sha256', current), signedSha256 = digest('sha256', signed);
  if (currentSha256 !== expectedSha256 || signedSha256 !== expectedSha256) {
    throw new Error('Working-tree release-promotion policy differs from the signed release commit');
  }
  return deepFreeze({ commit, sha256: expectedSha256 });
}

function bindPolicyToSignedCommit(policy, commit) {
  if (!canonicalPolicies.has(policy)) throw new Error('Release policy is not the canonical working-tree policy');
  verifyPromotionPolicyCommitBinding({ commit, expectedSha256: policy.sha256 });
  signedPolicyBindings.set(policy, commit);
  return policy;
}

function assertPolicyStillBound(policy, commit) {
  verifyPromotionPolicyCommitBinding({ commit, expectedSha256: policy.sha256 });
}

function packageBindings(evidence) {
  return SURFACES.map(surface => {
    const filename = `${surface.stem}-${evidence.candidate.manifest.package_version}.tgz`;
    const expected = evidence.candidate.manifest.files[filename];
    if (!SHA256.test(expected ?? '')) throw new Error(`Missing retained digest for ${surface.name}`);
    return {
      package: surface.name,
      version: evidence.candidate.manifest.package_version,
      filename,
      source: path.join(evidence.candidate.directory, filename),
      sha256: expected,
    };
  });
}

function makeDecision({ policy, evidence = null, stableApproval = null, extraProblems = [] }) {
  if (!canonicalPolicies.has(policy)) throw new Error('Stable promotion requires the canonical in-process policy receipt');
  const problems = [...activationProblems(policy), ...extraProblems];
  let packages = [], candidate = null, authenticatedGithubActor = null, approval = null;
  if (evidence || stableApproval) {
    if (signedPolicyBindings.get(policy) !== evidence?.tags?.commit) {
      throw new Error('Promotion policy is not bound to the verified signed release commit');
    }
    assertProductionReleaseEvidence(evidence);
    if (evidence.candidate.validation_profile !== policy.required_validation_profile) throw new Error('Stable promotion requires the routine release validation profile');
    if (evidence.repository !== policy.repository) throw new Error('Production evidence repository differs from promotion policy');
    if (!policy.github_api_actor_ids.map(String).includes(String(evidence.apiCaller.id))) problems.push('GitHub API caller is not a qualified policy actor.');
    if (!stableApproval) throw new Error('Authenticated stable release approval is required');
    packages = packageBindings(evidence);
    candidate = {
      commit: evidence.candidate.manifest.commit,
      rc_tag: evidence.tags.rc.tag,
      stable_tag: evidence.tags.stable.tag,
      run_id: evidence.candidate.manifest.run_id,
      run_attempt: evidence.candidate.manifest.run_attempt,
      artifact_id: evidence.candidate.artifact_id,
      artifact_sha256: evidence.archive.sha256,
      manifest_sha256: evidence.candidate.manifest_sha256,
    };
    authenticatedGithubActor = evidence.apiCaller;
    approval = stableApproval;
  }
  const unmet = [...new Set(problems)];
  const receipt = deepFreeze({ schema: PROMOTION_DECISION_SCHEMA, policy: { source: policy.source, sha256: policy.sha256 },
    repository: policy.repository, candidate, packages, authenticated_github_actor: authenticatedGithubActor,
    approval,
    identity_basis: evidence ? { github_transport: policy.github_transport_trust } : null,
    production_identity_authenticated: evidence?.production_identity_authenticated === true,
    production_identity_policy_satisfied: Boolean(evidence && stableApproval && policy.github_api_actor_ids.map(String).includes(String(evidence.apiCaller.id))),
    ready_for_publication: unmet.length === 0, unmet_requirements: unmet });
  promotionDecisions.add(receipt);
  return receipt;
}

/**
 * Acquire and evaluate the complete production gate. Disabled/incomplete policy
 * returns a non-ready receipt without touching GitHub or reading credentials.
 */
export async function evaluateReleasePromotion({ rcTag, stableTag, runId, artifactId,
  approvalIssue, approvalSha256, destination,
  token } = {}) {
  const policy = loadCanonicalPromotionPolicy();
  if (activationProblems(policy).length) return makeDecision({ policy });
  const evidenceToken = token ?? process.env.AIWG_GITHUB_RELEASE_EVIDENCE_TOKEN;
  if (!nonempty(evidenceToken) || !nonempty(destination) || !Number.isSafeInteger(runId) || runId < 1
    || !Number.isSafeInteger(artifactId) || artifactId < 1
    || !Number.isSafeInteger(approvalIssue) || approvalIssue < 1 || !SHA256.test(approvalSha256 ?? '')
) {
    throw new Error('Complete production promotion inputs are required');
  }
  const tags = verifySignedTagPair({ root: ROOT, rcTag, stableTag });
  bindPolicyToSignedCommit(policy, tags.commit);
  const evidence = await acquireGithubProductionReleaseEvidence({ token: evidenceToken, approvalIssue,
    repository: policy.repository, workflowId: policy.rc_workflow_id, runId, artifactId,
    destination, tags });
  const stableApproval = verifyStableReleaseApproval({ evidence,
    allowedIssuerIds: policy.allowed_approval_issuer_ids, bodySha256: approvalSha256, policySha256: policy.sha256 });
  return makeDecision({ policy, evidence, stableApproval });
}

export function localRegistryIdentity(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Retained package must be a regular file');
  const bytes = fs.readFileSync(file);
  return { sha256: digest('sha256', bytes), shasum: digest('sha1', bytes), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
}

/** Exact registry metadata check used after success and conflict/idempotent paths. */
export function verifyRegistryPackageIdentity({ file, packageName, version, metadata } = {}) {
  const local = localRegistryIdentity(file);
  if (!plainObject(metadata) || metadata.name !== packageName || metadata.version !== version
    || !plainObject(metadata.dist) || metadata.dist.shasum !== local.shasum || metadata.dist.integrity !== local.integrity) {
    throw new Error(`Registry package identity mismatch for ${packageName}@${version}`);
  }
  return deepFreeze({ package: packageName, version, ...local });
}

function parseJsonOutput(text, label) {
  try { return JSON.parse(String(text)); } catch { throw new Error(`Malformed ${label} JSON`); }
}
function npm(spawn, args, env) {
  return spawn('npm', args, 'long', { cwd: ROOT, env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
}
const conflict = output => /(?:EPUBLISHCONFLICT|cannot publish over the previously published versions|package version already exists|\b409\b)/i.test(output);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function assertStagedInventory(directory, packages) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length !== packages.length || entries.some(entry => !entry.isFile()
    || !packages.some(item => item.filename === entry.name))) throw new Error('Retained publication staging inventory changed');
  for (const item of packages) {
    const file = path.join(directory, item.filename), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222) !== 0 || sha256(file) !== item.sha256) {
      throw new Error(`Retained publication package changed: ${item.package}`);
    }
  }
}

function stagePackages(decision, stagingRoot) {
  if (!promotionDecisions.has(decision) || decision.ready_for_publication !== true) {
    throw new Error('Publication requires an in-process ready promotion decision');
  }
  const directory = fs.mkdtempSync(path.join(stagingRoot ?? os.tmpdir(), 'aiwg-promotion-'));
  fs.chmodSync(directory, 0o700);
  try {
    for (const item of decision.packages) {
      const sourceStat = fs.lstatSync(item.source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error(`Retained source package is not a regular file: ${item.package}`);
      }
      if (sha256(item.source) !== item.sha256) throw new Error(`Retained source package changed: ${item.package}`);
      const target = path.join(directory, item.filename);
      fs.copyFileSync(item.source, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o400);
    }
    fs.chmodSync(directory, 0o500);
    assertStagedInventory(directory, decision.packages);
    return directory;
  } catch (error) {
    fs.chmodSync(directory, 0o700);
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function registryMetadata({ spawn, registry, item, file, env }) {
  let last;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = npm(spawn, ['view', `${item.package}@${item.version}`, '--json', '--registry', registry.url], env);
    if (!result.error && result.status === 0) {
      const metadata = parseJsonOutput(result.stdout, 'registry metadata');
      return verifyRegistryPackageIdentity({ file, packageName: item.package, version: item.version, metadata });
    }
    last = result.error?.message ?? result.stderr ?? result.status;
    if (attempt < 5) await wait(3000);
  }
  throw new Error(`Registry identity lookup failed for ${item.package}@${item.version}: ${last}`);
}

function registryTags({ spawn, registry, item, env }) {
  const result = npm(spawn, ['view', item.package, 'dist-tags', '--json', '--registry', registry.url], env);
  if (result.error || result.status !== 0) throw new Error(`Registry dist-tag lookup failed for ${item.package}`);
  const tags = parseJsonOutput(result.stdout, 'registry dist-tag');
  if (!plainObject(tags) || tags[registry.tag] !== item.version) throw new Error(`Registry dist-tag mismatch for ${item.package}`);
  return tags;
}

async function requirePriorRegistry({ policy, registryName, decision, directory, spawn, env }) {
  const position = policy.publication.order.indexOf(registryName);
  if (position < 1) return;
  for (const priorName of policy.publication.order.slice(0, position)) {
    const prior = policy.publication.registries[priorName];
    for (const item of decision.packages) {
      const file = path.join(directory, item.filename);
      await registryMetadata({ spawn, registry: prior, item, file, env });
      registryTags({ spawn, registry: prior, item, env });
      assertStagedInventory(directory, decision.packages);
    }
  }
}

/**
 * Irreversible entry point. It accepts only the in-process decision above,
 * stages immutable copies, rechecks the complete release-package inventory
 * before and after every registry action, and verifies conflict recovery.
 */
export async function publishReleasePromotion({ decision, registryName, receiptPath } = {}) {
  if (!promotionDecisions.has(decision) || decision.ready_for_publication !== true) {
    throw new Error('Publication requires an in-process ready promotion decision');
  }
  const policy = loadCanonicalPromotionPolicy();
  if (decision.policy.sha256 !== policy.sha256 || !policy.publication.order.includes(registryName)) {
    throw new Error('Promotion decision does not match the current canonical publication policy');
  }
  if (!nonempty(receiptPath)) throw new Error('A durable publication receipt path is required');
  if (decision.candidate?.commit === undefined) throw new Error('Promotion decision has no signed release commit');
  assertPolicyStillBound(policy, decision.candidate.commit);
  const spawn = boundedSpawnSync, env = process.env;
  const registry = policy.publication.registries[registryName], directory = stagePackages(decision, os.tmpdir());
  const receipt = { schema: 'aiwg-release-publication/v1', policy_sha256: policy.sha256,
    registry: registryName, registry_url: registry.url, candidate: decision.candidate, packages: [], complete: false };
  let receiptFd = null;
  try {
    fs.mkdirSync(path.dirname(path.resolve(receiptPath)), { recursive: true });
    receiptFd = fs.openSync(receiptPath, 'wx', 0o600);
    const persist = () => {
      const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
      fs.ftruncateSync(receiptFd, 0); fs.writeSync(receiptFd, bytes, 0, bytes.length, 0); fs.fsyncSync(receiptFd);
    };
    persist();
    await requirePriorRegistry({ policy, registryName, decision, directory, spawn, env });
    for (const item of decision.packages) {
      assertPolicyStillBound(policy, decision.candidate.commit);
      assertStagedInventory(directory, decision.packages);
      const file = path.join(directory, item.filename);
      const args = ['publish', file, '--ignore-scripts', '--access', registry.access, '--tag', registry.tag,
        '--registry', registry.url, ...(registry.provenance ? ['--provenance'] : [])];
      const result = npm(spawn, args, env), output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      const disposition = !result.error && result.status === 0 ? 'published' : conflict(output) ? 'already-published' : null;
      if (!disposition) throw new Error(`npm publish failed for ${item.package}: ${result.error?.message ?? result.status}`);
      const identity = await registryMetadata({ spawn, registry, item, file, env });
      assertStagedInventory(directory, decision.packages);
      // npm trusted publishing authorizes the tag supplied to `npm publish`;
      // it does not provide a separate long-lived account token for later tag
      // mutation. Gitea uses its workflow token and retains the explicit,
      // idempotent tag repair used by the existing registry workflow.
      if (registryName === 'gitea') {
        const tagResult = npm(spawn, ['dist-tag', 'add', `${item.package}@${item.version}`, registry.tag,
          '--registry', registry.url], env);
        if (tagResult.error || tagResult.status !== 0) throw new Error(`npm dist-tag failed for ${item.package}`);
      }
      registryTags({ spawn, registry, item, env });
      assertStagedInventory(directory, decision.packages);
      receipt.packages.push({ package: item.package, version: item.version, disposition, sha256: identity.sha256,
        shasum: identity.shasum, integrity: identity.integrity, tag: registry.tag });
      persist();
    }
    receipt.complete = true;
    persist();
    return deepFreeze(receipt);
  } finally {
    if (receiptFd !== null) fs.closeSync(receiptFd);
    fs.chmodSync(directory, 0o700);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'rc-tag': { type: 'string' }, 'stable-tag': { type: 'string' }, 'run-id': { type: 'string' },
    'artifact-id': { type: 'string' }, 'approval-issue': { type: 'string' },
    'approval-sha256': { type: 'string' }, destination: { type: 'string' },
    output: { type: 'string' }, receipt: { type: 'string' }, registry: { type: 'string' },
  } });
  if (!['verify', 'publish'].includes(positionals[0])) throw new Error('Usage: release-promotion.mjs verify|publish --rc-tag TAG --stable-tag TAG --run-id ID --artifact-id ID --approval-issue ID --approval-sha256 SHA --destination DIR --output FILE');
  const decision = await evaluateReleasePromotion({ rcTag: values['rc-tag'], stableTag: values['stable-tag'],
    runId: Number(values['run-id']), artifactId: Number(values['artifact-id']),
    approvalIssue: Number(values['approval-issue']), approvalSha256: values['approval-sha256'],
    destination: values.destination });
  if (values.output) fs.writeFileSync(values.output, JSON.stringify(decision, null, 2) + '\n', { mode: 0o600 });
  else console.log(JSON.stringify(decision, null, 2));
  if (positionals[0] === 'publish') await publishReleasePromotion({ decision, registryName: values.registry,
    receiptPath: values.receipt });
  if (!decision.ready_for_publication) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
