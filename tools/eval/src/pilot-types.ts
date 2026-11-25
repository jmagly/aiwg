// Typed projections of the canonical eval contract's optional pilot evidence.
import type { EvalResult, TestCase } from './models/types.js';

export type Split = 'dev' | 'held-out';
export type Hypothesis = 'H1' | 'H2';
export interface CheckRef { id: 'corpus' | 'coding' | 'security'; ref: string; digest: string }
export interface FileRef { ref: string; digest: string }
export interface PilotTask {
  family: 'corpus-verification' | 'coding-repair' | 'security-testing';
  split: Split;
  input: Record<string, unknown>;
  checks: CheckRef[];
  baseline_passed: boolean;
}
export interface Budget { total_tokens: number; tool_calls: number; latency_ms: number }
export interface PilotPins {
  repository_snapshot: string;
  environment: string;
  model: string;
  model_version: string;
  tool_permissions: string[];
  budget: Budget;
  checker: FileRef;
  flow_runtime: FileRef;
}
export interface PilotArm {
  id: string;
  hypothesis: Hypothesis;
  configuration: 'none' | 'all' | 'discover' | 'expert' | 'dag' | 'loop' | 'graph' | 'weakened-guard';
  context: FileRef[];
  graph?: FileRef;
}
export interface PilotDataset {
  dataset_id: string;
  evidence_mode: 'offline-fixture';
  commitment: string;
  seed: number;
  tasks: (TestCase & { pilot: PilotTask })[];
  arms: PilotArm[];
  pins: PilotPins;
  responses: FileRef;
}
export interface Resources {
  total_tokens: number;
  context_tokens: number;
  latency_ms: number;
  tool_calls: number;
  permission_violations: number;
  invalid_transitions: number;
  duplicate_effects: number;
  regressions: number;
}
export interface PilotRun {
  arm_id: string;
  hypothesis: Hypothesis;
  split: Split;
  family: PilotTask['family'];
  order: number;
  status: 'completed' | 'failed' | 'partial';
  success: boolean;
  pin_digest: string;
  dataset_commitment: string;
  checks: CheckRef[];
  resources: Resources;
  resource_source: 'fixture';
  observed_model: string;
  adjudication_id: string;
}
export interface Adjudication {
  id: string;
  case_id: string;
  candidate_id: string;
  evaluator: 'hidden-executable';
  accepted: boolean;
  reasons: string[];
  disagreement: boolean;
  human_label: 'NOT RUN';
}
export interface ArmSummary {
  arm_id: string;
  split: Split;
  sample_n: number;
  successes: number;
  failures: number;
  partials: number;
  success_rate: number;
  total_tokens: number;
  success_per_total_tokens: number | null;
  mean_latency_ms: number;
}
export interface Interval { estimate: number; lower: number; upper: number }
export interface Comparison {
  hypothesis: Hypothesis;
  baseline: string;
  candidate: string;
  sample_n: number;
  bootstrap: { method: 'paired-percentile'; confidence: 0.95; resamples: number; seed: number };
  metrics: Record<'success' | 'total_tokens' | 'context_tokens' | 'latency_ms' | 'permission_violations' | 'invalid_transitions' | 'duplicate_effects' | 'regressions', Interval>;
}
export interface PilotSummary {
  dataset_id: string;
  dataset_commitment: string;
  evidence_mode: 'offline-fixture';
  splits: Record<Split, number>;
  families: Record<PilotTask['family'], number>;
  records: EvalResult[];
  adjudication: Adjudication[];
  arms: ArmSummary[];
  comparisons: Comparison[];
  negative_control_valid: boolean;
  human_evaluation: 'NOT RUN';
  claim_gate: { state: 'BLOCKED'; reasons: string[] };
}
export interface ResponseTape {
  task_id: string;
  arm_id: string;
  text: string;
  refined?: string;
  self_pass: boolean;
  status: PilotRun['status'];
  total_tokens: number;
  latency_ms: number;
  tool_calls: number;
}
