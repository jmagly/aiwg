import type { PinConfigs } from './pins.mjs';
export interface RuleOrdering { precedence?: unknown; overridable?: unknown; name?: string; id?: string }
export interface ResolvedRuleOrdering { precedence: string; overridable: boolean; precedence_source: string; project_context: boolean }
export function validateRulePrecedenceConfig(value: unknown): string[];
export function resolveRulePrecedence(rule: RuleOrdering, configs?: PinConfigs, aliases?: string[]): ResolvedRuleOrdering;
export const RULE_PRECEDENCE_TEXT: string;
