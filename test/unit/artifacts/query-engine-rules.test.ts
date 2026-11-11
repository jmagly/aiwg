// Guard required bound contracts against kernel delivery overrides.
import { describe, expect, it } from 'vitest';
import { buildRelations, relationId } from '../../../src/artifacts/relations-builder.js';
import { RelationsReader } from '../../../src/artifacts/relations.js';
import { compoundGoverningRules, governingRuleFields, showBindings } from '../../../src/artifacts/query-engine-rules.js';
import type { MetadataEntry } from '../../../src/artifacts/types.js';

const entry = (type: string, name: string, extra: Partial<MetadataEntry> = {}): MetadataEntry => ({
  path: `.aiwg/${type}s/${name}.md`, type, name, title: name, tags: [],
  created: '', updated: '', checksum: '', summary: '', dependencies: [], dependents: [], ...extra,
});

describe('governing rule pin parity (#3768)', () => {
  it.each(['UI/UX', 'design/development', 'design/devloipment', './src/key.ts', '/src/key.ts', 'src/key.ts', 'src\\key.ts'])(
    'does not activate path rules from free-text %s (#4082)', phrase => {
      const target = entry('agent', 'UX Lead');
      const rule = entry('rule', 'banned-apis', { activation: 'paths', rulePaths: ['**/*'] });
      const entries = [target, rule];
      for (const reader of [undefined, new RelationsReader(buildRelations(entries))]) {
        expect(compoundGoverningRules(entries, target, reader, phrase)).toEqual([]);
        const governed = { ...target, governedPaths: ['src/key.ts'] };
        expect(compoundGoverningRules(entries, governed, reader, phrase)).toEqual([
          { rule, applicability: ['path:src/key.ts'] },
        ]);
      }
    },
  );

  it.each(['skill', 'agent', 'flow'] as const)('keeps the pinned %s contract identical in discover and show', async type => {
    const target = entry(type, 'work');
    const rule = entry('rule', 'policy', { activation: 'bound', ruleEnforcement: 'high',
      ruleSummary: 'Require approval.', bound_to: { [`${type}s`]: ['work'] } });
    const entries = [target, rule];
    const reader = new RelationsReader(buildRelations(entries), new Set([relationId(rule)]));
    const original = structuredClone(entries);
    const discover = () => governingRuleFields(compoundGoverningRules(entries, target, reader));
    const discovered = discover();
    const shown = await showBindings(entries, target, '', { name: 'work' }, async () => '', reader);
    const checks = [{ rule_id: relationId(rule), applicability: [`bound:${type}:${relationId(target)}`],
      fetch_command: `aiwg show rule ${relationId(rule)} --body` }];
    expect(shown.fields.required_rule_checks).toEqual(checks);
    expect(discovered.required_rule_checks).toEqual(checks);
    expect(discovered.bound_rules).toEqual([{ name: 'policy', activation: 'kernel', enforcement: 'high',
      precedence: 'medium', overridable: true, precedence_source: 'rule', project_context: false,
      summary: 'Require approval.', show_command: 'aiwg show rule policy --body' }]);
    expect(discovered.bound_rules).toEqual(shown.fields.bound_rules);
    expect(discovered.rule_stats).toEqual({ by_enforcement: { high: 1 }, by_activation: { kernel: 1 }, required_checks: 1 });
    expect(discover()).toEqual(discovered);
    expect(entries).toEqual(original);
    expect(reader.index.rules[relationId(rule)].activation).toBe('bound');
  });

  it.each(['kernel', 'core'])('retains an explicitly bound %s rule without adding ambient kernel matches', async activation => {
    const target = entry('skill', 'work');
    const bound = entry('rule', 'bound', { activation, bound_to: { skills: ['work'] } });
    const ambient = entry('rule', 'ambient', { activation: 'kernel', triggers: ['work'] });
    const entries = [target, bound, ambient];
    const discovered = governingRuleFields(compoundGoverningRules(entries, target, undefined, 'work'));
    const shown = await showBindings(entries, target, '', { name: 'work' }, async () => '');
    expect(discovered.required_rule_checks).toHaveLength(1);
    expect(discovered.required_rule_checks).toEqual(shown.fields.required_rule_checks);
    expect(discovered.bound_rules).toEqual(shown.fields.bound_rules);
    expect(discovered.bound_rules?.[0].activation).toBe(activation);
  });
});
