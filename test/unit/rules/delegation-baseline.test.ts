// Static policy regression checks: session tier inheritance must never return.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const rules = 'agentic/code/addons/aiwg-utils/rules';
const read = (name: string) => readFileSync(join(rules, `${name}.md`), 'utf8');
describe('delegation rule baseline', () => {
  it('contains modes, keep-local exits, wrappers, return and brief contracts', () => {
    const rule = read('subagent-scoping');
    for (const value of ['Delegate by default', 'advisory', '`off`', 'Keep local:', 'Bang for the buck', 'aiwg-model-explorer', 'aiwg-model-verifier', 'returnBudgetTokens', 'confidence', 'open questions', 'verify centrally', 'OBJECTIVE:', 'CONTEXT:', 'SCOPE:', 'CONSTRAINTS:', 'OUTPUT:', 'STOP WHEN:', 'DO NOT:']) expect(rule).toContain(value);
    expect(rule.split('\n').length - 1).toBeLessThanOrEqual(500);
  });
  it('rejects session tier defaults across rule sources and has a flagship worked example', () => {
    for (const name of readdirSync(rules).filter(name => name.endsWith('.md'))) {
      expect(readFileSync(join(rules, name), 'utf8')).not.toMatch(/assume the current model is the agent.s default tier/i);
    }
    expect(read('escalation-discipline')).toContain('No flagship workers');
    expect(read('escalation-discipline')).toContain('economy');
    for (const name of ['parallel-then-synthesize', 'context-bloat', 'god-session']) expect(read(name)).toContain('Rule 4a');
    expect(readFileSync('agentic/code/addons/rlm/rules/rlm-context-management.md', 'utf8')).toContain('Rule 4a');
  });
});
