import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { inventoryWorkflowExecution } from '../../../tools/security/workflow-execution-inventory.mjs';

const contents = (files: Record<string, string>) => Object.entries(files).map(([path, content]) => ({
  path, content, sha256: createHash('sha256').update(content).digest('hex'),
}));
const inventory = (files: Record<string, string>, boundary: 'read' | 'execute' = 'read') =>
  inventoryWorkflowExecution({ head: 'a'.repeat(40), contents: contents(files) }, { executionBoundary: boundary });

describe('workflow execution inventory', () => {
  it('links PR204-style commands to scripts, local actions, Dockerfiles, and mutable refs', () => {
    const report = inventory({
      '.github/workflows/fc-market.yml': `jobs:\n  build:\n    runs-on: ubuntu-latest\n    services:\n      postgres:\n        image: postgres:17-alpine\n    steps:\n      - uses: actions/checkout@v4\n      - uses: ./.github/actions/build\n      - run: pnpm install --frozen-lockfile && pnpm run build && pnpm exec playwright install chromium && docker build -t cards .\n`,
      '.github/actions/build/action.yml': `runs:\n  using: composite\n  steps:\n    - run: yarn test\n      shell: bash\n`,
      'package.json': JSON.stringify({ scripts: { postinstall: 'node scripts/setup.js', build: 'bun run bundle', bundle: 'node scripts/bundle.js', test: 'node scripts/test.js' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
      'Dockerfile': 'FROM node:22-alpine\nRUN corepack pnpm install --frozen-lockfile\n',
      'scripts/setup.js': '// inert\n',
      'scripts/bundle.js': '// inert\n',
      'scripts/test.js': '// inert\n',
    }, 'execute');
    expect(report.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'container-image', ref: 'postgres:17-alpine', immutable: false }),
      expect.objectContaining({ kind: 'remote-action', ref: 'actions/checkout@v4', immutable: false }),
      expect.objectContaining({ kind: 'local-action' }),
      expect.objectContaining({ kind: 'browser-download' }),
      expect.objectContaining({ kind: 'dockerfile' }),
      expect.objectContaining({ kind: 'package-script', name: 'postinstall' }),
      expect.objectContaining({ kind: 'package-script', name: 'bundle' }),
      expect.objectContaining({ kind: 'package-install', lock: expect.objectContaining({ path: 'pnpm-lock.yaml' }) }),
    ]));
    expect(report.completeness.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'dependency-lifecycle-unreviewed' }),
    ]));
    expect(report.decision.action).toBe('require-authorization');
    const buildScript = report.nodes.find(node => node.kind === 'package-script' && node.name === 'build');
    expect(buildScript?.source).toEqual(expect.objectContaining({ path: 'package.json', sha256: expect.any(String), pointer: 'scripts.build' }));
    expect(report.edges.some(edge => edge.to === buildScript?.id)).toBe(true);
  });

  it('distinguishes pinned refs and offline reviewed scripts from mutable execution evidence', () => {
    const files = {
      '.github/workflows/ci.yml': `jobs:\n  test:\n    steps:\n      - uses: org/repo@${'b'.repeat(40)}\n      - run: npm run test\n    services:\n      postgres:\n        image: postgres@sha256:${'c'.repeat(64)}\n`,
      'package.json': JSON.stringify({ scripts: { test: 'node test.js' } }),
      'test.js': 'console.log("ok")',
    };
    const report = inventoryWorkflowExecution({ head: 'a'.repeat(40), contents: contents(files) }, {
      executionBoundary: 'execute', reviewedScriptHashes: [
        createHash('sha256').update('npm run test').digest('hex'),
        createHash('sha256').update('node test.js').digest('hex'),
        createHash('sha256').update(files['test.js']).digest('hex'),
      ],
    });
    expect(report.nodes.filter(node => node.kind === 'remote-action').every(node => node.immutable)).toBe(true);
    expect(report.nodes.filter(node => node.kind === 'container-image').every(node => node.immutable)).toBe(true);
    expect(report.completeness.complete).toBe(true);
    expect(report.nodes.find(node => node.kind === 'local-script-entrypoint')).toEqual(expect.objectContaining({ reviewed: true, source: expect.objectContaining({ path: 'test.js' }) }));
    expect(report.findings.every(item => item.severity === 'low')).toBe(true);
    expect(report.decision.action).toBe('separate-authorization-required');
    expect(inventory({ '.github/workflows/ci.yml': 'jobs:\n  test:\n    steps:\n      - run: echo hello\n' }).decision.action).toBe('proceed');
  });

  it('traverses reusable workflows and surfaces missing and cyclic destinations', () => {
    const report = inventory({
      '.github/workflows/main.yml': 'jobs:\n  call:\n    uses: ./.github/workflows/other.yml\n',
      '.github/workflows/other.yml': 'jobs:\n  call:\n    uses: ./.github/workflows/main.yml\n  missing:\n    steps:\n      - uses: ./no-such-action\n',
    });
    expect(report.completeness.complete).toBe(false);
    expect(report.completeness.omissions.map(item => item.reason)).toContain('workflow-cycle-or-depth-limit');
    expect(report.completeness.omissions.map(item => item.reason)).toContain('local-action-unavailable');
  });

  it('resolves job working directories and ignores lifecycle only when explicitly disabled', () => {
    const report = inventory({
      '.github/workflows/app.yml': 'jobs:\n  build:\n    defaults:\n      run:\n        working-directory: apps/card\n    steps:\n      - run: pnpm install --frozen-lockfile --ignore-scripts && pnpm run build\n',
      'apps/card/package.json': JSON.stringify({ scripts: { postinstall: 'node bootstrap.js', build: 'node build.js' } }),
      'apps/card/pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
      'apps/card/build.js': '// offline fixture',
    });
    expect(report.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'package-install', ignoreScripts: true,
        lock: expect.objectContaining({ path: 'apps/card/pnpm-lock.yaml' }) }),
      expect.objectContaining({ kind: 'package-script', name: 'build' }),
    ]));
    expect(report.nodes.some(node => node.kind === 'package-script' && node.name === 'postinstall')).toBe(false);
    expect(report.completeness.omissions.some(item => item.reason === 'dependency-lifecycle-unreviewed')).toBe(false);
  });

  it('enforces exact content hashes and bounded snapshots', () => {
    expect(() => inventoryWorkflowExecution({ contents: contents({ 'x': 'y' }) })).toThrow('immutable commit SHA');
    expect(() => inventoryWorkflowExecution({ head: 'a'.repeat(40), contents: [{ path: 'x', content: 'y', sha256: 'bad' }] })).toThrow('Hash mismatch');
    expect(() => inventoryWorkflowExecution({ head: 'a'.repeat(40), contents: [{ path: 'x', content: 'y', sourceRevision: 'b'.repeat(40) }] })).toThrow('Source revision mismatch');
    expect(() => inventoryWorkflowExecution({ head: 'a'.repeat(40), contents: [{ path: '../x', content: 'y' }] })).toThrow('Invalid');
    expect(() => inventoryWorkflowExecution({ head: 'a'.repeat(40), contents: [{ path: 'x', content: 'x'.repeat(262_145) }] })).toThrow('byte limit');
  });

  it('applies configured policy only at the execution boundary', () => {
    const snapshot = { head: 'a'.repeat(40), contents: contents({
      '.github/workflows/ci.yml': 'jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n',
    }) };
    const policy = { schemaVersion: '1', mode: 'enforce', defaultProfile: 'high-assurance' };
    const read = inventoryWorkflowExecution(snapshot, { executionBoundary: 'read', policy });
    const execute = inventoryWorkflowExecution(snapshot, { executionBoundary: 'execute', policy });
    expect(read.decision.action).toBe('proceed');
    expect(execute.decision.action).toBe('require-authorization');
    expect(execute.policy.profile).toBe('high-assurance');
  });
});
