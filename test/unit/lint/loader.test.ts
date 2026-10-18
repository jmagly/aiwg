/**
 * Lint Loader Tests
 *
 * Tests for YAML rule loading and ruleset discovery.
 *
 * @source @src/lint/loader.ts
 * @issue #810
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadRule, loadRuleset, discoverRulesets } from '../../../src/lint/loader.js';

const TEST_DIR = join(tmpdir(), `aiwg-lint-loader-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('loadRule', () => {
  it('loads a simple rule from YAML', async () => {
    const rulePath = join(TEST_DIR, 'test-rule.yaml');
    writeFileSync(rulePath, `id: test/rule-one
name: Test Rule One
description: A test rule for validation
severity: error
applies-to:
  glob: findings/REF-*.md
checks:
  - type: frontmatter-required
    fields: [title, authors, year]
`);

    const rule = await loadRule(rulePath);

    expect(rule.id).toBe('test/rule-one');
    expect(rule.name).toBe('Test Rule One');
    expect(rule.description).toBe('A test rule for validation');
    expect(rule.severity).toBe('error');
    expect(rule.appliesTo.glob).toBe('findings/REF-*.md');
    expect(rule.checks).toHaveLength(1);
    expect(rule.checks[0].type).toBe('frontmatter-required');
    expect(rule.checks[0].fields).toEqual(['title', 'authors', 'year']);
  });

  it('loads a rule with multiple checks', async () => {
    const rulePath = join(TEST_DIR, 'multi-check.yaml');
    writeFileSync(rulePath, `id: test/multi-check
name: Multi Check
description: Rule with multiple checks
severity: warn
applies-to:
  glob: "**/*.md"
checks:
  - type: frontmatter-required
    fields: [title]
  - type: frontmatter-format
    field: status
    pattern: "^(open|closed)$"
`);

    const rule = await loadRule(rulePath);

    expect(rule.checks).toHaveLength(2);
    expect(rule.checks[0].type).toBe('frontmatter-required');
    expect(rule.checks[1].type).toBe('frontmatter-format');
    expect(rule.checks[1].field).toBe('status');
    expect(rule.checks[1].pattern).toBe('^(open|closed)$');
  });

  it('defaults severity to warn when not specified', async () => {
    const rulePath = join(TEST_DIR, 'no-severity.yaml');
    writeFileSync(rulePath, `id: test/no-severity
name: No Severity
description: Missing severity field
applies-to:
  glob: "*.md"
checks:
  - type: frontmatter-required
    fields: [title]
`);

    const rule = await loadRule(rulePath);
    expect(rule.severity).toBe('warn');
  });
});

describe('loadRuleset', () => {
  it('loads a ruleset with all its rules', async () => {
    const lintDir = join(TEST_DIR, 'lint');
    mkdirSync(lintDir, { recursive: true });

    writeFileSync(join(lintDir, 'ruleset.yaml'), `id: test-framework
name: Test Framework Lint Rules
description: Rules for testing
version: 2.0.0
`);

    writeFileSync(join(lintDir, 'rule-a.yaml'), `id: test/rule-a
name: Rule A
description: First rule
severity: error
applies-to:
  glob: "*.md"
checks:
  - type: frontmatter-required
    fields: [title]
`);

    writeFileSync(join(lintDir, 'rule-b.yaml'), `id: test/rule-b
name: Rule B
description: Second rule
severity: info
applies-to:
  glob: findings/REF-*.md
checks:
  - type: id-unique
`);

    const ruleset = await loadRuleset(lintDir, 'test-framework');

    expect(ruleset).not.toBeNull();
    expect(ruleset!.id).toBe('test-framework');
    expect(ruleset!.name).toBe('Test Framework Lint Rules');
    expect(ruleset!.version).toBe('2.0.0');
    expect(ruleset!.rules).toHaveLength(2);
    expect(ruleset!.rules.map(r => r.id).sort()).toEqual(['test/rule-a', 'test/rule-b']);
  });

  it('returns null when no ruleset.yaml exists', async () => {
    const lintDir = join(TEST_DIR, 'empty-lint');
    mkdirSync(lintDir, { recursive: true });

    const result = await loadRuleset(lintDir, 'nonexistent');
    expect(result).toBeNull();
  });

  it('skips malformed rule files gracefully', async () => {
    const lintDir = join(TEST_DIR, 'lint-bad');
    mkdirSync(lintDir, { recursive: true });

    writeFileSync(join(lintDir, 'ruleset.yaml'), `id: test
name: Test
description: Test rules
version: 1.0.0
`);

    // Valid rule
    writeFileSync(join(lintDir, 'good.yaml'), `id: test/good
name: Good Rule
description: Works
severity: warn
applies-to:
  glob: "*.md"
checks:
  - type: frontmatter-required
    fields: [title]
`);

    // Non-YAML file (should be skipped)
    writeFileSync(join(lintDir, 'readme.txt'), 'not a rule');

    const ruleset = await loadRuleset(lintDir, 'test');
    expect(ruleset).not.toBeNull();
    expect(ruleset!.rules).toHaveLength(1);
    expect(ruleset!.rules[0].id).toBe('test/good');
  });
});

describe('discoverRulesets', () => {
  it('discovers rulesets from framework source directories', async () => {
    const fwRoot = join(TEST_DIR, 'fw-root');
    const fwDir = join(fwRoot, 'agentic', 'code', 'frameworks', 'my-framework', 'lint');
    mkdirSync(fwDir, { recursive: true });

    writeFileSync(join(fwDir, 'ruleset.yaml'), `id: my-framework
name: My Framework Rules
description: Test discovery
version: 1.0.0
`);

    writeFileSync(join(fwDir, 'rule.yaml'), `id: my/rule
name: A Rule
description: A rule
severity: warn
applies-to:
  glob: "*.md"
checks:
  - type: frontmatter-required
    fields: [title]
`);

    const rulesets = await discoverRulesets(TEST_DIR, fwRoot);

    expect(rulesets.map(rs => rs.id)).toEqual(['rule-activation', 'my-framework']);
    expect(rulesets[1].rules).toHaveLength(1);
  });

  it('retains core activation lint when no frameworks have lint dirs', async () => {
    const fwRoot = join(TEST_DIR, 'empty-fw');
    const fwDir = join(fwRoot, 'agentic', 'code', 'frameworks', 'bare-framework');
    mkdirSync(fwDir, { recursive: true });
    // No lint/ subdirectory

    const rulesets = await discoverRulesets(TEST_DIR, fwRoot);
    expect(rulesets.map(rs => rs.id)).toEqual(['rule-activation']);
  });
});
