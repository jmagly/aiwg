import type { RuleDiagnostic } from './activation.mjs';
export interface RulesConfig { inline_budget_tokens?: number }
export interface InlineBudgetConfig { rules?: RulesConfig }
export interface StartupContributor { path: string; bytes?: number; content?: string }
export interface InlineBudgetReport {
  provider: string;
  limit: number;
  selected_bytes: number;
  selected_tokens: number;
  estimate: string;
  disabled: boolean;
  exceeded: boolean;
  contributors: Array<{ path: string; bytes: number; estimated_tokens: number }>;
}
export interface InlineBudgetOptions {
  provider: string;
  files: readonly StartupContributor[];
  config?: InlineBudgetConfig;
  env?: Record<string, string | undefined>;
  reportOnly?: boolean;
}
export const DEFAULT_RULES_INLINE_BUDGET_TOKENS: 64000;
export function validateRulesConfig(rules: unknown): string[];
export function resolveRulesInlineBudget(config?: InlineBudgetConfig, env?: Record<string, string | undefined>): number;
export function guardRulesInlineBudget(options: InlineBudgetOptions): { report: InlineBudgetReport; diagnostics: RuleDiagnostic[]; passed: boolean };
