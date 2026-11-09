// Offline public-CLI audit of the issue #3935 harness inventory and deployment contract.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

const root = path.resolve(import.meta.dirname, '../..');
const providers = ['antigravity', 'claude', 'codex', 'copilot', 'cursor', 'deepseek-harness',
  'factory', 'grokbot', 'grok-build', 'hermes', 'muse', 'opencode', 'openclaw',
  'openhuman', 'pi', 'omp', 'warp', 'windsurf'];
const kernels = ['skill-discovery', 'artifact-output-policy'];
const cores = ['anti-laziness', 'no-attribution'];
const hooks: Record<string, string> = {
  claude: '.claude/settings.json', codex: '.codex/hooks.json',
  muse: '.muse/hooks.json', factory: '.factory/hooks.json',
};
let scratch: string | undefined;
afterEach(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function fixture() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-harness-audit-'));
  const project = path.join(scratch, 'project');
  const home = path.join(scratch, 'home');
  fs.mkdirSync(project);
  fs.mkdirSync(home);
  // Deliberately do not inherit provider credentials, HOME overrides or channel pointers.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state'),
    TMPDIR: scratch, AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1',
    NODE_DISABLE_COMPILE_CACHE: '1',
  };
  for (const key of ['AIWG_RULE_BINDING_INDEX_CACHE', 'AIWG_FRAMEWORK_INDEX_CACHE',
    'AIWG_FRAMEWORK_INDEX_CACHE_SOURCE']) env[key] = process.env[key];
  const invoke = (args: string[]) => spawnSync(process.execPath, args, {
      cwd: project, env, encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    });
  const run = (args: string[]) => {
    const result = invoke(args);
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  };
  const cli = (...args: string[]) => run([path.join(root, 'bin/aiwg.mjs'), ...args]);
  const resolve = (file: string) => file.startsWith('~/') ? path.join(home, file.slice(2))
    : path.isAbsolute(file) ? file : path.join(project, file);
  const read = (file: string) => fs.readFileSync(resolve(file), 'utf8');
  return { project, home, invoke, run, cli, resolve, read };
}

function snapshot(directory: string): Record<string, string> {
  return Object.fromEntries([[directory, `directory:${fs.statSync(directory).mtimeMs}`],
    ...fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(file))
      : [[file, `${fs.statSync(file).mtimeMs}:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`]];
  })]);
}

describe.each(providers)('%s offline harness bootstrap audit', provider => {
  it('deploys bootstrap, four requested rules, skills and supported prompt hooks; refresh has no drift', () => {
    const f = fixture();
    // Resolve the registry in the same isolated environment as deployment, including home paths.
    const registry = JSON.parse(f.run(['--input-type=module', '-e',
      `import { listProviderDefinitions } from ${JSON.stringify(path.join(root, 'dist/src/providers/provider-definitions.js'))};
       console.log(JSON.stringify(listProviderDefinitions()));`]));
    const definition = registry.find((item: { id: string }) => item.id === provider);
    expect(definition).toBeDefined();
    expect(fs.existsSync(path.join(root, 'tools/agents/providers', `${provider}.mjs`))).toBe(true);
    f.cli('use', 'all', '--provider', provider,
      ...(definition.context.promptDiscovery?.optIn ? ['--enable-cross-provider-hooks'] : []));

    const bootstraps: string[] = provider === 'openclaw'
      ? ['~/.openclaw/workspace/AGENTS.md'] : definition.context.bootstrapTargets;
    for (const file of bootstraps) {
      const text = f.read(file);
      expect.soft(text, file).toContain('WORKSPACE.md');
      expect.soft(text, file).toContain('AIWG.md');
      expect.soft(text, file).toMatch(/read|load|@WORKSPACE/i);
    }
    expect(f.read('WORKSPACE.md')).toContain('Precedence');
    expect(f.read('AIWG.md')).toContain('skill-discovery');
    if (['copilot', 'grok-build', 'hermes'].includes(provider)) {
      const delivery = definition.context.promptDiscovery;
      expect(delivery).toBeDefined();
      for (const file of delivery.files) expect(fs.existsSync(f.resolve(file)), file).toBe(true);
      if (provider === 'hermes') {
        expect(delivery.delivery).toBe('hook-bridge');
        expect(delivery.optIn).toBe(true);
        expect(delivery.event).toBe('pre_llm_call');
        const doc = parseYaml(f.read(delivery.files[0]));
        expect(doc.hooks[delivery.event]).toEqual([expect.objectContaining({
          command: expect.stringContaining(delivery.files[1]), timeout: 2,
        })]);
        expect(f.read(delivery.files[1])).toBe(fs.readFileSync(path.join(root,
          'agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs'), 'utf8'));
      } else {
        expect(delivery.delivery).toBe('bootstrap-rule');
        expect(bootstraps).toEqual(expect.arrayContaining(delivery.files));
        for (const file of delivery.files) {
          expect(f.read(file)).toContain("aiwg discover --stdin <<'AIWG_REQUEST'");
          expect(f.read(file)).toContain('Before any other tool call or answer');
        }
      }
    }

    const rules = definition.paths.artifacts.rules || `.${provider}/rules`;
    if (provider === 'copilot') {
      expect.soft(rules).toBe('.github/instructions');
      expect.soft(definition.paths.contextDiscovery.rules).toBe(rules);
      expect.soft(definition.paths.artifacts.behaviors).toBe(rules);
      expect.soft(definition.smithPaths.rules).toBe(rules);
      expect.soft(fs.existsSync(f.resolve('.github/copilot-rules'))).toBe(false);
    }
    const extension = provider === 'cursor' ? '.mdc' : '.md';
    for (const core of cores) {
      const body = fs.readFileSync(path.join(root, 'agentic/code/addons/aiwg-utils/rules', `${core}.core.md`), 'utf8').trim();
      const delivered = ['claude', 'cursor'].includes(provider)
        ? f.read(`${rules}/core-${core}${extension}`) : bootstraps.map(f.read).join('\n');
      expect.soft(delivered, `${core} compact core body`).toContain(body);
    }
    for (const kernel of kernels) {
      const file = `${rules}/${kernel}${extension}`;
      expect.soft(fs.existsSync(f.resolve(file)), file).toBe(true);
      if (fs.existsSync(f.resolve(file))) {
        expect.soft(f.read(file), file).toContain('aiwg:managed');
        expect.soft(f.read(file), file).toMatch(/activation: kernel|alwaysApply: true|trigger: always_on/);
        expect.soft(f.read(file), file).toContain(kernel === 'skill-discovery'
          ? 'aiwg discover' : 'aiwg discover "<output> template" --type template');
      }
    }
    if (definition.paths.kernelSkills) {
      const quickref = `${definition.paths.kernelSkills}/aiwg-utils-quickref/SKILL.md`;
      expect.soft(fs.existsSync(f.resolve(quickref)), 'kernel discovery quickref').toBe(true);
      if (fs.existsSync(f.resolve(quickref))) {
        const text = f.read(quickref);
        // Native transformations can quote names and drop AIWG-only kernel metadata (Codex).
        const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        expect.soft(parseYaml(header?.[1] || '')).toMatchObject({ name: 'aiwg-utils-quickref' });
        expect.soft(text).toContain('aiwg discover');
      }
    }
    // Bulk roots are opt-in (--copy-all), but must never receive the native kernel quickref.
    const bulk = provider === 'muse' ? '.agents/.aiwg/skills'
      : provider === 'grok-build' ? '.grok/.aiwg/skills' : definition.paths.artifacts.skills;
    if (bulk && bulk !== definition.paths.kernelSkills) {
      expect.soft(fs.existsSync(f.resolve(`${bulk}/aiwg-utils-quickref/SKILL.md`)),
        'kernel quickref must not be duplicated in bulk skills').toBe(false);
    }
    if (hooks[provider]) {
      const doc = JSON.parse(f.read(hooks[provider]));
      const entries = provider === 'factory' ? doc.UserPromptSubmit : doc.hooks.UserPromptSubmit;
      expect(entries).toBeInstanceOf(Array);
      expect(JSON.stringify(entries)).toContain('aiwg-prompt-discovery');
      expect(f.read(`.${provider}/hooks/aiwg-prompt-discovery.cjs`)).toBe(
        fs.readFileSync(path.join(root, 'agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs'), 'utf8'));
    } else if (provider !== 'hermes') {
      // Bridge event mappings without prompt/context transport must not install this hook.
      const files = fs.readdirSync(f.project, { recursive: true }) as string[];
      expect(files.filter(file => file.endsWith('aiwg-prompt-discovery.cjs'))).toEqual([]);
    }
    if (provider === 'factory') {
      expect(f.read('AGENTS.md')).toContain('aiwg discover --stdin');
      expect(f.read('AGENTS.md')).toContain('aiwg show template <name> --body');
    }
    const before = snapshot(scratch!);
    const refresh = f.cli('refresh', '--dry-run', '--skip-update', '--provider', provider);
    expect(refresh).toContain('All deployments up to date');
    expect(refresh).not.toContain('Stale deployment:');
    const after = snapshot(scratch!);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(file => before[file] !== after[file]).map(file => path.relative(scratch!, file));
    expect(changed, 'dry-run changed files or directories').toEqual([]);
  }, 240_000);
});

it('records generic as registry metadata without claiming a deployable harness', () => {
  const f = fixture();
  const result = f.invoke([path.join(root, 'bin/aiwg.mjs'), 'use', 'all', '--provider', 'generic']);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toContain('Unknown provider: generic');
  expect(fs.existsSync(f.resolve('skills/aiwg-utils-quickref/SKILL.md'))).toBe(false);
}, 240_000);
