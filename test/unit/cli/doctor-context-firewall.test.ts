// Exercise doctor's firewall boundary with real scans and isolated project fixtures.
import * as sharedFlagParsing from '../../../src/cli/flag-parsing.js';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkContextMemoryFirewall } from '../../../tools/cli/doctor-context-firewall.mjs';
import { PROVIDERS, SUPPORTED_PROVIDERS, scanContextMemoryFirewall, formatContextMemoryFirewall,
  writeReviewBaseline } from '../../../tools/security/context-memory-firewall.mjs';

const repo = process.cwd();
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(files: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-doctor-firewall-'));
  roots.push(root);
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), '# Local guidance\n');
  }
  return root;
}
const layouts = [
  { provider: 'pi', files: ['AGENTS.md', 'CLAUDE.md', '.agents/skills/kernel/SKILL.md', '.pi/skills/local/SKILL.md', '.pi/.aiwg/skills/standard/SKILL.md'] },
  { provider: 'omp', files: ['.omp/AGENTS.md', '.omp/agents/worker.md', '.omp/rules/local.md', '.agents/skills/kernel/SKILL.md'] },
  { provider: 'antigravity', files: ['AGENTS.md', '.antigravity/rules/project.md', '.agents/agents/worker.md', '.agents/skills/kernel/SKILL.md', '.agents/.aiwg/skills/standard/SKILL.md'] },
  { provider: 'deepseek-harness', files: ['AGENTS.md', 'CLAUDE.md', '.agents/skills/kernel/SKILL.md'] },
];
async function check(rootDir: string, providers: string[], strictContext = false) {
  const checks: Array<{ name: string; status: string; message: string }> = [];
  await checkContextMemoryFirewall({ rootDir, packageRoot: rootDir, providers, strictContext },
    (name: string, status: string, message: string) => checks.push({ name, status, message }));
  return checks;
}

describe('doctor context firewall provider coverage (#3649)', () => {
  it('exports the exact provider keys as the supported list', () => {
    expect(SUPPORTED_PROVIDERS).toEqual(Object.keys(PROVIDERS));
  });
  it.each(layouts)('scans $provider and claude together', async ({ provider, files }) => {
    const rootDir = await fixture([...new Set([...files, '.claude/rules/local.md'])]);
    const providers = [provider, 'claude'];
    const scan = await scanContextMemoryFirewall({ rootDir, packageRoot: rootDir, providers });
    expect(scan.providers).toEqual(providers);
    expect(scan.records.map((record: any) => record.path).sort()).toEqual([...new Set([...files, '.claude/rules/local.md'])].sort());
    const checks = await check(rootDir, providers);
    expect(checks).toHaveLength(1);
    expect(checks[0].message).toContain(`${scan.totals.files} file(s)`);
    expect(checks[0].message).not.toContain('scan failed');
  });
  it.each(['future-provider', 'toString', '__proto__'])('skips unknown %s and scans its siblings', async unknown => {
    const rootDir = await fixture(['AGENTS.md', '.claude/rules/local.md']);
    const providers = ['pi', unknown, 'claude'];
    const scan = await scanContextMemoryFirewall({ rootDir, packageRoot: rootDir, providers });
    expect(scan.providers).toEqual(['pi', 'claude']);
    expect(scan.records.map((record: any) => record.path)).toEqual(['.claude/rules/local.md', 'AGENTS.md']);
    expect(formatContextMemoryFirewall(scan)).toContain(`${unknown}: not yet supported; skipped`);
    expect(await check(rootDir, providers)).toContainEqual(expect.objectContaining({
      status: 'info', message: `${unknown}: not yet supported; skipped`,
    }));
  });
  it('keeps unsupported providers informational in strict context mode', async () => {
    const rootDir = await fixture(['CLAUDE.md']);
    const providers = ['future-provider', 'claude'];
    await writeReviewBaseline(await scanContextMemoryFirewall({ rootDir, packageRoot: rootDir, providers }),
      '.aiwg/context-memory-firewall-baseline.json');
    const checks = await check(rootDir, providers, true);
    expect(checks.map(item => item.status)).toEqual(['info', 'ok']);
  });
  it('reports unsupported configured providers in the real doctor while scanning siblings', async () => {
    const rootDir = await fixture(['CLAUDE.md', 'AGENTS.md']);
    await mkdir(path.join(rootDir, '.aiwg'), { recursive: true });
    await writeFile(path.join(rootDir, '.aiwg/aiwg.config'), JSON.stringify({ version: '1',
      providers: ['pi', 'future-provider', 'claude'] }));
    const env = { ...process.env, HOME: rootDir, USERPROFILE: rootDir,
      XDG_CONFIG_HOME: path.join(rootDir, 'config'), XDG_DATA_HOME: path.join(rootDir, 'data'),
      XDG_CACHE_HOME: path.join(rootDir, 'cache'), XDG_STATE_HOME: path.join(rootDir, 'state'),
      AIWG_CONFIG: path.join(rootDir, 'config/aiwg'), AIWG_ROOT: repo, AIWG_HOME: repo,
      AIWG_RESOLVE_IMPL_FROM: 'dist', NO_COLOR: '1' };
    let output: string;
    try { output = execFileSync(process.execPath, [path.join(repo, 'tools/cli/doctor.mjs')],
      { cwd: rootDir, env, encoding: 'utf8', timeout: 60_000 }); }
    catch (error: any) { output = error.stdout; }
    expect(output).toContain('future-provider: not yet supported; skipped');
    expect(output).toMatch(/Context\/memory firewall: 2 file\(s\)/);
    expect(output).not.toContain('scan failed');
  }, 70_000);
});

// ── Context and persistent-memory firewall (#2040) ────────────────────

describe('tools/cli/doctor.mjs — context/memory firewall (#2040)', () => {
  let content: string;
  beforeEach(async () => {
    const { readFileSync } = await import('fs');
    content = readFileSync(path.join(repo, 'tools/cli/doctor.mjs'), 'utf-8')
      + readFileSync(path.join(repo, 'tools/cli/doctor-context-firewall.mjs'), 'utf-8')
      + readFileSync(path.join(repo, 'tools/cli/doctor-args.mjs'), 'utf-8');
  });

  it('imports and invokes the cross-category firewall', () => {
    expect(content).toContain('scanContextMemoryFirewall');
    expect(content).toContain("from '../security/context-memory-firewall.mjs'");
    expect(content).toContain('const firewall = await scanContextMemoryFirewall');
  });

  it('exposes strict, baseline, and provider-budget controls', () => {
    // Execute the actual parser with the shared helpers, without running the
    // script's top-level diagnostics or process.exit(). This checks values and
    // precedence rather than depending on the spelling of its former loop.
    const parserSource = content.slice(content.indexOf('const DOCTOR_VALUE_FLAGS'), content.indexOf('// Parse-or-exit wrapper'));
    const parse = new Function('shared', `
      const {
        requireFlagValue: requireDoctorFlagValue,
        hasPositionalOrSwitch: hasDoctorFlagSwitch,
        argsTerminatorIndex: doctorArgsTerminatorIndex,
        valueTokenIndexes: doctorValueTokenIndexes,
        MissingFlagValueError: DoctorMissingFlagValueError,
      } = shared;
      ${parserSource}
      return parseDoctorArgs;
    `)(sharedFlagParsing);
    expect(parse([])).toMatchObject({ strictContext: false,
      contextBaseline: '.aiwg/context-memory-firewall-baseline.json', contextBudgetTokens: 200_000 });
    expect(parse(['--strict-context', '--context-baseline', 'reviewed.json', '--context-budget-tokens', '12345']))
      .toMatchObject({ strictContext: true, contextBaseline: 'reviewed.json', contextBudgetTokens: 12345 });
    expect(parse(['--context-baseline=old.json', '--context-baseline=new.json',
      '--context-budget-tokens=1000', '--context-budget-tokens=2000']))
      .toMatchObject({ contextBaseline: 'new.json', contextBudgetTokens: 2000 });
    expect(parse(['--', '--strict-context', '--context-baseline', 'ignored.json']))
      .toMatchObject({ strictContext: false, contextBaseline: '.aiwg/context-memory-firewall-baseline.json' });
    for (const flag of ['--context-baseline', '--context-budget-tokens']) {
      expect(() => parse([flag])).toThrow(`${flag} requires a value`);
      expect(() => parse([`${flag}=`])).toThrow(`${flag} requires a value`);
    }
    expect(content).toContain('baselinePath: contextBaseline');
    expect(content).toContain('budgetTokens: contextBudgetTokens');
    expect(content).toContain("strictContext ? 'error' : 'warn'");
  });

  it('reports all six context contributions and review states', () => {
    expect(content).toContain('Object.entries(firewall.categories)');
    expect(content).toContain('firewall.trust.stale');
    expect(content).toContain('firewall.trust.quarantined');
    expect(content).toContain("record.reviewStatus === 'changed-review-required'");
  });

  it('scans Muse Code through the firewall without an unknown-provider hole (#229)', async () => {
    const rootDir = await fixture(['AGENTS.md', '.agents/skills/kernel/SKILL.md']);
    const checks = await check(rootDir, ['muse']);
    expect(checks).toHaveLength(1);
    expect(checks[0].message).toContain('2 file(s)');
    expect(content).toContain('if (!agentsPath) {');
    expect(content).toContain('0 agents deployed on disk — no native agent surface');
  });

  it('scans Grok Build through the firewall without an unknown-provider hole (#2640)', async () => {
    const rootDir = await fixture(['AGENTS.md', '.grok/agents/worker.md', '.grok/skills/kernel/SKILL.md']);
    const checks = await check(rootDir, ['grok-build']);
    expect(checks).toHaveLength(1);
    expect(checks[0].message).toContain('3 file(s)');
    expect(checks[0].message).not.toContain('scan failed');
  });

  it('scans every provider the firewall supports through doctor (#2640)', async () => {
    const rootDir = await fixture(['WORKSPACE.md']);
    for (const provider of SUPPORTED_PROVIDERS) {
      const checks = await check(rootDir, [provider]);
      expect(checks, provider).toHaveLength(1);
      expect(checks[0].message, provider).toContain('1 file(s)');
      expect(checks[0].message, provider).not.toMatch(/scan failed|not yet supported/);
    }
  });

});
