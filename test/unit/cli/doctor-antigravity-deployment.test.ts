// Deploy synthetic Antigravity resources and audit them without invoking a provider.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error shipped JavaScript module
import { deployAgents, deploySkills } from '../../../tools/agents/providers/antigravity.mjs';
// @ts-expect-error shipped JavaScript module
import { collectDelegationInheritance, collectDoctorModelChecks } from '../../../tools/cli/doctor-delegation-inheritance.mjs';
// @ts-expect-error shipped JavaScript module
import { wrapperTextFindings } from '../../../tools/cli/doctor-wrapper-text.mjs';
import { deployedWrapperEnforcement, resolveWrapperPin, wrapperEnforcementReport,
  wrapperModelRisks } from '../../../src/models/wrapper-enforcement.js';
import { MODEL_WRAPPER_DEFINITIONS } from '../../../src/models/wrapper-definitions.js';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = path.join(packageRoot, 'test/fixtures/providers/antigravity-delegation/skills');
let root: string;
let projectDir: string;
const options = () => ({ projectDir, packageRoot, config: { providers: ['antigravity'] } });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'doctor-antigravity-'));
  projectDir = path.join(root, 'project');
  await mkdir(projectDir);
  for (const [key, value] of Object.entries({ HOME: root, USERPROFILE: root,
    XDG_CONFIG_HOME: path.join(root, 'xdg'), AIWG_CONFIG: path.join(root, 'config'),
    AIWG_RESOLVE_IMPL_FROM: 'src' })) vi.stubEnv(key, value);
  const result = deploySkills(['session-only', 'mirror-model'].map(name => path.join(fixture, name)),
    projectDir, { dryRun: false, quiet: true, provider: 'antigravity' });
  expect(result.kernel).toBe(2);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('Antigravity deployment doctor (#4473)', () => {
  it('does not infer per-skill flagship risks from an unknown session model', async () => {
    for (const name of ['session-only', 'mirror-model']) {
      expect(await readFile(path.join(projectDir, '.agents/skills', name, 'SKILL.md'), 'utf8'))
        .toContain(`name: ${name}`);
    }
    expect(await collectDelegationInheritance(options())).toEqual([]);
  });

  it('reports global-only support without manufacturing warnings for absent or deployed wrappers', async () => {
    for (const deployed of [false, true]) {
      if (deployed) deployAgents(MODEL_WRAPPER_DEFINITIONS.map(wrapper =>
        path.join(packageRoot, 'agentic/code/addons/aiwg-utils/agents', `${wrapper.name}.md`)),
      projectDir, { dryRun: false, quiet: true, provider: 'antigravity' });
      const rows = await collectDoctorModelChecks(options());
      expect(rows.filter((row: any) => row.status === 'warn')).toEqual([]);
      const text = wrapperTextFindings(rows);
      expect(text).toHaveLength(1);
      expect(text[0].message).toContain('global-only');
      expect(text[0].message).toContain('per-skill model controls are unsupported');
      expect(text[0].message).toContain('not a live resolved-model audit');
    }
  });

  it('classifies wrapper mirrors separately from explicit CLI model selection', () => {
    expect(resolveWrapperPin('antigravity', MODEL_WRAPPER_DEFINITIONS[1]))
      .toMatchObject({ model: undefined, effort: undefined, enforcement: 'global-only' });
    expect(deployedWrapperEnforcement('antigravity', { model: 'gpt-6-luna', inheritedModel: 'gpt-6-astra' }))
      .toMatchObject({ model: 'global-only', effort: 'global-only', effectiveModel: 'gpt-6-astra' });
    expect(wrapperEnforcementReport('antigravity')).toContain('global-only');
    // A concrete flagship still requires election even on a global-only provider.
    expect(wrapperModelRisks('antigravity', { inheritedModel: 'gpt-6-astra' }))
      .toEqual(['delegation.flagship-inheritance']);
  });

  it('keeps actual flagship and missing native-pin warnings on Claude and Codex', async () => {
    for (const [relative, content] of [
      ['.claude/agents/missing.md', '---\nname: missing\n---\n'],
      ['.codex/config.toml', 'model = "gpt-6-astra"\n'],
      ['.agents/skills/codex-skill/SKILL.md', '---\nmodel: gpt-6-luna\n---\n'],
    ]) {
      const file = path.join(projectDir, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    const rows = await collectDelegationInheritance({ ...options(), config: { providers: ['antigravity', 'claude', 'codex'] } });
    expect(rows.filter((row: any) => row.provider === 'antigravity')).toEqual([]);
    expect(rows).toContainEqual(expect.objectContaining({ provider: 'claude', artifact: 'missing', id: 'delegation.flagship-inheritance' }));
    expect(rows).toContainEqual(expect.objectContaining({ provider: 'codex', artifact: 'codex-skill', resolvedModel: 'gpt-6-astra' }));
  });
});
