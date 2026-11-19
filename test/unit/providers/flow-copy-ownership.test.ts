// Copied flow projections use the same ownership/removal contract as authored skills.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectBoundFlowSkills } from '../../../tools/agents/providers/rule-delivery-surface.mjs';
import { removeSkillCopy } from '../../../tools/agents/providers/skill-copy-prune.mjs';
import { uninstall } from '../../../tools/agents/providers/grok-build.mjs';
import { captureDeploymentOutputs, recordDeploymentOutputs } from '../../../src/providers/deployment-ownership.mjs';
import { planDeploymentRemoval } from '../../../src/providers/deployment-removal.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-flow-copy-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function project(provider: string, kind: 'yaml' | 'md' = 'yaml') {
  const sourceRoot = path.join(root, 'source');
  const source = path.join(sourceRoot, `agentic/code/frameworks/demo/flows/flow-fixture.${kind}`);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, kind === 'yaml' ? 'name: flow-fixture\nsteps: []\n'
    : '---\nname: flow-fixture\ndescription: Fixture flow\n---\n\nFollow the fixture.\n');
  const target = path.join(root, 'project');
  const native = provider === 'grok-build' ? '.grok' : `.${provider}`;
  const standard = `${native}/.aiwg/skills`;
  const definition = { name: provider, paths: { skills: provider === 'grok-build' ? '.grok/skills' : standard },
    kernelSkillsPath: `${native}/skills`, ...(provider === 'grok-build' ? { standardSkillsPath: standard } : {}) };
  const before = captureDeploymentOutputs([target]);
  const options = { target, srcRoot: sourceRoot, mode: 'all', deploySkills: true, copyStandardSkills: true,
    ruleDelivery: { targets: [{ type: 'flow', name: 'flow-fixture', source }], bindings: new Map() } };
  projectBoundFlowSkills(options, definition, () => true);
  recordDeploymentOutputs(before, [target], options);
  return { target, sourceRoot, dir: path.join(target, standard, 'flow-fixture') };
}

describe.each(['claude', 'grok-build'])('%s copied flow ownership', provider => {
  it.each(['yaml', 'md'] as const)('records removable %s projections in the standard tier', kind => {
    const { target, sourceRoot, dir } = project(provider, kind);
    expect(fs.existsSync(path.join(target, provider === 'grok-build' ? '.grok' : `.${provider}`, 'skills/flow-fixture'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.aiwg-managed'), 'utf8')).toBe('aiwg\n');
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, '.aiwg-manifest.json'), 'utf8'));
    expect(receipt.managed['SKILL.md']).toMatchObject({ owners: ['demo'], kind: 'skill' });
    expect(receipt.managed['.aiwg-managed']).toMatchObject({ owners: ['demo'], kind: 'skill' });
    const plan = planDeploymentRemoval(target, provider, 'demo');
    expect(plan.decisions.filter(entry => entry.owned && entry.action === 'preserve')).toEqual([]);
    expect(plan.decisions).toContainEqual(expect.objectContaining({ path: path.join(dir, 'SKILL.md'), action: 'remove' }));
    if (provider === 'grok-build') {
      const preview = uninstall(target, { srcRoot: sourceRoot, dryRun: true });
      expect(preview.skipped).toEqual([]);
      expect(preview.planned).toContain(path.relative(target, dir));
      expect(fs.existsSync(dir)).toBe(true);
      expect(uninstall(target, { srcRoot: sourceRoot }).removed).toEqual(preview.planned);
    } else expect(removeSkillCopy(dir)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it.each(['edited', 'added', 'symlink', 'invalid-receipt', 'linked-receipt'])('preserves %s flow copies', change => {
    const { target, sourceRoot, dir } = project(provider);
    const file = path.join(dir, 'SKILL.md');
    if (change === 'edited') fs.appendFileSync(file, '\nOperator edit.\n');
    if (change === 'added') fs.writeFileSync(path.join(dir, 'operator.txt'), 'keep');
    if (change === 'invalid-receipt') fs.writeFileSync(path.join(dir, '.aiwg-manifest.json'), '{invalid');
    if (change === 'linked-receipt') {
      const receipt = path.join(dir, '.aiwg-manifest.json');
      fs.renameSync(receipt, path.join(root, 'outside-receipt'));
      fs.symlinkSync(path.join(root, 'outside-receipt'), receipt);
    }
    if (change === 'symlink') { fs.renameSync(file, path.join(root, 'outside')); fs.symlinkSync(path.join(root, 'outside'), file); }
    if (provider === 'grok-build') {
      expect(uninstall(target, { srcRoot: sourceRoot }).skipped).toContain(path.relative(target, dir));
    } else expect(removeSkillCopy(dir)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });
});

it.each(['codex', 'absolute'])('keeps standalone flow provenance removable with %s skill roots', layout => {
  const target = path.join(root, 'project');
  const source = path.join(root, 'standalone/flow-fixture.yaml');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'name: flow-fixture\nsteps: []\n');
  const skills = path.join(target, '.claude/.aiwg/skills');
  const provider = { name: layout === 'codex' ? 'codex' : 'claude',
    paths: { skills }, kernelSkillsPath: layout === 'codex' ? '.agents/skills' : '.claude/skills' };
  const options = { target, mode: 'standalone', deploySkills: true, copyStandardSkills: true,
    deploySource: 'project-local', logicalInputPath: (file: string) => file,
    ruleDelivery: { targets: [{ type: 'flow', name: 'flow-fixture', source }], bindings: new Map() } };
  const before = captureDeploymentOutputs([target]);
  projectBoundFlowSkills(options, provider, () => true);
  recordDeploymentOutputs(before, [target], options);
  const dir = path.join(layout === 'codex' ? path.join(target, '.agents/skills') : skills, 'flow-fixture');
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, '.aiwg-manifest.json'), 'utf8'));
  expect(receipt.managed['SKILL.md']).toMatchObject({ source: 'project-local', sourcePath: source, owners: ['standalone'] });
  expect(receipt.managed['SKILL.md'].frameworkSlug).toBeUndefined();
  expect(removeSkillCopy(dir, { dryRun: true })).toBe(true);
  expect(removeSkillCopy(dir)).toBe(true);
  expect(fs.existsSync(dir)).toBe(false);
});
