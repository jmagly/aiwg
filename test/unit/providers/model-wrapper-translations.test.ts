// Provider goldens exercise real translators and temp-only deployment of all five wrappers.
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { load } from 'js-yaml';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { wrapperControls } from '../../../src/models/wrapper-enforcement.js';
import { MODEL_WRAPPER_DEFINITIONS } from '../../../src/models/wrapper-definitions.js';
import { loadProviderModelCatalog } from '../../../src/models/catalog-policy.js';
import { verifyModelWrapperDeployment } from '../../../src/models/wrapper-deployment.js';
import { isFlagshipModel } from '../../../src/models/tiers.js';

const providers = ['claude', 'codex', 'copilot', 'cursor', 'factory', 'opencode', 'omp',
  'antigravity', 'grok-build', 'openclaw', 'warp', 'windsurf'];
// Independent format expectations: do not derive these from the translators under test.
const nativeControls: Record<string, { model?: string; effort?: string }> = {
  claude: { model: 'model', effort: 'effort' },
  codex: { model: 'model', effort: 'model_reasoning_effort' },
  factory: { model: 'model', effort: 'reasoningEffort' },
  omp: { model: 'model', effort: 'thinkingLevel' },
  cursor: { model: 'model' }, copilot: { model: 'model' }, opencode: { model: 'model' },
};
const references = ['hermes', 'muse', 'pi', 'deepseek-harness', 'grokbot', 'openhuman'];
const effortKeys = ['effort', 'model-effort', 'model_reasoning_effort', 'reasoningEffort', 'thinkingLevel'];
const toml = (text: string) => getStaticTOMLValue(parseTOML(text)) as Record<string, any>;
function serialized(provider: string, output: string) {
  if (provider === 'codex') {
    const fields = toml(output);
    return { fields, body: fields.developer_instructions as string };
  }
  if (provider === 'windsurf') {
    const capabilities = output.match(/<capabilities>\n([\s\S]*?)\n<\/capabilities>/)![1];
    expect(capabilities.split('\n').every(line => /^- \S+$/.test(line))).toBe(true);
    return { fields: { capabilities: capabilities.split('\n').map(line => line.slice(2)) }, body: output };
  }
  return { fields: metadata(output), body: output.split(/\n---\n/).slice(1).join('\n---\n') };
}
function expectedCapabilities(provider: string, readOnly: boolean) {
  const tools = readOnly ? ['Read', 'Grep', 'Glob', 'Bash'] : ['Bash', 'Read', 'Write', 'Edit', 'Grep'];
  if (provider === 'codex') return { tools: undefined, sandbox_mode: readOnly ? 'read-only' : undefined };
  if (provider === 'opencode') return { permission: readOnly
    ? { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', bash: 'ask', edit: 'deny', task: 'deny' }
    : { bash: { 'aiwg *': 'allow', 'git status': 'allow', 'git diff': 'allow', 'git log*': 'allow',
      'npm test': 'allow', 'npm run *': 'allow', 'git push': 'ask', 'rm -rf': 'deny', '*': 'ask' } } };
  if (provider === 'factory') return { tools: readOnly ? ['Execute', 'Glob', 'Grep', 'Read'] : ['Create', 'Edit', 'Execute', 'Grep', 'Read'] };
  if (provider === 'copilot') return { tools: readOnly ? ['search/codebase', 'terminal'] : ['terminal', 'search/codebase', 'edit'] };
  if (provider === 'antigravity') return { tools: readOnly ? ['view_file', 'grep_search', 'run_command']
    : ['run_command', 'view_file', 'write_to_file', 'replace_file_content', 'grep_search'] };
  if (provider === 'omp') return { tools: tools.map(tool => tool.toLowerCase()) };
  if (provider === 'grok-build') return { tools: undefined };
  if (provider === 'windsurf') return { capabilities: tools };
  return { tools };
}
function expectControls(provider: string, fields: Record<string, any>, model?: string, effort?: string) {
  const controls = nativeControls[provider] ?? {};
  expect(wrapperControls(provider)).toEqual(controls);
  expect(fields.model).toBe(model);
  for (const key of effortKeys) expect(fields[key], `${provider}.${key}`).toBe(key === controls.effort ? effort : undefined);
}
const roots: string[] = [];
const catalog = loadProviderModelCatalog();
const source = (name: string) => join(process.cwd(), 'agentic/code/addons/aiwg-utils/agents', `${name}.md`);
const metadata = (text: string) => load(text.match(/^---\n([\s\S]*?)\n---/)![1]) as Record<string, any>;
function expectWorkerBoundaries(text: string) {
  expect(text).toContain('## Worker boundaries');
  expect(text).toContain('child allowance is zero');
  expect(text).toContain('Write only allowed artifacts');
  expect(text).toContain('bounded blocked result');
}
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function translator(provider: string) {
  const adapter = await import(`../../../tools/agents/providers/${provider}.mjs`);
  return { adapter, translate: provider === 'grok-build' ? adapter.compileGrokAgent : adapter.transformAgent };
}

describe('model wrapper provider translations', () => {
  it('OpenHuman harness wrappers use semantic hints and native read-only isolation', async () => {
    const { deployOpenHumanHarnessAgents } = await import('../../../src/cli/handlers/use.js');
    const root = await mkdtemp(join(tmpdir(), 'aiwg-openhuman-wrapper-')); roots.push(root);
    vi.stubEnv('OPENHUMAN_HOME', join(root, 'home'));
    const result = await deployOpenHumanHarnessAgents({ frameworkRoot: process.cwd(), target: root,
      selectors: MODEL_WRAPPER_DEFINITIONS.map(wrapper => wrapper.name), scope: 'user' });
    expect(result.emitted).toBe(5);
    for (const wrapper of MODEL_WRAPPER_DEFINITIONS) {
      const text = await readFile(join(root, 'home/agents', `aiwg_${wrapper.name.replaceAll('-', '_')}.toml`), 'utf8');
      const fields = toml(text);
      expect(fields.model).toEqual({ hint: wrapper.role });
      expect(fields.model_reasoning_effort).toBeUndefined();
      if (wrapper.name.endsWith('-worker')) expectWorkerBoundaries(fields.system_prompt.inline);
      expect(fields.sandbox_mode).toBe(wrapper.readOnly ? 'read_only' : 'none');
      expect(text).toContain('WorkerClaims');
      expect(text).toContain('Stop rules');
      if (wrapper.readOnly) {
        expect(text).toContain('sandbox_mode = "read_only"');
        expect(text).toContain('max_turn_output_tokens = 1000');
        expect(text).toContain('never silently inherit flagship');
      }
    }
  });

  it.each([
    ['factory', /^tools: \[".*"\]$/m],
    ['copilot', /^tools: \['.*'\]$/m],
  ] as const)('%s wrappers keep the translator\'s inline tools format', async (provider, pattern) => {
    const { translate } = await translator(provider);
    for (const wrapper of MODEL_WRAPPER_DEFINITIONS) {
      const output = translate(source(wrapper.name), await readFile(source(wrapper.name), 'utf8'), { modelCatalog: catalog, quiet: true });
      expect(output.match(/^---\n([\s\S]*?)\n---/)![1]).toMatch(pattern);
      expect(Array.isArray(metadata(output).tools)).toBe(true);
      if (provider === 'factory') {
        const tools = JSON.parse(output.match(/^tools: (\[.*\])$/m)![1]);
        expect(tools).toEqual(metadata(output).tools);
        expect(tools.length).toBeGreaterThan(0);
      }
    }
  });

  it.each(providers)('%s serialization retains exact capabilities and the Worker boundaries section', async provider => {
    const { translate } = await translator(provider);
    for (const wrapper of MODEL_WRAPPER_DEFINITIONS) {
      const input = await readFile(source(wrapper.name), 'utf8');
      const output = translate(source(wrapper.name), input, { modelCatalog: catalog, quiet: true });
      const { fields, body } = serialized(provider, output);
      for (const [key, value] of Object.entries(expectedCapabilities(provider, wrapper.readOnly))) {
        expect(fields[key], `${provider}.${wrapper.name}.${key}`).toEqual(value);
      }
      if (wrapper.name.endsWith('-worker')) {
        expectWorkerBoundaries(body);
        const section = input.match(/## Worker boundaries\n[\s\S]*?(?=\n## |$)/)![0].trim();
        expect(body).toContain(section);
      }
    }
  });

  it.each(providers)('%s serializes explicit pins and effort only through supported native controls', async provider => {
    const { translate } = await translator(provider);
    const controls = nativeControls[provider] ?? {};
    for (const wrapper of MODEL_WRAPPER_DEFINITIONS) {
      // Exercise an explicit operator selector even for OMP's placeholder catalog defaults.
      for (const effortKey of effortKeys) {
        const input = requireSource(wrapper.name).replace(/^(model:.*)$/m, `$1\n${effortKey}: low`);
        const output = translate(source(wrapper.name), input, { modelCatalog: catalog, quiet: true,
          ...(controls.model ? { [`${wrapper.role}Model`]: 'operator/model-v42' } : {}) });
        expectControls(provider, serialized(provider, output).fields, controls.model ? 'operator/model-v42' : undefined,
          controls.effort ? 'low' : undefined);
      }
    }
  });

  it.each(Object.keys(nativeControls))('%s keeps an unknown source model pin as written', async provider => {
    const { translate } = await translator(provider);
    for (const wrapper of MODEL_WRAPPER_DEFINITIONS) {
      const input = requireSource(wrapper.name).replace(/^model:.*$/m, 'model: vendor/future-model-v42\nmodel-effort: high');
      const output = translate(source(wrapper.name), input, { modelCatalog: catalog, quiet: true });
      expectControls(provider, serialized(provider, output).fields, 'vendor/future-model-v42',
        nativeControls[provider].effort ? 'high' : undefined);
    }
  });

  it.each(['antigravity', 'openclaw', 'warp', 'windsurf'])('%s omits unsupported native pins for unknown source models', async provider => {
    const { translate } = await translator(provider);
    for (const wrapper of MODEL_WRAPPER_DEFINITIONS) {
      const input = requireSource(wrapper.name).replace(/^model:.*$/m, 'model: vendor/future-model-v42');
      const output = translate(source(wrapper.name), input, { modelCatalog: catalog, quiet: true });
      expectControls(provider, serialized(provider, output).fields);
    }
  });

  it('Grok Build rejects ignored exact pins and keeps selection on worker CLI -m', async () => {
    const { translate } = await translator('grok-build');
    const input = requireSource('aiwg-model-coding-worker');
    expect(() => translate(source('aiwg-model-coding-worker'),
      input.replace(/^model:.*$/m, 'model: vendor/future-model-v42'), { modelCatalog: catalog, quiet: true }))
      .toThrow(/exact model pin.*-m/);
    expect(() => translate(source('aiwg-model-coding-worker'), input,
      { codingModel: 'vendor/future-model-v42', modelCatalog: catalog, quiet: true })).toThrow(/-m/);
    const output = translate(source('aiwg-model-coding-worker'), input, { modelCatalog: catalog, quiet: true });
    expect(Object.keys(metadata(output))).toEqual(['name', 'description']);
    expect(output).toContain('frontmatter model is ignored');
    expect(output).toContain('Tier enforcement: inherited');
  });

  it.each(references)('%s has a reference translation, without native wrapper pin controls', async provider => {
    const { adapter, translate } = await translator(provider);
    expect(wrapperControls(provider)).toEqual({});
    for (const wrapper of MODEL_WRAPPER_DEFINITIONS) {
      const input = requireSource(wrapper.name);
      const output = translate(source(wrapper.name), input, { modelCatalog: catalog, quiet: true });
      expect(output).toBe(input);
      expect(metadata(output).tools).toEqual(metadata(input).tools);
      if (wrapper.name.endsWith('-worker')) expectWorkerBoundaries(serialized(provider, output).body);
    }
    // Indexed/skill-only providers emit no native agent files. Hermes does not export this writer.
    if (provider !== 'hermes') {
      const root = await mkdtemp(join(tmpdir(), 'aiwg-wrapper-reference-')); roots.push(root);
      expect(adapter.deployAgents(MODEL_WRAPPER_DEFINITIONS.map(item => source(item.name)), root, { quiet: true })).toBe(0);
      expect(await readdir(root)).toEqual([]);
    }
  });

  it.each(providers)('%s golden: all wrappers retain contract, role tier and safe capabilities', async provider => {
    const { adapter, translate } = await translator(provider);
    const outputs: Record<string, unknown> = {};
    for (const wrapper of MODEL_WRAPPER_DEFINITIONS) {
      const text = await readFile(source(wrapper.name), 'utf8');
      const output = translate(source(wrapper.name), text, { modelCatalog: catalog, quiet: true });
      expect(output).toContain('WorkerClaims');
      expect(output).toContain('Stop rules');
      const fields = provider === 'codex' ? Object.fromEntries(Object.entries(toml(output))
        .filter(([key]) => ['name', 'model', 'model_reasoning_effort', 'sandbox_mode'].includes(key)))
        : provider === 'windsurf' ? { capabilities: output.match(/<capabilities>([\s\S]*?)<\/capabilities>/)?.[1] }
        : metadata(output);
      if (wrapper.readOnly) {
        if (provider === 'codex') expect(fields.sandbox_mode).toBe('read-only');
        else if (provider === 'opencode') expect(fields.permission).toEqual({ '*': 'deny', read: 'allow',
          grep: 'allow', glob: 'allow', bash: 'ask', edit: 'deny', task: 'deny' });
        else if (provider === 'cursor') expect(fields.readonly).toBe(true);
        if (fields.tools) expect(String(fields.tools)).not.toMatch(/(?:^|,)(?:Write|Edit|Create|Task|Agent|write|edit|task)(?:,|$)/);
        if (provider === 'antigravity') expect(fields.tools).toEqual(['view_file', 'grep_search', 'run_command']);
        if (provider === 'copilot') expect(fields.tools).toEqual(['search/codebase', 'terminal']);
        if (provider === 'omp') expect(fields.tools).toEqual(['read', 'grep', 'glob', 'bash']);
        if (provider === 'factory') expect(fields.tools).toEqual(['Execute', 'Glob', 'Grep', 'Read']);
        if (provider === 'windsurf') expect(fields.capabilities).toBe('\n- Read\n- Grep\n- Glob\n- Bash\n');
      }
      if (fields.model) {
        expect(isFlagshipModel(String(fields.model))).toBe(false);
        expect(fields.model).not.toBe('auto');
      } else expect(output).toContain('stop unless the conductor confirms the required non-flagship session');
      outputs[wrapper.name] = { ...fields, contract: 'WorkerClaims: criterion + evidence + verdict; stop rules' };
    }
    await expect(JSON.stringify(outputs, null, 2) + '\n').toMatchFileSnapshot(`../../fixtures/model-wrappers/${provider}.golden.json`);
    // Warp uses aggregate context only. All other adapters deploy discrete mirrors or native agents.
    if (typeof adapter.deployAgents !== 'function' || provider === 'warp') return;
    const root = await mkdtemp(join(tmpdir(), 'aiwg-wrapper-matrix-')); roots.push(root);
    adapter.deployAgents(MODEL_WRAPPER_DEFINITIONS.map(item => source(item.name)), root,
      { provider, modelCatalog: catalog, quiet: true, dryRun: false, force: true });
    const destination = join(root, adapter.paths.agents);
    const files = await readdir(destination);
    expect(files.filter(file => /\.(?:md|toml)$/.test(file))).toHaveLength(5);
    for (const file of files.filter(file => /\.(?:md|toml)$/.test(file))) {
      const text = await readFile(join(destination, file), 'utf8');
      const { fields, body } = serialized(provider, text);
      const extension = provider === 'codex' ? '.toml' : provider === 'copilot' ? '.agent.md' : '.md';
      const wrapper = MODEL_WRAPPER_DEFINITIONS.find(item => file === `${item.name}${extension}`)!;
      expect(wrapper).toBeDefined();
      for (const [key, value] of Object.entries(expectedCapabilities(provider, wrapper.readOnly))) {
        expect(fields[key], `${provider}.${file}.${key}`).toEqual(value);
      }
      if (file.includes('-worker')) expectWorkerBoundaries(body);
      if (provider === 'factory') {
        expect(text).toMatch(/^tools: \[".*"\]$/m);
        expect(JSON.parse(text.match(/^tools: (\[.*\])$/m)![1])).toEqual(metadata(text).tools);
      }
    }
    const result = await verifyModelWrapperDeployment(destination, { provider,
      models: Object.fromEntries(Object.entries(catalog.providers[provider].roles).map(([role, model]) => [role, model.id])) });
    expect(result.missing).toEqual([]);
    expect(result.mismatches).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it.each(providers)('%s refuses a flagship role override without election', async provider => {
    const { translate } = await translator(provider);
    for (const wrapper of MODEL_WRAPPER_DEFINITIONS) {
      expect(() => translate(source(wrapper.name), requireSource(wrapper.name), {
        modelCatalog: catalog, [`${wrapper.role}Model`]: 'gpt-6-astra', quiet: true,
      })).toThrow(/user-elected only/);
    }
  });

  it('refuses a catalog flagship disguised behind an economy tier', async () => {
    const { translate } = await translator('codex');
    const poisoned = structuredClone(catalog);
    poisoned.providers.codex.tiers!.economy = { id: 'synthetic-elected', status: 'active', selection: 'user-elected' };
    expect(() => translate(source('aiwg-model-explorer'), requireSource('aiwg-model-explorer'), {
      modelCatalog: poisoned,
    })).toThrow(/user-elected only/);
  });

  it('uses the standard catalog pin when Cursor economy would select auto', async () => {
    const { translate } = await translator('cursor');
    const output = translate(source('aiwg-model-explorer'), requireSource('aiwg-model-explorer'), { modelCatalog: catalog });
    const fields = metadata(output);
    expect(fields.model).toBe(catalog.providers.cursor.tiers?.standard.id ?? catalog.providers.cursor.roles.coding.id);
    expect(fields['model-tier']).toBe('standard');
  });
});

import { readFileSync } from 'node:fs';
function requireSource(name: string) { return readFileSync(source(name), 'utf8'); }
