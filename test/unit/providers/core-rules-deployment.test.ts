import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { measureDeployedCoreRules } from '../../../src/rules/activation.mjs';

// Core rule class (#3450): compact bodies always injected into every harness.
const repo = resolve(__dirname, '../../..');
const fixture = join(repo, 'test/fixtures/rule-delivery');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const walk = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]) : [];
const CORE = readFileSync(join(repo, 'agentic/code/addons/aiwg-utils/rules/anti-laziness.core.md'), 'utf8').trim();
const MARKER = '# Core: Anti-Laziness';
const NO_ATTRIBUTION = readFileSync(join(repo, 'agentic/code/addons/aiwg-utils/rules/no-attribution.core.md'), 'utf8').trim();
const PROVIDER_FILES: Record<string, string[]> = {
  claude: ['.claude/rules/core-anti-laziness.md'],
  cursor: ['.cursor/rules/core-anti-laziness.mdc'],
  codex: ['AGENTS.md'],
  hermes: ['AGENTS.md'],
  warp: ['WARP.md'],
  openclaw: ['../home/.openclaw/workspace/AGENTS.md'],
  pi: ['AGENTS.md'],
};

function run(srcRoot: string, target: string, provider: string, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const opts = { srcRoot, target, provider, mode: 'general', deployRules: true, rulesOnly: true, force: true, quiet: true, ...extra };
  return execFileSync('node', ['--input-type=module', '-e', `
    const { deploy } = await import(${JSON.stringify(join(repo, 'tools/agents/providers', `${provider}.mjs`))});
    const report = await deploy(${JSON.stringify(opts)});
    console.log('REPORT:' + JSON.stringify(report));
  `], { cwd: repo, env: { ...process.env, HOME: join(target, '../home'), HERMES_HOME: join(target, '../home/.hermes'),
    AIWG_ROOT: srcRoot, OPENCLAW_PROFILE: 'default', AIWG_RULES_INLINE_BUDGET_TOKENS: '0', ...env }, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'aiwg-core-rules-'));
  roots.push(root);
  mkdirSync(join(root, 'target'));
  return root;
}
function fixtureSource(root: string, bodies: Record<string, string> = { 'fixture-core': 'FIXTURE_CORE_BODY — always applies.' }, extras: Record<string, string> = {}) {
  const source = join(root, 'source');
  cpSync(fixture, source, { recursive: true });
  for (const [name, body] of Object.entries(bodies)) {
    writeFileSync(join(source, `rules/${name}.md`), `---\nname: ${name}\nactivation: core\nenforcement: high\n---\n\n# ${name}\n\nFULL_${name}_BODY\n`);
    writeFileSync(join(source, `rules/${name}.core.md`), body);
  }
  for (const [name, content] of Object.entries(extras)) writeFileSync(join(source, `rules/${name}.md`), content);
  return source;
}

describe('core rule delivery (#3450)', () => {
  for (const provider of Object.keys(PROVIDER_FILES)) {
    it(`${provider}: a deploy mode without sdlc-complete still delivers the anti-laziness core body`, () => {
      const root = tempRoot();
      run(repo, join(root, 'target'), provider); // mode: general selects no framework
      for (const name of PROVIDER_FILES[provider]) {
        const content = readFileSync(join(root, 'target', name), 'utf8');
        expect(content).toContain(CORE);
        const attributionFile = name.replace('anti-laziness', 'no-attribution');
        const attribution = readFileSync(join(root, 'target', attributionFile), 'utf8');
        expect(attribution).toContain(NO_ATTRIBUTION);
        if (provider === 'cursor') expect(attribution).toContain('alwaysApply: true');
        if (!['claude', 'cursor'].includes(provider)) expect(attribution).toContain('## Core rules');
      }
      // sdlc-complete rules are absent in this mode, proving independence from the framework
      const all = walk(join(root, 'target')).filter(f => /\.(md|mdc)$/.test(f)).map(f => readFileSync(f, 'utf8')).join('\n');
      expect(all).not.toContain('agent-friendly-code');
      // The full rule is reachable by command only and is never imported.
      expect(all).not.toMatch(/@[^\s)`]*anti-laziness/);
      expect(all).not.toMatch(/@[^\s)`]*no-attribution/);
      const measured = measureDeployedCoreRules(provider === 'openclaw' ? join(root, 'home/.openclaw/workspace') : join(root, 'target'), provider);
      expect(measured.bodies.map(body => body.name).join(' ')).toContain('anti-laziness');
      expect(measured.bodies.map(body => body.name).join(' ')).toContain('no-attribution');
      expect(measured.bytes).toBeLessThanOrEqual(measured.limit);
    }, 120_000);
  }

  for (const provider of Object.keys(PROVIDER_FILES)) {
    for (const mode of ['sdlc', 'all', 'kernel-only']) {
      it(`${provider}: ${mode} delivers both shipped core bodies`, () => {
        const root = tempRoot();
        run(repo, join(root, 'target'), provider, {
          mode: mode === 'kernel-only' ? 'all' : mode, kernelOnly: mode === 'kernel-only',
          config: { installed: { sdlc: {} } },
        });
        for (const name of PROVIDER_FILES[provider]) {
          expect(readFileSync(join(root, 'target', name), 'utf8')).toContain(CORE);
          expect(readFileSync(join(root, 'target', name.replace('anti-laziness', 'no-attribution')), 'utf8'))
            .toContain(NO_ATTRIBUTION);
        }
      }, 120_000);
    }
  }

  it('places the core section first in the managed startup block, before kernel rules', () => {
    const root = tempRoot();
    run(fixtureSource(root), join(root, 'target'), 'codex', { mode: 'all' });
    const aiwg = readFileSync(join(root, 'target/AGENTS.md'), 'utf8');
    expect(aiwg.indexOf('## Core rules')).toBeGreaterThan(-1);
    expect(aiwg.indexOf('FIXTURE_CORE_BODY')).toBeLessThan(aiwg.indexOf('codex: Before every task'));
    expect(aiwg).not.toContain('FIXTURE_KERNEL_BODY');
    expect(readFileSync(join(root, 'target/.codex/rules/fixture-kernel.md'), 'utf8')).toContain('FIXTURE_KERNEL_BODY');
    expect(aiwg).not.toContain('FULL_fixture-core_BODY');
    expect(readFileSync(join(root, 'target/AGENTS.md'), 'utf8')).toContain('Read and follow');
  }, 90_000);

  it('hermes keeps core inline even though it is not CRITICAL, and survives index spill pressure', () => {
    const root = tempRoot();
    const extras: Record<string, string> = {};
    for (let i = 0; i < 90; i++) {
      extras[`pressure-${String(i).padStart(3, '0')}`] = `---\nname: pressure-${i}\nactivation: summary\nenforcement: high\nsummary: ${'Follow pressure policy number '.padEnd(230, 'x')}${i}\n---\n\nPRESSURE_BODY_${i}\n`;
    }
    run(fixtureSource(root, undefined, extras), join(root, 'target'), 'hermes', { mode: 'all' });
    const agents = readFileSync(join(root, 'target/AGENTS.md'), 'utf8');
    expect(agents).toContain('FIXTURE_CORE_BODY');
    expect(agents.length).toBeLessThanOrEqual(19_000);
    // the kernel/summary index is what spills; core is never demoted or spilled
    expect(existsSync(join(root, 'target/.hermes/rules/RULES-INDEX.md'))).toBe(true);
    expect(readFileSync(join(root, 'target/.hermes/rules/RULES-INDEX.md'), 'utf8')).not.toContain('FIXTURE_CORE_BODY');
    expect(agents).not.toContain('FIXTURE_KERNEL_BODY');
  }, 90_000);

  it('keeps the core file when the inline budget is exceeded in report-only mode', () => {
    const root = tempRoot();
    run(fixtureSource(root), join(root, 'target'), 'claude', { mode: 'all', reportOnly: true }, { CI: '', AIWG_RULES_INLINE_BUDGET_TOKENS: '1' });
    const core = readFileSync(join(root, 'target/.claude/rules/core-fixture-core.md'), 'utf8');
    expect(core).toContain('FIXTURE_CORE_BODY');
    expect(core).not.toContain('FULL_fixture-core_BODY');
  }, 90_000);

  it('redeploy is idempotent and removes a retired core body', () => {
    const root = tempRoot();
    const source = fixtureSource(root);
    run(source, join(root, 'target'), 'claude', { mode: 'all' });
    const first = readFileSync(join(root, 'target/.claude/rules/core-fixture-core.md'), 'utf8');
    run(source, join(root, 'target'), 'claude', { mode: 'all' });
    expect(readFileSync(join(root, 'target/.claude/rules/core-fixture-core.md'), 'utf8')).toBe(first);
    rmSync(join(source, 'rules/fixture-core.md'));
    rmSync(join(source, 'rules/fixture-core.core.md'));
    run(source, join(root, 'target'), 'claude', { mode: 'all' });
    expect(existsSync(join(root, 'target/.claude/rules/core-fixture-core.md'))).toBe(false);
  }, 90_000);

  it('fails the deploy when a single core body exceeds 1024 bytes', () => {
    const root = tempRoot();
    const source = fixtureSource(root, { 'fixture-core': 'x'.repeat(1025) });
    expect(() => run(source, join(root, 'target'), 'claude', { mode: 'all' })).toThrow(/1025 bytes|per-body cap is 1024/);
    expect(existsSync(join(root, 'target/.claude/rules/core-fixture-core.md'))).toBe(false);
  }, 90_000);

  it('fails the deploy when the core set exceeds 6144 bytes, naming the budget', () => {
    const root = tempRoot();
    const bodies = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`fixture-core-${i}`, `core ${i} ${'y'.repeat(1000)}`]));
    const source = fixtureSource(root, bodies);
    try {
      run(source, join(root, 'target'), 'codex', { mode: 'all' });
      throw new Error('deploy unexpectedly succeeded');
    } catch (error) {
      expect(String((error as { stderr?: string }).stderr ?? error)).toMatch(/reserved core budget is 6144 bytes/);
    }
    expect(existsSync(join(root, 'target/AIWG.md'))).toBe(false);
  }, 90_000);

  it('fails the deploy when a core body imports a file with @', () => {
    const root = tempRoot();
    const source = fixtureSource(root, { 'fixture-core': 'See @.claude/rules/anti-laziness.md for more.' });
    expect(() => run(source, join(root, 'target'), 'claude', { mode: 'all' })).toThrow();
  }, 90_000);

  it('the shipped anti-laziness core body is within its caps and carries no @ reference', () => {
    expect(Buffer.byteLength(CORE)).toBeLessThanOrEqual(1024);
    expect(CORE).not.toMatch(/(^|\s)@\S/);
    expect(CORE.startsWith(MARKER)).toBe(true);
  });
});
