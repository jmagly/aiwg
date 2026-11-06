// Keep prompt discovery local and read-only while retaining library ranking.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverCapability } from '../../../src/artifacts/query-engine-discover.js';
import { buildPrebuiltRelations } from '../../../src/artifacts/prebuilt-relations.js';
import { buildAiwgFortemiIndexExport } from '../../../src/artifacts/browser-export.js';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getGraphIndexDir } from '../../../src/artifacts/types.js';

let temporary: string;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-prompt-library-'));
  vi.stubEnv('AIWG_ROOT', temporary);
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
    vi.stubEnv(key, path.join(temporary, key));
  }
  for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR',
    'AIWG_FRAMEWORK_INDEX_CACHE', 'AIWG_FRAMEWORK_INDEX_CACHE_SOURCE']) vi.stubEnv(key, '');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temporary, { recursive: true, force: true });
});

it('ranks synthetic warm metadata without rebuilding indexes or assembling rules', async () => {
  const directory = getGraphIndexDir(temporary, 'framework');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'metadata.json');
  const entries = Object.fromEntries(['security-review', 'security-audit', 'security-check', 'security-test']
    .map(name => [name, {
      type: 'skill', name, title: name, path: `agentic/code/addons/test/skills/${name}/SKILL.md`,
      capability: 'Review authentication security', summary: 'Review authentication security', tags: ['security'],
    }]));
  fs.writeFileSync(file, JSON.stringify({ entries }));
  const before = fs.readFileSync(file, 'utf8');
  const listing = fs.readdirSync(temporary, { recursive: true });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await discoverCapability(temporary, {
    phrase: 'security-review', promptContext: true, limit: 3, backend: 'fortemi-core', json: true,
  });
  const result = JSON.parse(log.mock.calls[0][0]);
  expect(result.results).toHaveLength(3);
  expect(result.results[0]).toMatchObject({ type: 'skill', name: 'security-review', capability: 'Review authentication security' });
  expect(result.results[0].score).toBeGreaterThanOrEqual(1);
  expect(result.results[0]).not.toHaveProperty('required_rule_checks');
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(fs.readdirSync(temporary, { recursive: true })).toEqual(listing);
});

it('returns no candidates on a cold index without creating a cache', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await discoverCapability(temporary, { phrase: 'security review', promptContext: true });
  expect(JSON.parse(log.mock.calls[0][0])).toEqual({ results: [] });
  expect(fs.readdirSync(temporary)).toEqual([]);
});

it('does not saturate matches from disconnected boilerplate in notification-shaped noise', async () => {
  const directory = getGraphIndexDir(temporary, 'framework');
  fs.mkdirSync(directory, { recursive: true });
  const entries = Object.fromEntries(['dispatch', 'status', 'continuation'].map(name => [name, {
    type: 'skill', name, title: name, path: `skills/${name}/SKILL.md`, tags: [], summary: '',
    capability: 'Orchestrate multi-agent teams',
    triggers: ['run the greenfield team on this task', 'security review team'],
  }]));
  fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify({ entries }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await discoverCapability(temporary, {
    phrase: '[SYSTEM NOTIFICATION - NOT USER INPUT] <task-notification> Run completed. Read the security review output file and continue. </task-notification>',
    promptContext: true, limit: 3,
  });
  const results = JSON.parse(log.mock.calls[0][0]).results;
  expect(results).toHaveLength(3);
  for (const result of results) expect(result.score).toBeLessThan(0.70);
});

// A normal project relies solely on the package's shipped tables and search export.
function prebuiltProject() {
  const runtimeRoot = path.join(temporary, 'runtime');
  fs.mkdirSync(runtimeRoot);
  vi.stubEnv('AIWG_ROOT', runtimeRoot);
  const project = path.join(temporary, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(runtimeRoot, 'package.json'), '{"name":"aiwg","version":"1.0.0"}');
  for (const kind of ['frameworks', 'addons', 'extensions', 'agents', 'behaviors']) {
    fs.mkdirSync(path.join(runtimeRoot, 'agentic/code', kind), { recursive: true });
  }
  const skill = 'agentic/code/addons/example/skills/security-review/SKILL.md';
  fs.mkdirSync(path.dirname(path.join(runtimeRoot, skill)), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, skill), '---\nname: security-review\ndescription: Review authentication security\n---\n# Security Review\nReview authentication security.\n');
  const entry = { type: 'skill', name: 'security-review', title: 'Security Review', path: skill,
    phase: '', tags: ['security'], created: '', updated: '', checksum: '',
    summary: 'Review authentication security', capability: 'Review authentication security',
    dependencies: ['agentic/code/addons/example/templates/review.md'], dependents: [] };
  const rulePath = 'agentic/code/addons/example/rules/security-gate.md';
  const ruleText = '---\nname: security-gate\nsummary: Require **security** review before delivery\nenforcement: high\nactivation: summary\n---\n# Security Gate\n**Enforcement Level**: HIGH **Scope**: All agents\n';
  fs.mkdirSync(path.dirname(path.join(runtimeRoot, rulePath)), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, rulePath), ruleText);
  const rule = { ...entry, type: 'rule', name: 'security-gate', title: 'Security Gate', path: rulePath,
    capability: '**Enforcement Level**: HIGH **Scope**: All agents', summary: '**Enforcement Level**: HIGH',
    ruleSummary: 'Require **security** review before delivery', activation: 'summary', ruleEnforcement: 'high' };
  const directory = getGraphIndexDir(runtimeRoot, 'framework');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify({
    version: '1', builtAt: '2026-01-01T00:00:00.000Z', entries: { [skill]: entry, [rulePath]: rule },
  }));
  const templatePath = 'agentic/code/addons/example/templates/review.md';
  fs.mkdirSync(path.dirname(path.join(runtimeRoot, templatePath)), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, templatePath), '# Review Template\n');
  const template = { ...entry, type: 'template', name: 'review', title: 'Review Template', path: templatePath, dependencies: [] };
  const tables = buildPrebuiltRelations(runtimeRoot, [entry, rule, template]);
  for (const [file, text] of Object.entries(tables)) {
    const target = path.join(runtimeRoot, 'prebuilt/framework-relations', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  const exported = buildAiwgFortemiIndexExport(runtimeRoot, { graph: 'framework', schemaVersion: 'v2' });
  const text = JSON.stringify(exported);
  const prebuilt = path.join(runtimeRoot, 'prebuilt/fortemi-core/framework');
  fs.mkdirSync(prebuilt, { recursive: true });
  fs.writeFileSync(path.join(prebuilt, 'aiwg-fortemi-index-v2.json'), text);
  fs.writeFileSync(path.join(prebuilt, 'manifest.json'), JSON.stringify({
    schema_version: 'aiwg.fortemi.prebuilt.v1', backend: 'fortemi-core', graph: 'framework',
    export_path: 'aiwg-fortemi-index-v2.json', export_schema_version: 'aiwg.fortemi.index.export.v2',
    export_checksum: createHash('sha256').update(text).digest('hex'), item_count: exported.items.length,
  }));
  fs.rmSync(path.join(temporary, 'XDG_DATA_HOME'), { recursive: true, force: true });
  return { project, directory, runtimeRoot };
}

it('injects candidates in a project with only a valid prebuilt package and no per-root index', () => {
  const { project, directory, runtimeRoot } = prebuiltProject();
  expect(fs.existsSync(directory)).toBe(false);
  // Forward to the built runtime while resolving corpus/index roots from the fixture.
  const moduleDir = path.join(runtimeRoot, 'dist/src/artifacts');
  fs.mkdirSync(moduleDir, { recursive: true });
  const runtime = new URL('../../../dist/src/artifacts/query-engine-discover.js', import.meta.url).href;
  fs.writeFileSync(path.join(moduleDir, 'query-engine-discover.js'), `export { discoverCapability } from ${JSON.stringify(runtime)};`);
  const hook = fileURLToPath(new URL('../../../agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs', import.meta.url));
  const result = spawnSync(process.execPath, [hook], { cwd: project, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, AIWG_PROMPT_DISCOVERY: '1' },
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'Review authentication security' }),
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  expect(context).toContain('skill security-review');
  expect(context).toContain('Template review: aiwg show template review');
  expect(context.length).toBeLessThan(600);
  expect(fs.existsSync(directory)).toBe(false);
});

it('reads a prebuilt-only package without any filesystem writes, including digest receipts', async () => {
  const { project, directory } = prebuiltProject();
  const snapshot = () => fs.readdirSync(temporary, { recursive: true }).map(String).sort()
    .map(file => [file, fs.statSync(path.join(temporary, file)).isFile()
      ? fs.readFileSync(path.join(temporary, file), 'utf8') : null]);
  const before = snapshot();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const writes = ['writeFileSync', 'mkdirSync', 'renameSync'].map(method =>
    vi.spyOn(fs, method as 'writeFileSync'));
  await discoverCapability(project, { phrase: 'security-review', promptContext: true, limit: 3, json: true });
  const candidate = JSON.parse(log.mock.calls[0][0]).results[0];
  expect(candidate.name).toBe('security-review');
  expect(candidate.templates).toEqual([expect.objectContaining({ name: 'review', show_command: 'aiwg show template review' })]);
  for (const write of writes) expect(write).not.toHaveBeenCalled();
  expect(snapshot()).toEqual(before);
  expect(fs.existsSync(directory)).toBe(false);
});

it('uses a rule frontmatter summary instead of enforcement boilerplate', async () => {
  const directory = getGraphIndexDir(temporary, 'framework');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify({ entries: {
    gate: { type: 'rule', name: 'security-gate', title: 'Security Gate', path: 'rules/security-gate.md',
      tags: ['security'], capability: '**Enforcement Level**: HIGH **Scope**: security',
      summary: 'Security entry summary', ruleSummary: 'Require **security** review before delivery' },
  } }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await discoverCapability(temporary, { phrase: 'security-gate', promptContext: true, limit: 3 });
  expect(JSON.parse(log.mock.calls[0][0]).results[0].capability).toBe('Require **security** review before delivery');
});

it('recovers prebuilt rule summaries when the shipped search export omits rule frontmatter', async () => {
  const { project } = prebuiltProject();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await discoverCapability(project, { phrase: 'security-gate', promptContext: true, limit: 3 });
  const rule = JSON.parse(log.mock.calls[0][0]).results.find((entry: { type: string }) => entry.type === 'rule');
  expect(rule.capability).toBe('Require **security** review before delivery');
});

it.each(['source', 'checksum'])('falls back to existing local metadata when the prebuilt %s is invalid', async invalid => {
  const { project, directory, runtimeRoot } = prebuiltProject();
  if (invalid === 'source') {
    fs.writeFileSync(path.join(runtimeRoot, 'agentic/code/agents/changed.md'), '# Changed source');
  } else {
    fs.appendFileSync(path.join(runtimeRoot, 'prebuilt/framework-relations/relations.json'), ' ');
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify({ entries: {
    local: { type: 'skill', name: 'local-review', title: 'Local Review', path: 'skills/local-review.md',
      tags: [], summary: 'Local review fallback' },
  } }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await discoverCapability(project, { phrase: 'local-review', promptContext: true, limit: 3 });
  expect(JSON.parse(log.mock.calls[0][0]).results[0].name).toBe('local-review');
  expect(fs.readdirSync(directory)).toEqual(['metadata.json']);
});
