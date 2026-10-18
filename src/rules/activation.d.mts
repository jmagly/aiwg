export type RuleActivation = 'kernel' | 'summary' | 'bound' | 'paths' | 'on-demand';
export type RuleBindingKey = 'skills' | 'agents' | 'flows';
export interface RuleBindings { skills: string[]; agents: string[]; flows: string[] }
export interface RuleFrontmatter extends Record<string, unknown> {
  activation: RuleActivation;
  tagged: boolean;
  summary?: string;
  bound_to: RuleBindings;
  paths?: string[];
  enforcedBy?: unknown;
}
export interface RuleDiagnostic { severity: 'error' | 'warn' | 'info'; code: string; message: string }
export type RuleValidationResult =
  | { valid: true; diagnostics: RuleDiagnostic[]; rule: RuleFrontmatter }
  | { valid: false; diagnostics: RuleDiagnostic[]; rule?: never };
export const RULE_ACTIVATIONS: readonly RuleActivation[];
export const RULE_BINDING_TYPES: Readonly<{ skills: 'skill'; agents: 'agent'; flows: 'flow' }>;
export const ruleFrontmatterSchema: Record<string, unknown>;
export function inferRuleActivation(enforcement: unknown): 'kernel' | 'on-demand';
export function validateRuleFrontmatter(data: unknown): RuleValidationResult;
export function parseRuleFrontmatter(content: string): RuleValidationResult & { data: unknown; body: string };
