import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  root = mkdtempSync(join(repoRoot, 'test/.wp1-shell-'));
  capture = join(root, 'argv.jsonl');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeBinary(name, response = '') {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!${process.execPath}\n` +
    `import fs from 'node:fs';\n` +
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
  // Use file descriptors for subprocess output in runners that restrict pipes.
  // Only I/O is adapted: native execSync still invokes a real shell, so a
  // regression to shell interpolation executes the payload and fails the test.
  const prelude = `import cp from 'node:child_process';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
let invocation = 0;
for (const name of ['execSync', 'execFileSync', 'spawnSync']) {
  const native = cp[name];
  cp[name] = (...args) => {
    const index = name === 'execSync' ? 1 : 2;
    const options = args[index] ?? {};
    const output = process.env.WP1_CAPTURE + '-' + invocation++;
    const stdout = fs.openSync(output, 'w');
    const stderr = fs.openSync(output + '-err', 'w');
    let result;
    try { args[index] = { ...options, stdio: ['ignore', stdout, stderr] }; result = native(...args); }
    finally { fs.closeSync(stdout); fs.closeSync(stderr); }
    const read = file => fs.readFileSync(file, options.encoding ? { encoding: options.encoding } : undefined);
    return name === 'spawnSync' ? { ...result, stdout: read(output), stderr: read(output + '-err') } : read(output);
  };
}
syncBuiltinESMExports();
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
  it('keeps the generated Ralph hook identical to the addon source', () => {
    expect(readFileSync(join(repoRoot, 'agentic/code/plugins/agent-loop/hooks/ralph-commit.js'), 'utf8'))
      .toBe(readFileSync(join(repoRoot, 'agentic/code/addons/agent-loop/hooks/ralph-commit.js'), 'utf8'));
  });
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

  it('sends tmux text literally and Enter separately, including status lines (75)', () => {
    fakeBinary('tmux');
    const text = payload();
    const target = `${text}:0.0`;
    run(`const { TmuxManager } = await import(${JSON.stringify(moduleUrl('tools/daemon/tmux-manager.mjs'))});
const text = ${JSON.stringify(text)};
const manager = new TmuxManager({ sessionName: text });
manager.sendToPane(0, text);
manager.sendToPane(0, '-Enter', false);
manager.updateStatusPane(text);
console.log('null');`);
    const sent = calls().filter(args => args[0] === 'send-keys');
    expect(sent.slice(0, 3)).toEqual([
      ['send-keys', '-t', target, '-l', '--', text],
      ['send-keys', '-t', target, 'Enter'],
      ['send-keys', '-t', target, '-l', '--', '-Enter'],
    ]);
    expect(sent.slice(3)).toEqual([
      ['send-keys', '-t', `${text}:0.1`, 'C-c'],
      ['send-keys', '-t', `${text}:0.1`, 'C-l'],
      ...text.split('\n').flatMap(line => [
        ['send-keys', '-t', `${text}:0.1`, '-l', '--', line],
        ['send-keys', '-t', `${text}:0.1`, 'Enter'],
      ]),
    ]);
    expectNoSideEffects();
  });

  it.skipIf(!tmuxAvailable)('delivers literal multiline text through real tmux to a cat pane (75)', (ctx) => {
    const text = '-Enter\n' + payload();
    const output = run(`const { TmuxManager } = await import(${JSON.stringify(moduleUrl('tools/daemon/tmux-manager.mjs'))});
const socket = ${JSON.stringify(join(root, 'tmux.sock'))};
const tmux = args => {
  const result = cp.spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || 'tmux failed');
  return result.stdout;
};
let started = false;
try {
  tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'wp1', '-x', '2000', '-y', '50', 'cat']);
  started = true;
  process.env.TMUX = socket + ',0,0';
  const manager = new TmuxManager({ sessionName: 'wp1' });
  manager.sendToPane(0, ${JSON.stringify(text)});
  let captured = '';
  for (let i = 0; i < 100; i++) {
    captured = tmux(['capture-pane', '-p', '-t', 'wp1:0.0']);
    if (captured.includes(${JSON.stringify(text)})) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  console.log(JSON.stringify({ captured }));
} catch (error) {
  if (!started && /Operation not permitted/.test(error.message)) console.log(JSON.stringify({ unavailable: error.message }));
  else throw error;
} finally { if (started) tmux(['kill-server']); }`);
    if (output.unavailable) ctx.skip(output.unavailable);
    expect(output.captured).toContain(text);
    expectNoSideEffects();
  });

  it.each(['getPRStatus', 'commentOnPR', 'getPRReviews'])('rejects option-like PR numbers in %s', (method) => {
    fakeBinary('gh', "process.stderr.write('Logged in to github.com account tester\\n');\n");
    const output = run(`const client = await import(${JSON.stringify(moduleUrl('tools/contrib/lib/github-client.mjs'))});
console.log(JSON.stringify(client[${JSON.stringify(method)}]('--help', 'comment')));`);
    expect(output).toMatchObject({ success: false, error: expect.stringContaining('only digits') });
    expect(calls()).toEqual([['auth', 'status']]);
  });

  it.each(['--help/repo', 'owner/--help', 'owner/repo --help', 'owner'])('rejects invalid fork repository %s', (upstream) => {
    fakeBinary('gh');
    const output = run(`const { forkRepo } = await import(${JSON.stringify(moduleUrl('tools/contrib/lib/github-client.mjs'))});
console.log(JSON.stringify(forkRepo(${JSON.stringify(upstream)})));`);
    expect(output).toMatchObject({ success: false, error: 'Repository must be in owner/repo format' });
    expect(existsSync(capture)).toBe(false);
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

  it.each(['title', 'body', 'comment'])('passes gh %s as literal argv (72–74)', (field) => {
    fakeBinary('gh', `if (process.argv[2] === 'auth') process.stderr.write('✓ Logged in to github.com account tester\\n');\n` +
      `else process.stdout.write('https://github.com/example/repo/pull/42\\n');\n`);
    const text = payload();
    const title = field === 'title' ? text : 'title';
    const body = field === 'body' ? text : 'body';
    const output = run(`const { checkGhAuth, commentOnPR, createPR } = await import(${JSON.stringify(moduleUrl('tools/contrib/lib/github-client.mjs'))});
console.log(JSON.stringify({ auth: checkGhAuth(), result: ${field === 'comment'
  ? `commentOnPR(42, ${JSON.stringify(text)})`
  : `createPR(${JSON.stringify(title)}, ${JSON.stringify(body)}, ['bug', 'security'], true)`} }));`);
    expect(output.auth).toMatchObject({ authenticated: true, username: 'tester' });
    if (field === 'comment') {
      expect(output.result).toEqual({ success: true, error: null });
      expect(calls().at(-1)).toEqual(['pr', 'comment', '42', '--body', text]);
    } else {
      expect(output.result).toMatchObject({ success: true, number: 42 });
      expect(calls().at(-1)).toEqual(['pr', 'create', '--title', title, '--body', body, '--draft', '--label', 'bug,security']);
    }
    expectNoSideEffects();
  });
});
