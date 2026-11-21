// Reproduce #4352 through sync and query using body-only tokens beyond the export cap.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../../src/artifacts/cli.js';
import { run } from '../../../src/cli/router.js';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { DEFAULT_MAX_SOURCE_BODY_BYTES } from '../../../src/artifacts/browser-export.js';
import { BUILTIN_GRAPH_CONFIGS, GRAPH_CONFIGS } from '../../../src/artifacts/types.js';

let root: string;
let output: ReturnType<typeof vi.spyOn>;
const sizes = [500, 1500, 3000, 6000, 12000];
const expectedPaths = sizes.map(size => `code/f${size}.js`).sort();

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-fulltext-large-'));
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'config'));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  fs.mkdirSync(path.join(root, '.aiwg'));
  fs.mkdirSync(path.join(root, 'code'));
  fs.writeFileSync(path.join(root, '.aiwg', 'aiwg.config'), JSON.stringify({
    index: { graphs: { demo: { scanDirs: ['code'], extensions: ['.js'] } } },
  }));
  for (const size of sizes) {
    const filler = Array.from({ length: size }, (_, i) =>
      `function filler${i + 1}() { return ${i + 1}; }`).join('\n');
    fs.writeFileSync(path.join(root, `code/f${size}.js`),
      `/* header comment for demo module ${size} */\n${filler}\nfunction uniqueNeedleIdentifier() { return 42; }\n`);
  }
  await buildIndex(root, { graph: 'demo', force: true, quiet: true, workers: 1 });
  output.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const key of Object.keys(GRAPH_CONFIGS)) {
    if (!(key in BUILTIN_GRAPH_CONFIGS)) delete GRAPH_CONFIGS[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('large source bodies in Fortemi Core fulltext (#4352)', () => {
  it('finds the trailing needle in all five files, matching the local backend', async () => {
    expect(fs.statSync(path.join(root, 'code/f12000.js')).size)
      .toBeGreaterThan(DEFAULT_MAX_SOURCE_BODY_BYTES);
    await main(['sync', '--graph', 'demo']);
    const exported = JSON.parse(fs.readFileSync(path.join(root,
      '.aiwg/.index/fortemi-core/demo/aiwg-fortemi-index-v2.json'), 'utf8'));
    for (const backend of [[], ['--backend', 'local']]) {
      output.mockClear();
      await main(['query', 'uniqueNeedleIdentifier', '--fulltext', '--graph', 'demo', '--json', ...backend]);
      const result = JSON.parse(output.mock.calls.at(-1)![0] as string);
      expect(result.results.map((entry: { path: string }) => entry.path).sort())
        .toEqual(expectedPaths);
    }
    for (const item of exported.items) {
      expect(item.search.body).toContain('uniqueNeedleIdentifier');
      expect(item.chunks.some((chunk: { text: string }) =>
        chunk.text.includes('uniqueNeedleIdentifier'))).toBe(true);
    }
  });

  it('reports zero size omissions for created, unchanged and all-graph syncs', async () => {
    for (const flags of [['--graph', 'demo'], ['--graph', 'demo'], ['--all']]) {
      output.mockClear();
      await main(['sync', ...flags]);
      expect(output.mock.calls.flat().join('\n'))
        .toContain('Source bodies: no size cap; 0 items omitted for size.');
    }
  });

  it.each(['--help', '-h'])('documents size behavior per backend in query %s', async flag => {
    for (const invoke of [() => main(['query', flag]), () => run(['index', 'query', flag])]) {
      output.mockClear();
      await invoke();
      const help = output.mock.calls.flat().join('\n');
      expect(help).toContain('Usage: aiwg index query');
      expect(help).toContain('--fulltext');
      expect(help).toContain('Fortemi Core: searches text bodies captured at sync, without a size cap');
      expect(help).toContain('local: reads current source files at query time, without a size cap');
      expect(help).toContain('256 KiB');
    }
  });

  it('preserves the general index help route', async () => {
    await run(['index', '--help']);
    expect(output.mock.calls.flat().join('\n')).toContain('Usage: aiwg index <subcommand>');
  });
});
