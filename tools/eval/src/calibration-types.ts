// Typed projections of the existing eval contract's offline criterion calibration.
import type { JudgeCollection } from './judge-types.js';
import type { EvalResult } from './models/types.js';
export interface Criterion {
  id: string;
  version: string;
  type: 'binary' | 'ordinal' | 'nominal';
  construct: string;
  evidence: string[];
  weight: number;
  applicability: string;
  allows_na: boolean;
  missing_evidence: string;
  anchors: Record<string, string>;
  values: Record<string, number | null>;
}
export interface Evaluator {
  id: string;
  version: string;
  treatment: 'single' | 'calibration' | 'shuffling' | 'repeated' | 'ensemble';
  observed_model: string;
  observed_vendor: string;
  observed_family: string;
  revision: string;
  prompt: string;
  prompt_digest: string;
  settings: Record<string, unknown>;
  examples: string[];
  config_digest: string;
}
export interface Vote {
  episode_id: string;
  bundle_digest: string;
  criterion_id: string;
  criterion_version: string;
  evaluator_id: string;
  config_digest: string;
  execution_id: string;
  retry_of: string | null;
  status: 'completed' | 'partial' | 'provider-error' | 'missing';
  label: string | null;
  evidence: string[];
  rationale: string;
  critical_flags: string[];
  raw_response: string;
  raw_digest: string;
  cost_usd: number | 'unknown';
  tokens: number | 'unknown';
  latency_ms: number | 'unknown';
  option_order: string[];
  confidence: number | null;
  prompt?: string;
  prompt_digest?: string;
  settings?: Record<string, unknown>;
  settings_digest?: string;
  observed_model?: string;
  observed_vendor?: string;
  observed_family?: string;
  revision?: string;
  secondary_flags?: string[];
}
export interface Human {
  episode_id: string;
  bundle_digest: string;
  criterion_id: string;
  criterion_version: string;
  annotator: string;
  blinded: true;
  label: string;
  evidence: string[];
  rationale: string;
}
export interface Adjudicated extends Omit<Human, 'annotator' | 'blinded'> { adjudicator: string }
export interface CalibrationStudy {
  collection?: JudgeCollection;
  version: 'qualitative-v1';
  provenance: { repository: string; commit: string; analysis: string; protocol: string };
  dataset_commitment: string;
  outputs_digest: string;
  commitment: string;
  split: Record<'dev' | 'held-out', string[]>;
  contexts: Record<string, { request: string; input: Record<string, unknown> }>;
  criteria: Criterion[];
  prompt: string;
  prompt_digest: string;
  abstention: 'SKIP';
  thresholds: 'not-predeclared: insufficient-evidence';
  blinding: string;
  evaluators: Evaluator[];
  votes: Vote[];
  humans: Human[];
  adjudications: Adjudicated[];
}
export interface Bundle {
  id: string;
  task_id: string;
  family: string;
  split: 'dev' | 'held-out';
  digest: string;
  evidence: Record<string, unknown>;
}
export type FixedOutput = Pick<EvalResult, 'testCaseId' | 'modelResponse' | 'pilot' | 'details'>;
