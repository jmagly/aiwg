// Synthetic conductor tool events exercise refusal before any task content is read.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectLocalOnlyPaths, conductorToolDenial, conductorWorkerTrees, validLocalOnlyPath } from '../../../src/models/conductor-data-policy.mjs';
import { mergeWorkerSelection, WorkerSelectionPolicySchema } from '../../../src/models/worker-selection-policy.js';
import { diagnoseWorkerHealthReadiness } from '../../../src/models/worker-health-readiness.js';
import { workerResolutionFixture } from '../../fixtures/worker-resolution.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tool = (command: string, cwd?: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const recorded = JSON.parse(readFileSync(new URL('../../fixtures/models/conductor-worker-commands.json', import.meta.url), 'utf8'));
const workerFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwg-conductor-worker-')); roots.push(root);
  const tree = path.join(root, '.eval-control/worker-tree');
  mkdirSync(path.join(tree, 'eval-work'), { recursive: true });
  mkdirSync(path.join(root, '.git/worktrees/worker'), { recursive: true });
  writeFileSync(path.join(root, '.git/worktrees/worker/gitdir'), path.join(tree, '.git') + '\n');
  writeFileSync(path.join(tree, '.git'), `gitdir: ${root}/.git/worktrees/worker\n`);
  return { root, tree };
};

describe('T-OG-01 conductor worker execution guard (#3833)', () => {
  it.each(recorded)('allows the inert recorded input with execution checks disabled: $source', ({ root, event }) => {
    expect(conductorToolDenial(event, root, [], [])).toBeNull();
  });
  it.each(recorded)('denies the inert exact recorded input from $source', ({ root, workerTree, event }) => {
    expect(conductorToolDenial(event, root, [], [workerTree])).toMatch(/execute or import.*aiwg ralph-external --verify-worker/);
  });
  it.each(recorded)('discovers the registered tree for relocated $source', record => {
    const { root } = workerFixture();
    const event = JSON.parse(JSON.stringify(record.event).replaceAll(record.root, root));
    expect(conductorToolDenial(event, root, [])).toMatch(/aiwg ralph-external --verify-worker/);
  });
  it.each([
    'cd .eval-control/worker-tree && npm test',
    'cd .eval-control/worker-tree; nice -n 19 npx vitest run',
    'npm --prefix .eval-control/worker-tree test',
    'env CI=1 python3 .eval-control/worker-tree/eval-work/test.py',
    'timeout 10s env -C .eval-control/worker-tree sh -c "npm test"',
    'NODE_OPTIONS=--require=./.eval-control/worker-tree/setup.cjs node trusted.mjs',
    'systemd-run --user --working-directory=.eval-control/worker-tree -- node test.mjs',
    'python3 -c "import sys; sys.path.insert(0, \'./.eval-control/worker-tree\'); import reset"',
    'node --input-type=module -e "import(\'./.eval-control/worker-tree/eval-work/reset.mjs\')"',
    'sh -lc \'cd .eval-control/worker-tree && pytest\'',
    './.eval-control/worker-tree/check.sh',
    'cp .eval-control/worker-tree/eval-work/test.py copied.py; python3 copied.py',
    'node .aiwg/working/worktrees/task/test.mjs',
    'aiwg ralph-external --verify-worker; node .eval-control/worker-tree/test.mjs',
  ])('denies worker execution: %s', command => {
    const { root } = workerFixture();
    expect(conductorToolDenial(tool(command, root), root, [])).toMatch(/aiwg ralph-external --verify-worker/);
  });
  it.each([
    'git -C .eval-control/worker-tree diff --stat',
    'git -C .eval-control/worker-tree diff -- eval-work/reset.mjs',
    'nice -n 19 git -C .eval-control/worker-tree diff',
    'timeout 10s git -C .eval-control/worker-tree diff',
    'cat .eval-control/worker-tree/eval-work/reset.mjs',
    'sha256sum .eval-control/worker-tree/eval-work/reset.test.mjs',
    'cp .eval-control/worker-tree/eval-work/reset.mjs eval-work/reset.mjs',
    'node trusted-check.mjs',
    'node .eval-control/worker-tree-other/check.mjs',
    'aiwg models resolve --workdir .eval-control/worker-tree --format shell',
    'aiwg ralph-external --verify-worker --run-dir /private/run --check \'{"id":"unit","command":"/usr/bin/node","args":["test.mjs"],"cwd":".eval-control/worker-tree"}\'',
    'cd .eval-control/worker-tree && git diff && cat eval-work/reset.mjs',
  ])('allows inspection and trusted entry points: %s', command => {
    const { root } = workerFixture();
    expect(conductorToolDenial(tool(command, root), root, [])).toBeNull();
  });
  it('handles worker cwd and symlink aliases without opening or executing source', () => {
    const { root, tree } = workerFixture();
    symlinkSync(tree, path.join(root, 'alias'));
    writeFileSync(path.join(tree, 'eval-work/reset.mjs'), 'throw new Error("MUST NEVER EXECUTE");');
    expect(conductorToolDenial(tool('node eval-work/reset.mjs', tree), root, [])).toMatch(/--verify-worker/);
    expect(conductorToolDenial(tool('node alias/eval-work/reset.mjs', root), root, [])).toMatch(/--verify-worker/);
    expect(conductorToolDenial(tool('git diff', tree), root, [])).toBeNull();
    expect(conductorToolDenial({ tool_name: 'Read', tool_input: { file_path: path.join(tree, 'eval-work/reset.mjs') } }, root, [])).toBeNull();
  });
  it('finds sibling worker trees from a linked conductor checkout', () => {
    const { root, tree } = workerFixture();
    const conductor = path.join(root, 'conductor');
    mkdirSync(conductor);
    mkdirSync(path.join(root, '.git/worktrees/conductor'));
    writeFileSync(path.join(conductor, '.git'), 'gitdir: ../.git/worktrees/conductor\n');
    writeFileSync(path.join(root, '.git/worktrees/conductor/commondir'), '../..\n');
    writeFileSync(path.join(root, '.git/worktrees/conductor/gitdir'), path.join(conductor, '.git') + '\n');
    expect(conductorWorkerTrees(conductor)).toContain(tree);
    expect(conductorWorkerTrees(conductor)).not.toContain(conductor);
    expect(conductorToolDenial(tool(`python3 ${tree}/check.py`, conductor), conductor, [])).toMatch(/--verify-worker/);
  });
});

describe('T-OG-01 local-only conductor input policy', () => {
  it.each(['../private', '/private', 'a/../b', './secret', 'a//b', 'a/*', 'a)\nBash(*)', '', '.', '..', 'a/.', 'secret\n', 'secret\r', 'secret\u2028'])('rejects unsafe policy path %j', file => {
    expect(validLocalOnlyPath(file)).toBe(false);
    expect(WorkerSelectionPolicySchema.safeParse({ dataPolicy: { localOnlyPaths: [file] } }).success).toBe(false);
  });
  it('unions inherited protected paths instead of relaxing them', () => {
    const { policy, diagnostics } = mergeWorkerSelection([
      { source: 'user', authority: 'user', digest: 'u', policy: { dataPolicy: { localOnlyPaths: ['private'] } } },
      { source: 'project', authority: 'project', digest: 'p', policy: { dataPolicy: { localOnlyPaths: [] },
        dataClasses: { 'local-only': { allowedProcessing: ['local'], localOnlyPaths: ['eval-work/local.txt'] } } } },
    ]);
    expect(diagnostics).toEqual([]);
    expect(collectLocalOnlyPaths(policy, { groups: { workers: { members: [], maxParallel: 1, dataPolicy: { localOnlyPaths: ['group/input'] } } } }))
      .toEqual(['eval-work/local.txt', 'group/input', 'private']);
  });
  it.each([
    'cat eval-work/local.txt | head -5',
    'ls -la . && cat eval-work/local.txt 2>/dev/null | head -5 && pwd',
    'cat "eval-work/local.txt"',
    'head < eval-work/local.txt',
    'python -c "open(\'eval-work/local.txt\').read()"',
  ])('refuses the explicit shell reference %s', command => {
    expect(conductorToolDenial(tool(command), '/project', ['eval-work/local.txt'])).toMatch(/local-only/);
  });
  it.each([
    'for f in eval-work/*.json eval-work/*.txt .eval-control/policy.md; do echo "=== $f ==="; cat "$f"; done',
    'cat eval-work/*.txt',
    'cat eval-work/loc?l.txt',
    'cat eval-work/[kl]ocal.txt',
    'cat eval-work/[!p]*.txt',
    'cat eval-work/[a-z]*.txt',
    'cat eval-*/local.*',
    'cat **/local.txt',
    'cat eval-work/**/*.txt',
    'cat "eval-work/"*.txt',
    'cat < eval-work/*.txt',
    'grep -r x eval-work',
    'grep -Rn x ./eval-work',
    'grep --recursive -e x eval-work',
    'grep -r -e x -- eval-work',
    'rg x eval-work',
    'rg --glob "*.txt" x eval-work',
    'rg --files eval-work',
    'rg x',
    'grep -r x',
    'find eval-work -type f -exec cat {} \\;',
  ])('refuses glob or ancestor reads: %s', command => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-conductor-glob-')); roots.push(root);
    mkdirSync(path.join(root, 'eval-work'));
    writeFileSync(path.join(root, 'eval-work/local.txt'), 'synthetic local-only input');
    expect(conductorToolDenial(tool(command, root), root, ['eval-work/local.txt'])).toMatch(/local-only/);
  });
  it.each([
    'cat eval-work/public.txt',
    'ls eval-work',
    'cat eval-work/*.json',
    'cat eval-work/**/*.json',
    'cat eval-work/[!l]*.txt',
    'cat eval-work/*.tx',
    'cat eval-work/*/local.txt',
    'cat "eval-work/*.txt"',
    "cat 'eval-work/loc?l.txt'",
    'cat eval-work/\\*.txt',
    'cat eval-work/"*".txt',
    'grep x eval-work',
    'grep -r x public-inputs',
    'rg x public-inputs',
    'rg -e x public-inputs',
    'find public-inputs -exec cat {} \\;',
    'rg x public-inputs; ls eval-work',
  ])('allows commands that cannot read the protected file: %s', command => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-conductor-glob-')); roots.push(root);
    mkdirSync(path.join(root, 'eval-work'));
    writeFileSync(path.join(root, 'eval-work/local.txt'), 'synthetic local-only input');
    expect(conductorToolDenial(tool(command, root), root, ['eval-work/local.txt'])).toBeNull();
  });
  it('resolves glob cwd and symlink ancestors, including protected directory subtrees', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-conductor-glob-')); roots.push(root);
    mkdirSync(path.join(root, 'eval-work'));
    mkdirSync(path.join(root, 'private-inputs/deep'), { recursive: true });
    writeFileSync(path.join(root, 'eval-work/local.txt'), 'synthetic local-only input');
    writeFileSync(path.join(root, 'private-inputs/deep/input.txt'), 'synthetic nested input');
    symlinkSync(path.join(root, 'eval-work'), path.join(root, 'alias-dir'));
    const paths = ['eval-work/local.txt', 'private-inputs'];
    for (const command of ['cat *.txt', 'cat ../eval-work/*.txt', 'rg x .']) {
      expect(conductorToolDenial(tool(command, path.join(root, 'eval-work')), root, paths)).toBeTruthy();
    }
    for (const command of ['cat alias-dir/*.txt', 'rg x alias-dir', 'cat private-*/*', 'cat private-*/*/*.txt']) {
      expect(conductorToolDenial(tool(command, root), root, paths)).toBeTruthy();
    }
    expect(conductorToolDenial(tool(`cat ${root}/eval-work/*.txt`), root, paths)).toBeTruthy();
    expect(conductorToolDenial(tool('cat private-inputs/*'), root, ['private-inputs'])).toBeTruthy();
  });
  it('normalizes Read paths and nested cwd, blocks subtrees and symlink aliases', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aiwg-conductor-input-')); roots.push(root);
    mkdirSync(path.join(root, 'eval-work'));
    writeFileSync(path.join(root, 'eval-work/local.txt'), 'synthetic local-only input');
    symlinkSync(path.join(root, 'eval-work/local.txt'), path.join(root, 'alias'));
    const paths = ['eval-work/local.txt'];
    expect(conductorToolDenial({ tool_name: 'Read', tool_input: { file_path: './eval-work/../eval-work/local.txt' } }, root, paths)).toBeTruthy();
    expect(conductorToolDenial(tool('cat local.txt', path.join(root, 'eval-work')), root, paths)).toBeTruthy();
    expect(conductorToolDenial(tool('cat alias'), root, paths)).toBeTruthy();
    expect(conductorToolDenial({ tool_name: 'Grep', tool_input: { path: 'private/deep/file' } }, root, ['private'])).toBeTruthy();
    expect(conductorToolDenial(tool('cat public.txt'), root, paths)).toBeNull();
    expect(conductorToolDenial({ tool_name: 'Read', tool_input: { file_path: 'README.md' } }, root, paths)).toBeNull();
  });
  it('doctor lists declarations even when worker dispatch is disabled', () => {
    const f = workerResolutionFixture();
    f.snapshot.config.parallelism!.worker_dispatch = false;
    f.snapshot.models.defaults.workerSelection!.dataPolicy = { localOnlyPaths: ['eval-work/local.txt'] };
    const report = diagnoseWorkerHealthReadiness(f.snapshot, f.request);
    expect(report.findings.find(item => item.code === 'CONDUCTOR_LOCAL_ONLY_PATHS')?.message).toContain('eval-work/local.txt');
  });
});
