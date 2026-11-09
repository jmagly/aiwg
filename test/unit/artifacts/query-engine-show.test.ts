// Regressions for packaged body paths and executable skill metadata cards.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex } from '../../../src/artifacts/index-builder.js';
import { discoveryIdForEntry, withIndexProvenance } from '../../../src/artifacts/query-engine-entries.js';
import { showArtifact, showMetadata } from '../../../src/artifacts/query-engine-show.js';
import { resolveMetadataPath } from '../../../src/artifacts/query-engine-show-load.js';
import { getGraphIndexDir, type ArtifactIndex } from '../../../src/artifacts/types.js';

let tmp: string;
let root: string;
let project: string;
const skillPath = 'agentic/code/addons/example/skills/issue-create/SKILL.md';
const templatePath = 'agentic/code/addons/example/templates/bug-report.md';
function put(relative: string, content: string) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function entries() {
  const index = JSON.parse(fs.readFileSync(path.join(getGraphIndexDir(project, 'framework'), 'metadata.json'), 'utf8')) as ArtifactIndex;
  return Object.values(index.entries);
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-show-'));
  root = path.join(tmp, 'runtime');
  project = path.join(tmp, 'project');
  fs.mkdirSync(project, { recursive: true });
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) vi.stubEnv(key, path.join(tmp, key));
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(key, '');
  vi.stubEnv('AIWG_ROOT', root);
  put('package.json', '{"name":"aiwg","version":"1.0.0"}');
  for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) fs.mkdirSync(path.join(root, 'agentic/code', kind), { recursive: true });
  put('docs/agentic-install-runbook.md', '---\ntype: runbook\n---\n# Agentic Install Runbook\n\n## Install\nUse the package.\n');
  put(templatePath, '# Bug Report\n');
  put(skillPath, `---\nname: issue-create\nscript:\n  entrypoint: scripts/compose.mjs\n  runtime: node\n  cwd: project-root\n---\n# Issue Create\n\nUse @${templatePath}\n`);
  await buildIndex(root, { graph: 'framework', quiet: true });
  vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('show packaged artifacts (#4027)', () => {
  it('reads a packaged docs runbook by id outside the package, and reports its source metadata path', async () => {
    const runbook = entries().find(entry => entry.type === 'runbook')!;
    expect(runbook.path).toBe('docs/agentic-install-runbook.md');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const params = { name: discoveryIdForEntry(runbook), typeFilter: ['runbook'], graph: 'framework' as const, backend: 'local' as const };
    await showArtifact(project, { ...params, body: true, json: true });
    const shown = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(shown.path).toBe(path.join(root, runbook.path));
    expect(shown.content).toContain('# Agentic Install Runbook');
    expect(shown.provenance.scope).toBe('packaged');
    await showMetadata(project, { ...params, json: true });
    expect(JSON.parse(String(log.mock.calls.at(-1)![0])).paths.absolute).toBe(shown.path);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await showArtifact(project, { ...params, body: true });
    expect(stdout.mock.calls.map(([value]) => String(value)).join('')).toBe(shown.content);
  });

  it.each(['runbook', 'template', 'skill', 'agent', 'flow', 'command', 'rule', 'behavior'])(
    'anchors packaged %s docs to the scope root even when the project has a shadow file', type => {
      const entry = { ...entries()[0], path: 'docs/shared.md', type };
      fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(project, entry.path), 'Project shadow');
      expect(resolveMetadataPath(project, root, withIndexProvenance(entry, 'framework'))).toBe(path.join(root, entry.path));
      expect(resolveMetadataPath(project, root, withIndexProvenance(entry, 'project'))).toBe(path.join(project, entry.path));
    },
  );
});

describe('show executable skills (#4030)', () => {
  it('renders issue-create by name and id with template relations and a run hint', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const skill = entries().find(entry => entry.path === skillPath)!;
    const params = { typeFilter: ['skill'], backend: 'local' as const };
    await showArtifact(project, { ...params, name: 'issue-create', json: true });
    const card = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(card.run_hint).toBe('aiwg run skill issue-create');
    expect(card.templates).toEqual([expect.objectContaining({ name: 'bug-report', show_command: 'aiwg show template bug-report' })]);
    await showArtifact(project, { ...params, name: 'issue-create' });
    const text = String(log.mock.calls.at(-1)![0]);
    expect(text).toContain('# skill: issue-create');
    expect(text).toContain('## Templates');
    expect(text).toContain('aiwg show template bug-report');
    expect(text).not.toContain('## Used by');
    await showArtifact(project, { ...params, name: discoveryIdForEntry(skill) });
    expect(String(log.mock.calls.at(-1)![0])).toBe(text);
    await showArtifact(project, { name: 'bug-report', typeFilter: ['template'] });
    expect(String(log.mock.calls.at(-1)![0])).toContain('aiwg show skill issue-create');
  });

  it('renders a corpus fallback card with its string installation hint', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // An explicit project graph keeps the package skill out of the index lookup.
    fs.mkdirSync(getGraphIndexDir(project, 'project'), { recursive: true });
    fs.copyFileSync(path.join(getGraphIndexDir(project, 'framework'), 'metadata.json'), path.join(getGraphIndexDir(project, 'project'), 'metadata.json'));
    put('agentic/code/addons/example/skills/unindexed/SKILL.md', '# Unindexed\n');
    await showArtifact(project, { name: 'unindexed', typeFilter: ['skill'], graph: 'project', backend: 'local' });
    expect(String(log.mock.calls.at(-1)![0])).toContain('# skill: unindexed');
  });
});
