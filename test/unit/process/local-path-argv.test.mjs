import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(import.meta.dirname, '../../..');
const moduleUrl = (relative) => pathToFileURL(join(repoRoot, relative)).href;

// Real executable stubs record the argv received after Node starts a child.
// Running each entry point in an isolated process keeps PATH and cwd local.
describe.skipIf(process.platform === 'win32')('local paths are passed without shell expansion (#3093)', () => {
  let root;
  let bin;
  let log;

  beforeEach(() => {
    root = mkdtempSync(join(repoRoot, 'test', '.wp1-path-'));
    bin = join(root, 'bin');
    log = join(root, 'argv.jsonl');
    mkdirSync(bin);
    const executable = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.WP1_ARGV_LOG, JSON.stringify({ command: path.basename(process.argv[1]), args }) + '\\n');
if (args[0] === 'clone') fs.mkdirSync(args.at(-1), { recursive: true });
if (args.includes('get-url')) process.stdout.write('https://example.com/literal.git\\n');
if (path.basename(process.argv[1]) === 'df') process.stdout.write('Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/test 5000 1000 4000 20% /fixture\\n');
`;
    for (const command of ['git', 'df']) {
      writeFileSync(join(bin, command), executable, { mode: 0o755 });
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(code, cwd = root, extraEnv = {}) {
    // File descriptors work in runners that restrict synchronous pipe I/O.
    // The native exec APIs still execute the command, including any shell
    // interpretation if a caller regresses to execSync.
    const prelude = `import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
let invocation = 0;
for (const name of ['execSync', 'execFileSync']) {
  const native = cp[name];
  cp[name] = (...args) => {
    const index = name === 'execSync' ? 1 : 2;
    const options = args[index] ?? {};
    const outputPath = process.env.WP1_ARGV_LOG + '-' + invocation++;
    const fd = fs.openSync(outputPath, 'w');
    try { args[index] = { ...options, stdio: ['ignore', fd, 'inherit'] }; native(...args); }
    finally { fs.closeSync(fd); }
    return fs.readFileSync(outputPath, options.encoding ? { encoding: options.encoding } : undefined);
  };
}
syncBuiltinESMExports();
`;
    const outputPath = join(root, 'result.txt');
    const fd = openSync(outputPath, 'w');
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', prelude + code], {
        cwd,
        stdio: ['ignore', fd, 'inherit'],
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          AIWG_RESOLVE_IMPL_FROM: 'src',
          WP1_ARGV_LOG: log,
          ...extraEnv,
        },
      });
    } finally {
      closeSync(fd);
    }
    return readFileSync(outputPath, 'utf8');
  }

  function calls() {
    return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  }

  it('clones to the literal edge path containing command substitution and spaces', () => {
    const edgePath = join(root, 'edge $(touch pwned) "quoted"');
    const configDir = join(root, 'config');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'channel.json'), JSON.stringify({ channel: 'stable', edgePath }));

    run(`const { switchToEdge } = await import(${JSON.stringify(moduleUrl('src/channel/manager.mjs'))});
await switchToEdge();`, root, { AIWG_CONFIG: configDir });

    expect(calls()[0]).toEqual({
      command: 'git',
      args: ['clone', '--branch', 'main', '--', 'https://github.com/jmagly/aiwg.git', edgePath],
    });
    expect(existsSync(edgePath)).toBe(true);
    expect(JSON.parse(readFileSync(join(configDir, 'channel.json'), 'utf8')).channel).toBe('edge');
    expect(existsSync(join(root, 'pwned'))).toBe(false);
  });

  it.each(['--template=evil', 'relative-edge'])('rejects non-absolute edge path %s before invoking git', (edgePath) => {
    const configDir = join(root, 'config');
    mkdirSync(configDir);
    writeFileSync(join(configDir, 'channel.json'), JSON.stringify({ channel: 'stable', edgePath }));
    writeFileSync(join(configDir, 'installation.json'), JSON.stringify({
      schemaVersion: 1, method: 'source', runMode: 'normal', channel: 'stable',
      root: repoRoot, updateStrategy: 'source-git', managerExecutable: null, edgePath,
    }));
    const output = run(`const { switchToEdge } = await import(${JSON.stringify(moduleUrl('src/channel/manager.mjs'))});
try { await switchToEdge(); } catch (error) { console.log(JSON.stringify({ error: error.message })); }`, root, { AIWG_CONFIG: configDir });
    expect(JSON.parse(output)).toEqual({ error: 'Edge installation path must be absolute' });
    expect(existsSync(log)).toBe(false);
    expect(JSON.parse(readFileSync(join(configDir, 'channel.json'), 'utf8')).channel).toBe('stable');
  });

  it('checks disk space in a literal cwd and parses the last df output line', () => {
    const cwd = join(root, 'workspace $(touch pwned) "quoted"');
    mkdirSync(cwd);
    const output = run(`const { MigrationTool } = await import(${JSON.stringify(moduleUrl('tools/workspace/migration-tool.mjs'))});
console.log(JSON.stringify(await new MigrationTool(${JSON.stringify(cwd)}).checkDiskSpace()));`, cwd);

    expect(calls()).toEqual([{ command: 'df', args: ['-k', cwd] }]);
    expect(JSON.parse(output)).toMatchObject({ passed: true, available: 4000 * 1024, required: 0 });
    expect(existsSync(join(cwd, 'pwned'))).toBe(false);
  });

  it('resolves topology URLs with literal project paths and remote names', () => {
    const target = join(root, 'repo $(touch pwned) "quoted"');
    const remote = 'origin $(touch pwned) `touch pwned`';
    mkdirSync(join(target, '.aiwg'), { recursive: true });
    writeFileSync(join(target, '.aiwg', 'aiwg.config'), JSON.stringify({ remotes: { primary: remote } }));

    const block = run(`const { buildRemotesTopologyBlock } = await import(${JSON.stringify(moduleUrl('tools/agents/providers/base.mjs'))});
console.log(buildRemotesTopologyBlock(${JSON.stringify(target)}));`);

    expect(calls()).toEqual([{ command: 'git', args: ['-C', target, 'remote', 'get-url', remote] }]);
    expect(block).toContain(`\`${remote}\` (https://example.com/literal.git)`);
    expect(existsSync(join(root, 'pwned'))).toBe(false);
  });
});
