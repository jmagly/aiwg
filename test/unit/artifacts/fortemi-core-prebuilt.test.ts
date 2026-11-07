// Prebuilt readiness must bind a checksum-valid export to the installed sources.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { getFortemiCorePrebuiltStatus } from '../../../src/artifacts/fortemi-core-sync.js';
import { frameworkSourceDigest } from '../../../src/artifacts/framework-source-digest.js';

describe('Fortemi prebuilt source freshness (#3914)', () => {
  let root: string;
  let manifestPath: string;
  let sourcePath: string;
  let manifest: Record<string, unknown>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-prebuilt-freshness-'));
    // A git worktree uses a .git file rather than a directory.
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /unused\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'aiwg', version: '2026.11.1' }));
    sourcePath = path.join(root, 'agentic/code/addons/example/skills/example/SKILL.md');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, '---\nname: example\n---\nOriginal capability\n');
    manifestPath = path.join(root, 'prebuilt/fortemi-core/framework/manifest.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const exported = JSON.stringify({ schema_version: 'aiwg.fortemi.index.export.v2', source: { graph: 'framework' }, items: [] });
    fs.writeFileSync(path.join(path.dirname(manifestPath), 'aiwg-fortemi-index-v2.json'), exported);
    manifest = {
      schema_version: 'aiwg.fortemi.prebuilt.v1', backend: 'fortemi-core', graph: 'framework',
      export_path: 'aiwg-fortemi-index-v2.json', export_schema_version: 'aiwg.fortemi.index.export.v2',
      export_checksum: createHash('sha256').update(exported).digest('hex'), item_count: 0,
      package_version: '2026.11.1', source_digest: frameworkSourceDigest(root, false),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reports an intact index built for an older package version as stale', () => {
    manifest.package_version = '2026.10.16';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(getFortemiCorePrebuiltStatus('framework', root)).toMatchObject({
      built: true, stale: true, reason: expect.stringMatching(/package version.*2026\.10\.16.*2026\.11\.1/),
    });
  });

  it.each(['edit', 'add', 'remove'])('reports source drift without a version bump: %s', (change) => {
    if (change === 'edit') fs.appendFileSync(sourcePath, 'New capability\n');
    if (change === 'add') fs.writeFileSync(path.join(path.dirname(sourcePath), 'extra.md'), '# Extra\n');
    if (change === 'remove') fs.unlinkSync(sourcePath);
    expect(getFortemiCorePrebuiltStatus('framework', root)).toMatchObject({
      built: true, stale: true, reason: expect.stringContaining('source digest'),
    });
  });

  it.each(['package_version', 'source_digest'])('rejects an index missing %s', (field) => {
    delete manifest[field];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(getFortemiCorePrebuiltStatus('framework', root)).toMatchObject({ built: true, stale: true });
  });

  it('accepts the current identity in both source and packaged installs', () => {
    expect(getFortemiCorePrebuiltStatus('framework', root)).toMatchObject({ built: true, stale: false, reason: null });
    fs.unlinkSync(path.join(root, '.git'));
    expect(getFortemiCorePrebuiltStatus('framework', root)).toMatchObject({ built: true, stale: false, reason: null });
  });

  it('keeps integrity failures visible before checking source identity', () => {
    fs.appendFileSync(path.join(path.dirname(manifestPath), 'aiwg-fortemi-index-v2.json'), ' ');
    expect(getFortemiCorePrebuiltStatus('framework', root)).toMatchObject({
      stale: true, reason: 'prebuilt export checksum does not match manifest',
    });
  });
});
