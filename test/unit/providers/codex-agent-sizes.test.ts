// Check the actual provider output against the dispatch ceiling and lint renderer.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPackagedCodexRenderer, packagedRuleSources } from '../../../tools/agents/providers/packaged-codex-agents.mjs';
import { renderBoundRulesPointer } from '../../../tools/agents/providers/bound-rules-pointer.mjs';

const repo = resolve(__dirname, '../../..');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('Codex final agent sizes', () => {
  it('deduplicates bound-rule pointers against authored pointers and repeated bindings', () => {
    const target = { type: 'agent', name: 'reviewer' };
    const pointer = '.codex/RULES-BOUND.md#agent-reviewer';
    const output = renderBoundRulesPointer(`Read \`${pointer}\`.\n`, [target, target], '.codex/RULES-BOUND.md', { compact: true });
    expect(output.split(pointer)).toHaveLength(2);
    expect(output).toContain('before governed work');
    expect(renderBoundRulesPointer(output, [target], '.codex/RULES-BOUND.md', { compact: true })).toBe(output);
    expect(renderBoundRulesPointer(output, [], '.codex/RULES-BOUND.md')).toBe(`Read \`${pointer}\`.\n`);
  });

  it('keeps every real deployed agent within 16384 bytes and matches lint byte-for-byte', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiwg-codex-size-deploy-'));
    roots.push(root);
    const target = join(root, 'project'), home = join(root, 'home');
    const ruleSources = packagedRuleSources(repo);
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { deploy } = await import(${JSON.stringify(join(repo, 'tools/agents/providers/codex.mjs'))});
      await deploy(${JSON.stringify({ srcRoot: repo, target, mode: 'all', ruleSources,
        deployRules: true, force: true, quiet: true, deploymentHome: home })});
    `], { cwd: repo, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'),
        XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
        XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
        AIWG_ROOT: repo, AIWG_HOME: repo, AIWG_RULES_INLINE_BUDGET_TOKENS: '0' } });
    const dir = join(target, '.codex/agents');
    const files = readdirSync(dir).filter(file => file.endsWith('.toml'));
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('security-auditor.toml');
    expect(files).toContain('rlm-agent.toml');
    const manifest = JSON.parse(readFileSync(join(dir, '.aiwg-manifest.json'), 'utf8'));
    const render = await createPackagedCodexRenderer(repo, { ruleSources });
    for (const file of files) {
      expect(statSync(join(dir, file)).size, file).toBeLessThanOrEqual(16_384);
      const source = manifest.managed[file].sourcePath;
      expect(readFileSync(join(dir, file), 'utf8'), file).toBe(render(source));
    }
  }, 90_000);
});
