/** #3035: real addon deploy pipeline with synthetic sources and isolated homes. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileWithCapture as execFileSync } from '../../../helpers/exec-file-capture.js';
import { existsSync, readdirSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { emptyConfig, readAiwgConfig, writeAiwgConfig } from '../../../../src/config/aiwg-config.js';

const { afterDeploy, afterVerification, host } = vi.hoisted(() => ({ afterDeploy: vi.fn(), afterVerification: vi.fn(), host: { fallback: false } }));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: (...args: Parameters<typeof actual.statSync>) => {
    if (host.fallback && String(args[0]).startsWith('/proc/self/fd/')) throw Object.assign(new Error('synthetic missing procfs'), { code: 'ENOENT' });
    return actual.statSync(...args);
  } };
});

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PROVIDERS = [
  'pi', 'openclaw', 'opencode', 'copilot', 'muse', 'openhuman',
  'grokbot', 'grok-build', 'deepseek-harness', 'windsurf',
] as const;

// Node's homedir() observes the parent environment in Vitest worker threads.
// Keep both import spellings aligned with the per-test JS environment that
// the real deploy subprocess inherits.
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => process.env.HOME!;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => process.env.HOME!;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('../../../../src/channel/manager.mjs', () => ({
  getFrameworkRoot: vi.fn(async () => 'mock-framework-root'),
  getVersionInfo: vi.fn(async () => ({ version: 'test', channel: 'test', devMode: true })),
}));

// Exercise the checkout's deployer while use resolves tiny synthetic addons.
vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({
  createScriptRunner: (sourceRoot: string) => ({
    run: async (script: string, args: string[] = []) => {
      try {
        if (!args.includes('--source')) args = [...args, '--source', sourceRoot];
        const targetIndex = args.indexOf('--target');
        execFileSync(process.execPath, [join(REPO_ROOT, script), ...args], {
          cwd: args[targetIndex + 1], stdio: 'pipe', env: process.env, timeout: 60_000,
        });
        await afterDeploy(args);
        return { exitCode: 0 };
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        return { exitCode: typeof status === 'number' ? status : 1, message: (error as Error).message };
      }
    },
  }),
}));

async function interceptVerification(): Promise<void> {
  const verification = await import('../../../../src/cli/services/deployment-verification.js');
  const original = verification.verifyProviderDeployment;
  vi.spyOn(verification, 'verifyProviderDeployment').mockImplementation(async options => {
    const result = await original(options);
    await afterVerification(result);
    return result;
  });
}

// Redirect every provider config/home override, including overrides belonging
// to adapters eagerly imported by the deployer. Never inspect the real home.
const ISOLATED_ENV = [
  'HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'CODEX_HOME', 'HERMES_HOME', 'OPENHUMAN_HOME', 'OPENCLAW_HOME', 'GROK_HOME', 'DSH_HOME',
  'PI_CODING_AGENT_DIR', 'OMP_CODING_AGENT_DIR', 'AIWG_GROKBOT_SKILLS_DIR',
] as const;
const UNSET_ENV = ['AIWG_ROOT', 'AIWG_HOME', 'OPENCLAW_PROFILE', 'AIWG_USER_REGISTRY_PATH'] as const;

function write(root: string, relative: string, content: string): void {
  const destination = join(root, relative);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function writeSources(root: string): void {
  mkdirSync(join(root, 'agentic/code/frameworks'), { recursive: true });
  write(root, 'agentic/code/providers/model-catalog.v1.json', JSON.stringify({
    version: '1.0.0', refreshedAt: '2026-10-12',
    providers: Object.fromEntries(PROVIDERS.map(provider => [provider, { roles: {} }])),
  }));
  // The harness deployer expects its shipped patch to be present.
  write(root, 'agentic/code/providers/deepseek-harness/aiwg.cordis.patch.yml', '# synthetic patch\n');
  const addons = 'agentic/code/addons';
  write(root, `${addons}/aiwg-utils/manifest.json`, JSON.stringify({ id: 'aiwg-utils', version: '1.0.0' }));
  write(root, `${addons}/aiwg-utils/skills/sess-probe/SKILL.md`,
    '---\nnamespace: aiwg\nname: sess-probe\nplatforms: [all]\ndescription: synthetic session probe\nmetadata:\n  entrypoint: session-entry.md\n---\n\nProbe [recipe](references/recipes.md).\n');
  write(root, `${addons}/aiwg-utils/skills/sess-probe/session-entry.md`, '# synthetic entrypoint\n');
  write(root, `${addons}/aiwg-utils/skills/sess-probe/references/recipes.md`, '# synthetic recipes\n');
  write(root, `${addons}/aiwg-utils/skills/kern-probe/SKILL.md`,
    '---\nnamespace: aiwg\nname: kern-probe\nplatforms: [all]\nkernel: true\ndescription: synthetic kernel probe\nmetadata:\n  entrypoint: kernel-entry.md\n---\n\nKernel probe.\n');
  write(root, `${addons}/aiwg-utils/skills/kern-probe/kernel-entry.md`, '# kernel entrypoint\n');
  write(root, `${addons}/decision-engine/manifest.json`, JSON.stringify({
    id: 'decision-engine', version: '1.0.0', explicitInstall: true,
    dependencies: { required: ['aiwg-utils'] },
  }));
  write(root, `${addons}/decision-engine/skills/de-check/SKILL.md`,
    '---\nnamespace: aiwg\nname: de-check\nplatforms: [all]\ndescription: synthetic decision check\n---\n\nCheck body.\n');
}

describe('aiwg use addon requiring aiwg-utils across providers (#3035)', () => {
  let frameworkRoot: string;
  let tempRoot: string;
  let project: string;

  beforeAll(() => {
    frameworkRoot = mkdtempSync(join(tmpdir(), 'aiwg-addon-sources-'));
    writeSources(frameworkRoot);
  });
  afterAll(() => rmSync(frameworkRoot, { recursive: true, force: true }));

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'aiwg-addon-provider-'));
    project = join(tempRoot, 'project');
    mkdirSync(project);
    for (const name of ISOLATED_ENV) {
      const relative = name === 'HOME' || name === 'USERPROFILE' ? 'home'
        : name === 'OPENHUMAN_HOME' ? 'home/.openhuman' : name.toLowerCase();
      const dir = join(tempRoot, relative);
      mkdirSync(dir, { recursive: true });
      vi.stubEnv(name, dir);
    }
    for (const name of UNSET_ENV) vi.stubEnv(name, undefined);
  });
  afterEach(() => {
    host.fallback = false;
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves existing removal candidates, discovery paths, and user registry roots', async () => {
    vi.resetModules();
    const { candidateDeployedPaths } = await import('../../../../src/extensions/project-local-remove.js');
    const { getProviderArtifactPathStrings, getProviderContextDiscoveryPathStrings, getProviderKernelSkillPath } =
      await import('../../../../src/providers/provider-definitions.js');
    const { USER_SCOPE_PATHS } = await import('../../../../src/cli/scope-resolver.js');
    const { recordUserDeploy, userRegistryPath } = await import('../../../../src/config/user-registry.js');
    const { resolveIndexDir } = await import('../../../../src/artifacts/index-reader.js');
    const { getFrameworkIndexBaseDir } = await import('../../../../src/artifacts/framework-index-paths.js');
    const { removeHandler } = await import('../../../../src/cli/handlers/subcommands.js');
    const home = process.env.HOME!;
    const expected = {
      openclaw: { artifact: join(home, '.openclaw/.aiwg/skills'), kernel: join(home, '.openclaw/skills/aiwg'), user: join(home, '.openclaw/skills') },
      muse: { artifact: '.agents/skills', kernel: '.agents/skills', user: join(process.env.XDG_CONFIG_HOME!, 'muse/skills') },
      openhuman: { artifact: join(home, '.openhuman/.aiwg/skills'), kernel: join(home, '.openhuman/skills'), user: join(home, '.openhuman/skills') },
      grokbot: { artifact: process.env.AIWG_GROKBOT_SKILLS_DIR!, kernel: '', user: process.env.AIWG_GROKBOT_SKILLS_DIR! },
      'grok-build': { artifact: '.grok/skills', kernel: '.grok/skills', user: join(process.env.GROK_HOME!, 'skills') },
    };
    for (const [provider, roots] of Object.entries(expected)) {
      expect(getProviderArtifactPathStrings(provider)?.skills).toBe(roots.artifact);
      expect(getProviderKernelSkillPath(provider)).toBe(roots.kernel);
      expect(getProviderContextDiscoveryPathStrings(provider)?.skills).toBe(provider === 'grokbot' ? '' : roots.artifact);
      expect(candidateDeployedPaths(project, provider, 'skills/legacy/SKILL.md')).toEqual([
        join(isAbsolute(roots.artifact) ? roots.artifact : join(project, roots.artifact), 'legacy/SKILL.md'),
      ]);
      expect(USER_SCOPE_PATHS[provider].skills).toBe(roots.user);
      await recordUserDeploy({ framework: 'legacy', provider, version: '1', source: 'bundled',
        counts: { agents: 0, commands: 0, skills: 1, rules: 0 }, entries: { skills: ['legacy'] } });
      const args = ['legacy', '--provider', provider, '--scope', 'user', '--dry-run'];
      const result = await removeHandler.execute({ cwd: project, frameworkRoot, rawArgs: ['remove', ...args], args });
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain(join(roots.user, 'legacy'));
    }
    expect(userRegistryPath()).toBe(join(home, '.aiwg/installed.json'));
    expect(resolveIndexDir(project, 'framework')).toBe(join(getFrameworkIndexBaseDir(project), 'framework'));
  });

  it.each(['local', 'fortemi-core'] as const)('alternates use/show/discover between two package roots in one HOME (%s)', { timeout: 60000 }, async backend => {
    vi.resetModules();
    const { useHandler } = await import('../../../../src/cli/handlers/use.js');
    const { showArtifact, discoverCapability } = await import('../../../../src/artifacts/query-engine.js');
    const { getGraphIndexDir } = await import('../../../../src/artifacts/types.js');
    const { getFortemiCoreSyncStatus } = await import('../../../../src/artifacts/fortemi-core-sync.js');
    const roots = [join(tempRoot, 'runtime'), join(tempRoot, 'edge')];
    for (const root of roots) {
      writeSources(root);
      write(root, 'package.json', '{"name":"aiwg","version":"1.0.0"}');
      for (const kind of ['extensions', 'agents', 'behaviors']) mkdirSync(join(root, 'agentic/code', kind), { recursive: true });
      write(root, 'agentic/code/addons/decision-engine/skills/de-check/SKILL.md',
        `---\nname: de-check\ndescription: synthetic decision check\nplatforms: [all]\n---\nDecision check from ${root}.\n`);
    }
    await writeAiwgConfig(project, emptyConfig(['claude']));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const snapshots = new Map<string, string>();
    try {
      for (const root of [...roots, ...roots]) {
        vi.stubEnv('AIWG_ROOT', root);
        const args = ['decision-engine', '--provider', 'claude', '--target', project];
        const result = await useHandler.execute({ cwd: project, frameworkRoot: root, rawArgs: ['use', ...args], args });
        expect(result.exitCode, result.message).toBe(0);
        output.mockClear();
        await showArtifact(project, { name: 'de-check', typeFilter: ['skill'], backend, json: true });
        const shown = JSON.parse(output.mock.calls.map(call => call[0]).join(''));
        expect(shown.path).toBe(join(root, 'agentic/code/addons/decision-engine/skills/de-check/SKILL.md'));
        expect(shown.content).toBeUndefined();
        expect(shown.description).toBe('synthetic decision check');
        output.mockClear();
        await showArtifact(project, { name: 'de-check', typeFilter: ['skill'], backend, json: true, body: true });
        const body = JSON.parse(output.mock.calls.map(call => call[0]).join(''));
        expect(body.path).toBe(shown.path);
        expect(body.content).toBe(readFileSync(shown.path, 'utf8'));
        expect(body.content).toContain(`Decision check from ${root}.`);
        output.mockClear();
        await discoverCapability(project, { phrase: 'synthetic decision check', backend, json: true });
        const found = JSON.parse(output.mock.calls.map(call => call[0]).join(''));
        expect(found.results.length).toBeGreaterThan(0);
        expect(found.results.every((entry: { path: string }) => entry.path.startsWith(`${root}/`))).toBe(true);
        const dir = getGraphIndexDir(project, 'framework');
        const metadata = readFileSync(join(dir, 'metadata.json'), 'utf8');
        if (snapshots.has(root)) expect(metadata).toBe(snapshots.get(root));
        else snapshots.set(root, metadata);
        expect(getFortemiCoreSyncStatus(project, 'framework').stale).toBe(false);
      }
      expect(getGraphIndexDir(roots[0], 'framework')).not.toBe(getGraphIndexDir(roots[1], 'framework'));
    } finally { output.mockRestore(); }
  });

  for (const provider of PROVIDERS) {
    const title = `deploys decision-engine and support assets for ${provider}`;
    it(title, { timeout: 60000 }, async () => {
      await writeAiwgConfig(project, emptyConfig([provider]));
      vi.resetModules();
      const { useHandler } = await import('../../../../src/cli/handlers/use.js');
      const adapter = await import(`../../../../tools/agents/providers/${provider}.mjs`);
      // Grokbot exposes native writes only at user scope.
      const args = ['decision-engine', '--provider', provider, '--target', project,
        ...(provider === 'grokbot' ? ['--scope', 'user'] : [])];
      const result = await useHandler.execute({ cwd: project, frameworkRoot, rawArgs: ['use', ...args], args });
      expect(result.exitCode, result.message).toBe(0);

      const resolve = (value: string) => isAbsolute(value) ? value : join(project, value);
      let kernelRoot = resolve(adapter.kernelSkillsPath);
      let skillRoot = resolve(adapter.paths.skills);
      if (provider === 'muse') {
        // muse.mjs deploySkills: private STANDARD_MIRROR_SUBDIR at project scope.
        skillRoot = join(project, '.agents/.aiwg/skills');
      } else if (provider === 'grok-build') {
        skillRoot = resolve(adapter.standardSkillsPath);
      } else if (provider === 'grokbot') {
        // grokbot.mjs deploySkills: configured native root and its opt-in mirror.
        kernelRoot = adapter.resolveGrokbotSkillsDir();
        skillRoot = join(kernelRoot, '.aiwg', 'skills');
      } else if (provider === 'openclaw') {
        // openclaw.mjs deploySkills preserves the native aiwg/ namespace.
        kernelRoot = join(kernelRoot, 'aiwg');
      }
      const utilsSource = join(frameworkRoot, 'agentic/code/addons/aiwg-utils/skills/sess-probe');
      expect(readFileSync(join(skillRoot, 'sess-probe/SKILL.md'), 'utf8')).toContain('synthetic session probe');
      for (const support of ['session-entry.md', 'references/recipes.md']) {
        expect(readFileSync(join(skillRoot, 'sess-probe', support))).toEqual(readFileSync(join(utilsSource, support)));
      }
      expect(existsSync(join(skillRoot, 'de-check/SKILL.md'))).toBe(true);
      expect(existsSync(join(kernelRoot, 'kern-probe/SKILL.md'))).toBe(true);
      expect(readFileSync(join(kernelRoot, 'kern-probe/kernel-entry.md'), 'utf8')).toBe('# kernel entrypoint\n');
      expect((await readAiwgConfig(project))?.installed?.['decision-engine']).toBeDefined();
      if (provider === 'openclaw' || provider === 'grokbot') {
        const { readUserRegistry } = await import('../../../../src/config/user-registry.js');
        const record = (await readUserRegistry()).installed['decision-engine'].deployedTo[provider];
        expect(record.skills).toBe(1);
        expect(record).toMatchObject({ entries: { skills: [provider === 'openclaw'
          ? '../.aiwg/skills/de-check' : '.aiwg/skills/de-check'] } });
      }
      if (provider === 'openclaw' || provider === 'openhuman') {
        expect(existsSync(join(project, 'WORKSPACE.md'))).toBe(true);
        expect(existsSync(join(project, '.aiwg/AIWG.md'))).toBe(false);
        expect(existsSync(join(project, 'AIWG.md'))).toBe(true);
        expect(result.message).not.toContain('Required canonical context file is missing: AIWG.md');
      }
      expect(process.env.AIWG_ROOT).toBeUndefined();
      expect(process.env.AIWG_HOME).toBeUndefined();
    });
  }

  const rollbackProviders = [...PROVIDERS, 'antigravity', 'claude', 'codex', 'cursor', 'factory', 'hermes', 'omp', 'warp'];
  it.each(rollbackProviders.flatMap(provider => ['decision-engine', 'sdlc'].map(bundle => ({ provider, bundle }))))('rolls back every context output after late $bundle verification failure for $provider', { timeout: 60000 }, async ({ provider, bundle }) => {
    const sourceRoot = join(tempRoot, 'rollback-sources');
    writeSources(sourceRoot);
    if (provider === 'omp') {
      write(sourceRoot, 'package.json', JSON.stringify({ name: 'aiwg', version: '1.0.0' }));
      symlinkSync(join(REPO_ROOT, 'tools'), join(sourceRoot, 'tools'), 'dir');
      symlinkSync(join(REPO_ROOT, 'dist'), join(sourceRoot, 'dist'), 'dir');
      write(sourceRoot, 'agentic/code/providers/omp/aiwg-bridge.ts', '// synthetic OMP extension bridge\n');
    }
    write(sourceRoot, 'agentic/code/frameworks/sdlc-complete/manifest.json', JSON.stringify({ id: 'sdlc', name: 'SDLC', version: '1.0.0', modeAliases: ['sdlc'], keywords: ['sdlc'] }));
    write(sourceRoot, 'agentic/code/frameworks/sdlc-complete/skills/framework-probe/SKILL.md', '---\nname: framework-probe\nplatforms: [all]\n---\nSynthetic framework probe.\n');
    await writeAiwgConfig(project, emptyConfig([provider]));
    const originals = new Map<string, Buffer>();
    for (const name of ['WORKSPACE.md', 'AIWG.md', 'AGENTS.md', 'CLAUDE.md', 'WARP.md', '.hermes.md',
      '.aiwg/AIWG.md', '.github/copilot-instructions.md', '.windsurfrules', '.windsurf/rules/aiwg-orchestration.md', '.omp/AGENTS.md']) {
      const file = join(project, name);
      const bytes = Buffer.from(`# Operator\r\n<!-- aiwg-managed -->\r\n${name} before deploy\r\n`);
      write(project, name, bytes.toString());
      originals.set(file, bytes);
    }
    const before = new Map<string, Buffer>();
    const inventory = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) inventory(file);
        else if (entry.isFile()) before.set(file, readFileSync(file));
      }
    };
    inventory(tempRoot);
    afterVerification.mockImplementation(result => { result.outcome = 'failed'; });
    vi.resetModules();
    await interceptVerification();
    // Wrapper correctness has its own suite; this fixture targets the later
    // context/final-verification boundary with a tiny synthetic corpus.
    const wrappers = await import('../../../../src/models/wrapper-deployment.js');
    vi.spyOn(wrappers, 'verifyModelWrapperDeployment').mockResolvedValue({ supported: false, valid: true,
      agentsPath: null, found: [], missing: [], mismatches: [] });
    const manager = await import('../../../../src/channel/manager.mjs');
    vi.mocked(manager.getFrameworkRoot).mockResolvedValue(sourceRoot);
    const { useHandler } = await import('../../../../src/cli/handlers/use.js');
    const args = [bundle, '--provider', provider, '--target', project, '--json',
      ...(['grokbot', 'omp'].includes(provider) ? ['--scope', 'user'] : [])];
    const result = await useHandler.execute({ cwd: project, frameworkRoot: sourceRoot, rawArgs: ['use', ...args], args });
    expect(result.exitCode, result.message).toBe(1);
    expect(afterVerification).toHaveBeenCalled();
    const structured = JSON.parse(result.message!);
    expect(structured.contextFiles.length, result.message).toBeGreaterThan(0);
    expect(structured.contextRollback.conflicts).toEqual([]);
    expect(structured.contextRollback.restored.length).toBeGreaterThan(0);
    for (const [file, bytes] of originals) expect(readFileSync(file), file).toEqual(bytes);
    for (const file of structured.contextRollback.restored) {
      if (before.has(file)) expect(readFileSync(file), file).toEqual(before.get(file));
      else expect(existsSync(file), file).toBe(false);
    }
  });

  it.each([false, true])('returns JSON rollback conflicts and keeps edits made at verification (fallback=%s)', { timeout: 60000 }, async fallback => {
    host.fallback = fallback;
    await writeAiwgConfig(project, emptyConfig(['claude']));
    const file = join(project, 'WORKSPACE.md');
    afterVerification.mockImplementation(result => {
      writeFileSync(file, 'operator edit during verification');
      result.outcome = 'failed';
    });
    vi.resetModules();
    await interceptVerification();
    const { useHandler } = await import('../../../../src/cli/handlers/use.js');
    const args = ['decision-engine', '--provider', 'claude', '--target', project, '--json'];
    const result = await useHandler.execute({ cwd: project, frameworkRoot, rawArgs: ['use', ...args], args });
    expect(result.exitCode).toBe(1);
    const structured = JSON.parse(result.message!);
    expect(structured.contextRollback.conflicts).toEqual([{ path: file, reason: 'Context changed since deployment wrote it' }]);
    expect(readFileSync(file, 'utf8')).toBe('operator edit during verification');
  });

  it.each([false, true])('rolls back completed generator writes even when the generator throws (fallback=%s)', { timeout: 60000 }, async fallback => {
    host.fallback = fallback;
    await writeAiwgConfig(project, emptyConfig(['claude']));
    const file = join(project, 'WORKSPACE.md');
    const original = '# Operator workspace\n';
    writeFileSync(file, original);
    vi.resetModules();
    const pipeline = await import('../../../../src/smiths/context-pipeline/index.js');
    const generate = pipeline.generate;
    vi.spyOn(pipeline, 'generate').mockImplementation(async options => {
      await generate(options);
      throw new Error('after completed generator writes');
    });
    const { useHandler } = await import('../../../../src/cli/handlers/use.js');
    const args = ['decision-engine', '--provider', 'claude', '--target', project, '--json'];
    const result = await useHandler.execute({ cwd: project, frameworkRoot, rawArgs: ['use', ...args], args });
    expect(result.exitCode, result.message).toBe(1);
    const structured = JSON.parse(result.message!);
    expect(structured.schema).toBe('aiwg.use.result.v1');
    expect(structured.contextRollback.conflicts).toEqual([]);
    expect(structured.contextRollback.restored.length).toBeGreaterThan(0);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(existsSync(join(project, '.aiwg/AIWG.md'))).toBe(false);
  });

  it('shares one journal across provider passes and restores both after final verification', { timeout: 60000 }, async () => {
    await writeAiwgConfig(project, emptyConfig(['claude', 'codex']));
    const files = ['WORKSPACE.md', 'AGENTS.md', 'CLAUDE.md'];
    for (const file of files) write(project, file, `# ${file}\r\n<!-- aiwg-managed -->\r\noperator bytes\r\n`);
    vi.resetModules();
    await interceptVerification();
    afterVerification.mockImplementation(result => { if (result.provider === 'codex') result.outcome = 'failed'; });
    const { useHandler } = await import('../../../../src/cli/handlers/use.js');
    const args = ['decision-engine', '--providers', 'claude,codex', '--target', project, '--json'];
    const result = await useHandler.execute({ cwd: project, frameworkRoot, rawArgs: ['use', ...args], args });
    expect(result.exitCode, result.message).toBe(1);
    const structured = JSON.parse(result.message!);
    expect(structured.contextFiles.length).toBeGreaterThanOrEqual(2);
    expect(structured.contextRollback.conflicts).toEqual([]);
    for (const file of files) expect(readFileSync(join(project, file), 'utf8')).toBe(`# ${file}\r\n<!-- aiwg-managed -->\r\noperator bytes\r\n`);
  });

  it('restores context written by a provider step that throws before returning', { timeout: 60000 }, async () => {
    await writeAiwgConfig(project, emptyConfig(['windsurf']));
    const file = join(project, '.windsurfrules');
    writeFileSync(file, 'operator original');
    afterDeploy.mockImplementation(() => { throw new Error('after provider writes'); });
    vi.resetModules();
    const { useHandler } = await import('../../../../src/cli/handlers/use.js');
    const args = ['decision-engine', '--provider', 'windsurf', '--target', project, '--json'];
    const result = await useHandler.execute({ cwd: project, frameworkRoot, rawArgs: ['use', ...args], args });
    expect(result.exitCode, result.message).toBe(1);
    const structured = JSON.parse(result.message!);
    expect(structured.contextRollback.conflicts).toEqual([]);
    expect(structured.contextRollback.restored).toContain(file);
    expect(readFileSync(file, 'utf8')).toBe('operator original');
    expect(existsSync(join(project, '.windsurf/rules/aiwg-orchestration.md'))).toBe(false);
  });

  it('rebuilds a recent shared graph from another source before verifying an addon', async () => {
    vi.resetModules();
    const { buildIndex } = await import('../../../../src/artifacts/index-builder.js');
    const { loadGraphIndexFile } = await import('../../../../src/artifacts/index-reader.js');
    const { useHandler } = await import('../../../../src/cli/handlers/use.js');
    const partialRoot = join(tempRoot, 'partial-runtime');
    write(partialRoot, 'agentic/code/frameworks/other/skills/unrelated/SKILL.md',
      '---\nname: unrelated\n---\n# Unrelated\n');
    await buildIndex(partialRoot, { graph: 'framework', quiet: true });
    const before = loadGraphIndexFile<any>(project, 'metadata.json', 'framework');
    expect(Object.keys(before.entries)).toHaveLength(1);
    afterDeploy.mockImplementation(() => buildIndex(partialRoot, { graph: 'framework', quiet: true }));
    // A fresh timestamp (or a reconcile receipt) cannot prove bundle coverage.
    const args = ['decision-engine', '--provider', 'claude', '--target', project];
    const result = await useHandler.execute({ cwd: project, frameworkRoot, rawArgs: ['use', ...args], args });
    expect(result.exitCode, result.message).toBe(0);
    const after = loadGraphIndexFile<any>(project, 'metadata.json', 'framework');
    expect(after.entries['agentic/code/addons/decision-engine/skills/de-check/SKILL.md']).toBeDefined();
    expect(after.entries['agentic/code/frameworks/other/skills/unrelated/SKILL.md']).toBeUndefined();
  });

  it('cleans removed standard skills and bundle-root support files on addon redeploy', { timeout: 60000 }, async () => {
    const sourceRoot = join(tempRoot, 'sources');
    writeSources(sourceRoot);
    const addon = join(sourceRoot, 'agentic/code/addons/decision-engine');
    write(addon, 'skills/retired/SKILL.md', '---\nname: retired\nplatforms: [all]\n---\nRetired.\n');
    write(addon, 'skills/de-check/SKILL.md',
      '---\nname: de-check\nplatforms: [all]\n---\nUse [single](templates/retired.md) and [pack](assets/reports/).\n');
    write(addon, 'templates/retired.md', '# retired template\n');
    write(addon, 'assets/reports/retired.md', '# retired report\n');
    await writeAiwgConfig(project, emptyConfig(['pi']));
    vi.resetModules();
    const { useHandler } = await import('../../../../src/cli/handlers/use.js');
    const args = ['decision-engine', '--provider', 'pi', '--target', project];
    const execute = () => useHandler.execute({ cwd: project, frameworkRoot: sourceRoot, rawArgs: ['use', ...args], args });
    const first = await execute();
    expect(first.exitCode, first.message).toBe(0);
    const deployed = join(project, '.pi/.aiwg/skills');
    expect(existsSync(join(deployed, 'de-check/templates/retired.md'))).toBe(true);
    expect(existsSync(join(deployed, 'de-check/assets/reports/retired.md'))).toBe(true);
    write(deployed, 'retired/local.txt', 'operator note');
    write(deployed, 'de-check/assets/reports/local.txt', 'operator report');
    rmSync(join(addon, 'skills/retired'), { recursive: true });
    rmSync(join(addon, 'templates'), { recursive: true });
    rmSync(join(addon, 'assets'), { recursive: true });
    write(addon, 'skills/de-check/SKILL.md', '---\nname: de-check\nplatforms: [all]\n---\nUpdated.\n');
    const second = await execute();
    expect(second.exitCode, second.message).toBe(0);
    expect(existsSync(join(deployed, 'retired/SKILL.md'))).toBe(false);
    expect(existsSync(join(deployed, 'de-check/templates/retired.md'))).toBe(false);
    expect(existsSync(join(deployed, 'de-check/assets/reports/retired.md'))).toBe(false);
    expect(readFileSync(join(deployed, 'retired/local.txt'), 'utf8')).toBe('operator note');
    expect(readFileSync(join(deployed, 'de-check/assets/reports/local.txt'), 'utf8')).toBe('operator report');
    expect(existsSync(join(deployed, 'sess-probe/SKILL.md'))).toBe(true);
  });


  it.each(['pi', 'openclaw', 'grokbot'])('keeps the first skill owner and support assets when a later addon collides for %s', { timeout: 60000 }, async provider => {
    const sourceRoot = join(tempRoot, 'sources');
    writeSources(sourceRoot);
    const addons = 'agentic/code/addons';
    write(sourceRoot, `${addons}/decision-engine/skills/sess-probe/SKILL.md`,
      '---\nname: sess-probe\nplatforms: [all]\nmetadata:\n  entrypoint: session-entry.md\n---\nConflicting skill.\n');
    write(sourceRoot, `${addons}/decision-engine/skills/sess-probe/session-entry.md`, '# conflicting entrypoint\n');
    await writeAiwgConfig(project, emptyConfig([provider]));
    vi.resetModules();
    const { useHandler } = await import('../../../../src/cli/handlers/use.js');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const args = ['decision-engine', '--provider', provider, '--target', project,
        ...(provider === 'grokbot' ? ['--scope', 'user'] : [])];
      const result = await useHandler.execute({ cwd: project, frameworkRoot: sourceRoot, rawArgs: ['use', ...args], args });
      expect(result.exitCode, result.message).toBe(0);
      const skillRoot = provider === 'openclaw' ? join(process.env.HOME!, '.openclaw/.aiwg/skills')
        : provider === 'grokbot' ? join(process.env.AIWG_GROKBOT_SKILLS_DIR!, '.aiwg/skills')
          : join(project, '.pi/.aiwg/skills');
      const deployed = join(skillRoot, 'sess-probe');
      expect(readFileSync(join(deployed, 'SKILL.md'), 'utf8')).toContain('synthetic session probe');
      expect(readFileSync(join(deployed, 'session-entry.md'), 'utf8')).toBe('# synthetic entrypoint\n');
      expect(warning).toHaveBeenCalledWith(
        "Skill deploy collision: 'sess-probe' is owned by aiwg-utils; decision-engine skipped",
      );
      expect(JSON.parse(readFileSync(join(deployed, '.aiwg-manifest.json'), 'utf8')).managed['SKILL.md'].frameworkSlug).toBe('aiwg-utils');
      if (provider !== 'pi') {
        const { readUserRegistry } = await import('../../../../src/config/user-registry.js');
        expect((await readUserRegistry()).installed['decision-engine'].deployedTo[provider]).toMatchObject({
          skills: 1, entries: { skills: [provider === 'openclaw' ? '../.aiwg/skills/de-check' : '.aiwg/skills/de-check'] },
        });
      }
    } finally {
      warning.mockRestore();
    }
  });

  it.each(['pi', 'grokbot'])('reconciles moved-install receipts and records native ownership for %s', { timeout: 60000 }, async provider => {
    const sourceRoot = join(tempRoot, 'sources');
    writeSources(sourceRoot);
    const addon = join(sourceRoot, 'agentic/code/addons/decision-engine');
    write(addon, 'skills/de-check/SKILL.md', '---\nname: de-check\nplatforms: [all]\n---\nUse [check](templates/check.md).\n');
    write(addon, 'templates/check.md', 'reconciled asset');
    const deployed = provider === 'pi' ? join(project, '.pi/.aiwg/skills/de-check')
      : join(process.env.AIWG_GROKBOT_SKILLS_DIR!, '.aiwg/skills/de-check');
    afterDeploy.mockImplementation(() => {
      const receiptPath = join(deployed, '.aiwg-manifest.json');
      if (!existsSync(receiptPath)) return;
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      receipt.skillSource = receipt.skillSource.replace(sourceRoot, join(tempRoot, 'previous-install'));
      writeFileSync(receiptPath, JSON.stringify(receipt));
    });
    await writeAiwgConfig(project, emptyConfig([provider]));
    vi.resetModules();
    const { useHandler } = await import('../../../../src/cli/handlers/use.js');
    const args = ['decision-engine', '--provider', provider, '--target', project,
      ...(provider === 'grokbot' ? ['--scope', 'user'] : [])];
    const result = await useHandler.execute({ cwd: project, frameworkRoot: sourceRoot, rawArgs: ['use', ...args], args });
    expect(result.exitCode, result.message).toBe(0);
    expect(readFileSync(join(deployed, 'templates/check.md'), 'utf8')).toBe('reconciled asset');
    const receipt = JSON.parse(readFileSync(join(deployed, '.aiwg-manifest.json'), 'utf8'));
    expect(receipt.managed['templates/check.md'].frameworkSlug).toBe('decision-engine');
    if (provider === 'grokbot') {
      const { readUserRegistry } = await import('../../../../src/config/user-registry.js');
      expect((await readUserRegistry()).installed['decision-engine'].deployedTo.grokbot.skills).toBe(1);
    }
  });

  it('forwards force and takes ownership of skill instructions, support assets, and receipt', { timeout: 60000 }, async () => {
    const sourceRoot = join(tempRoot, 'sources');
    writeSources(sourceRoot);
    const addon = join(sourceRoot, 'agentic/code/addons/decision-engine');
    write(addon, 'skills/sess-probe/SKILL.md', '---\nname: sess-probe\nplatforms: [all]\n---\nForced skill using [support](templates/forced.md).\n');
    write(addon, 'templates/forced.md', 'forced support');
    await writeAiwgConfig(project, emptyConfig(['pi']));
    vi.resetModules();
    const { useHandler } = await import('../../../../src/cli/handlers/use.js');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    afterDeploy.mockImplementation((deployArgs: string[]) => {
      if (!deployArgs.includes(addon)) return;
      const receiptPath = join(project, '.pi/.aiwg/skills/sess-probe/.aiwg-manifest.json');
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      receipt.skillSource = join(sourceRoot, 'agentic/code/addons/aiwg-utils/skills/sess-probe');
      receipt.managed['SKILL.md'].frameworkSlug = 'aiwg-utils';
      writeFileSync(receiptPath, JSON.stringify(receipt));
    });
    const args = ['decision-engine', '--provider', 'pi', '--target', project, '--force'];
    const result = await useHandler.execute({ cwd: project, frameworkRoot: sourceRoot, rawArgs: ['use', ...args], args });
    expect(result.exitCode, result.message).toBe(0);
    const deployed = join(project, '.pi/.aiwg/skills/sess-probe');
    expect(readFileSync(join(deployed, 'SKILL.md'), 'utf8')).toContain('Forced skill');
    expect(readFileSync(join(deployed, 'templates/forced.md'), 'utf8')).toBe('forced support');
    expect(warning).toHaveBeenCalledWith("Skill deploy collision: 'sess-probe' is owned by aiwg-utils; decision-engine taking ownership");
    expect(JSON.parse(readFileSync(join(deployed, '.aiwg-manifest.json'), 'utf8')).managed['SKILL.md'].frameworkSlug).toBe('decision-engine');
  });

  it('forwards force through the framework deployment argument filter', async () => {
    vi.resetModules();
    const { useHandler } = await import('../../../../src/cli/handlers/use.js');
    const args = ['sdlc', '--provider', 'pi', '--target', project, '--force', '--dry-run', '--no-utils', '--no-project-local'];
    const result = await useHandler.execute({ cwd: project, frameworkRoot, rawArgs: ['use', ...args], args });
    expect(result.exitCode, result.message).toBe(0);
    expect(afterDeploy).toHaveBeenCalledWith(expect.arrayContaining(['--force']));
  });

  it.each(['bundled', 'project-local', 'user'])('releases only receipt-owned skills on %s removal and permits a new framework owner', { timeout: 60000 }, async scope => {
    vi.resetModules();
    const { deploySkillDir } = await import('../../../../tools/agents/providers/base.mjs');
    const { removeHandler } = await import('../../../../src/cli/handlers/subcommands.js');
    const { hashBundleArtifacts } = await import('../../../../src/extensions/project-local-remove.js');
    const source = scope === 'project-local' ? join(project, '.aiwg/addons/aiwg-utils')
      : join(tempRoot, 'sources/agentic/code/addons/aiwg-utils');
    const root = scope === 'user' ? join(process.env.HOME!, '.claude/.aiwg/skills')
      : join(project, '.claude/.aiwg/skills');
    for (const name of ['cleanup-audit', 'edited']) {
      write(source, `skills/${name}/SKILL.md`, `---\nname: ${name}\n---\nUtils.\n`);
      write(source, `skills/${name}/references/support.md`, 'managed');
      deploySkillDir(join(source, 'skills', name), root, {});
    }
    write(root, 'edited/references/support.md', 'operator edit');
    write(root, 'edited/SKILL.md', 'operator instructions');
    write(root, 'edited/local.txt', 'operator addition');
    const foreign = join(tempRoot, 'sources/agentic/code/frameworks/research-complete/skills/foreign');
    write(foreign, 'SKILL.md', 'foreign owner');
    deploySkillDir(foreign, root, {});
    if (scope === 'user') {
      const { recordUserDeploy } = await import('../../../../src/config/user-registry.js');
      await recordUserDeploy({ framework: 'aiwg-utils', provider: 'claude', version: '1', source: 'bundled',
        counts: { agents: 0, commands: 0, skills: 3, rules: 0 },
        entries: { skills: ['../.aiwg/skills/cleanup-audit', '../.aiwg/skills/edited', '../.aiwg/skills/foreign'] } });
    } else {
      const config = emptyConfig(['claude']);
      config.installed['aiwg-utils'] = { version: '1', source: scope, installedAt: new Date().toISOString(),
        deployedTo: { claude: { agents: 0, commands: 0, skills: 2, rules: 0 } },
        ...(scope === 'project-local' ? { localPath: '.aiwg/addons/aiwg-utils', localType: 'addon' as const,
          artifactHashes: await hashBundleArtifacts(source) } : {}) };
      await writeAiwgConfig(project, config);
    }
    const args = ['aiwg-utils', ...(scope === 'user' ? ['--scope', 'user'] : [])];
    const result = await removeHandler.execute({ cwd: project, frameworkRoot: tempRoot, rawArgs: ['remove', ...args], args });
    expect(result.exitCode, result.message).toBe(0);
    expect(existsSync(join(root, 'cleanup-audit'))).toBe(false);
    expect(existsSync(join(root, 'edited/.aiwg-manifest.json'))).toBe(false);
    expect(readFileSync(join(root, 'edited/references/support.md'), 'utf8')).toBe('operator edit');
    expect(readFileSync(join(root, 'edited/local.txt'), 'utf8')).toBe('operator addition');
    expect(readFileSync(join(root, 'edited/SKILL.md'), 'utf8')).toBe('operator instructions');
    expect(readFileSync(join(root, 'foreign/SKILL.md'), 'utf8')).toBe('foreign owner');
    if (scope === 'bundled') expect(result.message).toContain('Preserve .claude/.aiwg/skills/foreign/SKILL.md — foreign or unverifiable ownership receipt');
    else expect(result.message).not.toContain('skills/foreign');
    const framework = join(tempRoot, 'sources/agentic/code/frameworks/sdlc-complete/skills/cleanup-audit');
    write(framework, 'SKILL.md', 'SDLC version');
    deploySkillDir(framework, root, {});
    expect(readFileSync(join(root, 'cleanup-audit/SKILL.md'), 'utf8')).toBe('SDLC version');
  });

  it.each(['bundled', 'user'])('resolves framework aliases on %s removal', async scope => {
    vi.resetModules();
    const { deploySkillDir } = await import('../../../../tools/agents/providers/base.mjs');
    const { removeHandler } = await import('../../../../src/cli/handlers/subcommands.js');
    const source = join(tempRoot, 'agentic/code/frameworks/sdlc-complete/skills/demo');
    const root = join(scope === 'user' ? process.env.HOME! : project, '.claude/.aiwg/skills');
    write(source, 'SKILL.md', 'SDLC instructions');
    deploySkillDir(source, root, {});
    if (scope === 'user') {
      const { recordUserDeploy } = await import('../../../../src/config/user-registry.js');
      await recordUserDeploy({ framework: 'sdlc', provider: 'claude', version: '1', source: 'bundled',
        counts: { agents: 0, commands: 0, skills: 1, rules: 0 }, entries: { skills: ['../.aiwg/skills/demo'] } });
    } else {
      const config = emptyConfig(['claude']);
      config.installed.sdlc = { version: '1', source: 'bundled', installedAt: new Date().toISOString(),
        deployedTo: { claude: { agents: 0, commands: 0, skills: 1, rules: 0 } } };
      await writeAiwgConfig(project, config);
    }
    const args = ['sdlc', ...(scope === 'user' ? ['--scope', 'user'] : [])];
    const context = { cwd: project, frameworkRoot: tempRoot, rawArgs: ['remove', ...args], args };
    expect((await removeHandler.execute({ ...context, args: [...args, '--dry-run'] })).exitCode).toBe(0);
    expect(existsSync(join(root, 'demo/.aiwg-manifest.json'))).toBe(true);
    expect((await removeHandler.execute(context)).exitCode).toBe(0);
    expect(existsSync(join(root, 'demo'))).toBe(false);
  });

});
