#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { frameworkSourceDigest } from '../../src/artifacts/framework-source-digest.ts';
import { buildPrebuiltRelations } from '../../src/artifacts/prebuilt-relations.ts';
import { getGraphIndexDir } from '../../src/artifacts/types.ts';
import { PREBUILT_RELATIONS_DIR } from '../../src/artifacts/relations.ts';
import { acquireDirectoryLock } from '../../src/artifacts/prebuilt-build-lock.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const prebuiltRoot = path.join(repoRoot, 'prebuilt', 'fortemi-core');
const outRoot = path.join(prebuiltRoot, 'framework');
const lockRoot = path.join(prebuiltRoot, '.framework-build.lock');
const generatedAt = process.env.AIWG_PREBUILT_INDEX_GENERATED_AT ?? '1970-01-01T00:00:00.000Z';

process.env.AIWG_ROOT ??= repoRoot;

const releaseLock = await acquireDirectoryLock(lockRoot, { reclaimDeadOwner: true });
let nextRoot;
let previousRoot;
let size = 0;
let itemCount = 0;

try {
  const { buildIndex } = await import('../../src/artifacts/index-builder.ts');
  const { buildAiwgFortemiIndexExport } = await import('../../src/artifacts/browser-export.ts');

  mkdirSync(prebuiltRoot, { recursive: true });
  nextRoot = mkdtempSync(path.join(prebuiltRoot, '.framework-next-'));

  await buildIndex(repoRoot, { graph: 'framework', force: true, explicit: true });

  const metadata = JSON.parse(readFileSync(path.join(getGraphIndexDir(repoRoot, 'framework'), 'metadata.json'), 'utf8'));
  const tables = buildPrebuiltRelations(repoRoot, Object.values(metadata.entries));
  const relationDir = path.join(repoRoot, PREBUILT_RELATIONS_DIR);
  mkdirSync(relationDir, { recursive: true });
  // Manifest is published last: partial writes fail checksum validation.
  for (const [file, text] of Object.entries(tables)) {
    const temp = path.join(relationDir, `${file}.${process.pid}.tmp`);
    writeFileSync(temp, text);
    renameSync(temp, path.join(relationDir, file));
  }

  const exported = buildAiwgFortemiIndexExport(repoRoot, {
    graph: 'framework',
    repo: 'aiwg',
    privacy: 'public',
    generatedAt,
    schemaVersion: 'v2',
    includeSourceBody: false,
  });

  for (const item of exported.items) {
    // Release checkouts receive fresh filesystem mtimes on every runner. The
    // general index records those mtimes for incremental local indexing, but a
    // prebuilt release index must be reproducible from the same signed source.
    // Bind exported record timestamps to the explicit build epoch instead.
    item.updated_at = generatedAt;
    if (item.source) item.source.updated_at = generatedAt;
    const searchText = [
      item.title,
      item.name,
      item.summary,
      item.search?.capability,
      item.source?.path,
      ...(item.search?.triggers ?? []),
      ...(item.tags ?? []),
    ]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join('\n');
    item.text = item.summary || item.title || '';
    if (item.search) {
      const executableFrontmatter = item.search.frontmatter?.aiwg_script
        ? { aiwg_script: item.search.frontmatter.aiwg_script }
        : {};
      const outputKind = item.search.frontmatter?.outputKind;
      item.search.body = searchText;
      // The prebuilt export intentionally drops general frontmatter to stay
      // compact, retaining runtime script metadata and default output kinds
      // needed by executable skills and template discovery without a local index.
      item.search.frontmatter = { ...executableFrontmatter,
        ...(typeof outputKind === 'string' ? { outputKind } : {}) };
    }
    delete item.chunks;
  }

  const sourceStats = JSON.parse(readFileSync(path.join(getGraphIndexDir(repoRoot, 'framework'), 'stats.json'), 'utf8'));
  sourceStats.builtAt = generatedAt;
  sourceStats.buildTimeMs = 0;
  const sourceStatsJson = JSON.stringify(sourceStats) + '\n';
  writeFileSync(path.join(nextRoot, 'source-stats.json'), sourceStatsJson, 'utf8');

  const exportJson = JSON.stringify(exported) + '\n';
  const checksum = createHash('sha256').update(exportJson).digest('hex');
  const exportPath = path.join(nextRoot, 'aiwg-fortemi-index-v2.json');
  writeFileSync(exportPath, exportJson, 'utf-8');

  const manifest = {
    schema_version: 'aiwg.fortemi.prebuilt.v1',
    backend: 'fortemi-core',
    graph: 'framework',
    generated_at: generatedAt,
    export_path: 'aiwg-fortemi-index-v2.json',
    export_schema_version: 'aiwg.fortemi.index.export.v2',
    export_checksum: checksum,
    item_count: exported.items.length,
    privacy: 'public',
    package_version: JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version,
    source_digest: frameworkSourceDigest(repoRoot, false),
    source_stats_checksum: createHash('sha256').update(sourceStatsJson).digest('hex'),
  };
  writeFileSync(path.join(nextRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  size = readFileSync(exportPath).byteLength;
  itemCount = exported.items.length;

  if (existsSync(outRoot)) {
    previousRoot = path.join(prebuiltRoot, `.framework-previous-${process.pid}-${Date.now()}`);
    renameSync(outRoot, previousRoot);
  }
  try {
    renameSync(nextRoot, outRoot);
    nextRoot = undefined;
  } catch (error) {
    if (previousRoot && !existsSync(outRoot)) renameSync(previousRoot, outRoot);
    throw error;
  }
  if (previousRoot) {
    rmSync(previousRoot, { recursive: true, force: true });
    previousRoot = undefined;
  }
} finally {
  if (nextRoot) rmSync(nextRoot, { recursive: true, force: true });
  if (previousRoot && !existsSync(outRoot)) renameSync(previousRoot, outRoot);
  if (previousRoot) rmSync(previousRoot, { recursive: true, force: true });
  await releaseLock();
}

console.log(`Prebuilt Fortemi Core framework index: ${itemCount} items, ${size} bytes`);
