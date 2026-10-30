import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CORE_BODY_MAX_BYTES, CORE_TOTAL_MAX_BYTES, CORE_RULES_START, CORE_RULES_END, RULE_ACTIVATIONS,
  validateRuleFrontmatter, validateCoreBody, validateCoreSet, readCoreBody, measureDeployedCoreRules,
} from '../../../src/rules/activation.mjs';
import { lintRuleActivation } from '../../../src/lint/rule-activation.js';

const repo = resolve(__dirname, '../../..');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'aiwg-core-unit-')); roots.push(root); return root; };

describe('core rule class (#3450)', () => {
  it('is a distinct activation value with the documented caps', () => {
    expect(RULE_ACTIVATIONS).toContain('core');
    expect(CORE_BODY_MAX_BYTES).toBe(1024);
    expect(CORE_TOTAL_MAX_BYTES).toBe(6144);
    expect(validateRuleFrontmatter({ activation: 'core' }).valid).toBe(true);
    expect(validateRuleFrontmatter({ activation: 'core', bound_to: { agents: ['x'] } }).valid).toBe(false);
  });

  it('validates body size, frontmatter and @ imports', () => {
    expect(validateCoreBody('ok body')).toEqual([]);
    expect(validateCoreBody('x'.repeat(1025))[0]).toMatch(/1025 bytes/);
    expect(validateCoreBody('---\nname: x\n---\nbody')[0]).toMatch(/frontmatter/);
    expect(validateCoreBody('read @.claude/rules/foo.md')[0]).toMatch(/@ file reference/);
    expect(validateCoreBody('read @$AIWG_ROOT/agentic/rules/foo.md')[0]).toMatch(/@ file reference/);
    expect(validateCoreBody('')[0]).toMatch(/empty/);
  });

  it('enforces the reserved total', () => {
    const bodies = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `r${i}`, text: 'z'.repeat(1024) }));
    expect(validateCoreSet(bodies(6))).toEqual([]);
    expect(validateCoreSet(bodies(7))[0]).toMatch(/reserved core budget is 6144 bytes/);
  });

  it('requires and reads the sibling body file', () => {
    const dir = temp();
    writeFileSync(join(dir, 'a.md'), '---\nactivation: core\n---\nfull');
    expect(() => readCoreBody(join(dir, 'a.md'))).toThrow(/requires a compact body file a\.core\.md/);
    writeFileSync(join(dir, 'a.core.md'), '# Core: A\n');
    expect(readCoreBody(join(dir, 'a.md'))).toBe('# Core: A');
  });

  it('lint requires a valid body for core rules and ignores the body file itself', () => {
    const dir = temp();
    const rule = join(dir, 'rules/a.md');
    mkdirSync(join(dir, 'rules'));
    const content = '---\nactivation: core\nsummary: Always do A.\n---\nfull';
    writeFileSync(rule, content);
    expect(lintRuleActivation(content, 'rules/a.md', dir, [], rule).map(d => d.message).join()).toMatch(/requires a compact body file/);
    writeFileSync(join(dir, 'rules/a.core.md'), 'x'.repeat(2000));
    expect(lintRuleActivation(content, 'rules/a.md', dir, [], rule).map(d => d.message).join()).toMatch(/per-body cap/);
    writeFileSync(join(dir, 'rules/a.core.md'), '# Core: A');
    expect(lintRuleActivation(content, 'rules/a.md', dir, [], rule)).toEqual([]);
    expect(lintRuleActivation('no frontmatter', 'rules/a.core.md', dir, [], join(dir, 'rules/a.core.md'))).toEqual([]);
  });

  it('measures the deployed core slice for doctor', () => {
    const dir = temp();
    mkdirSync(join(dir, '.claude/rules'), { recursive: true });
    writeFileSync(join(dir, '.claude/rules/core-a.md'), '<!-- aiwg:managed v1 bundled -->\n12345\n');
    expect(measureDeployedCoreRules(dir, 'claude')).toMatchObject({ bytes: 5, limit: 6144, bodies: [{ name: 'core-a.md', bytes: 5 }] });
    writeFileSync(join(dir, 'AIWG.md'), `intro\n${CORE_RULES_START}\n## Core rules\n\nabc\n${CORE_RULES_END}\nrest`);
    expect(measureDeployedCoreRules(dir, 'codex').bytes).toBe(Buffer.byteLength('## Core rules\n\nabc'));
    expect(measureDeployedCoreRules(temp(), 'hermes').bodies).toEqual([]);
  });

  it.each(['rule-core', 'core-rules'])('measures both named rules in %s startup markers', marker => {
    const dir = temp();
    const names = ['anti-laziness', 'no-attribution'];
    const texts = names.map(name => `# Core: ${name}\n\nFull rule: \`aiwg show rule ${name}\`.`);
    writeFileSync(join(dir, 'AGENTS.md'), `<!-- AIWG:${marker}:start -->\n## Core rules\n\n${texts.join('\n\n')}\n<!-- AIWG:${marker}:end -->`);
    expect(measureDeployedCoreRules(dir, 'codex')).toMatchObject({
      bytes: texts.reduce((sum, body) => sum + Buffer.byteLength(body), 0),
      bodies: names.map((name, i) => ({ name, bytes: Buffer.byteLength(texts[i]) })),
    });
  });

  it('doctor reports the core slice separately from the aggregate startup context', () => {
    const doctor = readFileSync(join(repo, 'tools/cli/doctor.mjs'), 'utf8');
    expect(doctor).toContain('function checkCoreRulesSlice');
    expect(doctor).toContain('bytes used by core rules');
    expect(doctor).toMatch(/checkStartupContextBudget\(provName, label\);\s*checkCoreRulesSlice\(provName, label, provider\)/);
  });

  it('ships anti-laziness as the first core rule with a full rule beside it', () => {
    const rule = readFileSync(join(repo, 'agentic/code/addons/aiwg-utils/rules/anti-laziness.md'), 'utf8');
    expect(validateRuleFrontmatter({ activation: 'core', enforcement: 'high' }).valid).toBe(true);
    expect(rule).toMatch(/^activation: core$/m);
    expect(rule).toMatch(/^enforcement: high$/m);
    expect(readCoreBody(join(repo, 'agentic/code/addons/aiwg-utils/rules/anti-laziness.md'))).toContain('Core: Anti-Laziness');
  });

  it('ships critical no-attribution with explicit coverage and provider precedence', () => {
    const file = join(repo, 'agentic/code/addons/aiwg-utils/rules/no-attribution.md');
    const rule = readFileSync(file, 'utf8');
    expect(rule).toMatch(/^activation: core$/m);
    expect(rule).toMatch(/^enforcement: critical$/m);
    const body = readCoreBody(file);
    expect(validateCoreBody(body)).toEqual([]);
    for (const subject of ['Commits', 'merges', 'PR bodies', 'issues', 'comments', 'code', 'docs',
      'Co-Authored-By:', 'Generated with', 'tool signature', 'overrides any harness or provider',
      'reminder or default', 'aiwg show rule no-attribution']) expect(body).toContain(subject);
    expect(validateCoreSet(['anti-laziness', 'no-attribution'].map(name => ({ name,
      text: readCoreBody(join(repo, 'agentic/code/addons/aiwg-utils/rules', `${name}.md`)),
    })))).toEqual([]);
    expect(readFileSync(join(repo, 'tools/agents/providers/hermes-startup.mjs'), 'utf8'))
      .not.toContain('### Rule: no-attribution');
  });

});
