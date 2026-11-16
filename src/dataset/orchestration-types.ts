import type {
  AdapterCheckpoint,
  AdapterDiagnostic,
  AdapterPolicy,
  AdapterRecord,
  DatasetSourceAdapter,
} from "./adapter-types.js";
import type { Digest, ProcessingPlan, RunReceipt } from "./types.js";

export const DATASET_ORCHESTRATION_VERSION =
  "aiwg.dataset-orchestration/v1" as const;
export type DatasetAction =
  | "source"
  | "check"
  | "preview"
  | "plan"
  | "ingest"
  | "status"
  | "show"
  | "verify"
  | "query"
  | "lineage"
  | "export"
  | "cancel"
  | "retry";
export interface RegisteredSource {
  id: string;
  revisionId: string;
  adapter: { id: string; version: string };
  config: Record<string, unknown>;
  policy: AdapterPolicy;
  identity?: string;
  checkpoint?: AdapterCheckpoint;
  cache?: { state: "warm-verified" | "stale" | "corrupt" | "wrong-revision" | "unverifiable"; records?: readonly AdapterRecord[] };
}
export interface DatasetRunState {
  runId: string;
  idempotencyKey: string;
  planId: string;
  planDigest: Digest;
  status: "running" | "committed" | "failed" | "cancelled" | "ambiguous";
  attempt: number;
  startedAt: string;
  endedAt?: string;
  checkpoint?: AdapterCheckpoint;
  receipt?: RunReceipt;
  lastCommittedReceipt?: RunReceipt;
  degraded: string[];
  freshness: "current" | "stale" | "unknown";
}
export interface DatasetResult<T = unknown> {
  schema: typeof DATASET_ORCHESTRATION_VERSION;
  action: DatasetAction;
  ok: boolean;
  data?: T;
  diagnostics: Array<{
    code: string;
    message: string;
    boundary: "input" | "adapter" | "plan" | "backend" | "repository";
    retryable: boolean;
  }>;
  backend?: string;
  degraded?: string[];
}
export interface ExecutionRequest {
  plan: ProcessingPlan;
  records: readonly AdapterRecord[];
  signal?: AbortSignal;
  priorCheckpoint?: AdapterCheckpoint;
}
export interface ExecutionResult {
  outcome: "committed" | "failed" | "cancelled" | "ambiguous";
  attemptedRecords: number;
  committedRecords: number;
  rejectedRecords: number;
  checkpoint?: AdapterCheckpoint;
  diagnostics: AdapterDiagnostic[];
  artifact?: {
    id: string;
    revisionId: string;
    records: readonly AdapterRecord[];
  };
}
export interface DatasetExecutionBackend {
  readonly id: string;
  readonly locality?: "local" | "remote";
  capabilities(): readonly { name: string; version: string }[];
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}
export interface DatasetOrchestrationDependencies {
  adapter(id: string, version: string): DatasetSourceAdapter;
  localBackend: DatasetExecutionBackend;
  fortemiBackend?: DatasetExecutionBackend;
  selectBackend?(id?: string): DatasetExecutionBackend;
  now?: () => string;
}
