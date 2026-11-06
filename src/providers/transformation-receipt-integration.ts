import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { readAiwgConfig, type InstalledEntry } from '../config/aiwg-config.js';
import { readUserRegistry, type UserScopeProviderDeploy } from '../config/user-registry.js';
import type { ArtifactVerificationResult } from '../security/artifact-verifier.js';
import { USER_SCOPE_PATHS } from '../cli/scope-resolver.js';
import {
  getProviderDefinition,
  getProviderKernelSkillPath,
  normalizeProviderDefinitionId,
  resolveProviderPathValue,
  type ProviderArtifactPathStrings,
} from './provider-definitions.js';
import {
  createProviderTransformationReceipt,
  diagnoseProviderTransformationReceipt,
  providerTransformationReceiptPath,
  writeProviderTransformationReceipt,
  type ProviderTransformationDiagnosis,
  type ProviderTransformationReceipt,
} from './transformation-receipt.js';

const TRANSFORMER_ID = 'aiwg-provider-transformer';
const TRANSFORMER_VERSION = '1';
import { collectOwnedDirectory } from './transformation-receipt-outputs.js';
import { receiptBundles, sourceEvidence } from './transformation-receipt-source.js';
export { providerReceiptHasLocalSources, sourceVerificationsFromSignedWebRelease } from './transformation-receipt-source.js';

export interface ProviderReceiptIntegrationOptions {
  projectRoot: string;
  /** Root containing provider outputs; projectRoot remains the local control root. */
  outputRoot?: string;
  frameworkRoot: string;
  provider: string;
  scope: 'project' | 'user';
  requestedBundles: string[];
  generatedAt?: string;
  /** Verifier results keyed by installed bundle name. Required for receipt issuance. */
  sourceVerifications?: Readonly<Record<string, ArtifactVerificationResult>>;
  /** Explicit reason a verified source handoff is unavailable. */
  sourceDisposition?: 'local-source' | 'source-unavailable' | 'verification-failed';
}

export interface ProviderReceiptRuntimeEvidence {
  provider: string;
  outputRoot: string;
  outputPaths: string[];
  source: {
    subject: string;
    sha256: string;
    verification: 'verified' | 'policy-exempt' | 'failed';
  };
  transformer: ProviderTransformationReceipt['transformer'];
}

export interface ProviderReceiptFinalization {
  status: 'written' | 'policy-exempt' | 'source-unavailable' | 'skipped';
  receiptPath: string | null;
  evidenceStatePath?: string;
  outputCount: number;
  reason?: string;
}

const PROVIDER_TRANSFORMATION_EVIDENCE_STATE_SCHEMA = 'aiwg.provider-transformation-evidence-state.v1' as const;

interface ProviderTransformationEvidenceState {
  schemaVersion: typeof PROVIDER_TRANSFORMATION_EVIDENCE_STATE_SCHEMA;
  recordedAt: string;
  provider: string;
  scope: 'project' | 'user';
  disposition: 'local-source' | 'source-unavailable' | 'verification-failed';
}

export function providerTransformationEvidenceStatePath(
  projectRoot: string,
  provider: string,
  scope: 'project' | 'user',
): string {
  const receiptPath = providerTransformationReceiptPath(projectRoot, provider, scope);
  return receiptPath.replace(/\.json$/, '.evidence.json');
}

function validateEvidenceState(value: unknown): ProviderTransformationEvidenceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('evidence state must be an object');
  const state = value as ProviderTransformationEvidenceState;
  if (state.schemaVersion !== PROVIDER_TRANSFORMATION_EVIDENCE_STATE_SCHEMA) throw new Error('unsupported evidence state schema');
  if (!Number.isFinite(Date.parse(state.recordedAt))) throw new Error('recordedAt must be an RFC 3339 date-time');
  if (state.scope !== 'project' && state.scope !== 'user') throw new Error('scope must be project or user');
  if (!['local-source', 'source-unavailable', 'verification-failed'].includes(state.disposition)) {
    throw new Error('unsupported source evidence disposition');
  }
  if (!state.provider || state.provider.includes('/') || state.provider.includes('\\')) throw new Error('provider is invalid');
  return state;
}

async function writeEvidenceState(
  options: ProviderReceiptIntegrationOptions,
  disposition: ProviderTransformationEvidenceState['disposition'],
): Promise<string> {
  const provider = normalizeProviderDefinitionId(options.provider) ?? options.provider;
  const target = providerTransformationEvidenceStatePath(options.projectRoot, provider, options.scope);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  const state: ProviderTransformationEvidenceState = {
    schemaVersion: PROVIDER_TRANSFORMATION_EVIDENCE_STATE_SCHEMA,
    recordedAt: options.generatedAt ?? new Date().toISOString(),
    provider,
    scope: options.scope,
    disposition,
  };
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await rm(providerTransformationReceiptPath(options.projectRoot, provider, options.scope), { force: true });
  return target;
}

async function readEvidenceState(options: ProviderReceiptIntegrationOptions): Promise<ProviderTransformationEvidenceState | null> {
  const provider = normalizeProviderDefinitionId(options.provider) ?? options.provider;
  try {
    const state = validateEvidenceState(JSON.parse(await readFile(
      providerTransformationEvidenceStatePath(options.projectRoot, provider, options.scope),
      'utf8',
    )));
    if (state.provider !== provider || state.scope !== options.scope) throw new Error('evidence state identity does not match deployment');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function portablePath(root: string, absolute: string): string | null {
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function artifactPaths(
  provider: string,
  scope: 'project' | 'user',
): ProviderArtifactPathStrings | null {
  const definition = getProviderDefinition(provider);
  if (!definition) return null;
  if (scope === 'user') return USER_SCOPE_PATHS[provider] ?? null;
  return {
    agents: definition.paths.artifacts.agents ?? '',
    commands: definition.paths.artifacts.commands ?? '',
    skills: definition.paths.artifacts.skills ?? '',
    rules: definition.paths.artifacts.rules ?? '',
    behaviors: definition.paths.artifacts.behaviors ?? '',
  };
}

export async function installedEntries(options: ProviderReceiptIntegrationOptions): Promise<Record<string, InstalledEntry>> {
  if (options.scope === 'user' && options.provider !== 'openhuman') {
    return (await readUserRegistry()).installed;
  }
  return (await readAiwgConfig(options.projectRoot))?.installed ?? {};
}

function exactUserEntries(
  installed: Record<string, InstalledEntry>,
  bundles: string[],
  provider: string,
  type: keyof ProviderArtifactPathStrings,
): string[] {
  const entries = new Set<string>();
  for (const bundle of bundles) {
    const deployment = installed[bundle]?.deployedTo[provider] as UserScopeProviderDeploy | undefined;
    for (const name of deployment?.entries?.[type] ?? []) {
      if (name === path.basename(name) && name !== '.' && name !== '..') entries.add(name);
    }
  }
  return [...entries].sort();
}

function transformerEvidence(
  provider: string,
  scope: 'project' | 'user',
): ProviderTransformationReceipt['transformer'] {
  const definition = getProviderDefinition(provider);
  const adapterContract = definition
    ? {
      adapters: definition.adapters,
      artifacts: definition.paths.artifacts,
      kernelSkills: definition.paths.kernelSkills,
      scope,
      userArtifacts: scope === 'user' ? USER_SCOPE_PATHS[provider] ?? null : null,
    }
    : { provider, scope };
  return {
    id: TRANSFORMER_ID,
    version: TRANSFORMER_VERSION,
    providerAdapter: provider,
    providerAdapterVersion: sha256(stable(adapterContract)),
  };
}

export async function resolveProviderReceiptRuntimeEvidence(
  rawOptions: ProviderReceiptIntegrationOptions,
): Promise<ProviderReceiptRuntimeEvidence> {
  const provider = normalizeProviderDefinitionId(rawOptions.provider) ?? rawOptions.provider;
  const options = { ...rawOptions, provider };
  const installed = await installedEntries(options);
  const deployedBundles = receiptBundles(installed, options);
  const evidenceOptions = deployedBundles.length > 0
    ? { ...options, requestedBundles: deployedBundles }
    : options;
  const paths = artifactPaths(provider, options.scope);
  const outputRoot = path.resolve(
    options.outputRoot ?? (options.scope === 'user' ? homedir() : options.projectRoot),
  );
  const ownedFiles = new Set<string>();
  const receiptDirectories = new Set([outputRoot, path.join(outputRoot, '.aiwg'), path.join(outputRoot, `.${provider}`)]);
  if (paths) {
    for (const type of ['agents', 'commands', 'skills', 'rules', 'behaviors'] as const) {
      const configured = paths[type];
      if (!configured) continue;
      const directory = resolveProviderPathValue(configured, outputRoot);
      receiptDirectories.add(path.dirname(directory));
      if (path.basename(path.dirname(directory)) === '.aiwg') receiptDirectories.add(path.dirname(path.dirname(directory)));
      const entries = options.scope === 'user'
        ? exactUserEntries(installed, evidenceOptions.requestedBundles, provider, type)
        : [];
      await collectOwnedDirectory(directory, entries, ownedFiles);
    }
    if (options.scope === 'project') {
      const kernel = resolveProviderPathValue(getProviderKernelSkillPath(provider), outputRoot);
      if (kernel) await collectOwnedDirectory(kernel, [], ownedFiles);
    }
  }
  // Settings, hooks and generated context now have explicit sidecars too.
  for (const directory of receiptDirectories) {
    await collectOwnedDirectory(directory, [], ownedFiles, outputRoot);
    for (const child of ['hooks', 'plugins']) await collectOwnedDirectory(path.join(directory, child), [], ownedFiles);
  }
  const outputPaths = [...ownedFiles]
    .map(file => portablePath(outputRoot, file))
    .filter((file): file is string => Boolean(file))
    .sort();
  return {
    provider,
    outputRoot,
    outputPaths,
    source: await sourceEvidence(evidenceOptions, installed),
    transformer: transformerEvidence(provider, options.scope),
  };
}

export async function finalizeProviderTransformationReceipt(
  options: ProviderReceiptIntegrationOptions,
): Promise<ProviderReceiptFinalization> {
  if (options.sourceDisposition) {
    const evidenceStatePath = await writeEvidenceState(options, options.sourceDisposition);
    if (options.sourceDisposition === 'local-source') {
      return {
        status: 'policy-exempt',
        receiptPath: null,
        evidenceStatePath,
        outputCount: 0,
        reason: 'local-source development deployments are exempt from signed-release receipt issuance',
      };
    }
    return {
      status: options.sourceDisposition === 'source-unavailable' ? 'source-unavailable' : 'skipped',
      receiptPath: null,
      evidenceStatePath,
      outputCount: 0,
      reason: options.sourceDisposition === 'source-unavailable'
        ? 'verified signed-release source evidence is not available from cache or configured resource access'
        : 'canonical source verification failed',
    };
  }
  if (!options.sourceVerifications) {
    return {
      status: 'skipped',
      receiptPath: null,
      outputCount: 0,
      reason: 'authenticated canonical source evidence was not supplied',
    };
  }
  const evidence = await resolveProviderReceiptRuntimeEvidence(options);
  if (evidence.source.verification !== 'verified') {
    return {
      status: 'skipped',
      receiptPath: null,
      outputCount: 0,
      reason: evidence.source.verification === 'failed'
        ? 'canonical source verification failed'
        : 'authenticated canonical source evidence was not supplied',
    };
  }
  if (evidence.outputPaths.length === 0) {
    return { status: 'skipped', receiptPath: null, outputCount: 0, reason: 'no managed provider outputs were found' };
  }
  const verifiedSource: ProviderTransformationReceipt['source'] = {
    subject: evidence.source.subject,
    sha256: evidence.source.sha256,
    verification: evidence.source.verification,
  };
  const receipt = await createProviderTransformationReceipt({
    projectRoot: options.projectRoot,
    outputRoot: evidence.outputRoot,
    provider: evidence.provider,
    scope: options.scope,
    generatedAt: options.generatedAt,
    source: verifiedSource,
    transformer: evidence.transformer,
    outputPaths: evidence.outputPaths,
  });
  const receiptPath = await writeProviderTransformationReceipt(options.projectRoot, receipt);
  await rm(providerTransformationEvidenceStatePath(options.projectRoot, evidence.provider, options.scope), { force: true });
  return {
    status: 'written',
    receiptPath,
    outputCount: receipt.outputs.length,
  };
}

export async function diagnoseIntegratedProviderTransformationReceipt(
  options: ProviderReceiptIntegrationOptions,
): Promise<ProviderTransformationDiagnosis> {
  const provider = normalizeProviderDefinitionId(options.provider) ?? options.provider;
  const receiptPath = providerTransformationReceiptPath(options.projectRoot, provider, options.scope);
  try {
    await access(receiptPath);
  } catch {
    const state = await readEvidenceState(options);
    if (state?.disposition === 'local-source') {
      return {
        status: 'policy-exempt',
        receiptPath,
        checkedOutputs: 0,
        findings: [{
          kind: 'policy-exempt',
          message: 'This local-source development deployment is explicitly exempt from signed-release transformation receipts.',
        }],
      };
    }
    if (state?.disposition === 'source-unavailable') {
      return {
        status: 'source-evidence-unavailable',
        receiptPath,
        checkedOutputs: 0,
        findings: [{
          kind: 'source-evidence-unavailable',
          message: 'The deployment succeeded, but verified signed-release source evidence was unavailable from cache or configured resource access.',
        }],
      };
    }
    if (state?.disposition === 'verification-failed') {
      return {
        status: 'drifted',
        receiptPath,
        checkedOutputs: 0,
        findings: [{
          kind: 'source-verification-failure',
          message: 'Canonical source verification failed during receipt finalization.',
        }],
      };
    }
    return {
      status: 'missing-receipt',
      receiptPath,
      checkedOutputs: 0,
      findings: [{
        kind: 'missing-receipt',
        message: 'No transformation receipt exists for this provider deployment.',
      }],
    };
  }
  const evidence = await resolveProviderReceiptRuntimeEvidence(options);
  return diagnoseProviderTransformationReceipt({
    projectRoot: options.projectRoot,
    outputRoot: evidence.outputRoot,
    provider: evidence.provider,
    scope: options.scope,
    source: evidence.source,
    transformer: evidence.transformer,
  });
}
