import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { parseRuleFrontmatter, validateRuleFrontmatter, ruleFrontmatterSchema, inferRuleActivation } from '../../../src/rules/activation.mjs';

const summary = 'Fix the canonical source before regenerating output.';

describe('shared rule activation contract (#2938)', () => {
  it.each(['kernel', 'summary', 'bound', 'paths', 'on-demand'])('accepts %s independently of enforcement', activation => {
    const data = { activation, enforcement: 'critical', summary,
      ...(activation === 'bound' ? { bound_to: { agents: ['debugger'] } } : {}),
      ...(activation === 'paths' ? { paths: ['src/**', '{tools,dist}/**'], bound_to: { skills: ['fix-source'] } } : {}),
    };
    expect(validateRuleFrontmatter(data).valid).toBe(true);
  });
  it.each(['alwaysApply', 'bound + paths', ['kernel'], '', null, 1])('rejects explicit invalid mode %j without fallback', activation => {
    const result = validateRuleFrontmatter({ activation });
    expect(result.valid).toBe(false);
    expect(result.rule).toBeUndefined();
    expect(result.diagnostics.some(d => d.code === 'missing-activation')).toBe(false);
  });
  it.each(['critical', 'high', 'block', 'unknown', undefined, 'MEDIUM', 'low'])('infers migration delivery for %j', enforcement => {
    const result = validateRuleFrontmatter({ enforcement, paths: ['legacy/**'], scope: 'descriptive' });
    expect(result.rule?.activation).toBe(inferRuleActivation(enforcement));
    expect(result.rule?.tagged).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warn', message: expect.stringContaining(inferRuleActivation(enforcement)) }));
  });
  it('counts trimmed Unicode code points, including astral characters', () => {
    expect(validateRuleFrontmatter({ activation: 'summary', summary: `  ${'🦊'.repeat(240)}  ` }).rule?.summary).toBe('🦊'.repeat(240));
    expect(validateRuleFrontmatter({ activation: 'summary', summary: '🦊'.repeat(241) }).valid).toBe(false);
  });
  it.each(['', '  ', 'Do this\nthen that', 'Do this\rthen that', 'Do this\u2028then that', 42])('rejects invalid summaries %j', value => {
    expect(validateRuleFrontmatter({ activation: 'summary', summary: value }).valid).toBe(false);
  });
  it.each(['summary', 'bound', 'paths'])('requires an authored summary for %s', activation => {
    expect(validateRuleFrontmatter({ activation, paths: ['src/**'], bound_to: { agents: ['debugger'] } }).valid).toBe(false);
  });
  it.each([
    { activation: 'bound', summary },
    { activation: 'bound', summary, bound_to: {} },
    { activation: 'bound', summary, bound_to: { skills: [] } },
    { activation: 'kernel', bound_to: {} },
    { activation: 'on-demand', bound_to: { agents: ['debugger'] } },
    { activation: 'summary', summary, paths: ['src/**'] },
    { activation: 'bound', summary, bound_to: { agents: ['debugger'] }, paths: ['src/**'] },
    { activation: 'paths', summary },
    { activation: 'paths', summary, paths: [] },
  ])('rejects contradictory or incomplete mode %j', data => {
    expect(validateRuleFrontmatter(data).valid).toBe(false);
  });
  it.each([{ skill: ['fix'] }, { agents: 'debugger' }, { agents: [''] }, { flows: ['flow-*'] }, { agents: ['../debugger'] }])('rejects malformed bindings %j', bound_to => {
    expect(validateRuleFrontmatter({ activation: 'bound', summary, bound_to }).valid).toBe(false);
  });
  it('accepts canonical namespaces and leaves identity deduplication to delivery', () => {
    expect(validateRuleFrontmatter({ activation: 'bound', summary, bound_to: { agents: ['aiwg:agent:abc', 'aiwg:agent:abc'] } }).valid).toBe(true);
  });
  it.each(['/etc/**', '../src/**', 'src/../**', 'C:/src/**', '\\server\\share', 'src\\**', '', '  '])('rejects unsafe glob %j', glob => {
    expect(validateRuleFrontmatter({ activation: 'paths', summary, paths: [glob] }).valid).toBe(false);
  });
  it.each([null, false, 'hook', [], { arbitrary: { payload: true } }])('preserves opaque enforcedBy %j without effect', enforcedBy => {
    const result = validateRuleFrontmatter({ activation: 'kernel', enforcedBy });
    expect(result.rule?.enforcedBy).toEqual(enforcedBy);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ severity: 'info', code: 'reserved-enforcedBy' }));
  });
  it('parses nested YAML, preserves body and metadata, normalizes missing binding lists', () => {
    const result = parseRuleFrontmatter('---\r\nactivation: bound\r\nsummary: Fix the source.\r\nbound_to:\r\n  agents: [debugger]\r\nlegacy: preserved\r\n---\r\n# Body\r\n');
    expect(result.rule).toMatchObject({ activation: 'bound', bound_to: { skills: [], agents: ['debugger'], flows: [] }, legacy: 'preserved' });
    expect(result.body).toBe('# Body\r\n');
  });
  it.each(['---\nactivation: [\n---\nBody', '---\nactivation: kernel\nactivation: summary\n---\nBody', '---\n- kernel\n---\nBody', '---\nactivation: kernel'])('fails malformed YAML/frontmatter %j', source => {
    expect(parseRuleFrontmatter(source).valid).toBe(false);
  });
  it('preserves leading body whitespace and treats empty frontmatter as untagged', () => {
    const result = parseRuleFrontmatter('---\n---\n\n  Body\n');
    expect(result.body).toBe('\n  Body\n');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'missing-activation' }));
  });
  it('handles missing frontmatter with an explicit migration warning', () => {
    expect(parseRuleFrontmatter('# Rule').rule?.activation).toBe('kernel');
  });
  it('strictly compiles the registered schema, and the schema requires explicit activation', () => {
    const validate = new Ajv({ strict: true }).compile(ruleFrontmatterSchema);
    expect(validate({ activation: 'kernel' })).toBe(true);
    expect(validate({})).toBe(false);
  });
});
