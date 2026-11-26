// Offline template and migration coverage for the #2642 generated delegation policy.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDelegationRubric } from '../../../src/smiths/context-pipeline/delegation-rubric.js';
import { buildParallelismSection, replaceOrAppendParallelismBlock } from '../../../src/smiths/context-pipeline/parallelism-section.js';
import { buildAgentsMd } from '../../../src/smiths/context-pipeline/agents-md.js';
import { buildAiwgMdContent } from '../../../src/smiths/context-pipeline/aiwg-md.js';
import { generate } from '../../../src/smiths/context-pipeline/generator.js';
import { ensureManagedHook } from '../../../src/smiths/context-pipeline/managed-hook.js';
import { emptyConfig } from '../../../src/config/aiwg-config.js';
import type { WorkerSelectionPolicy } from '../../../src/models/types.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiwg-delegation-'));
  vi.stubEnv('AIWG_HOME', process.cwd());
  vi.stubEnv('AIWG_CONFIG', join(root, 'user'));
  vi.stubEnv('AIWG_HIDE_PARALLELISM_IN_CONTEXT', '0');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('delegation template', () => {
  it.each(['default', 'advisory', 'off'] as const)('renders %s in at most 15 lines', async mode => {
    const rubric = await renderDelegationRubric({ mode, strategy: 'balanced', maxAutoTier: 'standard', returnBudgetTokens: 800 });
    expect(rubric).toMatchSnapshot();
    expect(rubric.split('\n').length).toBeLessThanOrEqual(15);
    expect(rubric).not.toContain('{{');
    expect(rubric).toContain('Return ≤ 800 tokens');
  });
  it('emits defaults without project config and mirrors the rubric into a small Codex bridge', async () => {
    const section = await buildParallelismSection(root);
    expect(section).toContain('AIWG-DELEGATION:START');
    expect(section).toContain('defaults; edit project models.json');
    expect(section).toContain('Consider delegation');
    const bridge = await buildAgentsMd({ projectPath: root, provider: 'codex', sections: [] });
    expect(bridge.content).toContain(await renderDelegationRubric({}));
    expect(Buffer.byteLength(bridge.content)).toBeLessThan(32 * 1024);
    expect(await buildAiwgMdContent(root, '# Project\n')).toContain('AIWG-DELEGATION:START');
  });
  it('renders project model policy even without aiwg.config', async () => {
    const policy: WorkerSelectionPolicy = { mode: 'default', strategy: 'quality', maxAutoTier: 'standard', returnBudgetTokens: 500 };
    await writeFile(join(root, 'models.json'), JSON.stringify({ defaults: { workerSelection: policy } }));
    const section = await buildParallelismSection(root);
    expect(section).toContain(await renderDelegationRubric(policy, true));
  });
  it.each([
    ['claude', 'native custom subagents'], ['codex', 'native custom subagents'],
    ['warp', 'global/run-scoped'], ['hermes', 'global/run-scoped'], ['grokbot', 'global/run-scoped'],
    ['grok-build', 'pending (#2577)'], ['devin', 'unsupported'], ['muse', 'unverified'],
  ])('states the %s support class without a live claim', async (provider, expected) => {
    const section = await buildParallelismSection(root, { readConfig: async () => emptyConfig([provider]) });
    expect(section).toContain(expected);
    expect(section.split('\n').filter(line => line.startsWith('**Provider behavior'))).toMatchSnapshot();
  });
  it('refreshes managed and operator-owned Codex bridges without losing text or duplicating the rubric', async () => {
    const opts = { projectPath: root, provider: 'codex' as const, sections: [], detectExistingFiles: true };
    await generate(opts);
    await writeFile(join(root, 'models.json'), '{"defaults":{"workerSelection":{"mode":"off"}}}');
    await generate(opts);
    const { readFile } = await import('node:fs/promises');
    let bridge = await readFile(join(root, 'AGENTS.md'), 'utf8');
    expect(bridge).toContain('Automatic delegation is off');
    await writeFile(join(root, 'AGENTS.md'), `Operator text\n${bridge}`);
    await ensureManagedHook(join(root, 'AGENTS.md'), { provider: 'codex' });
    bridge = await readFile(join(root, 'AGENTS.md'), 'utf8');
    expect(bridge.startsWith('Operator text')).toBe(true);
    expect(bridge.match(/AIWG-DELEGATION:START/g)).toHaveLength(1);
  });
  it('hides both context and bridge under the existing opt-out', async () => {
    vi.stubEnv('AIWG_HIDE_PARALLELISM_IN_CONTEXT', '1');
    expect(await buildParallelismSection(root)).toBe('');
    expect((await buildAgentsMd({ projectPath: root, provider: 'codex', sections: [] })).content).not.toContain('AIWG-DELEGATION');
  });
  it.each(['\n', '\r\n'])('migrates old and mixed duplicate blocks on regenerate (%j)', async eol => {
    const old = '<!-- AIWG-PARALLELISM-CAP:START -->\nold\n<!-- AIWG-PARALLELISM-CAP:END -->\n';
    const section = await buildParallelismSection(root);
    const input = `# Operator\n${old}preserve this\n${section}tail\n`.replace(/\n/g, eol);
    const once = replaceOrAppendParallelismBlock(input, section);
    expect(once.match(/AIWG-DELEGATION:START/g)).toHaveLength(1);
    expect(once).not.toContain('AIWG-PARALLELISM-CAP');
    expect(once).toContain('preserve this');
    expect(replaceOrAppendParallelismBlock(once, section)).toBe(once);
    expect(replaceOrAppendParallelismBlock(input, '')).not.toContain('AIWG-DELEGATION');
    const regenerated = await buildAiwgMdContent(root, `# Operator\n${old}`);
    expect(regenerated.match(/AIWG-DELEGATION:START/g)).toHaveLength(1);
    expect(regenerated).not.toContain('AIWG-PARALLELISM-CAP');
  });
});
