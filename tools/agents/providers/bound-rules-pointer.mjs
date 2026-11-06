// Render the final bound-rule pointer shared by deployment and size checks.
import { replaceBoundRulesBlock } from './base-contract.mjs';

export const boundRuleAnchor = target => `${target.type}-${target.name}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

export function renderBoundRulesPointer(body, targets, indexRel, { fetch = '', compact = false } = {}) {
  const clean = replaceBoundRulesBlock(body, []);
  const pointers = [...new Set(targets.map(target => `${indexRel}#${boundRuleAnchor(target)}`))];
  if (!pointers.length) return clean;
  // Authored pointers already reach the same complete rule set; keep one copy.
  const missing = pointers.filter(pointer => !clean.includes(`\`${pointer}\``));
  const instruction = missing.length
    ? `${compact ? 'Read and follow' : 'Read and follow before governed work'}: ${missing.map(pointer => `\`${pointer}\``).join('; ')}.`
    : 'Read and follow the bound rules listed above before governed work.';
  return `${clean}${clean.endsWith('\n') ? '' : '\n'}\n<!-- AIWG:bound-rules:start -->\n${instruction}\n${fetch ? fetch + '\n' : ''}<!-- AIWG:bound-rules:end -->\n`;
}

export function projectCodexAgentBindings(rendered, targets) {
  return rendered.replace(/^developer_instructions = (".*")$/m, (_, value) =>
    `developer_instructions = ${JSON.stringify(renderBoundRulesPointer(JSON.parse(value), targets, '.codex/RULES-BOUND.md', { compact: true }))}`);
}
