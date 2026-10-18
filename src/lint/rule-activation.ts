/** Activation checks within the existing lint runner, not a delivery selector. */
import type { MetadataEntry } from '../artifacts/types.js';
import { loadLocalCapabilityEntries, resolveRuleBindingTarget } from '../artifacts/query-engine.js';
import { parseRuleFrontmatter, RULE_BINDING_TYPES } from '../rules/activation.mjs';
import type { LintDiagnostic, LintRuleset } from './types.js';

export const ruleActivationRuleset: LintRuleset = {
  id: 'rule-activation', name: 'Rule activation', framework: 'core', version: '1.0.0',
  description: 'Validate rule and behavior activation contracts and exact indexed bindings',
  rules: [{
    id: 'rules/activation', name: 'Rule activation contract', severity: 'error',
    description: 'Validate activation, summaries, paths, bindings, and migration fallback',
    appliesTo: { glob: '**/{rules/**/*.md,behaviors/**/BEHAVIOR.md}' },
    checks: [{ type: 'rule-activation' }],
  }],
};

export function lintRuleActivation(
  content: string, file: string, projectRoot: string, entries?: MetadataEntry[],
): LintDiagnostic[] {
  // Generated structural indexes are not authored rules.
  if (/^(?:RULES-INDEX|RULES-ONDEMAND)\.md$/.test(file.split('/').pop()!)) return [];
  const result = parseRuleFrontmatter(content);
  const diagnostics = result.diagnostics.map(item => ({
    ruleId: 'rules/activation', ruleName: 'Rule activation contract',
    file, severity: item.severity, message: item.message,
  }));
  if (!result.rule) return diagnostics;
  const bindings = result.rule.bound_to;
  if (!Object.values(bindings).some(list => list.length > 0)) return diagnostics;
  // Reuse existing artifact index ownership and show precedence. No title guessing,
  // corpus directory resolver, or extra binding registry.
  const indexed = entries ?? loadLocalCapabilityEntries(projectRoot);
  for (const key of Object.keys(RULE_BINDING_TYPES) as Array<keyof typeof RULE_BINDING_TYPES>) {
    for (const id of bindings[key]) {
      try {
        resolveRuleBindingTarget(indexed, RULE_BINDING_TYPES[key], id);
      } catch (error) {
        diagnostics.push({ ruleId: 'rules/activation', ruleName: 'Rule activation contract',
          file, severity: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return diagnostics;
}
