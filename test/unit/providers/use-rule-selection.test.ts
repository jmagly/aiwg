// Verify transient use selections leave persisted installation and retirement authoritative.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error Deployment tooling has no TypeScript declaration.
import { parseArgs } from '../../../tools/agents/deploy-options.mjs';
// @ts-expect-error Deployment tooling has no TypeScript declaration.
import { useRuleSelectionConfig } from '../../../tools/agents/use-rule-selection.mjs';
// @ts-expect-error Deployment tooling has no TypeScript declaration.
import { collectDeploymentRuleSources } from '../../../tools/agents/providers/rule-delivery-surface.mjs';

let scratch: string, source: string, target: string, configFile: string;
beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'aiwg-use-selection-'));
  source = path.join(scratch, 'source');
  target = path.join(scratch, 'project');
  cpSync(path.resolve(import.meta.dirname, '../../fixtures/cli/use-rule-selection'), source, { recursive: true });
  mkdirSync(path.join(target, '.aiwg'), { recursive: true });
  configFile = path.join(target, '.aiwg/aiwg.config');
  writeFileSync(configFile, JSON.stringify({ providers: ['claude'], installed: {} }));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function config(mode: string, extra: string[] = []) {
  return useRuleSelectionConfig(parseArgs(['--target', target, '--rule-selection-mode', mode, ...extra]),
    path.join(source, 'agentic/code/extensions/extra-extension'));
}

describe('use rule selection snapshot', () => {
  it('selects the requested framework on a later extension pass without saving an installation', () => {
    const before = readFileSync(configFile, 'utf8');
    const selected = config('sdlc');
    expect(Object.keys(selected.installed)).toEqual(['sdlc-complete']);
    const opts = { srcRoot: path.join(source, 'agentic/code/extensions/extra-extension'), target, mode: 'all' };
    const tokenRule = path.join(source, 'agentic/code/frameworks/sdlc-complete/rules/token-security.md');
    expect(collectDeploymentRuleSources({ ...opts, config: selected })).toContain(tokenRule);
    expect(readFileSync(configFile, 'utf8')).toBe(before);
    // A later invocation without the use selection must still retire those rules.
    expect(collectDeploymentRuleSources(opts)).not.toContain(tokenRule);
  });

  it('expands full all mode through canonical framework discovery', () => {
    expect(Object.keys(config('all').installed).sort()).toEqual(['media-marketing-kit', 'sdlc-complete']);
  });

  it('preserves existing installation metadata and operator rule pins', () => {
    const installed = { 'sdlc-complete': { source: 'bundled', installedAt: '2026-01-01', deployedTo: { claude: { rules: 2 } } },
      marketing: { source: 'bundled' } };
    const rules = { always_load: [{ rules: ['token-security'] }] };
    writeFileSync(configFile, JSON.stringify({ installed, rules }));
    const selected = config('sdlc');
    expect(selected.installed).toEqual(installed);
    expect(selected.rules).toEqual(rules);
  });

  it.each(['general', 'unknown'])('leaves %s selection unchanged', mode => {
    expect(config(mode)).toBeUndefined();
  });

  it('leaves kernel-only all and standalone deployer calls unchanged', () => {
    expect(config('all', ['--kernel-only'])).toBeUndefined();
    expect(useRuleSelectionConfig(parseArgs(['--target', target]), source)).toBeUndefined();
  });

  it.each([{ tail: [] }, { tail: ['--target', 'project'] }])('rejects a missing internal mode value before deployment: $tail', ({ tail }) => {
    expect(() => parseArgs(['--rule-selection-mode', ...tail])).toThrow('--rule-selection-mode requires a deployment mode');
  });
});
