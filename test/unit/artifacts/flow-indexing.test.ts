/**
 * Flow Document Indexing (#1540)
 *
 * YAML Flow documents (the workflow metalanguage, apiVersion workflow.aiwg.io/v1)
 * are pure YAML, not markdown+frontmatter — the standard frontmatter path left
 * them unclassified and invisible to `aiwg discover`. These tests cover the
 * parseFlowDoc detector and that buildIndex classifies a Flow doc as type
 * 'flow' with discovery metadata (name + capability from spec.description).
 *
 * @source @src/artifacts/index-builder.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseFlowDoc, parseRunbookDoc, buildIndex } from '../../../src/artifacts/index-builder.js';
import { main } from '../../../src/artifacts/cli.js';
import { discoverCapability } from '../../../src/artifacts/query-engine-discover.js';
import { showArtifact } from '../../../src/artifacts/query-engine-show.js';
import { listHandler } from '../../../src/cli/handlers/subcommands-list.js';
import { discoverProjectLocalBundles } from '../../../src/extensions/project-local-discovery.js';
import { INDEX_DIR } from '../../../src/artifacts/types.js';

const CAPABILITY_YAML = `apiVersion: workflow.aiwg.io/v1
kind: WorkflowCapability
metadata:
  name: check-tls-expiry
  labels:
    category: pki
spec:
  description: Check a TLS certificate's expiry date for a given host
  agent: workflow-executor
`;

describe('parseFlowDoc', () => {
  it('detects a workflow.aiwg.io/v1 capability and extracts discovery metadata', () => {
    const r = parseFlowDoc(CAPABILITY_YAML, 'foo/check-tls.yaml');
    expect(r).not.toBeNull();
    expect(r!.name).toBe('check-tls-expiry');
    expect(r!.description).toBe("Check a TLS certificate's expiry date for a given host");
    expect(r!.tags).toContain('pki');
    expect(r!.kind).toBe('WorkflowCapability');
    expect(r!.searchTerms).toContain('agent');
    expect(r!.searchTerms).toContain('workflow-executor');
  });

  it('accepts the legacy ops.aiwg.io/v1 alias', () => {
    const doc = CAPABILITY_YAML.replace('workflow.aiwg.io/v1', 'ops.aiwg.io/v1');
    expect(parseFlowDoc(doc, 'x.yaml')).not.toBeNull();
  });

  it('accepts the forward Flows alias flow.aiwg.io/v1 (#1536)', () => {
    const doc = CAPABILITY_YAML.replace('workflow.aiwg.io/v1', 'flow.aiwg.io/v1');
    expect(parseFlowDoc(doc, 'x.yaml')).not.toBeNull();
  });

  it('accepts a domain-extension namespace (sys.workflow.aiwg.io/v1)', () => {
    const doc = CAPABILITY_YAML.replace('workflow.aiwg.io/v1', 'sys.workflow.aiwg.io/v1');
    expect(parseFlowDoc(doc, 'x.yaml')).not.toBeNull();
  });

  it('rejects an unrelated domain resource whose namespace merely ends in ops.aiwg.io', () => {
    const doc = 'apiVersion: repo-maintainer.ops.aiwg.io/v1\nkind: RepoMaintenanceDecision\nmetadata:\n  name: decision\n';
    expect(parseFlowDoc(doc, 'x.yaml')).toBeNull();
  });

  it('derives searchable capability text for process resources without a description', () => {
    const doc = [
      'apiVersion: flow.aiwg.io/v1',
      'kind: FlowPlaybook',
      'metadata:',
      '  name: rotate-certificates',
      'spec:',
      '  steps:',
      '    - id: verify-expiry',
      '      capability: check-tls-expiry',
      '',
    ].join('\n');
    const result = parseFlowDoc(doc, 'x.yaml');
    expect(result?.capability).toContain('Flow Playbook rotate-certificates');
    expect(result?.searchTerms).toContain('check-tls-expiry');
  });

  it('classifies a declarative Runbook kind separately from flows', () => {
    const doc = CAPABILITY_YAML.replace('WorkflowCapability', 'WorkflowRunbook');
    expect(parseFlowDoc(doc, 'x.yaml')?.type).toBe('runbook');
  });

  it('returns null for a non-flow YAML', () => {
    expect(parseFlowDoc('apiVersion: v1\nkind: Pod\n', 'x.yaml')).toBeNull();
  });

  it('returns null for a .md file even if content looks like a flow', () => {
    expect(parseFlowDoc(CAPABILITY_YAML, 'x.md')).toBeNull();
  });

  it('returns null for unparseable YAML', () => {
    expect(parseFlowDoc(':\n  - [unbalanced', 'x.yaml')).toBeNull();
  });
});

describe('parseRunbookDoc', () => {
  const runbookBody = `# Certificate Rotation Runbook

## Purpose

Rotate expiring service certificates without interrupting clients.

## Procedure

Issue the replacement and deploy it to the edge.

## Verification

Confirm the new serial is served.

## Rollback

Restore the prior certificate if verification fails.
`;

  it('detects a procedural Markdown runbook and extracts structured terms', () => {
    const result = parseRunbookDoc({}, runbookBody, 'ops/certificate-rotation-runbook.md');
    expect(result?.kind).toBe('Runbook');
    expect(result?.capability).toContain('Rotate expiring service certificates');
    expect(result?.searchTerms).toContain('Verification');
    expect(result?.searchTerms.some(term => term.includes('prior certificate'))).toBe(true);
  });

  it('does not promote a runbook template that lacks executable process sections', () => {
    const template = '# Support Runbook Template\n\n## Purpose\n\nDescribe the service.\n\n## Document Sections\n\nFill these in.\n';
    expect(parseRunbookDoc({}, template, 'templates/support-runbook-template.md')).toBeNull();
  });
});

describe('buildIndex classifies Flow documents (#1540)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-flow-index-'));
    for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
      vi.stubEnv(key, path.join(tmpDir, key));
    }
    for (const key of ['AIWG_ARTIFACTS_PATH', 'AIWG_PROJECT_ARTIFACTS_PATH', 'AIWG_PROJECT_AIWG_DIR', 'AIWG_PROJECT_LOCAL_PATHS']) vi.stubEnv(key, '');
    vi.stubEnv('AIWG_ROOT', path.join(tmpDir, 'runtime'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    { location: 'local', entry: 'flows/', backend: 'local' as const },
    { location: 'relocated', entry: 'processes/ux/', backend: 'local' as const },
    { location: 'local', entry: 'flows/', backend: 'fortemi-core' as const },
    { location: 'relocated', entry: 'processes/ux/', backend: 'fortemi-core' as const },
  ])('discovers and lists an addon flow with ownership ($location root, $backend, #4089)', async ({ location, entry, backend }) => {
    const artifactRoot = path.join(tmpDir, location === 'local' ? '.aiwg' : 'private-artifacts');
    if (location === 'relocated') fs.writeFileSync(path.join(tmpDir, '.aiwg-location'), 'private-artifacts\n');
    const bundle = path.join(artifactRoot, 'addons', 'ux-studio');
    fs.mkdirSync(path.join(bundle, entry), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify({
      id: 'ux-studio', type: 'addon', name: 'UX Studio', version: '2026.11.6',
      description: 'Redesign screens', manifestVersion: '1', platforms: { claude: 'full' },
      keywords: ['ux'], deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
      addonConfig: { entry: { flows: entry } },
    }));
    fs.writeFileSync(path.join(bundle, entry, 'screen-redesign.yaml'), [
      'apiVersion: flow.aiwg.io/v1', 'kind: FlowCapability', 'metadata:',
      '  name: screen-redesign', 'spec:', '  description: Redesign a screen with UX proposals',
      '  version: "1.0.0"', '  inputs: []', '  outputs: []', '  agent: ux-studio-orchestrator', '',
    ].join('\n'));
    fs.writeFileSync(path.join(bundle, entry, 'unrelated.yaml'), 'apiVersion: v1\nkind: Pod\n');
    fs.writeFileSync(path.join(bundle, entry, 'broken.yaml'), ': [unbalanced');
    fs.symlinkSync(path.join(bundle, entry, 'screen-redesign.yaml'), path.join(bundle, entry, 'linked.yaml'));
    expect((await discoverProjectLocalBundles(tmpDir)).errors).toEqual([]);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    await main(['build', '--graph', 'project']);
    cwd.mockRestore();
    vi.mocked(console.log).mockClear();
    await discoverCapability(tmpDir, { phrase: 'redesign a screen ux proposals', graph: 'project',
      typeFilter: ['flow'], backend, json: true });
    const result = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));
    expect(result.results).toEqual([expect.objectContaining({ name: 'screen-redesign', type: 'flow' })]);
    vi.mocked(console.log).mockClear();
    await discoverCapability(tmpDir, { phrase: 'screen-redesign', typeFilter: ['flow'], backend, json: true });
    const defaultGraphResult = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));
    expect(defaultGraphResult.results).toEqual([expect.objectContaining({ name: 'screen-redesign', type: 'flow' })]);
    vi.mocked(console.log).mockClear();
    await showArtifact(tmpDir, { name: 'screen-redesign', typeFilter: ['flow'], graph: 'project', backend: 'local' });
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('Owner: addon:ux-studio');
    const listed = await listHandler.execute({ cwd: tmpDir, args: ['--project-local'], rawArgs: ['list', '--project-local'] });
    expect(listed.message).toContain('ux-studio [project] [addon]');
    expect(listed.message).toContain('Flows (1): screen-redesign');
    expect(listed.message).not.toContain('Validation errors');
  });

  it('indexes a Flow YAML as type "flow" with discoverable name + capability', async () => {
    const flowDir = path.join(tmpDir, '.aiwg', 'workflow', 'capabilities');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(flowDir, 'check-tls.yaml'), CAPABILITY_YAML);

    await buildIndex(tmpDir, { scope: '.aiwg', outputDir: tmpDir, force: true });

    const indexPath = path.join(tmpDir, INDEX_DIR, 'metadata.json');
    expect(fs.existsSync(indexPath), `index at ${indexPath}`).toBe(true);
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

    const entry = Object.values(index.entries).find(
      (e: any) => e.path.endsWith('check-tls.yaml')
    ) as any;
    expect(entry, 'flow entry indexed').toBeTruthy();
    expect(entry.type).toBe('flow');
    expect(entry.name).toBe('check-tls-expiry');
    expect(entry.capability).toBe("Check a TLS certificate's expiry date for a given host");
    expect(entry.tags).toContain('pki');
    expect(entry.kind).toBe('WorkflowCapability');
    expect(entry.searchTerms).toContain('workflow-executor');
  });

  it('indexes a procedural Markdown runbook separately while preserving its template origin', async () => {
    const templateDir = path.join(tmpDir, 'agentic', 'code', 'addons', 'ops', 'templates');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'certificate-rotation-runbook.md'), [
      '# Certificate Rotation Runbook',
      '',
      '## Purpose',
      '',
      'Rotate expiring service certificates safely.',
      '',
      '## Procedure',
      '',
      'Issue and deploy the replacement certificate.',
      '',
      '## Verification',
      '',
      'Confirm the new serial is served.',
      '',
      '## Rollback',
      '',
      'Restore the prior certificate.',
      '',
    ].join('\n'));

    await buildIndex(tmpDir, { scope: 'agentic', outputDir: tmpDir, force: true });
    const index = JSON.parse(fs.readFileSync(path.join(tmpDir, INDEX_DIR, 'metadata.json'), 'utf8'));
    const entry = Object.values(index.entries).find((value: any) =>
      value.path.endsWith('certificate-rotation-runbook.md')) as any;
    expect(entry.type).toBe('runbook');
    expect(entry.kind).toBe('Runbook');
    expect(entry.sourceType).toBe('template');
    expect(entry.capability).toContain('Rotate expiring service certificates');
  });
});
