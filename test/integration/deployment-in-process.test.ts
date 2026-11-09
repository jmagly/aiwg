import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(root, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  };
  walk(root);
  return files;
}

describe('embedded deployment equivalence', () => {
  it('deploys multiple addons byte-identically, captures previews and uses a constant process count', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-deploy-in-process-'));
    temporary.push(scratch);
    const sources = ['first', 'second', 'third'].map(name => {
      const source = path.join(scratch, 'sources', name);
      const write = (relative: string, body: string): void => {
        const file = path.join(source, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
      };
      write(`agents/${name}.md`, `---\nname: ${name}\ndescription: Synthetic ${name} agent\nmodel: sonnet\n---\nFollow the ${name} instructions.\n`);
      write(`commands/${name}.md`, `---\ndescription: Synthetic ${name} command\n---\nRun ${name}.\n`);
      write(`skills/${name}-skill/SKILL.md`, `---\nname: ${name}-skill\ndescription: Synthetic ${name} skill\ntier: kernel\n---\nUse ${name}.\n`);
      write(`rules/${name}.md`, `---\nname: ${name}\ndescription: Synthetic rule\nactivation: summary\nsummary: Follow the synthetic rule.\n---\nFollow ${name}.\n`);
      return source;
    });
    const harness = path.join(scratch, 'run.mjs');
    fs.writeFileSync(harness, `
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createScriptRunner } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'dist/src/cli/handlers/script-runner.js')).href)};
const runner = createScriptRunner(${JSON.stringify(ROOT)});
const environment = () => Object.fromEntries(Object.entries(process.env).sort());
const before = { console: globalThis.console, cwd: process.cwd(), exitCode: process.exitCode, env: environment(),
  listeners: ['exit', 'SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)) };
const script = 'tools/agents/deploy-agents.mjs';
const sources = ${JSON.stringify(sources)};
const options = { capture: true };
const bad = await runner.run(script, ['--provider', 'missing-provider'], options);
if (bad.exitCode !== 1) throw new Error('Invalid provider must fail without terminating the host');
const help = await runner.run(script, ['--help'], options);
if (help.exitCode !== 0) throw new Error('Help must return to the host');
const args = source => ['--source', source, '--target', process.cwd(), '--provider', 'codex',
  '--deploy-version', '2026.10.5', '--deploy-commands', '--deploy-skills', '--deploy-rules',
  '--copy-all', '--no-context-files', '--skip-commands-migration', '--no-commands-warning'];
for (const [index, source] of sources.entries()) {
  // Captured calls have piped-output semantics even when the host is a TTY.
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  if (index === 0) {
    fs.mkdirSync(path.join(process.cwd(), '.codex/commands'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), '.codex/commands/legacy.md'), '<!-- aiwg:managed source=bundled -->\\nLegacy command.\\n');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  }
  let result;
  try {
    const callArgs = index === 0 ? args(source).filter(arg => arg !== '--skip-commands-migration') : args(source);
    result = await runner.run(script, callArgs, options);
  } finally {
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
    else delete process.stdout.isTTY;
  }
  if (result.exitCode) throw new Error(JSON.stringify(result));
}
const preview = path.join(process.env.HOME, 'preview.txt');
const fd = fs.openSync(preview, 'w');
try {
  const result = await runner.run(script, [...args(sources[0]), '--dry-run', '--model', 'preview-model'], { capture: true, stdoutFd: fd });
  if (result.exitCode) throw new Error(JSON.stringify(result));
} finally { fs.closeSync(fd); }
// A preview override must not affect a later real deployment.
const repeat = await runner.run(script, args(sources[0]), options);
if (repeat.exitCode) throw new Error(JSON.stringify(repeat));
assert.equal(globalThis.console, before.console);
assert.equal(process.cwd(), before.cwd);
assert.equal(process.exitCode, before.exitCode);
assert.deepEqual(environment(), before.env);
assert.deepEqual(['exit', 'SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)), before.listeners);
`);
    const snapshots: Array<Record<string, string>> = [];
    const previews: string[][] = [];
    const counts: number[] = [];
    for (const mode of ['subprocess', 'embedded']) {
      // Same absolute path for both modes: deployed hook commands embed the anchored project path.
      const base = path.join(scratch, 'run');
      fs.rmSync(base, { recursive: true, force: true });
      const project = path.join(base, 'project');
      const home = path.join(base, 'home');
      fs.mkdirSync(project, { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      const log = path.join(base, 'processes.jsonl');
      const preload = path.join(base, 'preload.mjs');
      fs.writeFileSync(preload, `import { appendFileSync } from 'node:fs';
process.on('exit', () => appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv) + '\\n'));
globalThis.fetch = () => { throw new Error('Network is forbidden'); };
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-10-25T12:00:00.000Z'])); }
  static now() { return RealDate.parse('2026-10-25T12:00:00.000Z'); }
};
`);
      const result = spawnSync(process.execPath, [harness], {
        cwd: project, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
          HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
          XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'),
          AIWG_CONFIG: path.join(home, '.aiwg'), AIWG_PROJECT_MEMORY_HOME: path.join(base, 'memory'),
          AIWG_DEPLOY_SUBPROCESS: mode === 'subprocess' ? '1' : '0',
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, CI: '1', NO_COLOR: '1', NO_UPDATE_NOTIFIER: '1',
        },
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const preview = fs.readFileSync(path.join(home, 'preview.txt'), 'utf8');
      previews.push(preview.split('\n').filter(line => /^\[dry-run\] Would /i.test(line))
        .map(line => line.replaceAll(project, '<project>').replaceAll(home, '<home>')));
      fs.rmSync(path.join(home, 'preview.txt'));
      snapshots.push({ ...Object.fromEntries(Object.entries(tree(project)).map(([key, value]) => [`project/${key}`, value])),
        ...Object.fromEntries(Object.entries(tree(home)).map(([key, value]) => [`home/${key}`, value])) });
      counts.push(fs.readFileSync(log, 'utf8').trim().split('\n').length);
    }
    expect(Object.keys(snapshots[0]).filter(file => file.endsWith('.aiwg-manifest.json')).length).toBeGreaterThan(0);
    expect(Object.keys(snapshots[0])).toEqual(expect.arrayContaining([
      'project/.agents/skills/first-skill/SKILL.md',
      'project/.agents/skills/second-skill/SKILL.md',
      'project/.agents/skills/third-skill/SKILL.md',
    ]));
    expect(Object.keys(snapshots[0])).toContain('home/.codex/prompts/aiwg-third.md');
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(previews[0].length).toBeGreaterThan(0);
    expect(previews[1]).toEqual(previews[0]);
    expect(counts[0]).toBeGreaterThan(10);
    expect(counts[1]).toBe(1);
  }, 120_000);
});
