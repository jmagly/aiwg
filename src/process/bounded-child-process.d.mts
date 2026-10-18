import type {
  ExecFileSyncOptions,
  ExecFileSyncOptionsWithBufferEncoding,
  ExecFileSyncOptionsWithStringEncoding,
  ExecSyncOptions,
  ExecSyncOptionsWithBufferEncoding,
  ExecSyncOptionsWithStringEncoding,
  SpawnSyncOptions,
  SpawnSyncOptionsWithBufferEncoding,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from 'node:child_process';

export type SyncProcessTier = 'quick' | 'network' | 'long';

export const AIWG_SYNC_LONG_TIMEOUT_MS_ENV: 'AIWG_SYNC_LONG_TIMEOUT_MS';

export const SYNC_PROCESS_TIER_BOUNDS_MS: Readonly<{
  quick: number;
  network: number;
  long: number;
}>;

export function resolveSyncProcessTimeoutMs(tier: SyncProcessTier): number;

export function positiveTimeoutMs(value: unknown, fallbackMs: number): number;

// Overloads mirror Node's own execSync/execFileSync/spawnSync overload set
// (string vs Buffer return type keyed on `options.encoding`), with the
// required `tier` inserted right before `options` — same narrowing behavior
// callers get from the native APIs, e.g. `.trim()` on the result when
// `encoding: 'utf8'` is set.

export function boundedExecSync(command: string, tier: SyncProcessTier): Buffer;
export function boundedExecSync(command: string, tier: SyncProcessTier, options: ExecSyncOptionsWithStringEncoding): string;
export function boundedExecSync(command: string, tier: SyncProcessTier, options: ExecSyncOptionsWithBufferEncoding): Buffer;
export function boundedExecSync(command: string, tier: SyncProcessTier, options?: ExecSyncOptions): string | Buffer;

export function boundedExecFileSync(file: string, args: readonly string[], tier: SyncProcessTier): Buffer;
export function boundedExecFileSync(
  file: string,
  args: readonly string[],
  tier: SyncProcessTier,
  options: ExecFileSyncOptionsWithStringEncoding,
): string;
export function boundedExecFileSync(
  file: string,
  args: readonly string[],
  tier: SyncProcessTier,
  options: ExecFileSyncOptionsWithBufferEncoding,
): Buffer;
export function boundedExecFileSync(
  file: string,
  args: readonly string[],
  tier: SyncProcessTier,
  options?: ExecFileSyncOptions,
): string | Buffer;

export function boundedSpawnSync(command: string, args: readonly string[], tier: SyncProcessTier): SpawnSyncReturns<Buffer>;
export function boundedSpawnSync(
  command: string,
  args: readonly string[],
  tier: SyncProcessTier,
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function boundedSpawnSync(
  command: string,
  args: readonly string[],
  tier: SyncProcessTier,
  options: SpawnSyncOptionsWithBufferEncoding,
): SpawnSyncReturns<Buffer>;
export function boundedSpawnSync(
  command: string,
  args: readonly string[],
  tier: SyncProcessTier,
  options?: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer>;

/** Async launch with direct-child timeout and cleanup before termination. */
export function boundedSpawn(
  command: string, args: readonly string[], tier: SyncProcessTier,
  options: import('node:child_process').SpawnOptions,
  onTermination?: () => void,
): Promise<{ status: number | null; signal: NodeJS.Signals | null; error?: Error; pid?: number }>;
