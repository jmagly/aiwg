// Collection declarations and transport observations within the existing eval archive.
import type { FileRef, PilotDataset } from './pilot-types.js';
import type { CalibrationStudy, FixedOutput, Vote } from './calibration-types.js';
export interface JudgeConfiguration {
  id: string;
  transport: 'cli' | 'openrouter';
  group?: 'workers' | 'cursor' | 'muse-external';
  role?: string;
  model?: string;
  max_call_usd?: number;
  max_tokens?: number;
}
export interface ExecutableReference {
  type: 'executable-reference';
  episode_id: string;
  bundle_digest: string;
  criterion_id: string;
  label: 'MET' | 'UNMET';
  provenance: { checker: FileRef; checks: PilotDataset['tasks'][number]['pilot']['checks']; outcomes_digest: string; output_status: string };
}
export interface JudgeCollection {
  config_digest: string;
  seed: number;
  tranche: 'dev' | 'heldout';
  max_attempts: number;
  evaluators: JudgeConfiguration[];
  stop_reason: 'complete' | 'max-calls' | 'max-usd' | 'in-flight';
  human_labels_needed: string[];
  executable_references: ExecutableReference[];
}
export interface CollectOptions {
  study: CalibrationStudy;
  records: FixedOutput[];
  evaluators: JudgeConfiguration[];
  runDir: string;
  tranche: 'dev' | 'heldout';
  seed: number;
  maxCalls: number;
  maxUsd?: number;
  maxAttempts?: number;
  dryRun?: boolean;
  resolver?: { file: string; args: string[] };
  // Loopback-only override for offline fixture servers. Production always uses OpenRouter.
  httpEndpoint?: string;
}
export interface Observation {
  raw: string;
  content: string;
  status?: Exclude<Vote['status'], 'completed'>;
  flags: string[];
  tokens: number | 'unknown';
  cost: number | 'unknown';
  observed_model: string;
  observed_vendor: string;
  observed_family: string;
  revision: string;
  settings: Record<string, unknown>;
}
