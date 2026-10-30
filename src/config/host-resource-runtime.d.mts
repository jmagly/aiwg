export interface HostResourceSample {
  /** Start of collection on the source host; absent on legacy/unavailable snapshots. */
  collectedAt?: string;
  supported: boolean; reason?: string; availMemGb?: number; load1?: number; cores?: number;
  loadRatio?: number; memPsiAvg10?: number; memPsiAvg60?: number; memPsiAvg300?: number;
  workerGroups?: Record<string, number>;
  workers?: number; hostCliProcesses?: Record<string, number>; workerUnits?: number; freeDiskGb?: number;
  workerCountingSource?: 'systemd-units-and-marked-processes' | 'owned-process-fallback';
}
export interface WorkerCensus {
  byGroup?: Record<string, number>;
  total: number; hostCliProcesses?: Record<string, number>; units?: number;
  source?: HostResourceSample['workerCountingSource'];
}
export interface HostResourceReaders {
  now?: () => number;
  readText?: (path: string) => string;
  readDir?: (path: string) => string[];
  uid?: number;
  groupNames?: string[];
  coreCount?: () => number;
  countWorkers?: () => number | undefined | WorkerCensus;
  countWorkerUnits?: () => number | undefined;
  listWorkerUnits?: () => string[] | undefined;
  statfs?: () => { bavail: number | bigint; bsize: number | bigint };
  statfsPath?: (path: string) => { bavail: number | bigint; bsize: number | bigint };
  paths?: string[];
}
export function readLiveHostResources(readers?: HostResourceReaders): HostResourceSample;
export function countWorkerProcesses(readers?: HostResourceReaders): WorkerCensus | undefined;
export function defaultCountWorkers(readers?: HostResourceReaders): number | undefined;
export function countWorkerUnits(options?: { spawn?: (...args: any[]) => any }): number | undefined;
export function listWorkerUnits(options?: { spawn?: (...args: any[]) => any }): string[] | undefined;
export function parseMemAvailableGb(text: unknown): number | undefined;
export function parseMemoryPsi(text: unknown): { avg10: number; avg60: number; avg300: number } | null;
export function parseLoadAverages(text: unknown): { load1: number; load5: number; load15: number } | null;
export function evaluateDispatchGate(live: HostResourceSample, thresholds: any): { ok: boolean; failures: any[]; thresholds: any };
