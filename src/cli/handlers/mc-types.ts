// Mission Control types operations, extracted from the shared handler.

export type MissionStatus = 'queued' | 'running' | 'done' | 'failed' | 'aborted' | 'paused';

export type SessionState = 'active' | 'paused' | 'stopped';

export type MissionMode = 'direct' | 'pty-orchestrator';

export interface Mission {
  id: string;
  objective: string;
  completion?: string;
  status: MissionStatus;
  loop: number;
  maxIterations: number;
  maxTotalTokens?: number;
  maxOutputTokens?: number;
  maxToolCalls?: number;
  maxTotalCost?: number;
  maxWallClockMinutes?: number;
  explorationQuota?: number;
  budgetStopPolicy?: 'completion-wins' | 'budget-wins';
  priority: string;
  mode: MissionMode;
  targetAgent?: string;
  lastAction?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /** Ralph loop ID once the mission is launched (#1439) */
  ralphLoopId?: string;
  /** Ralph process PID once the mission is launched (#1439) */
  ralphPid?: number;
  /** Shared-host admission lease backing this local execution (#1566, #1657). */
  admissionRequestId?: string;
  admissionState?: string;
  admissionLeaseExpiresAt?: string;
  admissionSubmittedAt?: string;
  admissionGeneration?: number;
  admissionLaunchClaimed?: boolean;
  admissionExecution?: { pid: number; startedAt: string };
  extensions?: Record<string, unknown>;
  managedWorker?: { invocationPath: string; runDir: string };
}

export interface Session {
  id: string;
  name: string;
  state: SessionState;
  maxMissions: number;
  createdAt: string;
  updatedAt: string;
  missions: Mission[];
  /** Idempotency ledger shared by CLI and Cockpit control mutations. */
  mutationKeys?: Record<string, { action: string; target: string; updatedAt: string }>;
}
