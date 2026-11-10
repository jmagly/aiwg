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
  'openhuman', 'pi', 'omp', 'warp', 'windsurf', 'generic'];
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
    if (provider === 'generic') {
      expect(definition.context.bootstrapTargets).toEqual(['AGENTS.md']);
      expect(definition.context.support).toBe('degraded');
      const adapter = JSON.parse(f.run(['--input-type=module', '-e',
        `import { paths, kernelSkillsPath } from ${JSON.stringify(path.join(root, 'tools/agents/providers/generic.mjs'))};
         console.log(JSON.stringify({ paths, kernelSkillsPath }));`]));
      for (const [kind, directory] of Object.entries(adapter.paths)) {
        expect(definition.paths.artifacts[kind], kind).toBe(directory);
      }
      expect(definition.paths.kernelSkills).toBe(adapter.kernelSkillsPath);
    }
    f.cli('use', 'all', '--provider', provider,
      ...(definition.context.promptDiscovery?.optIn ? ['--enable-cross-provider-hooks'] : []));

    const bootstraps: string[] = definition.context.bootstrapTargets;
    expect(bootstraps.length, 'registry must declare deployed bootstrap files').toBeGreaterThan(0);
    if (provider === 'openclaw') {
      const workspace = path.join(f.home, '.openclaw/workspace');
      expect(bootstraps.map(f.resolve).sort()).toEqual(
        fs.readdirSync(workspace).filter(file => file.endsWith('.md'))
          .map(file => path.join(workspace, file)).sort());
    }
    for (const file of bootstraps) {
      const text = f.read(file);
      if (provider === 'openclaw' && path.basename(file) === 'SOUL.md') {
        expect(text, file).toContain('<!-- AIWG Steward Identity -->');
        expect(text, file).toContain('aiwg discover');
        continue;
      }
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
        expect(doc.hooks[delivery.event]).toEqual([expect.objectContaining({ timeout: 2 })]);
        // #4055: the command is the anchored loader, bound to the script path and its SHA-256.
        const command: string = doc.hooks[delivery.event][0].command;
        const encoded = command.match(/Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)/)?.[1];
        expect(encoded, command).toBeDefined();
        const loader = JSON.parse(Buffer.from(encoded!, 'base64').toString());
        expect(path.resolve(loader.anchor, loader.relative)).toBe(f.resolve(delivery.files[1]));
        expect(command).toContain(createHash('sha256').update(fs.readFileSync(f.resolve(delivery.files[1]))).digest('hex'));
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
    const bulk = definition.paths.artifacts.skills;
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

describe.each(['muse', 'grok-build'])('%s bulk skill registry contract (#3994)', provider => {
  it('routes opt-in bulk skills to the declared artifact root and keeps kernel skills native', () => {
    const f = fixture();
    const sources = ['audit-kernel', 'audit-standard'].map((name, index) => {
      const directory = path.join(scratch!, 'sources', name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Offline routing fixture\nkernel: ${index === 0}\n---\n\n${name}\n`);
      return directory;
    });
    const registry = JSON.parse(f.run(['--input-type=module', '-e',
      `import { getProviderDefinition } from ${JSON.stringify(path.join(root, 'dist/src/providers/provider-definitions.js'))};
       console.log(JSON.stringify(getProviderDefinition(${JSON.stringify(provider)})));`]));
    const deploy = (copyStandardSkills: boolean) => f.run(['--input-type=module', '-e',
      `import { deploySkills } from ${JSON.stringify(path.join(root, 'tools/agents/providers', `${provider}.mjs`))};
       deploySkills(${JSON.stringify(sources)}, ${JSON.stringify(f.project)},
         { provider: ${JSON.stringify(provider)}, quiet: true, copyStandardSkills: ${copyStandardSkills} });`]);

    deploy(false);
    expect(f.read(`${registry.paths.kernelSkills}/audit-kernel/SKILL.md`)).toContain('audit-kernel');
    expect(fs.existsSync(f.resolve(`${registry.paths.artifacts.skills}/audit-standard/SKILL.md`))).toBe(false);

    deploy(true);
    expect(f.read(`${registry.paths.artifacts.skills}/audit-standard/SKILL.md`)).toContain('audit-standard');
    expect(fs.existsSync(f.resolve(`${registry.paths.artifacts.skills}/audit-kernel/SKILL.md`))).toBe(false);
    expect(fs.existsSync(f.resolve(`${registry.paths.kernelSkills}/audit-standard/SKILL.md`))).toBe(false);
  });
});

it('generic deploys directly through the adapter CLI as well as public use', () => {
  const f = fixture();
  const args = [path.join(root, 'tools/agents/deploy-agents.mjs'), '--provider', 'generic',
    '--target', f.project, '--mode', 'all', '--kernel-only', '--quiet'];
  const before = { ...snapshot(f.project), ...snapshot(f.home) };
  f.run([...args, '--dry-run']);
  expect({ ...snapshot(f.project), ...snapshot(f.home) }, 'fresh dry-run must not write destinations').toEqual(before);
  f.run(args);
  expect(f.read('AGENTS.md')).toContain('rules/RULES-INDEX.md');
  expect(f.read('rules/skill-discovery.md')).toContain('aiwg discover');
  const bootstrap = f.read('AGENTS.md');
  f.run([...args, '--no-context-files']);
  expect(f.read('AGENTS.md'), 'no-context-files must preserve the bootstrap').toBe(bootstrap);
}, 240_000);

it('generic copies portable agents, commands and opt-in skills from a synthetic framework', () => {
  const f = fixture();
  const source = path.join(scratch!, 'source');
  const framework = path.join(source, 'agentic/code/frameworks/portable');
  const put = (file: string, body: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  put(path.join(source, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
  put(path.join(framework, 'manifest.json'), '{"id":"portable"}');
  put(path.join(framework, 'agents/reviewer.md'), '# Portable reviewer\n');
  put(path.join(framework, 'commands/review.md'), '# Portable review\n');
  put(path.join(framework, 'skills/review/SKILL.md'), '---\nname: review\n---\n# Portable skill\n');
  const args = [path.join(root, 'tools/agents/deploy-agents.mjs'), '--provider', 'generic',
    '--source', source, '--target', f.project, '--mode', 'all', '--deploy-commands',
    '--deploy-skills', '--skip-commands-migration', '--quiet'];
  f.run(args);
  expect(f.read('agents/reviewer.md')).toContain('# Portable reviewer');
  expect(f.read('commands/review.md')).toContain('# Portable review');
  expect(fs.existsSync(f.resolve('skills/review/SKILL.md'))).toBe(false);
  f.run([...args, '--copy-all']);
  expect(f.read('skills/review/SKILL.md')).toContain('# Portable skill');
  put(f.resolve('agents/reviewer.md'), '# Operator reviewer\n');
  f.run([...args, '--copy-all']);
  expect(f.read('agents/reviewer.md')).toBe('# Operator reviewer\n');
}, 240_000);
