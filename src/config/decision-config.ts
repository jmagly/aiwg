import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseYamlSimple } from './user-config.js';
import { resolveUserConfigDir } from './user-config-dir.mjs';
import { validateJevConfig, type JevOpenBaoReference } from './jev-credential-reference.js';

/** Project decision settings. Credential references may live here; values never do. */
export interface DecisionConfig {
  /** Persistent runtime opt-in; environment overrides project, then user config. */
  enabled?: boolean;
  jev?: { credential: JevOpenBaoReference };
  /** Ask sampling: product default 5 passes, escalating to twice that. */
  ask?: {
    passes?: number;
    escalation_passes?: number;
    /** Omit to disable agreement acceptance. */
    min_agreement?: number;
    agreement_confidence_floor?: number;
    /** USD per million tokens. A complete split pair takes precedence over blended Jev. */
    cost?: {
      llm_per_mtok?: number;
      jev_per_mtok?: number;
      jev_input_per_mtok?: number;
      jev_output_per_mtok?: number;
      source?: 'typesafe-docs' | 'manual' | 'typesafe-snapshot';
      checked_at?: string;
      jev_model?: string;
    };
    savings?: {
      caller_model_class?: 'standard' | 'reasoning';
      reasoning_tokens?: number;
      output_tokens?: number;
    };
  };
  /** Offline, advisory adoption reporting. These thresholds never block work. */
  offload_report?: {
    window_hours?: number;
    minimum_eligible?: number;
    minimum_attempt_rate?: number;
    repeated_fallbacks?: number;
  };
}

export interface DecisionEnablementOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface DecisionEnablement {
  enabled: boolean;
  source: 'env' | 'project' | 'user' | 'default';
}

export function validateDecisionConfig(value: unknown): string[] {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['decision must be an object'];
  const errors: string[] = validateJevConfig((value as DecisionConfig).jev);
  const { enabled, ask, offload_report: report } = value as DecisionConfig;
  if (enabled !== undefined && typeof enabled !== 'boolean') errors.push('decision.enabled must be a boolean');
  if (report !== undefined) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) errors.push('decision.offload_report must be an object');
    else {
      for (const key of ['window_hours', 'minimum_eligible', 'repeated_fallbacks'] as const) {
        const configured = report[key];
        if (configured !== undefined && (!Number.isSafeInteger(configured) || configured < (key === 'minimum_eligible' ? 0 : 1))) {
          errors.push(`decision.offload_report.${key} must be a ${key === 'minimum_eligible' ? 'non-negative' : 'positive'} safe integer`);
        }
      }
      if (report.minimum_attempt_rate !== undefined && (typeof report.minimum_attempt_rate !== 'number'
        || !Number.isFinite(report.minimum_attempt_rate) || report.minimum_attempt_rate < 0 || report.minimum_attempt_rate > 1)) {
        errors.push('decision.offload_report.minimum_attempt_rate must be a probability from 0 to 1');
      }
      for (const key of Object.keys(report)) if (!['window_hours', 'minimum_eligible', 'minimum_attempt_rate', 'repeated_fallbacks'].includes(key)) {
        errors.push(`unknown decision.offload_report.${key}`);
      }
    }
  }
  if (ask === undefined) return errors;
  if (!ask || typeof ask !== 'object' || Array.isArray(ask)) return [...errors, 'decision.ask must be an object'];
  const sampling: string[] = [];
  for (const key of ['passes', 'escalation_passes'] as const) {
    if (ask[key] !== undefined && (!Number.isSafeInteger(ask[key]) || ask[key]! <= 0)) {
      sampling.push(`decision.ask.${key} must be a positive safe integer`);
    }
  }
  if (!sampling.length && ask.escalation_passes !== undefined && ask.escalation_passes < (ask.passes ?? 5)) {
    sampling.push('decision.ask.escalation_passes must be >= decision.ask.passes');
  }
  for (const key of ['min_agreement', 'agreement_confidence_floor'] as const) {
    if (ask[key] !== undefined && (typeof ask[key] !== 'number' || !Number.isFinite(ask[key]) || ask[key]! < 0 || ask[key]! > 1)) {
      sampling.push(`decision.ask.${key} must be a probability from 0 to 1`);
    }
  }
  for (const section of ['cost', 'savings'] as const) {
    const settings = ask[section];
    if (settings === undefined) continue;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      sampling.push(`decision.ask.${section} must be an object`);
      continue;
    }
    const allowed = section === 'cost' ? ['llm_per_mtok', 'jev_per_mtok', 'jev_input_per_mtok', 'jev_output_per_mtok', 'source', 'checked_at', 'jev_model'] : ['caller_model_class', 'reasoning_tokens', 'output_tokens'];
    for (const [key, value] of Object.entries(settings)) {
      if (!allowed.includes(key)) sampling.push(`unknown decision.ask.${section}.${key}`);
      else if (key === 'source') {
        if (!['typesafe-docs', 'manual', 'typesafe-snapshot'].includes(value as string)) sampling.push('decision.ask.cost.source must be typesafe-docs, manual or typesafe-snapshot');
      } else if (key === 'checked_at') {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
          || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) sampling.push('decision.ask.cost.checked_at must be an ISO date (YYYY-MM-DD)');
      } else if (key === 'jev_model') {
        if (typeof value !== 'string' || !/^jev-\d+\.\d+\.\d+$/.test(value)) sampling.push('decision.ask.cost.jev_model must be a versioned Jev model (jev-X.Y.Z)');
      } else if (key === 'caller_model_class') {
        if (value !== 'standard' && value !== 'reasoning') sampling.push('decision.ask.savings.caller_model_class must be standard or reasoning');
      } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000
        || (section === 'savings' && !Number.isSafeInteger(value))) {
        sampling.push(`decision.ask.${section}.${key} must be a non-negative ${section === 'savings' ? 'integer' : 'number'} <= 1000000`);
      }
    }
  }
  return [...errors, ...sampling];
}

function readEnabled(filePath: string, yaml = false): boolean | undefined {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const config = (yaml ? parseYamlSimple(content) : JSON.parse(content)) as { decision?: unknown };
  const errors = validateDecisionConfig(config.decision);
  if (errors.length) throw new Error(`${filePath}: ${errors.join('; ')}`);
  return (config.decision as DecisionConfig | undefined)?.enabled;
}

/** Resolve only enablement; never read credentials or probe a backend. */
export function resolveDecisionEnablement(options: DecisionEnablementOptions = {}): DecisionEnablement {
  const env = options.env ?? process.env;
  if (env.AIWG_DECISION_ENABLED === '0' || env.AIWG_DECISION_ENABLED === '1') {
    return { enabled: env.AIWG_DECISION_ENABLED === '1', source: 'env' };
  }
  const project = readEnabled(path.join(options.cwd ?? process.cwd(), '.aiwg', 'aiwg.config'));
  if (project !== undefined) return { enabled: project, source: 'project' };
  const user = readEnabled(path.join(resolveUserConfigDir({ env, homeDir: options.homeDir }), 'config.yaml'), true);
  if (user !== undefined) return { enabled: user, source: 'user' };
  return { enabled: false, source: 'default' };
}
