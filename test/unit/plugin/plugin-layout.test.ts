import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const PLUGIN_SOURCE_ROOT = 'agentic/code/plugins';

describe('plugin repository layout', () => {
  it('keeps the packaged line-memory command identical to its addon source', async () => {
    const source = await readFile(join(REPO_ROOT, 'agentic/code/addons/line-memory/commands/line-memory.mjs'), 'utf8');
    const packaged = await readFile(join(REPO_ROOT, 'agentic/code/plugins/line-memory/commands/line-memory.mjs'), 'utf8');
    expect(packaged).toBe(source);
  });

  it('keeps package output under agentic/code/plugins', async () => {
    const packager = await readFile(join(REPO_ROOT, 'tools/plugin/package-plugins.mjs'), 'utf8');
    const workflow = await readFile(join(REPO_ROOT, '.gitea/workflows/build-plugins.yml'), 'utf8');
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));

    expect(packager).toContain(`path.join(ROOT_DIR, '${PLUGIN_SOURCE_ROOT}')`);
    expect(packager).toContain(`./${PLUGIN_SOURCE_ROOT}/`);
    expect(workflow).toContain(`${PLUGIN_SOURCE_ROOT}/*/`);
    expect(workflow).not.toContain('for plugin in plugins/*/');
    expect(pkg.files).not.toContain('plugins/');
  });

  it('documents the project-local plugin compatibility boundary', async () => {
    const doc = await readFile(join(REPO_ROOT, 'docs/repo-layout-plugin-sources.md'), 'utf8');

    expect(doc).toContain('agentic/code/plugins/<name>/');
    expect(doc).toContain('.aiwg/{extensions,addons,frameworks,plugins}/<name>/');
    expect(doc).toContain('Project-local plugin bundles under `.aiwg/plugins/<name>/` remain supported');
  });

  it('publishes the current user-facing framework and addon catalog for Claude', async () => {
    const marketplace = JSON.parse(await readFile(
      join(REPO_ROOT, '.claude-plugin/marketplace.json'),
      'utf8',
    ));
    const plugins = new Map(marketplace.plugins.map((plugin: {
      name: string;
      source: string | object;
    }) => [plugin.name, plugin]));

    for (const name of [
      'validation-complete',
      'agent-loop',
      'agent-persistence',
      'agentic-installer',
      'aiwg-evals',
      'aiwg-dev',
      'auto-memory',
      'browser-control',
      'compound-memory',
      'doc-intelligence',
      'launchdarkly',
      'line-memory',
      'llm-wiki',
      'nlp-prod',
      'rlm',
      'semantic-memory',
      'skill-factory',
      'testing-quality',
      'twelve-factor',
      'uat-mcp',
    ]) {
      const plugin = plugins.get(name) as { source: string } | undefined;
      expect(plugin?.source).toBe(`./agentic/code/plugins/${name}`);
      const manifest = JSON.parse(await readFile(join(
        REPO_ROOT,
        `agentic/code/plugins/${name}/.claude-plugin/plugin.json`,
      ), 'utf8'));
      expect(manifest.name).toBe(name);
    }
  });

  it('keeps provider-specific manifests when cleaning Claude bundles', async () => {
    const packager = await readFile(join(REPO_ROOT, 'tools/plugin/package-plugins.mjs'), 'utf8');
    expect(packager).toContain("entry.name.endsWith('-plugin')");
    expect(await readFile(
      join(REPO_ROOT, 'agentic/code/plugins/sdlc/.codex-plugin/plugin.json'),
      'utf8',
    )).toContain('"name": "aiwg-sdlc"');
  });

  it('keeps every local marketplace payload on the release version', async () => {
    const rootPackage = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
    const marketplace = JSON.parse(await readFile(
      join(REPO_ROOT, '.claude-plugin/marketplace.json'),
      'utf8',
    ));

    expect(marketplace.version).toBe(rootPackage.version);
    for (const plugin of marketplace.plugins.filter((entry: { source: unknown }) => (
      typeof entry.source === 'string' && entry.source.startsWith(`./${PLUGIN_SOURCE_ROOT}/`)
    ))) {
      expect(plugin.version, plugin.name).toBe(rootPackage.version);
      const manifest = JSON.parse(await readFile(join(
        REPO_ROOT,
        plugin.source,
        '.claude-plugin/plugin.json',
      ), 'utf8'));
      expect(manifest.version, plugin.name).toBe(rootPackage.version);
    }
  });

  it('publishes declared skills in Claude-compatible directories', async () => {
    const pluginNames = await readdir(join(REPO_ROOT, PLUGIN_SOURCE_ROOT));
    for (const pluginName of pluginNames) {
      const pluginRoot = join(REPO_ROOT, PLUGIN_SOURCE_ROOT, pluginName);
      if (!(await stat(pluginRoot)).isDirectory()) continue;
      const manifestPath = join(pluginRoot, 'manifest.json');
      let manifest;
      try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      } catch (error: any) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      const skillsRoot = join(pluginRoot, 'skills');
      let bundled: string[] = [];
      try {
        const entries = await readdir(skillsRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) {
            expect(entry.name, `${pluginName} has a flat skill file`).not.toMatch(/\.md$/);
            continue;
          }
          try {
            await readFile(join(skillsRoot, entry.name, 'SKILL.md'), 'utf8');
            bundled.push(entry.name);
          } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error;
          }
        }
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
      expect(bundled.sort(), pluginName).toEqual([...(manifest.skills ?? [])].sort());
    }
  });

  it('keeps testing-quality addon manifests in lockstep with shipped skill directories', async () => {
    for (const relRoot of [
      'agentic/code/plugins/testing-quality',
      'agentic/code/addons/testing-quality',
    ]) {
      const root = join(REPO_ROOT, relRoot);
      const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
      expect(manifest.skills, relRoot).toEqual([
        'tdd-enforce',
        'mutation-test',
        'flaky-detect',
        'flaky-fix',
        'generate-factory',
        'test-sync',
        'test-conformance',
        'test-normalize',
        'test-platform-research',
      ]);
      for (const skill of manifest.skills) {
        await readFile(join(root, 'skills', skill, 'SKILL.md'), 'utf8');
      }
    }
  });

  it('does not retain checkout-only self references in standalone plugin payloads', async () => {
    const legacyRoots: Record<string, string[]> = {
      'agent-loop': ['agentic/code/addons/agent-loop/'],
      'agent-persistence': ['agentic/code/addons/agent-persistence/'],
      'testing-quality': ['agentic/code/addons/testing-quality/'],
      'aiwg-dev': ['agentic/code/addons/aiwg-dev/'],
    };
    for (const [pluginName, forbidden] of Object.entries(legacyRoots)) {
      const pluginRoot = join(REPO_ROOT, PLUGIN_SOURCE_ROOT, pluginName);
      const pending = [pluginRoot];
      while (pending.length) {
        const current = pending.pop()!;
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const path = join(current, entry.name);
          if (entry.isDirectory()) pending.push(path);
          else if (/\.(?:md|json|ya?ml)$/.test(entry.name)) {
            const content = await readFile(path, 'utf8');
            for (const legacyRoot of forbidden) expect(content, path).not.toContain(legacyRoot);
          }
        }
      }
    }
  });
});
