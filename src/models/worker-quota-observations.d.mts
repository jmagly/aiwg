export interface WorkerQuotaObservation { cli: string; quotaScope: string; observedAt: string; resetAt: string | null }
export function parseWorkerQuotaFailure(output: string, now?: number, failed?: boolean): { resetAt: string | null } | null;
export function loadWorkerQuotaObservations(cwd: string): Promise<WorkerQuotaObservation[]>;
export function workerQuotaExhaustion(values: WorkerQuotaObservation[] | undefined, quotaScope: string | undefined, now: number): WorkerQuotaObservation | null;
export function recordWorkerQuotaFailure(input: { cwd: string; cli: string; quotaScope?: string; output: string; exitCode: number; now?: number }): Promise<boolean>;
