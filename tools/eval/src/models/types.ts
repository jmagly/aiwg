/**
 * Model types for AIWG evaluation suite
 * Extends matric-eval types from @matric/eval-client
 */

import type { PilotTask, PilotRun, PilotSummary } from '../pilot-types.js';

export interface GenerationOptions {
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  stream?: boolean;
}

export interface GenerationResult {
  text: string;
  tokensGenerated: number;
  totalTime: number;
  timeToFirstToken?: number;
}

export interface GenerationModel {
  readonly name: string;
  generate(prompt: string, options?: GenerationOptions): Promise<GenerationResult>;
}

export interface TestCase {
  id: string;
  dimension: string;
  difficulty: 'basic' | 'intermediate' | 'advanced';
  prompt: string;
  expected: Record<string, unknown>;
  scoring: Record<string, number>;
  pilot?: PilotTask;
}

export interface EvalResult {
  testCaseId: string;
  dimension: string;
  score: number;
  maxScore: number;
  details: Record<string, unknown>;
  latencyMs: number;
  modelResponse: string;
  pilot?: PilotRun;
}

export type IntegrityMode = 'standard' | 'fresh' | 'locked' | 'full-locked';

export type IntegrityState =
  | 'not-assessed'
  | 'weak-signal'
  | 'verified'
  | 'compromised';

export type CompromiseLabel =
  | 'test_edit'
  | 'scorer_edit'
  | 'fixture_edit'
  | 'metric_leakage'
  | 'unknown';

export interface UncertaintyEstimate {
  method: 'wilson-95';
  confidence: 0.95;
  estimate: number;
  lower_bound: number;
  upper_bound: number;
}

export interface PairedBaselineInput {
  label?: string;
  score: number;
  sample_n?: number;
}

export interface PairedBaselineResult {
  label: string;
  baseline_score: number;
  current_score: number;
  delta: number;
  sample_n: number | null;
}

export interface ReleaseGateThresholds {
  promote_score: number;
  rollback_score: number;
  minimum_sample_n: number;
  minimum_interval_lower_bound: number;
}

export interface ReleaseGateDecision {
  decision: 'PROMOTE' | 'HOLD' | 'ROLLBACK';
  reasons: string[];
  thresholds: ReleaseGateThresholds;
}

/**
 * Machine-readable evidence attached to every report produced by the runner.
 *
 * These names intentionally use snake_case: they are a serialized contract,
 * not merely an internal TypeScript shape.
 */
export interface EvalIntegrityMetadata {
  sample_n: number;
  uncertainty: UncertaintyEstimate | null;
  paired_baseline: PairedBaselineResult | null;
  integrity_mode: IntegrityMode;
  fresh_workspace_required: boolean;
  fresh_workspace_verified: boolean;
  integrity_state: IntegrityState;
  trusted_score_source: string;
  compromise_labels: CompromiseLabel[];
  weak_signal_reason: string | null;
  release_gate: ReleaseGateDecision;
}

export interface ProtectedEvalArtifact {
  path: string;
  family: Extract<CompromiseLabel, 'test_edit' | 'scorer_edit' | 'fixture_edit'>;
}

export interface DimensionScore {
  dimension: string;
  score: number;
  tier: 'opus' | 'sonnet' | 'haiku' | 'not-recommended';
  testCases: number;
  passed: number;
}

export interface EvalReport extends Partial<EvalIntegrityMetadata> {
  model: string;
  backend: string;
  date: string;
  aiwgVersion: string;
  dimensions: DimensionScore[];
  overall: number;
  overallTier: 'opus' | 'sonnet' | 'haiku' | 'not-recommended';
  totalLatencyMs: number;
  pilot?: PilotSummary;
  /** Standard benchmark scores from matric-eval, present when --include-matric-benchmarks is set */
  matricBenchmarks?: import('@matric/eval-client').ModelResult;
}

/** Report contract guaranteed by AiwgEvalRunner, including standard-mode evidence labels. */
export type EvalReportWithIntegrity = EvalReport & EvalIntegrityMetadata;
