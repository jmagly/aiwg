// Prompt contracts require resolver-backed exploration and verification before dispatch.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('T-OG-08 mission and flow delegation instructions', () => {
  it.each(['flow-delivery-track', 'flow-gate-check', 'flow-guided-implementation', 'flow-security-review-cycle', 'flow-test-strategy-execution'])('%s carries the Delegation block and resolver contract', flow => {
    const root = join(process.cwd(), 'agentic/code/frameworks/sdlc-complete/skills', flow);
    expect(readFileSync(join(root, 'SKILL.md'), 'utf8')).toContain('## Delegation\n\nFollow [Worker delegation](references/delegation.md)');
    const instructions = readFileSync(join(root, 'references/delegation.md'), 'utf8');
    for (const required of ['resolveDelegation()', 'aiwg models resolve', 'defaults.workerSelection', 'aiwg-model-explorer', 'aiwg-model-verifier', 'frontmatter', 'election: user', 'requested_tier', 'resolved_model']) expect(instructions).toContain(required);
  });
  it('mission decomposition requests explicit tiers and routing records', () => {
    const body = readFileSync('agentic/code/addons/aiwg-utils/skills/aiwg-mission/SKILL.md', 'utf8');
    for (const required of ['resolveDelegation()', 'defaults.workerSelection', 'requested_tier', 'resolved_model', 'election: user']) expect(body).toContain(required);
  });
});
