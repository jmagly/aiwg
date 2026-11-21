import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolve } from 'path';
import { readFileSync, existsSync } from 'fs';
import { sourceRules } from './rule-source-expectations.js';
import { execFileSync } from 'child_process';

// @ts-expect-error — .mjs provider module without type declarations
import {
  ruleEnforcementLevel,
  isAlwaysOnRule,
  writeOnDemandRuleIndex,
  getAddonRuleFiles,
  collectFrameworkArtifacts,
  listOnDemandRuleFiles,
  onDemandRuleNames,
  renderOnDemandRuleSection,
  interpolateContextTokens,
  applyInlineRuleBudget,
  resolveRulesInlineBudgetTokens,
  DEFAULT_RULES_INLINE_BUDGET_TOKENS,
  reconcileInlineRuleBudget,
  readRuleBudgetSidecar,
  RULE_BUDGET_SIDECAR,
} from '../../../tools/agents/providers/base.mjs';
// @ts-expect-error — .mjs provider module without type declarations
import { generateAgentsMd as hermesAgentsMd } from '../../../tools/agents/providers/hermes.mjs';
// @ts-expect-error — .mjs provider module without type declarations
import { createAgentsMd as openhumanAgentsMd } from '../../../tools/agents/providers/openhuman.mjs';

const REPO_ROOT = resolve(__dirname, '../../..');
const levelOf = (f: string): string | null => ruleEnforcementLevel(readFileSync(f, 'utf8'));
const corpusRules = ['addons', 'frameworks', 'extensions'].flatMap(kind =>
  sourceRules(REPO_ROOT, kind as 'addons' | 'frameworks' | 'extensions'));
const legacyOnDemandNames = [...new Set(corpusRules.filter(rule => rule.legacyOnDemand).map(rule => rule.name))].sort();
const migratedTierNames = corpusRules.filter(rule => !rule.structural && rule.data.activation !== undefined).map(rule => rule.name);
const expectFallbackSection = (body: string, heading = 'On-Demand Rules') => {
  expect([...body.matchAll(/^- `([^`]+)` — `aiwg show rule /gm)].map(match => match[1])).toEqual(legacyOnDemandNames);
  if (legacyOnDemandNames.length) {
    expect(body).toContain(heading);
    expect(body).toContain('aiwg show rule ');
  } else expect(body).not.toContain(heading);
};

// `tmpFile()`'s directories were never removed (#3018), leaking one per call; module-level so
// it covers every describe block in this file, not just the ones that already track their own.
const fileRoots: string[] = [];
afterEach(async () => {
  await Promise.all(fileRoots.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tmpFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aiwg-tier-'));
  fileRoots.push(dir);
  const p = join(dir, name);
  await writeFile(p, content);
  return p;
}

describe('rule tier deployment (#1673)', () => {
  describe('ruleEnforcementLevel', () => {
    it('reads the enforcement frontmatter field (lowercased)', () => {
      expect(ruleEnforcementLevel('---\nenforcement: HIGH\n---\n# X')).toBe('high');
      expect(ruleEnforcementLevel('---\nname: y\nenforcement: medium\n---\n')).toBe('medium');
    });
    it('returns null when there is no frontmatter or no field', () => {
      expect(ruleEnforcementLevel('# No frontmatter')).toBeNull();
      expect(ruleEnforcementLevel('---\nname: y\n---\n')).toBeNull();
    });
  });

  describe('isAlwaysOnRule', () => {
    it('keeps explicitly activated CRITICAL and HIGH kernel rules always-on', async () => {
      expect(isAlwaysOnRule(await tmpFile('a.md', '---\nactivation: kernel\nenforcement: critical\n---\n'))).toBe(true);
      expect(isAlwaysOnRule(await tmpFile('b.md', '---\nactivation: kernel\nenforcement: high\n---\n'))).toBe(true);
    });
    it('routes MEDIUM and LOW rules off the always-on set', async () => {
      expect(isAlwaysOnRule(await tmpFile('c.md', '---\nenforcement: medium\n---\n'))).toBe(false);
      expect(isAlwaysOnRule(await tmpFile('d.md', '---\nenforcement: low\n---\n'))).toBe(false);
    });
    it('keeps unlabelled rules on demand and structural indexes always-on', async () => {
      expect(isAlwaysOnRule(await tmpFile('e.md', '# no level'))).toBe(false);
      expect(isAlwaysOnRule(await tmpFile('RULES-INDEX.md', '---\nenforcement: medium\n---\n'))).toBe(true);
      expect(isAlwaysOnRule(await tmpFile('RULES-ONDEMAND.md', '---\nenforcement: medium\n---\n'))).toBe(true);
    });
  });

  describe('writeOnDemandRuleIndex', () => {
    it('writes a managed index listing the on-demand rules with fetch hints', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'aiwg-od-'));
      fileRoots.push(dir);
      await mkdir(dir, { recursive: true });
      const n = writeOnDemandRuleIndex(dir, [join('x', 'diagram-generation.md'), join('y', 'activity-log.md')], {});
      expect(n).toBe(2);
      const body = await readFile(join(dir, 'RULES-ONDEMAND.md'), 'utf8');
      expect(body).toContain('aiwg:managed');
      expect(body).toContain('On-Demand Rules');
      expect(body).toContain('aiwg show rule diagram-generation');
      expect(body).toContain('aiwg show rule activity-log');
    });

    it('removes a stale index when there are no on-demand rules', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'aiwg-od-'));
      fileRoots.push(dir);
      await writeFile(join(dir, 'RULES-ONDEMAND.md'), 'stale');
      const n = writeOnDemandRuleIndex(dir, [], {});
      expect(n).toBe(0);
      await expect(access(join(dir, 'RULES-ONDEMAND.md'))).rejects.toThrow();
    });

    it('honors dry-run (no write)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'aiwg-od-'));
      writeOnDemandRuleIndex(dir, [join('x', 'foo.md')], { dryRun: true });
      await expect(access(join(dir, 'RULES-ONDEMAND.md'))).rejects.toThrow();
      await rm(dir, { recursive: true, force: true });
    });
  });

  // ADR 50–61, 265–272: preserve the exact file-delivery set, including
  // native paths at any severity; summaries/bindings never become full bodies.
  describe('deploy enumerators on real source', () => {
    it('getAddonRuleFiles yields activation-selected bodies and structural indexes', () => {
      const expected = sourceRules(REPO_ROOT, 'addons')
        .filter(rule => (!rule.consolidated || !rule.structural && rule.data.activation !== undefined) && rule.fileDelivered)
        .map(rule => rule.file).sort();
      expect(getAddonRuleFiles(REPO_ROOT).sort()).toEqual(expected);
    });

    it('collectFrameworkArtifacts rules yield activation-selected bodies and structural indexes', () => {
      const expected = sourceRules(REPO_ROOT, 'frameworks').filter(rule => rule.fileDelivered).map(rule => rule.file).sort();
      const arts = collectFrameworkArtifacts(REPO_ROOT, 'all', { includeRules: true });
      expect(arts.rules.sort()).toEqual(expected);
    });

    it('listOnDemandRuleFiles surfaces exactly the untagged medium/low fallback', () => {
      const od: string[] = listOnDemandRuleFiles(REPO_ROOT);
      // every entry is genuinely medium/low
      expect(od.every((f) => ['medium', 'low'].includes(levelOf(f) as string))).toBe(true);
      expect(onDemandRuleNames(od)).toEqual(legacyOnDemandNames);
      for (const name of migratedTierNames) expect(onDemandRuleNames(od)).not.toContain(name);
    });

    it('listOnDemandRuleFiles stays complete when called from bundled addon or extension sources (#1784)', () => {
      const rootNames = onDemandRuleNames(listOnDemandRuleFiles(REPO_ROOT));
      const addonNames = onDemandRuleNames(
        listOnDemandRuleFiles(join(REPO_ROOT, 'agentic/code/addons/aiwg-utils')),
      );
      const extensionNames = onDemandRuleNames(
        listOnDemandRuleFiles(join(REPO_ROOT, 'agentic/code/extensions/sys')),
      );

      expect(addonNames).toEqual(rootNames);
      expect(extensionNames).toEqual(rootNames);

      expect(rootNames).toEqual(legacyOnDemandNames);
      for (const name of migratedTierNames) expect(addonNames).not.toContain(name);
    });
  });
});

// ---------------------------------------------------------------------------
// #1675 — on-demand index/section propagation across non-Claude providers
// ---------------------------------------------------------------------------
describe('on-demand index propagation (#1675)', () => {
  const od = ['x/zeta.md', 'a/alpha.md', 'a/alpha.md', 'm/beta.md'];

  describe('onDemandRuleNames', () => {
    it('sorts and de-duplicates basenames (sans .md)', () => {
      expect(onDemandRuleNames(od)).toEqual(['alpha', 'beta', 'zeta']);
    });
    it('drops excluded names', () => {
      expect(onDemandRuleNames(od, ['alpha'])).toEqual(['beta', 'zeta']);
    });
    it('returns [] for empty input', () => {
      expect(onDemandRuleNames([])).toEqual([]);
      expect(onDemandRuleNames(undefined)).toEqual([]);
    });
  });

  describe('renderOnDemandRuleSection', () => {
    it('renders an H2 heading, fetch fence, and one bullet per rule', () => {
      const s = renderOnDemandRuleSection(od);
      expect(s).toContain('## On-Demand Rules');
      expect(s).toContain('```bash\naiwg show rule <name> --body\n```');
      expect(s).toContain('- `alpha` — `aiwg show rule alpha --body`');
      expect((s.match(/^- /gm) || []).length).toBe(3);
    });
    it('honors a custom heading level', () => {
      expect(renderOnDemandRuleSection(od, { heading: '### On-Demand Rules' })).toContain(
        '### On-Demand Rules',
      );
    });
    it('returns empty string when nothing remains after exclusion', () => {
      expect(renderOnDemandRuleSection(od, { exclude: ['alpha', 'beta', 'zeta'] })).toBe('');
      expect(renderOnDemandRuleSection([])).toBe('');
    });
  });

  describe('interpolateContextTokens', () => {
    it('substitutes the {{ON_DEMAND_RULES}} token', () => {
      const out = interpolateContextTokens('before\n{{ON_DEMAND_RULES}}\nafter', {
        onDemandRules: '## On-Demand Rules\n- `r` — `aiwg show rule r --body`',
      });
      expect(out).toContain('## On-Demand Rules');
      expect(out).not.toContain('{{ON_DEMAND_RULES}}');
    });
    it('clears the token when no on-demand rules are supplied', () => {
      expect(interpolateContextTokens('a{{ON_DEMAND_RULES}}b', {})).toBe('ab');
    });
  });

  // Source-wiring guard: every file-based provider must call the on-demand
  // index writer after deploying rules. Cheap regression guard against someone
  // dropping the wiring during a refactor.
  describe('file-based provider wiring', () => {
    const PROVIDERS = ['codex', 'factory', 'cursor', 'copilot', 'opencode', 'devin', 'openclaw'];
    for (const p of PROVIDERS) {
      it(`${p}.mjs imports and calls writeOnDemandRuleIndex`, () => {
        const src = readFileSync(
          resolve(REPO_ROOT, 'tools/agents/providers', `${p === 'devin' ? 'windsurf' : p}.mjs`),
          'utf8',
        );
        expect(src).toContain('writeOnDemandRuleIndex');
        expect(src).toContain('listOnDemandRuleFiles');
      });
    }
  });

  // End-to-end: deploy rules-only to a temp target via the real CLI and assert
  // each provider's rule dir gets a populated RULES-ONDEMAND.md whose count
  // matches the on-demand enumerator. Two providers with different rule dirs
  // (.codex/rules vs .github/instructions) catch path mistakes.
  describe('end-to-end RULES-ONDEMAND.md emission', () => {
    const expectedCount = onDemandRuleNames(listOnDemandRuleFiles(REPO_ROOT)).length;
    const CASES: Array<[string, string]> = [
      ['codex', '.codex/rules'],
      ['copilot', '.github/instructions'],
    ];
    for (const [provider, ruleDir] of CASES) {
      it(`${provider} writes RULES-ONDEMAND.md with ${expectedCount} entries`, async () => {
        const target = await mkdtemp(join(tmpdir(), `aiwg-od-${provider}-`));
        fileRoots.push(target);
        execFileSync(
          'node',
          [
            'tools/agents/deploy-agents.mjs',
            '--source', REPO_ROOT,
            '--target', target,
            '--rules-only', '--mode', 'all',
            '--provider', provider, '--force',
          ],
          { timeout: 60_000, cwd: REPO_ROOT, stdio: 'ignore' },
        );
        const indexPath = join(target, ruleDir, 'RULES-ONDEMAND.md');
        if (expectedCount === 0) {
          expect(existsSync(indexPath)).toBe(false);
          return;
        }
        expect(existsSync(indexPath)).toBe(true);
        const body = await readFile(indexPath, 'utf8');
        expect((body.match(/^- /gm) || []).length).toBe(expectedCount);
        expect(body).toContain('aiwg show rule ');
        await rm(target, { recursive: true, force: true });
      }, 60_000);
    }

    it('keeps the complete index after an aiwg-use-all-style addon pass (#1784)', async () => {
      const target = await mkdtemp(join(tmpdir(), 'aiwg-od-multipass-'));
      fileRoots.push(target);
      const expected = onDemandRuleNames(listOnDemandRuleFiles(REPO_ROOT));

      execFileSync(
        'node',
        [
          'tools/agents/deploy-agents.mjs',
          '--source', REPO_ROOT,
          '--target', target,
          '--rules-only', '--mode', 'all',
          '--provider', 'codex', '--force',
        ],
        { timeout: 60_000, cwd: REPO_ROOT, stdio: 'ignore' },
      );
      execFileSync(
        'node',
        [
          'tools/agents/deploy-agents.mjs',
          '--source', join(REPO_ROOT, 'agentic/code/addons/aiwg-utils'),
          '--target', target,
          '--deploy-rules',
          '--provider', 'codex', '--force',
        ],
        { timeout: 60_000, cwd: REPO_ROOT, stdio: 'ignore' },
      );

      // ADR 61, 265–272: once no legacy tier remains, remove its startup
      // listing rather than retaining stale entries from earlier passes.
      const indexPath = join(target, '.codex/rules/RULES-ONDEMAND.md');
      if (legacyOnDemandNames.length === 0) {
        expect(existsSync(indexPath)).toBe(false);
        return;
      }
      const body = await readFile(indexPath, 'utf8');
      const actual = [...body.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1]).sort();
      expect(actual).toEqual(expected);

      expect(actual).toEqual(legacyOnDemandNames);
      for (const name of migratedTierNames) expect(actual).not.toContain(name);

      await rm(target, { recursive: true, force: true });
    }, 60_000);
  });

  // Aggregated providers note the tier in their single bridge file.
  describe('aggregated provider bridge sections', () => {
    it('hermes generateAgentsMd embeds the on-demand section under cap', async () => {
      const target = await mkdtemp(join(tmpdir(), 'aiwg-od-hermes-'));
      hermesAgentsMd(58, 20, target, { srcRoot: REPO_ROOT, dryRun: false });
      const body = await readFile(join(target, 'AGENTS.md'), 'utf8');
      expectFallbackSection(body);
      expect(body.length).toBeLessThan(19_000); // Hermes hard cap
      await rm(target, { recursive: true, force: true });
    });

    it('openhuman AGENTS.md substitutes the {{ON_DEMAND_RULES}} token (#1785)', async () => {
      const target = await mkdtemp(join(tmpdir(), 'aiwg-od-openhuman-'));
      openhumanAgentsMd(target, REPO_ROOT, false);
      const body = await readFile(join(target, 'AGENTS.md'), 'utf8');
      expectFallbackSection(body);
      expect([...body.matchAll(/^- `([^`]+)` — `aiwg show rule /gm)].map(match => match[1])).toEqual(legacyOnDemandNames);
      for (const name of migratedTierNames) expect(body).not.toContain(`- \`${name}\` — \`aiwg show rule `);
      expect(body).not.toContain('{{ON_DEMAND_RULES}}');

      openhumanAgentsMd(target, join(REPO_ROOT, 'agentic/code/addons/aiwg-utils'), false);
      const addonPassBody = await readFile(join(target, 'AGENTS.md'), 'utf8');
      expectFallbackSection(addonPassBody);
      expect([...addonPassBody.matchAll(/^- `([^`]+)` — `aiwg show rule /gm)].map(match => match[1])).toEqual(legacyOnDemandNames);
      for (const name of migratedTierNames) expect(addonPassBody).not.toContain(`- \`${name}\` — \`aiwg show rule `);
      expect(addonPassBody).not.toContain('{{ON_DEMAND_RULES}}');

      await rm(target, { recursive: true, force: true });
    });

    it('openhuman deploy creates the AGENTS.md bridge on a full deploy (#1785)', async () => {
      const target = await mkdtemp(join(tmpdir(), 'aiwg-od-openhuman-deploy-'));
      execFileSync(
        'node',
        [
          'tools/agents/deploy-agents.mjs',
          '--source', REPO_ROOT,
          '--target', target,
          '--mode', 'sdlc',
          '--provider', 'openhuman',
          '--force',
          '--quiet',
        ],
        { timeout: 60_000, cwd: REPO_ROOT, stdio: 'ignore' },
      );
      const body = await readFile(join(target, 'AGENTS.md'), 'utf8');
      expect(body).toContain('OpenHuman');
      expectFallbackSection(body);
      expect(body).not.toContain('{{ON_DEMAND_RULES}}');
      await rm(target, { recursive: true, force: true });
    }, 60_000);

    it('warp WARP.md aggregates the on-demand section', async () => {
      const target = await mkdtemp(join(tmpdir(), 'aiwg-od-warp-'));
      execFileSync(
        'node',
        ['tools/warp/setup-warp.mjs', '--source', REPO_ROOT, '--target', target, '--mode', 'all', '--force'],
        { timeout: 60_000, cwd: REPO_ROOT, stdio: 'ignore' },
      );
      const body = await readFile(join(target, 'WARP.md'), 'utf8');
      expectFallbackSection(body, '## On-Demand Rules');
      await rm(target, { recursive: true, force: true });
    }, 60_000);
  });
});

describe('inline rule budget (#2562)', () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function ruleFile(root: string, name: string, level: string | null, bytes: number, inBody = false) {
    const header = level === null ? '' : inBody ? `# ${name}\n\n**Enforcement Level**: ${level.toUpperCase()}\n` : `---\nenforcement: ${level}\n---\n`;
    const file = join(root, `${name}.md`);
    await writeFile(file, header + 'x'.repeat(bytes));
    return file;
  }

  it('reads the enforcement level from the body header when frontmatter is absent', async () => {
    expect(ruleEnforcementLevel('# Ops\n\n**Enforcement Level**: CRITICAL\n')).toBe('critical');
    expect(ruleEnforcementLevel('---\nenforcement: high\n---\n**Enforcement Level**: LOW\n')).toBe('high');
  });

  it('defaults to 64K tokens and honors the environment override', () => {
    expect(resolveRulesInlineBudgetTokens({})).toBe(DEFAULT_RULES_INLINE_BUDGET_TOKENS);
    expect(resolveRulesInlineBudgetTokens({ AIWG_RULES_INLINE_BUDGET_TOKENS: '10000' })).toBe(10_000);
    expect(resolveRulesInlineBudgetTokens({ AIWG_RULES_INLINE_BUDGET_TOKENS: '0' })).toBe(0);
    expect(() => resolveRulesInlineBudgetTokens({ AIWG_RULES_INLINE_BUDGET_TOKENS: 'nope' })).toThrow('non-negative safe integer');
  });

  it('keeps every rule inline when the set fits the budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-rule-budget-'));
    roots.push(root);
    const files = [await ruleFile(root, 'a', 'high', 400), await ruleFile(root, 'b', 'critical', 400)];
    const result = applyInlineRuleBudget(files, 1_000);
    expect(result.inline).toEqual(files);
    expect(result.demoted).toEqual([]);
  });

  it('keeps all activation-selected rules even when the budget is exceeded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-rule-budget-'));
    roots.push(root);
    const critical = await ruleFile(root, 'critical-big', 'critical', 4_000, true);
    const highBig = await ruleFile(root, 'high-big', 'high', 4_000);
    const highSmall = await ruleFile(root, 'high-small', 'high', 400);
    const unlabelled = await ruleFile(root, 'unlabelled', null, 400);
    const index = join(root, 'RULES-INDEX.md');
    await writeFile(index, '# index\n' + 'y'.repeat(4_000));
    // 5 files ≈ 3.2K tokens; a 2.3K budget forces exactly one demotion — the largest HIGH.
    const result = applyInlineRuleBudget([critical, highBig, highSmall, unlabelled, index], 2_300);
    expect(result.demoted).toEqual([]);
    expect(result.inline).toEqual([critical, highBig, highSmall, unlabelled, index]);
  });

  it('preserves HIGH, unlabelled and CRITICAL rules when over budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-rule-budget-'));
    roots.push(root);
    const critical = await ruleFile(root, 'critical', 'critical', 8_000);
    const high = await ruleFile(root, 'high', 'high', 400);
    const unlabelled = await ruleFile(root, 'unlabelled', null, 4_000);
    const result = applyInlineRuleBudget([critical, high, unlabelled], 1_000);
    expect(result.demoted).toEqual([]);
    expect(result.inline).toEqual([critical, high, unlabelled]);
  });

  it('is disabled when the budget is zero', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-rule-budget-'));
    roots.push(root);
    const files = [await ruleFile(root, 'a', 'high', 40_000)];
    expect(applyInlineRuleBudget(files, 0)).toEqual({ inline: files, demoted: [] });
  });

  it('lists demoted HIGH rules in RULES-ONDEMAND.md under their own heading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-rule-budget-'));
    roots.push(root);
    const dest = join(root, '.claude', 'rules');
    await mkdir(dest, { recursive: true });
    const medium = await ruleFile(root, 'activity-log', 'medium', 10);
    const demoted = await ruleFile(root, 'ops-safety', 'high', 10);
    const count = writeOnDemandRuleIndex(dest, [medium], { demotedFiles: [demoted], inlineBudgetTokens: 64_000 });
    expect(count).toBe(2);
    const content = await readFile(join(dest, 'RULES-ONDEMAND.md'), 'utf8');
    expect(content).toContain('- `activity-log` — `aiwg show rule activity-log --body`');
    expect(content).toContain('## Binding rules moved on demand to fit the inline budget');
    expect(content).toContain('64,000-token inline budget');
    expect(content).toContain('- `ops-safety` — `aiwg show rule ops-safety --body`');
    // The demoted rule is not also listed as a MEDIUM/LOW rule.
    expect(content.split('ops-safety').length).toBe(3);
  });

  it('retires stale demotion state without deleting activation-selected or operator rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-rule-budget-'));
    roots.push(root);
    const dest = join(root, '.claude', 'rules');
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'large.md'), `<!-- aiwg:managed -->\n${'x'.repeat(8000)}`);
    await writeFile(join(dest, 'operator.md'), '# Operator');
    await writeFile(join(dest, RULE_BUDGET_SIDECAR), JSON.stringify({ budgetTokens: 1, demoted: ['large'] }));
    expect(reconcileInlineRuleBudget(dest, 1)).toEqual({ demoted: [], removed: [] });
    expect(existsSync(join(dest, 'large.md'))).toBe(true);
    expect(existsSync(join(dest, 'operator.md'))).toBe(true);
    expect(existsSync(join(dest, RULE_BUDGET_SIDECAR))).toBe(false);
  });

  it('lists sidecar-demoted names in RULES-ONDEMAND.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiwg-rule-budget-'));
    roots.push(root);
    const dest = join(root, '.claude', 'rules');
    await mkdir(dest, { recursive: true });
    const count = writeOnDemandRuleIndex(dest, [], { demotedNames: ['ops-safety', 'god-session'], inlineBudgetTokens: 64_000 });
    expect(count).toBe(2);
    const content = await readFile(join(dest, 'RULES-ONDEMAND.md'), 'utf8');
    expect(content).toContain('## Binding rules moved on demand to fit the inline budget');
    expect(content).toContain('- `god-session` — `aiwg show rule god-session --body`');
    expect(content).toContain('- `ops-safety` — `aiwg show rule ops-safety --body`');
  });
});
