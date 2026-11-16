import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectCliPackageClosure } from '../../helpers/cli-package-closure.mjs';
import { cliToolFiles, isCliPackageFile } from '../../../tools/release/cli-package-files.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-package-closure-'));
  roots.push(root);
  for (const [filename, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await writeFile(path.join(root, filename), body);
  }
  return root;
}

const CLOSURE_WALK_TIMEOUT_MS = 120_000;

describe('CLI package dependency closure (default lane)', () => {
  it('includes every exported types target in the public package files', async () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    function typesTargets(value: unknown, inTypes = false): string[] {
      if (typeof value === 'string') return inTypes ? [value] : [];
      if (!value || typeof value !== 'object') return [];
      return Object.entries(value).flatMap(([key, child]) => typesTargets(child, inTypes || key === 'types'));
    }
    const targets = typesTargets(manifest.exports);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(isCliPackageFile(target.replace(/^\.\//, ''), manifest.files),
        `${target} from package.json exports is absent from files`).toBe(true);
    }
  });

  it.each([
    "import './missing.mjs';",
    "export { value } from './missing.mjs';",
    "async function lazy() { return import('./missing.mjs'); }",
  ])('names an unlisted module and its authoritative list: %s', async statement => {
    const root = await fixture({ 'tools/entry.mjs': statement, 'tools/missing.mjs': 'export const value = 1;' });
    expect(inspectCliPackageClosure(root, ['tools/entry.mjs']).violations).toEqual([
      'tools/missing.mjs imported by tools/entry.mjs: absent from packages/cli/package.json "files"',
    ]);
  });

  it('walks every shipped entry, directory entries, cycles, and transitive imports', async () => {
    const root = await fixture({
      'bin/entry.mjs': "import '../tools/first.mjs';",
      'tools/first.mjs': "import './second.mjs';",
      'tools/second.mjs': "import './first.mjs'; import './unlisted.mjs';",
      'tools/unlisted.mjs': '',
      'tools/other/entry.mjs': "import '../also-unlisted.mjs';",
      'tools/also-unlisted.mjs': '',
    });
    const entries = ['bin/', 'tools/first.mjs', 'tools/second.mjs', 'tools/other/'];
    const result = inspectCliPackageClosure(root, entries);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.join('\n')).toContain('tools/unlisted.mjs');
    expect(result.violations.join('\n')).toContain('tools/also-unlisted.mjs');
    expect(cliToolFiles(root, entries)).toEqual(['tools/first.mjs', 'tools/other/entry.mjs', 'tools/second.mjs']);
    expect(inspectCliPackageClosure(root, ['bin/', 'tools/']).violations).toEqual([]);
  });

  it.each(['importImpl', 'resolveImpl'])('follows %s targets and TS imports at their installed paths', async loader => {
    const root = await fixture({
      'tools/entry.mjs': `const impl = ${loader}(import.meta.url, 'feature/owner.js');`,
      'src/feature/owner.ts': "import '../../../tools/missing.mjs';",
      'tools/missing.mjs': '',
    });
    const result = inspectCliPackageClosure(root, ['tools/entry.mjs', 'dist/src/']);
    expect(result.visited).toContain('dist/src/feature/owner.js');
    expect(result.violations).toEqual([
      'tools/missing.mjs imported by dist/src/feature/owner.js: absent from packages/cli/package.json "files"',
    ]);
    expect(inspectCliPackageClosure(root, ['tools/entry.mjs']).violations.join('\n'))
      .toContain('dist/src/feature/owner.js imported by tools/entry.mjs: absent from');
  });

  it('honors exclusions and explicit reinclusions, and reports missing source', async () => {
    const entries = ['dist/src/', '!dist/**/*.d.ts', 'dist/src/api/index.d.ts'];
    expect(isCliPackageFile('dist/src/other.d.ts', entries)).toBe(false);
    expect(isCliPackageFile('dist/src/api/index.d.ts', entries)).toBe(true);
    const root = await fixture({ 'tools/entry.mjs': "import './absent.mjs'; // import './comment.mjs'\nconst text = \"import('./string.mjs')\";" });
    expect(inspectCliPackageClosure(root, ['tools/']).violations).toEqual([
      'tools/absent.mjs imported by tools/entry.mjs: source missing for packages/cli/package.json "files"',
    ]);
  });

  it('follows the existing worker loaders and constructed resolver import', async () => {
    const root = await fixture({
      'src/mcp/tools/worker-invoke.mjs': "loadRalphExternal('lib/worker-context.mjs');",
      'tools/ralph-external/lib/worker-context.mjs': '',
      'tools/_resolve-impl.mjs': '',
    });
    const result = inspectCliPackageClosure(root, ['dist/src/']);
    expect(result.violations).toEqual([
      'tools/_resolve-impl.mjs imported by dist/src/mcp/tools/worker-invoke.mjs: absent from packages/cli/package.json "files"',
      'tools/ralph-external/lib/worker-context.mjs imported by dist/src/mcp/tools/worker-invoke.mjs: absent from packages/cli/package.json "files"',
    ]);
  });

  it('ignores erased type imports and refuses a listed tool with missing source', async () => {
    const root = await fixture({ 'src/entry.ts': "import type { Value } from './erased.js'; export const value = 1;" });
    expect(inspectCliPackageClosure(root, ['dist/src/']).violations).toEqual([]);
    expect(() => cliToolFiles(root, ['tools/missing.mjs']))
      .toThrow('tools/missing.mjs: source missing for packages/cli/package.json "files"');
  });

  // Walks the full package import graph (about 6 s on an idle host); the default 30 s
  // timeout failed under the 4-worker default lane on a busy host. The assertions are unchanged.
  it('the real package ships the complete import graph from every entry point', async () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    const manifest = JSON.parse(await readFile(path.join(root, 'packages/cli/package.json'), 'utf8'));
    const result = inspectCliPackageClosure(root, manifest.files);
    expect(result.visited).toContain('tools/ralph-external/lib/worker-context.mjs');
    expect(result.visited).toContain('tools/ralph-external/lib/worker-local-only-paths.mjs');
    expect(result.visited).toContain('dist/src/cli/router.js');
    expect(result.visited).toContain('tools/providers/pi-bridge-policy.mjs');
    expect(result.visited).toContain('dist/src/policy/hitl-config.js');
    for (const module of ['index', 'daemon-main', 'ipc-client', 'tmux-manager']) {
      expect(result.visited).toContain(`tools/daemon/${module}.mjs`);
    }
    expect(result.visited).toContain('dist/src/process/signal-child.mjs');
    expect(result.visited).toContain('dist/src/process/bounded-child-process.mjs');
    for (const module of [
      'artifacts/corpus-tools/resolve-cli', 'artifacts/corpus-tools/resolve',
      'artifacts/corpus-tools/resolve-corpus', 'research/identity', 'research/reference-match',
    ]) expect(result.visited).toContain(`dist/src/${module}.js`);
    expect(result.violations).toEqual([]);
  }, CLOSURE_WALK_TIMEOUT_MS);
});
