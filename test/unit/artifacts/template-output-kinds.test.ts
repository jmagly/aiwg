// Guard default output templates through fresh-index and packaged discovery.
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { discoverCapability } from '../../../src/artifacts/query-engine.js';
import { scoreEntry } from '../../../src/artifacts/query-engine-scoring.js';
import { matchTemplateOutputKind } from '../../../src/artifacts/template-output-kind.js';
import { loadFortemiCoreMetadataEntries } from '../../../src/artifacts/fortemi-core-query-adapter.js';
import { getGraphIndexDir, type ArtifactIndex, type MetadataEntry } from '../../../src/artifacts/types.js';

const repo = resolve('.');
const defaults = JSON.parse(readFileSync(join(repo, 'test/fixtures/artifacts/template-output-kinds.json'), 'utf8')) as {
  outputKind: string; path: string; phrases: string[];
}[];
const producers = JSON.parse(readFileSync(join(repo, 'test/fixtures/artifacts/template-output-producers.json'), 'utf8')) as Record<string, string[]>;
const probes = defaults.flatMap(item => item.phrases.flatMap(phrase =>
  ['', ' template', ' templates'].map(suffix => ({ ...item, phrase: phrase + suffix }))));
let temporary: string;
let root: string;
let entries: MetadataEntry[];
let packagedEntries: MetadataEntry[];

beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), 'aiwg-output-kinds-'));
  root = join(temporary, 'runtime');
  for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) {
    const target = join(root, 'agentic/code', kind);
    mkdirSync(target, { recursive: true });
    cpSync(join(repo, 'agentic/code', kind), target, { recursive: true });
  }
  writeFileSync(join(root, 'package.json'), '{"name":"aiwg"}');
  const skillDir = join(root, 'agentic/code/addons/synthetic/skills/worker-brief-exact');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: worker brief\ndescription: Prepare a worker brief.\n---\n# Worker brief\n');
  const templateDir = join(root, 'agentic/code/addons/synthetic/templates');
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, 'worker-brief.md'), '---\nname: worker brief\ndescription: Another worker brief.\n---\n# Worker brief\n');
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
    vi.stubEnv(key, join(temporary, key));
  }
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) {
    vi.stubEnv(key, join(temporary, 'artifacts'));
  }
  vi.stubEnv('AIWG_ROOT', repo);
  const packaged = loadFortemiCoreMetadataEntries(repo, 'framework');
  expect(packaged.reason).toBeUndefined();
  packagedEntries = packaged.entries;
  vi.stubEnv('AIWG_ROOT', root);
  await buildIndex(root, { graph: 'framework', force: true, explicit: true, quiet: true });
  const index = JSON.parse(readFileSync(join(getGraphIndexDir(root, 'framework'), 'metadata.json'), 'utf8')) as ArtifactIndex;
  entries = Object.values(index.entries);
}, 120_000);

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

for (const mode of ['fresh index', 'packaged index'] as const) {
  it.each(probes)(`${mode}: "$phrase" ranks $outputKind first`, async ({ phrase, path, outputKind }) => {
    vi.stubEnv('AIWG_ROOT', mode === 'fresh index' ? root : repo);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await discoverCapability(mode === 'fresh index' ? root : repo, {
        phrase, typeFilter: ['template'], graph: 'framework', limit: 3,
        backend: mode === 'fresh index' ? 'local' : 'fortemi-core',
        offline: true, noBuild: true, json: true,
      });
      const result = JSON.parse(log.mock.calls.map(args => args.join(' ')).join('\n')).results[0];
      expect(result?.path).toBe(join(mode === 'fresh index' ? root : repo, path));
      expect(result?.outputKind).toBe(outputKind);
      expect(result?.ranking.lexical_score).toBeGreaterThanOrEqual(1.002);
      expect(result?.ranking.matches).toContainEqual(expect.objectContaining({ field: 'output_kind', match: 'exact' }));
    } finally {
      log.mockRestore();
    }
  });
}

it.each(defaults)('retains $outputKind and aliases through build and packaged export/load', ({ path, outputKind, phrases }) => {
  for (const corpus of [entries, packagedEntries]) {
    const entry = corpus.find(item => item.path === path);
    expect(entry?.type).toBe('template');
    expect(entry?.outputKind).toBe(outputKind);
    expect(entry?.triggers).toEqual(expect.arrayContaining(phrases.map(phrase => phrase.toLowerCase())));
    expect(corpus.filter(item => item.type === 'template' && item.outputKind === outputKind)).toHaveLength(1);
  }
});

it('gives declared defaults priority over competing exact names and triggers', () => {
  const canonical = entries.find(item => item.outputKind === 'worker-brief')!;
  expect(canonical).toBeDefined();
  const decoy = { ...canonical, outputKind: undefined, name: 'worker brief', triggers: ['worker brief'] };
  const opts = { typeFilter: ['template'] };
  expect(scoreEntry(canonical, 'worker brief', opts)).toBeGreaterThan(scoreEntry(decoy, 'worker brief', opts));
  expect(scoreEntry(canonical, 'worker brief', opts)).toBeGreaterThan(scoreEntry({ ...decoy, name: 'other' }, 'worker brief', opts));
  expect(scoreEntry({ ...decoy, type: 'skill' }, 'worker brief')).toBeGreaterThan(scoreEntry(canonical, 'worker brief'));
});

it.each([
  { typeFilter: undefined, type: 'skill', path: 'agentic/code/addons/synthetic/skills/worker-brief-exact/SKILL.md' },
  { typeFilter: [], type: 'skill', path: 'agentic/code/addons/synthetic/skills/worker-brief-exact/SKILL.md' },
  { typeFilter: ['template'], type: 'template', path: 'agentic/code/addons/aiwg-utils/templates/subagent-brief.md' },
  { typeFilter: ['skill', 'template'], type: 'template', path: 'agentic/code/addons/aiwg-utils/templates/subagent-brief.md' },
])('respects exact skill names and explicit type filters: $typeFilter', async ({ typeFilter, type, path }) => {
  vi.stubEnv('AIWG_ROOT', root);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await discoverCapability(root, {
      phrase: 'worker brief', typeFilter, graph: 'framework', limit: 3,
      backend: 'local', offline: true, noBuild: true, json: true,
    });
    const result = JSON.parse(log.mock.calls.map(args => args.join(' ')).join('\n')).results[0];
    expect(result).toMatchObject({ type, path: join(root, path) });
  } finally {
    log.mockRestore();
  }
});

it('matches explicit kinds with separators and case, without promoting incidental or partial text', () => {
  const canonical = entries.find(item => item.outputKind === 'report.security')!;
  expect(matchTemplateOutputKind(canonical, 'REPORT_SECURITY')).toBe('report.security');
  expect(matchTemplateOutputKind(canonical, 'REPORT_SECURITY TEMPLATES')).toBe('report.security');
  expect(matchTemplateOutputKind(canonical, 'security')).toBeUndefined();
  expect(matchTemplateOutputKind(canonical, 'security finding in an unrelated longer query')).toBeUndefined();
  expect(matchTemplateOutputKind({ ...canonical, type: 'skill' }, 'security finding')).toBeUndefined();
  expect(matchTemplateOutputKind({ ...canonical, outputKind: undefined }, 'security finding')).toBeUndefined();
  expect(matchTemplateOutputKind(canonical, ' ')).toBeUndefined();
});

it('declares every utils addon template file in its manifest, including nested templates', () => {
  const addon = join(repo, 'agentic/code/addons/aiwg-utils');
  const manifest = JSON.parse(readFileSync(join(addon, 'manifest.json'), 'utf8')) as { templates: string[] };
  const directory = join(addon, 'templates');
  const files = readdirSync(directory, { recursive: true }) as string[];
  for (const file of files.filter(file => statSync(join(directory, file)).isFile())) {
    expect(manifest.templates, file).toContain(file.replace(/\.[^.]+$/, ''));
  }
});

it.each(['incident', 'release-notes-template', 'change-request-card', 'task-completed'])(
  'retains the explicit canonical name %s in fresh and packaged indexes', name => {
    const path = defaults.find(item => item.path.endsWith('/' + name + '.md'))!.path;
    for (const corpus of [entries, packagedEntries]) {
      expect(corpus.find(item => item.path === path)?.name).toBe(name);
    }
    expect(readFileSync(join(repo, path), 'utf8')).toMatch(new RegExp('^name: ' + name + '$', 'm'));
  },
);

it.each(Object.entries(producers))('%s references the templates it produces in Output template', (path, templates) => {
  const body = readFileSync(join(repo, path), 'utf8');
  const section = body.split(/^## Output template\s*$/m)[1]?.split(/^## /m)[0];
  expect(section).toBeDefined();
  for (const template of templates) expect(section).toContain(template);
});

it('documents every declared default', () => {
  const docs = readFileSync(join(repo, 'docs/output-templates.md'), 'utf8');
  for (const { outputKind, path } of defaults) {
    expect(docs).toContain('`' + outputKind + '`');
    expect(docs).toContain(path);
  }
});
