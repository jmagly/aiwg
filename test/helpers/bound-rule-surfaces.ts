/** Exercise bound contracts through real CLI, MCP transport, and npm package entry points. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';

const repo = path.resolve(import.meta.dirname, '../..');
export const kinds = ['skill', 'agent', 'flow'] as const;
export const bundles = ['amber', 'violet'] as const;
type Kind = typeof kinds[number];
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
// Independent oracle: identity is the type and SHA-256 of the corpus-relative source path.
const id = (type: string, file: string) => `aiwg:${type}:${digest(file).slice(0, 16)}`;
const component = (bundle: string, kind: Kind) => `agentic/code/addons/${bundle}/${kind}s/${kind === 'skill' ? 'shared/SKILL.md' : 'shared.md'}`;
const policy = (bundle: string) => `agentic/code/addons/${bundle}/rules/${bundle}-policy.md`;
const policyBody = (bundle: string) => `---\nname: ${bundle}-policy\nactivation: bound\nenforcement: high\nsummary: Follow ${bundle} policy.\nbound_to:\n${kinds.map(kind => `  ${kind}s: [${id(kind, component(bundle, kind))}]`).join('\n')}\n---\n# ${bundle} policy\n\nRequire the ${bundle} approval before work.\n`;

export function boundRuleFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-bound-surfaces-'));
  const stage = path.join(root, 'stage');
  const installed = path.join(root, 'package');
  const put = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const envFor = (packageRoot: string, lane: string): NodeJS.ProcessEnv => {
    const home = path.join(root, lane);
    const launcher = path.join(home, 'bin');
    fs.mkdirSync(launcher, { recursive: true });
    if (!fs.existsSync(path.join(launcher, 'aiwg'))) fs.symlinkSync(path.join(packageRoot, 'bin/aiwg.mjs'), path.join(launcher, 'aiwg'));
    // Allowlist the child environment; never inherit account stores or runtime overrides.
    return { PATH: `${launcher}${path.delimiter}${process.env.PATH}`, HOME: home, USERPROFILE: home, TMPDIR: os.tmpdir(),
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
      XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
      AIWG_CONFIG: path.join(home, 'config/aiwg'), AIWG_ROOT: packageRoot,
      AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1', npm_config_cache: path.join(home, 'npm'),
      npm_config_userconfig: path.join(home, 'empty.npmrc'), npm_config_globalconfig: path.join(home, 'empty-global.npmrc'),
      npm_config_offline: 'true', npm_config_update_notifier: 'false' };
  };
  const run = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => execFileSync(command, args, {
    cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const projectFor = (lane: string, pinned: boolean) => {
    const project = path.join(root, `project-${lane}-${pinned}`);
    put(path.join(project, '.aiwg/aiwg.config'), JSON.stringify({
      installed: Object.fromEntries(bundles.map(bundle => [bundle, { source: 'bundled' }])),
      ...(pinned ? { rules: { always_load: [{ rules: [id('rule', policy('amber'))] }] } } : {}),
    }));
    return project;
  };
  const cli = (packageRoot: string, lane: string, args: string[], pinned = false) => JSON.parse(run(process.execPath,
    [path.join(packageRoot, 'bin/aiwg.mjs'), ...args, '--json'], projectFor(lane, pinned), envFor(packageRoot, lane)));
  const mcp = (packageRoot: string, lane: string, name: string, args: object, pinned = false) => {
    const moduleUrl = pathToFileURL(path.join(packageRoot, 'dist/src/mcp/tools/discovery.mjs')).href;
    // Real SDK client/server and in-memory transport; runAiwgCli resolves the owned CLI on PATH.
    const script = `
      import { Client } from '@modelcontextprotocol/sdk/client/index.js';
      import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
      import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
      import { registerDiscoveryTools } from ${JSON.stringify(moduleUrl)};
      const server = new McpServer({ name: 'bound-rules', version: '1.0.0' });
      registerDiscoveryTools(server);
      const client = new Client({ name: 'bound-rules-test', version: '1.0.0' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([server.connect(a), client.connect(b)]);
        const result = await client.callTool(JSON.parse(process.argv[2]));
        if (result.isError) throw new Error(JSON.stringify(result));
        console.log(result.content[0].text);
      } finally { await client.close(); await server.close(); }
    `;
    const driver = path.join(projectFor(lane, pinned), 'driver.mjs');
    put(driver, script);
    const dependencies = path.join(path.dirname(driver), 'node_modules');
    if (!fs.existsSync(dependencies)) fs.symlinkSync(path.join(repo, 'node_modules'), dependencies, 'dir');
    return JSON.parse(run(process.execPath, [driver, JSON.stringify({ name, arguments: args })],
      path.dirname(driver), envFor(packageRoot, lane)));
  };
  return {
    root, stage, installed, cli, mcp,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    prepare() {
      fs.mkdirSync(stage);
      for (const file of ['package.json', 'bin', 'dist/src', 'src', 'tools', 'schemas', 'vscode-extension/schemas', 'agentic/code/providers']) {
        fs.cpSync(path.join(repo, file), path.join(stage, file), { recursive: true });
      }
      fs.symlinkSync(path.join(repo, 'node_modules'), path.join(stage, 'node_modules'), 'dir');
      for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) fs.mkdirSync(path.join(stage, 'agentic/code', kind), { recursive: true });
      for (const bundle of bundles) {
        put(path.join(stage, `agentic/code/addons/${bundle}/manifest.json`), JSON.stringify({
          id: bundle, type: 'addon', name: bundle, version: '1.0.0', description: `${bundle} synthetic bundle`,
        }));
        for (const kind of kinds) put(path.join(stage, component(bundle, kind)),
          `---\nname: shared\ntype: ${kind}\ncapability: ${bundle} beacon\n---\n# Shared\n\nPerform ${bundle} beacon work.\n`);
        put(path.join(stage, policy(bundle)), policyBody(bundle));
      }
      // Use the release's actual index/relationship producer, then the package's unchanged allowlist.
      run(process.execPath, ['--import', 'tsx', 'tools/release/build-fortemi-core-indices.mjs'], stage, envFor(stage, 'build'));
      const packed = JSON.parse(run('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', root], stage, envFor(stage, 'pack')))[0];
      const files = new Set(packed.files.map((file: { path: string }) => file.path));
      for (const bundle of bundles) {
        for (const kind of kinds) expect(files.has(component(bundle, kind))).toBe(true);
        expect(files.has(policy(bundle))).toBe(true);
      }
      run('tar', ['-xzf', path.join(root, packed.filename), '-C', root], root, envFor(stage, 'unpack'));
      fs.symlinkSync(path.join(repo, 'node_modules'), path.join(installed, 'node_modules'), 'dir');
      expect(fs.existsSync(path.join(installed, 'src'))).toBe(false);
    },
  };
}

export function assertContract(card: any, bundle: string, kind: Kind, pinned = false) {
  const ruleId = id('rule', policy(bundle));
  expect(card.id).toBe(id(kind, component(bundle, kind)));
  expect(card.type).toBe(kind);
  // Discovery rows expose the canonical ID; show cards additionally expose the source path.
  if ('path' in card) expect(card.path.replaceAll('\\', '/').endsWith(component(bundle, kind))).toBe(true);
  expect(card.required_rule_checks).toEqual([{ rule_id: ruleId,
    applicability: [`bound:${kind}:${card.id}`], fetch_command: `aiwg show rule ${ruleId} --body` }]);
  expect(card.bound_rules).toEqual([{ name: `${bundle}-policy`, activation: pinned && bundle === 'amber' ? 'kernel' : 'bound',
    enforcement: 'high', summary: `Follow ${bundle} policy.`, show_command: `aiwg show rule ${bundle}-policy --body` }]);
  expect(card.rule_stats.required_checks).toBe(1);
}

export function assertRuleBytes(card: any, bundle: string) {
  expect(card.id).toBe(id('rule', policy(bundle)));
  expect(digest(card.content)).toBe(digest(policyBody(bundle)));
  expect(card.content).toBe(policyBody(bundle));
}
