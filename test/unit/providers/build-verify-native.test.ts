import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGrokInspect } from '../../../src/providers/grok-build-inspect.js';
import { verifyProviderDeployment } from '../../../src/cli/services/deployment-verification.js';
vi.mock('../../../src/providers/grok-build-inspect.js', () => ({ runGrokInspect: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.resetAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function options(requireNativeInspection: boolean) {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'build-native-'));
  roots.push(projectRoot);
  return { projectRoot, frameworkRoot: projectRoot, provider: 'grok-build', scope: 'project' as const, requestedBundles: [], contextOptOut: true, requireNativeInspection };
}
describe('shared deployment native inspection gate', () => {
  it.each([
    { strict: false, agents: false }, { strict: true, agents: false },
    { strict: false, agents: true }, { strict: true, agents: true },
  ])('scopes native inspection and pin diagnostics ($strict, $agents)', async ({ strict, agents }) => {
    vi.mocked(runGrokInspect).mockReturnValue({ status: 'absent', remediation: 'Install Grok' });
    const opts = options(strict);
    if (agents) {
      const directory = path.join(opts.projectRoot, '.grok/agents');
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'fixture.md'), '---\nname: fixture\ndescription: Fixture\n---\nRole intent.');
    }
    const result = await verifyProviderDeployment(opts);
    const pins = result.findings.filter(finding => finding.id === 'grok-agent-model-pins-unenforced');
    expect(pins).toHaveLength(agents ? 1 : 0);
    if (agents) {
      expect(pins[0].message).toContain('per-agent model pins are not enforced');
      expect(pins[0].remediation).toContain('-m <model>');
    }
    expect(result.findings.find(finding => finding.id === 'grok-inspect-absent')?.severity).toBe(strict ? 'blocking' : 'advisory');
    expect(result.verificationLevel).toBe('deployment');
  });
  it.each(['claude', 'unknown-provider'])('keeps Grok pin diagnostics scoped to Grok (%s)', async provider => {
    const result = await verifyProviderDeployment({ ...options(false), provider });
    expect(result.findings.some(finding => finding.id === 'grok-agent-model-pins-unenforced')).toBe(false);
    expect(runGrokInspect).not.toHaveBeenCalled();
    if (provider === 'unknown-provider') {
      expect(result.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ severity: 'blocking', message: expect.stringContaining('No provider definition') }),
      ]));
    }
  });
  it('checks every deployed skill and the exact project instruction path in strict mode', async () => {
    const opts = options(true);
    for (let i = 0; i < 35; i++) {
      const root = path.join(opts.projectRoot, '.grok/skills', `skill-${i}`);
      mkdirSync(root, { recursive: true }); writeFileSync(path.join(root, 'SKILL.md'), '# Skill');
    }
    vi.mocked(runGrokInspect).mockReturnValue({ status: 'ok', binary: '/bin/grok', cwd: opts.projectRoot, stdout: '{}', parsed: {}, mismatches: [] });
    const result = await verifyProviderDeployment(opts);
    const argument = vi.mocked(runGrokInspect).mock.calls[0][0] as { expected: { skillNames: string[]; instructionPaths: string[] } };
    expect(argument.expected.skillNames).toHaveLength(35);
    expect(argument.expected.instructionPaths).toEqual([path.join(opts.projectRoot, 'AGENTS.md')]);
    expect(result.verificationLevel).toBe('native-inspection');
  });
});
