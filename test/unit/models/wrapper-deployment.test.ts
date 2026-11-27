import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_WRAPPER_DEFINITIONS } from '../../../src/models/wrapper-definitions.js';
import { verifyModelWrapperDeployment } from '../../../src/models/wrapper-deployment.js';

const roots: string[] = [];
const models = {
  reasoning: 'reasoning-current',
  coding: 'coding-current',
  efficiency: 'efficiency-current',
};

afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'aiwg-wrapper-deploy-'));
  roots.push(value);
  return value;
}

function codex(wrapper: string, model: string, effort: string): string {
  return [
    `name = "${wrapper}"`,
    'developer_instructions = "WorkerClaims: criterion evidence verdict. Stop rules"',
    'sandbox_mode = "read-only"',
    `model = "${model}"`,
    `model_reasoning_effort = "${effort}"`,
    '',
  ].join('\n');
}

describe('model wrapper deployment verification', () => {
  it('validates all five current Codex wrapper artifacts', async () => {
    const target = await root();
    await mkdir(join(target, 'nested'), { recursive: true });
    await Promise.all([
      writeFile(join(target, 'aiwg-model-reasoning-worker.toml'), codex('aiwg-model-reasoning-worker', models.reasoning, 'high')),
      writeFile(join(target, 'aiwg-model-coding-worker.toml'), codex('aiwg-model-coding-worker', models.coding, 'medium')),
      writeFile(join(target, 'nested', 'aiwg-model-efficiency-worker.toml'), codex('aiwg-model-efficiency-worker', models.efficiency, 'low')),
    ]);
    await Promise.all(MODEL_WRAPPER_DEFINITIONS.filter(item => item.readOnly).map(item =>
      writeFile(join(target, `${item.name}.toml`), codex(item.name, models[item.role], item.effort))));
    const result = await verifyModelWrapperDeployment(target, { provider: 'codex', models });
    expect(result.valid).toBe(true);
    expect(result.found).toHaveLength(5);
    expect(result.missing).toEqual([]);
    expect(result.mismatches).toEqual([]);
  });

  it('rejects empty and stale Codex wrappers by field', async () => {
    const target = await root();
    await Promise.all([
      writeFile(join(target, 'aiwg-model-reasoning-worker.toml'), codex('aiwg-model-reasoning-worker', 'reasoning-stale', 'high')),
      writeFile(join(target, 'aiwg-model-coding-worker.toml'), ''),
      writeFile(join(target, 'aiwg-model-efficiency-worker.toml'), codex('aiwg-model-efficiency-worker', models.efficiency, 'low')),
    ]);
    await Promise.all(MODEL_WRAPPER_DEFINITIONS.filter(item => item.readOnly).map(item =>
      writeFile(join(target, `${item.name}.toml`), codex(item.name, models[item.role], item.effort))));
    const result = await verifyModelWrapperDeployment(target, { provider: 'codex', models });
    expect(result.valid).toBe(false);
    expect(result.mismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ wrapper: 'aiwg-model-reasoning-worker', field: 'model', expected: models.reasoning, actual: 'reasoning-stale' }),
      expect.objectContaining({ wrapper: 'aiwg-model-coding-worker', field: 'content' }),
    ]));
  });

  it('validates Claude semantic aliases and canonical role metadata', async () => {
    const target = await root();
    await Promise.all(MODEL_WRAPPER_DEFINITIONS.map(({name: wrapper, role, tier}) => {
      const model = { reasoning: 'opus', coding: 'sonnet', efficiency: 'haiku' }[role];
      return writeFile(join(target, `${wrapper}.md`), [
        '---', `name: ${wrapper}`, `model: ${model}`, `model-role: ${role}`, `model-tier: ${tier}`, 'tools: [Read, Grep, Glob, Bash]', '---', '# Wrapper', 'WorkerClaims: criterion evidence verdict. Stop rules', '',
      ].join('\n'));
    }));
    const result = await verifyModelWrapperDeployment(target, { provider: 'claude', models });
    expect(result.valid).toBe(true);
  });

  it('finds Copilot wrappers deployed with the .agent.md suffix', async () => {
    const target = await root();
    await Promise.all(MODEL_WRAPPER_DEFINITIONS.map(({name: wrapper, role}) => {
      return writeFile(join(target, `${wrapper}.agent.md`), [
        '---', `name: ${wrapper}`, `description: AIWG ${role} worker`, 'tools: [search/codebase, terminal]', '---', '# Wrapper', 'WorkerClaims: criterion evidence verdict. Stop rules', '',
      ].join('\n'));
    }));
    const result = await verifyModelWrapperDeployment(target, { provider: 'copilot', models });
    expect(result.missing).toEqual([]);
    expect(result.found).toHaveLength(5);
    expect(result.mismatches).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it.each(['Write', 'Edit', 'Task', 'Agent', 'apply_patch', 'write_to_file', 'replace_file_content', 'write_file', 'edit_file'])
  ('rejects a mutating or delegating read-only tool: %s', async tool => {
    const target = await root();
    await writeFile(join(target, 'aiwg-model-explorer.md'), [
      '---', 'name: aiwg-model-explorer', 'model: haiku', 'model-role: efficiency',
      'model-tier: economy', `tools: [Read, ${tool}]`, '---',
      'WorkerClaims: criterion evidence verdict. Stop rules', '',
    ].join('\n'));
    const result = await verifyModelWrapperDeployment(target, { provider: 'claude', models });
    expect(result.mismatches).toContainEqual(expect.objectContaining({
      wrapper: 'aiwg-model-explorer', field: 'tools', reason: 'read-only wrapper exposes mutation or delegation tools',
    }));
  });

  it.each([
    ['sandbox_mode = "workspace-write"', 'sandbox_mode'],
    ['model = "gpt-6-astra"', 'model'],
    ['developer_instructions = "No return contract"', 'return-contract'],
  ])('rejects an unsafe or incomplete Codex explorer: %s', async (replacement, field) => {
    const target = await root();
    const key = replacement.split(' = ')[0];
    const content = codex('aiwg-model-explorer', models.efficiency, 'low')
      .replace(new RegExp(`^${key} = .*$`, 'm'), replacement);
    await writeFile(join(target, 'aiwg-model-explorer.toml'), content);
    const result = await verifyModelWrapperDeployment(target, { provider: 'codex', models });
    expect(result.mismatches).toContainEqual(expect.objectContaining({ wrapper: 'aiwg-model-explorer', field }));
  });

  it('reports an agent-less provider as unsupported without false pinning', async () => {
    const result = await verifyModelWrapperDeployment(null);
    expect(result.supported).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.missing).toHaveLength(5);
  });

  const md = (fm: string[], body = 'WorkerClaims: criterion evidence verdict. Stop rules') => ['---', ...fm, '---', body, ''].join('\n');
  const verify = async (file: string, content: string, provider: string) => {
    const target = await root();
    await writeFile(join(target, file), content);
    return (await verifyModelWrapperDeployment(target, { provider, models })).mismatches;
  };

  it('flags malformed artifacts that carry no parseable metadata', async () => {
    expect(await verify('aiwg-model-coding-worker.md', '# no front matter', 'claude')).toEqual([
      expect.objectContaining({ wrapper: 'aiwg-model-coding-worker', field: 'format' }),
    ]);
    expect(await verify('aiwg-model-coding-worker.json', '{not json', 'claude'))
      .toContainEqual(expect.objectContaining({ field: 'format' }));
    expect(await verify('aiwg-model-coding-worker.json', '"text"', 'claude'))
      .toContainEqual(expect.objectContaining({ field: 'format' }));
    expect(await verify('aiwg-model-coding-worker.json', '[1]', 'claude'))
      .toContainEqual(expect.objectContaining({ field: 'format' }));
    expect(await verify('aiwg-model-coding-worker.md', '---\njust text\n---\n', 'claude'))
      .toContainEqual(expect.objectContaining({ field: 'format' }));
  });

  it('accepts JSON artifacts and reports identity, role and tier drift', async () => {
    const mismatches = await verify('aiwg-model-coding-worker.json', JSON.stringify({
      name: 'other', model: 'sonnet', 'model-role': 'reasoning', 'model-tier': 'premium',
    }), 'claude');
    expect(mismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'name', expected: 'aiwg-model-coding-worker', actual: 'other' }),
      expect.objectContaining({ field: 'model-role', expected: 'coding', actual: 'reasoning' }),
      expect.objectContaining({ field: 'model-tier', expected: 'standard', actual: 'premium' }),
    ]));
  });

  it('requires Claude role and tier metadata and a role-matching model', async () => {
    const mismatches = await verify('aiwg-model-coding-worker.md', md(['name: aiwg-model-coding-worker', 'model: haiku']), 'claude');
    expect(mismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'model', expected: expect.stringContaining('sonnet'), actual: 'haiku' }),
      expect.objectContaining({ field: 'model-role', reason: 'Claude wrapper is missing its canonical role' }),
      expect.objectContaining({ field: 'model-tier', reason: 'Claude wrapper is missing its canonical tier' }),
    ]));
  });

  it('rejects flagship models and allows the standard fallback for read-only economy wrappers', async () => {
    const flagship = await verify('aiwg-model-coding-worker.md',
      md(['name: aiwg-model-coding-worker', 'model: gpt-6-astra', 'model-role: coding', 'model-tier: standard']), 'claude');
    expect(flagship).toContainEqual(expect.objectContaining({
      field: 'model', reason: 'wrapper model is flagship; wrappers cannot elect flagship', actual: 'gpt-6-astra',
    }));
    const fallback = md(['name: aiwg-model-explorer', 'model: sonnet', 'model-role: efficiency', 'model-tier: standard',
      'tools: [Read, Grep, Glob, Bash]']);
    expect((await verify('aiwg-model-explorer.md', fallback, 'claude')).map(item => item.field)).not.toContain('model-tier');
    const stale = fallback.replace('model-tier: standard', 'model-tier: premium');
    expect(await verify('aiwg-model-explorer.md', stale, 'claude'))
      .toContainEqual(expect.objectContaining({ field: 'model-tier', expected: 'economy', actual: 'premium' }));
    const writer = md(['name: aiwg-model-efficiency-worker', 'model: haiku', 'model-role: efficiency', 'model-tier: standard']);
    expect(await verify('aiwg-model-efficiency-worker.md', writer, 'claude'))
      .toContainEqual(expect.objectContaining({ field: 'model-tier', expected: 'economy', actual: 'standard' }));
  });

  it('requires and constrains read-only tool allowlists per provider', async () => {
    const base = ['name: aiwg-model-explorer'];
    expect(await verify('aiwg-model-explorer.md', md(base), 'claude'))
      .toContainEqual(expect.objectContaining({ field: 'tools', reason: 'read-only wrapper is missing its explicit tool allowlist' }));
    expect(await verify('aiwg-model-explorer.md', md([...base, 'tools: Read Grep']), 'claude'))
      .toContainEqual(expect.objectContaining({ field: 'tools', reason: 'read-only wrapper tools differ from the provider allowlist' }));
    expect(await verify('aiwg-model-explorer.md', md([...base, 'tools: Read, Grep, Glob, Bash']), 'claude'))
      .not.toContainEqual(expect.objectContaining({ field: 'tools' }));
    expect(await verify('aiwg-model-explorer.md', md([...base, 'tools: [Read, Grep, Glob, Bash, Extra]']), 'claude'))
      .toContainEqual(expect.objectContaining({ field: 'tools', reason: 'read-only wrapper tools differ from the provider allowlist' }));
  });

  it('enforces OpenCode permissions, Cursor read-only and the return contract', async () => {
    const opencodeBad = md(['permission:', '  edit: deny', '  task: allow']);
    expect(await verify('aiwg-model-explorer.md', opencodeBad, 'opencode'))
      .toContainEqual(expect.objectContaining({ field: 'permission' }));
    const opencodeGood = md(['permission:', '  edit: deny', '  task: deny', "  '*': deny"]);
    expect(await verify('aiwg-model-explorer.md', opencodeGood, 'opencode')).toEqual([]);
    expect(await verify('aiwg-model-explorer.md', md(['name: aiwg-model-explorer', 'readonly: false']), 'cursor'))
      .toContainEqual(expect.objectContaining({ field: 'readonly' }));
    expect(await verify('aiwg-model-explorer.md', md(['name: aiwg-model-explorer', 'readonly: true']), 'cursor'))
      .not.toContainEqual(expect.objectContaining({ field: 'readonly' }));
    expect(await verify('aiwg-model-explorer.md', md(['name: aiwg-model-explorer', 'readonly: true'], 'no contract'), 'cursor'))
      .toContainEqual(expect.objectContaining({ field: 'return-contract' }));
  });

  it('identifies Devin Desktop wrappers from a section heading when metadata is absent', async () => {
    const body = '### aiwg-model-explorer\nWorkerClaims: criterion evidence verdict. Stop rules\n';
    const target = await root();
    await writeFile(join(target, 'aiwg-model-explorer.md'), body);
    expect((await verifyModelWrapperDeployment(target, { provider: 'devin', models })).mismatches).toEqual([]);
    const other = await root();
    await writeFile(join(other, 'aiwg-model-explorer.md'), body);
    expect((await verifyModelWrapperDeployment(other, { provider: 'claude', models })).mismatches)
      .toContainEqual(expect.objectContaining({ field: 'format' }));
  });

  it('accepts an OpenCode wrapper whose name comes from its filename and reports Codex gaps', async () => {
    expect(await verify('aiwg-model-coding-worker.md', md(['description: x']), 'opencode')).toEqual([]);
    const codexMissing = await verify('aiwg-model-coding-worker.toml', 'name = "aiwg-model-coding-worker"\n', 'codex');
    expect(codexMissing).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'model', reason: 'Codex wrapper has no exact model pin', expected: 'coding-current' }),
      expect.objectContaining({ field: 'model_reasoning_effort', expected: 'medium' }),
      expect.objectContaining({ field: 'developer_instructions' }),
    ]));
  });

  it('reports duplicate wrapper artifacts and missing wrappers', async () => {
    const target = await root();
    await mkdir(join(target, 'a'));
    await writeFile(join(target, 'aiwg-model-coding-worker.md'), md(['name: aiwg-model-coding-worker']));
    await writeFile(join(target, 'a', 'aiwg-model-coding-worker.yaml'), md(['name: aiwg-model-coding-worker']));
    const result = await verifyModelWrapperDeployment(target, { provider: 'opencode', models });
    expect(result.valid).toBe(false);
    expect(result.found).toEqual(['aiwg-model-coding-worker']);
    expect(result.missing).toHaveLength(4);
    expect(result.mismatches).toContainEqual(expect.objectContaining({
      field: 'path', reason: expect.stringContaining('multiple deployed wrapper artifacts found'),
    }));
  });

  it('treats an unreadable agents directory as having no wrappers', async () => {
    const result = await verifyModelWrapperDeployment(join(await root(), 'does-not-exist'), { provider: 'codex', models });
    expect(result).toMatchObject({ supported: true, valid: false, found: [] });
    expect(result.missing).toHaveLength(5);
  });
});
