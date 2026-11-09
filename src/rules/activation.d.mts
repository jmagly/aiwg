export type RuleActivation = 'core' | 'kernel' | 'summary' | 'bound' | 'paths' | 'on-demand';
export type RuleBindingKey = 'skills' | 'agents' | 'flows';
export interface RuleBindings { skills: string[]; agents: string[]; flows: string[] }
export interface RuleFrontmatter extends Record<string, unknown> {
  activation: RuleActivation;
  tagged: boolean;
  precedence: 'critical' | 'high' | 'medium' | 'low';
  overridable: boolean;
  summary?: string;
  bound_to: RuleBindings;
  paths?: string[];
  enforcedBy?: string[];
}
export interface RuleDiagnostic { severity: 'error' | 'warn' | 'info'; code: string; message: string }
export type RuleValidationResult =
  | { valid: true; diagnostics: RuleDiagnostic[]; rule: RuleFrontmatter }
  | { valid: false; diagnostics: RuleDiagnostic[]; rule?: never };
export const RULE_ACTIVATIONS: readonly RuleActivation[];
export const RULE_BINDING_TYPES: Readonly<{ skills: 'skill'; agents: 'agent'; flows: 'flow' }>;
export const ruleFrontmatterSchema: Record<string, unknown>;
export function inferRuleActivation(enforcement?: unknown): 'on-demand';
export function validateRuleFrontmatter(data: unknown): RuleValidationResult;
export function parseRuleFrontmatter(content: string): RuleValidationResult & { data: unknown; body: string };
export const RULE_SUMMARY_MAX_LENGTH: number;
export function formatRuleFrontmatterError(file: string, data: unknown, diagnostics: RuleDiagnostic[]): string;
export const CORE_BODY_MAX_BYTES: number;
export const CORE_TOTAL_MAX_BYTES: number;
export const CORE_RULES_START: string;
export const CORE_RULES_END: string;
export function coreBodyPath(ruleFile: string): string;
export function validateCoreBody(text: string, label?: string): string[];
export function validateCoreSet(bodies: Array<{ name: string; text: string }>): string[];
export function readCoreBody(ruleFile: string): string;
export function measureDeployedCoreRules(target: string, provider: string, rulesDir?: string): { bodies: Array<{ name: string; bytes: number }>; bytes: number; limit: number };
