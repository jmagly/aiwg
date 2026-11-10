import type { ProviderModelCapabilityRegistry } from './provider-policy.js';
import type { WorkerSelectionPolicy } from './types.js';
import type { WorkerResolutionBinding } from './resolver.js';
import type { WorkerInvocationDriver } from '../serve/worker-invocation.js';
export function loadRecordedWorkerInstallations(input: {
  registry: ProviderModelCapabilityRegistry;
  cwd: string;
  policy?: WorkerSelectionPolicy;
  parallelism?: import('../config/aiwg-config.js').ParallelismConfig;
  /** Restrict revalidation to a CLI already selected by a bound invocation. */
  cli?: string;
  storePath?: string;
  storeDigest?: string;
  /** Request validation after store presence, before recorded policy/adapter checks. */
  precheckPolicy?: () => void;
}): Promise<{ registry: ProviderModelCapabilityRegistry; installations: Record<string, WorkerResolutionBinding>; drivers: Record<string, WorkerInvocationDriver>; observations: Record<string, import('./model-discovery.js').ProviderModelDiscovery>; qualificationFailures?: Record<string, string> }>;

export function hasProvider(name: string): boolean;

export function compileWorkerVersionPattern(pattern: string): RegExp;
export function normalizeWorkerVersionBanner(banner: string, pattern?: string): string;
export const workerVersionProbeEnvAllowlist: readonly string[];
export function workerVersionProbeEnvironment(source?: Record<string, string | undefined>): Record<string, string>;
export const workerVersionProbeDefaults: { readonly timeoutMs: number; readonly maxBytes: number };
export function workerVersionRangeMismatch(version: string, ranges: string[]): string | null;
export function boundedVersionProbe(
  executable: string,
  argv: string[],
  environment: Record<string, string>,
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
  versionPattern: string | undefined,
): Promise<{ rawBanner: string; version: string }>;

export interface WorkerRecoveryCapabilities {
  canVerifyAttempt?: boolean;
  parseWorkerAttemptFinal?(output: string | Uint8Array, options: Record<string, unknown>): Promise<unknown>;
}
export function registerWorkerRecoveryCapabilities<T extends object>(driver: T, capabilities: WorkerRecoveryCapabilities): T;
export function getWorkerRecoveryCapabilities(driver: object | undefined | null): Readonly<WorkerRecoveryCapabilities> | null;

export function prepareWorkerInstallationStore(input: { workerWritableRoots: string[]; apply?: boolean }): Promise<{ path: string; action: string }[]>;

/** Historical approvals only; no driver import, probe, auth read, or launch authority. */
export function inspectRecordedWorkerQualifications(input: {
  cwd: string; policy: WorkerSelectionPolicy; parallelism: import('../config/aiwg-config.js').ParallelismConfig;
  /** Include signed historical inputs for offline health projection, never launch authority. */
  includeInputs?: boolean;
}): Promise<Array<{ cli: string; provider: string; binding?: WorkerResolutionBinding;
  adapter?: import('./provider-policy.js').WorkerAdapterMetadata;
  observations?: import('./model-discovery.js').ProviderModelDiscovery }>>;
