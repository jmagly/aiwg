/**
 * Index Config Tests (#1491)
 *
 * @source @src/config/aiwg-config.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateIndexConfig, readIndexConfig } from '../../../src/config/aiwg-config.js';

describe('validateIndexConfig', () => {
  it('accepts a project graph backend default and rejects unknown values', () => {
    expect(validateIndexConfig({ graphBackend: 'sqlite', graphs: {} })).toEqual([]);
    expect(validateIndexConfig({ graphBackend: 'redis', graphs: {} })).toContain(
      'index.graphBackend: must be one of json | graphology | sqlite',
    );
  });
  it('accepts an absent/empty block', () => {
    expect(validateIndexConfig(undefined)).toEqual([]);
    expect(validateIndexConfig(null)).toEqual([]);
    expect(validateIndexConfig({})).toEqual([]);
    expect(validateIndexConfig({ graphs: {} })).toEqual([]);
  });

  it('rejects a non-object index', () => {
    expect(validateIndexConfig('nope')).toEqual(['index: must be an object']);
    expect(validateIndexConfig([1, 2])).toEqual(['index: must be an object']);
  });

  it('rejects non-object graphs', () => {
    expect(validateIndexConfig({ graphs: [] })).toEqual([
      'index.graphs: must be an object mapping graph names to definitions',
    ]);
  });

  it('accepts a well-formed JSON graph def', () => {
    const errs = validateIndexConfig({
      graphs: {
        references: {
          scanDirs: ['documentation/references'],
          extensions: ['.md'],
          defaultBuild: false,
          buildTier: 'lightweight',
          buildOrder: 10,
        },
      },
    });
    expect(errs).toEqual([]);
  });

  it('accepts a bounded codebase built-in override', () => {
    expect(validateIndexConfig({
      graphOverrides: {
        codebase: {
          scanDirs: ['backend', 'spec'],
          extensions: ['.py', '.pyi'],
        },
      },
    })).toEqual([]);
  });

  it('accepts project scan scope and rejects malformed or blank roots', () => {
    expect(validateIndexConfig({ graphOverrides: { project: { scanDirs: ['docs'], extensions: ['.md'] } } })).toEqual([]);
    for (const scanDirs of [[], [''], ['  '], [123], 'docs']) {
      expect(validateIndexConfig({ graphOverrides: { project: { scanDirs } } }))
        .toContain('index.graphOverrides.project.scanDirs: must be a non-empty array of strings');
    }
    expect(validateIndexConfig({ graphOverrides: { project: { shared: true } } }))
      .toContain('index.graphOverrides.project.shared: unknown field (supported: scanDirs, extensions)');
  });

  it('rejects unsupported or unsafe built-in override fields', () => {
    const errors = validateIndexConfig({
      graphOverrides: {
        framework: { scanDirs: ['elsewhere'] },
        codebase: { scanDirs: [], shared: true },
      },
    });
    expect(errors).toContain('index.graphOverrides.framework: unsupported built-in graph override (supported: project, codebase)');
    expect(errors).toContain('index.graphOverrides.codebase.scanDirs: must be a non-empty array of strings');
    expect(errors).toContain('index.graphOverrides.codebase.shared: unknown field (supported: scanDirs, extensions)');
  });

  it('flags a graph def missing scanDirs', () => {
    const errs = validateIndexConfig({ graphs: { bad: { extensions: ['.md'] } } });
    expect(errs).toContain('index.graphs.bad.scanDirs: required, must be a non-empty array of strings');
  });

  it('flags empty scanDirs and non-string-array extensions', () => {
    const errs = validateIndexConfig({ graphs: { bad: { scanDirs: [], extensions: [1] } } });
    expect(errs).toContain('index.graphs.bad.scanDirs: required, must be a non-empty array of strings');
    expect(errs).toContain('index.graphs.bad.extensions: must be an array of strings');
  });

  it('flags bad nodeStrategy and graphBackend enums', () => {
    const errs = validateIndexConfig({
      graphs: { g: { scanDirs: ['x'], nodeStrategy: 'weird', graphBackend: 'mongo' } },
    });
    expect(errs).toContain('index.graphs.g.nodeStrategy: must be one of default | filename-metadata');
    expect(errs).toContain('index.graphs.g.graphBackend: must be one of json | graphology | sqlite');
  });

  it('flags bad build ordering fields', () => {
    const errs = validateIndexConfig({
      graphs: {
        g: {
          scanDirs: ['x'],
          buildTier: 'urgent',
          buildOrder: 'first',
        },
      },
    });
    expect(errs).toContain('index.graphs.g.buildTier: must be one of lightweight | standard | heavy');
    expect(errs).toContain('index.graphs.g.buildOrder: must be a finite number');
  });

  it('requires filenamePattern for filename-metadata strategy', () => {
    const errs = validateIndexConfig({ graphs: { g: { scanDirs: ['x'], nodeStrategy: 'filename-metadata' } } });
    expect(errs).toContain("index.graphs.g.filenamePattern: required when nodeStrategy is 'filename-metadata'");
  });

  it('flags an invalid filenamePattern regex', () => {
    const errs = validateIndexConfig({ graphs: { g: { scanDirs: ['x'], filenamePattern: '(' } } });
    expect(errs.some((e) => e.startsWith('index.graphs.g.filenamePattern: not a valid regular expression'))).toBe(true);
  });

  it('validates edgeExtraction parser and edge entries', () => {
    const errs = validateIndexConfig({
      graphs: {
        g: {
          scanDirs: ['x'],
          edgeExtraction: { parser: 'nope', edges: [{ type: 'cites', source: 's' }] },
        },
      },
    });
    expect(errs).toContain("index.graphs.g.edgeExtraction.parser: must be 'citation-sidecar'");
    expect(errs).toContain('index.graphs.g.edgeExtraction.edges[0].target: required, must be a non-empty string');
  });

  it('validates the indices markdown manifest', () => {
    const ok = validateIndexConfig({
      graphs: { indices: { manifest: [{ name: 'by-topic', output: 'indices/by-topic.md' }] } },
    });
    expect(ok).toEqual([]);

    const bad = validateIndexConfig({ graphs: { indices: { manifest: 'nope' } } });
    expect(bad).toContain('index.graphs.indices.manifest: must be an array');

    const missingName = validateIndexConfig({ graphs: { indices: { manifest: [{ output: 'x.md' }] } } });
    expect(missingName.some((e) => e.includes("manifest[0]: 'name' is required"))).toBe(true);
  });

  it('does NOT require scanDirs on the reserved indices key', () => {
    // indices is the markdown manifest, not a JSON graph def — scanDirs is not required.
    const errs = validateIndexConfig({ graphs: { indices: { manifest: [{ name: 'by-year' }] } } });
    expect(errs).toEqual([]);
  });
});

describe('readIndexConfig precedence', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aiwg-index-cfg-'));
    await mkdir(join(dir, '.aiwg'), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeAiwgConfig = (obj: unknown) =>
    writeFile(join(dir, '.aiwg', 'aiwg.config'), JSON.stringify(obj), 'utf-8');
  const writeYaml = (text: string) => writeFile(join(dir, '.aiwg', 'config.yaml'), text, 'utf-8');

  it('returns none when neither file declares an index', async () => {
    await writeAiwgConfig({ version: '1', providers: ['claude'], installed: {}, scripts: {} });
    const { index, source } = await readIndexConfig(dir);
    expect(source).toBe('none');
    expect(index).toBeUndefined();
  });

  it('prefers aiwg.config over config.yaml', async () => {
    await writeAiwgConfig({
      version: '1', providers: ['claude'], installed: {}, scripts: {},
      index: { graphs: { fromJson: { scanDirs: ['a'] } } },
    });
    await writeYaml('index:\n  graphs:\n    fromYaml:\n      scanDirs: [b]\n');
    const { index, source } = await readIndexConfig(dir);
    expect(source).toBe('aiwg.config');
    expect(Object.keys(index!.graphs!)).toContain('fromJson');
    expect(Object.keys(index!.graphs!)).not.toContain('fromYaml');
  });

  it('falls back to config.yaml when aiwg.config has no index block', async () => {
    await writeAiwgConfig({ version: '1', providers: ['claude'], installed: {}, scripts: {} });
    await writeYaml('index:\n  graphs:\n    fromYaml:\n      scanDirs: [b]\n');
    const { index, source } = await readIndexConfig(dir);
    expect(source).toBe('config.yaml');
    expect(Object.keys(index!.graphs!)).toContain('fromYaml');
  });
});
