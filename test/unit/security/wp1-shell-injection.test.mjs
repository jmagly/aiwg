import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(import.meta.dirname, '../../..');
const moduleUrl = relative => pathToFileURL(join(repoRoot, relative)).href;
let tmuxAvailable = false;
try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore', timeout: 5_000 });
  tmuxAvailable = true;
} catch { /* Optional integration dependency. */ }
let root;
let capture;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-wp1-shell-'));
  capture = join(root, 'argv.jsonl');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeBinary(name, response = '') {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!${process.execPath}\n` +
    `const fs = require('node:fs');\n` +
    `fs.appendFileSync(process.env.WP1_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');\n` +
    response, { mode: 0o755 });
}
function calls() {
  return readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}
function payload() {
  return `$(touch ${root}/pwned) \`touch ${root}/backtick-pwned\` "quoted" 'single' \\ $HOME\nEnter`;
}
function expectNoSideEffects() {
  expect(existsSync(join(root, 'pwned'))).toBe(false);
  expect(existsSync(join(root, 'backtick-pwned'))).toBe(false);
}
function run(code, cwd = root) {
  const prelude = `import cp from 'node:child_process';
import { createRequire } from 'node:module';
`;
  const output = join(root, 'result');
  const fd = openSync(output, 'w');
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', prelude + code], {
      cwd, stdio: ['ignore', fd, 'inherit'], timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`,
        WP1_CAPTURE: capture,
        AIWG_RESOLVE_IMPL_FROM: 'src',
      },
    });
  } finally { closeSync(fd); }
  return JSON.parse(readFileSync(output, 'utf8'));
}

describe.skipIf(process.platform === 'win32')('WP1 shell injection regressions (#3093)', () => {
  it.each(['addons', 'plugins'])('keeps %s Ralph commit messages and filenames literal (56, 57)', (tree) => {
    const hook = join(repoRoot, `agentic/code/${tree}/agent-loop/hooks/ralph-commit.js`);
    const copy = join(root, 'ralph-commit.cjs');
    writeFileSync(copy, readFileSync(hook));
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const filename = '$(touch pwned).txt';
    writeFileSync(join(repo, filename), 'content');
    const task = 'task $(touch task-pwned) `touch backtick-pwned`';
    const summary = 'summary $(touch summary-pwned) "quoted" \\ $HOME';
    const output = run(`const git = args => cp.execFileSync('git', args, { encoding: 'utf8', timeout: 30000 });
git(['init', '-q']);
git(['config', 'user.name', 'Security Test']);
git(['config', 'user.email', 'test@example.invalid']);
const { commitIteration } = createRequire(import.meta.url)(${JSON.stringify(copy)});
const result = commitIteration({ currentIteration: 2, maxIterations: 3, task: ${JSON.stringify(task)} }, ${JSON.stringify(summary)});
console.log(JSON.stringify({ result, message: git(['log', '-1', '--format=%B']), status: git(['status', '--porcelain']) }));`, repo);
    expect(output.result.committed).toBe(true);
    expect(output.message).toContain(`ralph: iteration 2 - ${summary}`);
    expect(output.message).toContain(task);
    expect(output.message).toContain(filename);
    expect(output.status).toBe('');
    for (const marker of ['pwned', 'task-pwned', 'summary-pwned', 'backtick-pwned']) {
      expect(existsSync(join(repo, marker))).toBe(false);
    }
  });

  it.skipIf(!tmuxAvailable).each([40, 2000])('delivers literal multiline text through real tmux to a %i-column cat pane (75)', (width, ctx) => {
    const text = '-Enter\n' + payload();
    const received = join(root, 'received.txt');
    const paneScript = join(root, 'cat-pane.sh');
    // Signal readiness after terminal setup, and completion only after cat closes its output.
    writeFileSync(paneScript, `set -eu
stty -echo
tmux -S "$1" wait-for -S ready
cat > "$2"
tmux -S "$1" wait-for -S delivered
exec cat
`);
    const output = run(`const { TmuxManager } = await import(${JSON.stringify(moduleUrl('tools/daemon/tmux-manager.mjs'))});
const socket = ${JSON.stringify(join(root, 'tmux.sock'))};
const tmux = args => {
  const result = cp.spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || 'tmux failed');
  return result.stdout;
};
let started = false;
try {
  tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'wp1', '-x', ${JSON.stringify(String(width))}, '-y', '50',
    'sh', ${JSON.stringify(paneScript)}, socket, ${JSON.stringify(received)}]);
  started = true;
  tmux(['wait-for', 'ready']);
  process.env.TMUX = socket + ',0,0';
  const manager = new TmuxManager({ sessionName: 'wp1' });
  manager.sendToPane(0, ${JSON.stringify(text)});
  tmux(['send-keys', '-t', 'wp1:0.0', 'C-d']);
  tmux(['wait-for', 'delivered']);
  console.log(JSON.stringify({ delivered: true }));
} catch (error) {
  if (!started && /Operation not permitted/.test(error.message)) console.log(JSON.stringify({ unavailable: error.message }));
  else throw error;
} finally { if (started) tmux(['kill-server']); }`);
    if (output.unavailable) ctx.skip(output.unavailable);
    expect(output.delivered).toBe(true);
    expect(readFileSync(received, 'utf8')).toBe(text + '\n');
    expectNoSideEffects();
  });

  it.each(['owner/repo', 'owner/.github'])('preserves valid fork repository %s', (upstream) => {
    fakeBinary('gh', "if (process.argv[2] === 'auth') process.stderr.write('Logged in to github.com account tester\\n');\n" +
      "else if (process.argv[3] === 'view') process.exitCode = 1;\n");
    const output = run(`const { forkRepo } = await import(${JSON.stringify(moduleUrl('tools/contrib/lib/github-client.mjs'))});
console.log(JSON.stringify(forkRepo(${JSON.stringify(upstream)})));`);
    expect(output).toMatchObject({ success: true, alreadyExists: false });
    expect(calls().at(-1)).toEqual(['repo', 'fork', upstream, '--remote=false']);
  });

  it('preserves structured failures when spawning gh throws synchronously', () => {
    fakeBinary('gh', "process.stderr.write('Logged in to github.com account tester\\n');\n");
    const output = run(`const { createPR } = await import(${JSON.stringify(moduleUrl('tools/contrib/lib/github-client.mjs'))});
console.log(JSON.stringify(createPR('invalid\\0title', 'body')));`);
    expect(output).toMatchObject({ success: false, number: null, url: null, error: expect.stringContaining('Failed to create PR:') });
    expect(calls()).toEqual([['auth', 'status']]);
  });
});
