#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { boundedSpawnSync } from '../../src/process/bounded-child-process.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { resolveNpmPackTimeoutMs, runNpmPack } from './lib/fortemi-npm-pack.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const prebuiltDir = path.join(repoRoot, 'prebuilt', 'fortemi-core', 'framework');
const exportRel = 'prebuilt/fortemi-core/framework/aiwg-fortemi-index-v2.json';
const manifestRel = 'prebuilt/fortemi-core/framework/manifest.json';
const exportPath = path.join(repoRoot, exportRel);
const manifestPath = path.join(repoRoot, manifestRel);

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function sourceScriptDeclaration(item) {
  const sourcePath = item.source?.path;
  if (item.type !== 'aiwg.skill' || typeof sourcePath !== 'string') return null;
  const absolute = path.join(repoRoot, sourcePath);
  if (!existsSync(absolute)) return null;
  const source = readFileSync(absolute, 'utf8');
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  return parseYaml(match[1])?.script ?? null;
}

function parseNpmPackJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    const start = stdout.lastIndexOf('\n[');
    if (start >= 0) return JSON.parse(stdout.slice(start + 1));
    const first = stdout.indexOf('[');
    if (first >= 0) return JSON.parse(stdout.slice(first));
    throw new Error('no JSON array found in npm pack output');
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'aiwg-fortemi-prebuilt-gate-'));
process.once('exit', () => rmSync(tmp, { recursive: true, force: true }));
let packTimeoutMs;
try {
  packTimeoutMs = resolveNpmPackTimeoutMs();
} catch (err) {
  fail(err.message);
}
const packRun = runNpmPack({ cwd: repoRoot, destination: tmp, timeoutMs: packTimeoutMs });
const pack = packRun.result;
if (!packRun.ok) {
  if (pack.stdout) console.error(pack.stdout);
  if (pack.stderr) console.error(pack.stderr);
  fail(packRun.message);
}

let packJson;
try {
  packJson = parseNpmPackJson(pack.stdout);
} catch (err) {
  fail(`could not parse npm pack JSON output: ${err.message}`);
}

const files = new Set(packJson?.[0]?.files?.map((file) => file.path) ?? []);
if (!files.has(exportRel)) fail(`${exportRel} is missing from npm package`);
if (!files.has(manifestRel)) fail(`${manifestRel} is missing from npm package`);

if (!existsSync(prebuiltDir)) {
  fail('prebuilt Fortemi Core framework directory is missing after npm pack prepack');
}
if (!existsSync(exportPath)) fail(`${exportRel} is missing`);
if (!existsSync(manifestPath)) fail(`${manifestRel} is missing`);

const exportText = readFileSync(exportPath, 'utf8');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const exported = JSON.parse(exportText);
// The 2026.9.6 corpus has 4,135 metadata-only records (14,562,168 bytes),
// including 94 Testing Quality records for its conformance agents and flows.
// Retain an explicit package budget with about 3% headroom for this corpus;
// source-body, chunk, checksum, and per-record size checks remain independent.
const maxExportBytes = Number.parseInt(process.env.AIWG_FORTEMI_PREBUILT_MAX_BYTES ?? '16000000', 10);

if (manifest.schema_version !== 'aiwg.fortemi.prebuilt.v1') {
  fail(`manifest schema_version is ${manifest.schema_version}`);
}
if (Buffer.byteLength(exportText, 'utf8') > maxExportBytes) {
  fail(`${exportRel} is ${Buffer.byteLength(exportText, 'utf8')} bytes, above ${maxExportBytes}`);
}
if (manifest.backend !== 'fortemi-core') fail(`manifest backend is ${manifest.backend}`);
if (manifest.graph !== 'framework') fail(`manifest graph is ${manifest.graph}`);
if (manifest.export_schema_version !== 'aiwg.fortemi.index.export.v2') {
  fail(`manifest export_schema_version is ${manifest.export_schema_version}`);
}
if (manifest.export_checksum !== sha256(exportText)) {
  fail('manifest checksum does not match aiwg-fortemi-index-v2.json');
}
if (exported.schema_version !== 'aiwg.fortemi.index.export.v2') {
  fail(`export schema_version is ${exported.schema_version}`);
}
if (exported.source?.graph !== 'framework') fail(`export source.graph is ${exported.source?.graph}`);
if (!Array.isArray(exported.items) || exported.items.length === 0) {
  fail('export contains no items');
}
const nondeterministicTimestamp = exported.items.find((item) =>
  item.updated_at !== exported.generated_at || item.source?.updated_at !== exported.generated_at
);
if (nondeterministicTimestamp) {
  fail(`prebuilt export timestamp for ${nondeterministicTimestamp.source?.path ?? nondeterministicTimestamp.id} is not bound to generated_at`);
}
if (exported.items.some((item) => Array.isArray(item.chunks) && item.chunks.length > 0)) {
  fail('prebuilt framework export must not include chunk payloads; package fallback is metadata/capability-only');
}
const maxSearchBodyBytes = Number.parseInt(process.env.AIWG_FORTEMI_PREBUILT_MAX_BODY_BYTES ?? '4096', 10);
const oversizedBody = exported.items.find((item) =>
  Buffer.byteLength(item.search?.body ?? '', 'utf8') > maxSearchBodyBytes
);
if (oversizedBody) {
  fail(`prebuilt search body for ${oversizedBody.source?.path ?? oversizedBody.id} exceeds ${maxSearchBodyBytes} bytes`);
}
if (manifest.item_count !== exported.items.length) {
  fail(`manifest item_count ${manifest.item_count} does not match export item count ${exported.items.length}`);
}

const missingExecutableMetadata = exported.items.filter((item) =>
  sourceScriptDeclaration(item) && !item.search?.frontmatter?.aiwg_script
);
if (missingExecutableMetadata.length > 0) {
  fail(`prebuilt export strips executable metadata from ${missingExecutableMetadata.length} source skill(s): ${missingExecutableMetadata.slice(0, 5).map((item) => item.name ?? item.id).join(', ')}`);
}

try {
  const discover = boundedSpawnSync(
    process.execPath,
    [
      'bin/aiwg.mjs',
      'index',
      'discover',
      'campaign intake',
      '--graph',
      'framework',
      '--backend',
      'fortemi-core',
      '--limit',
      '3',
      '--json',
    ],
    'quick',
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(tmp, 'xdg'),
        AIWG_CONFIG: path.join(tmp, 'config-source'),
        AIWG_ROOT: repoRoot,
      },
    },
  );
  // `.error ||`, not just `status !== 0`, on every check below (#3062 B/C
  // finding 13): a surviving descendant holding the pipe can produce
  // ETIMEDOUT with status 0 — status alone would then read as success.
  if (discover.error || discover.status !== 0) {
    if (discover.error) console.error(discover.error.message);
    console.error(discover.stdout);
    console.error(discover.stderr);
    fail(`Fortemi Core prebuilt fallback discovery exited with status ${discover.status}`);
  }
  const result = JSON.parse(discover.stdout);
  const metadataMatches = [];
  for (const entry of result.results ?? []) {
    if (entry.type !== 'skill' || typeof entry.id !== 'string') continue;
    const show = boundedSpawnSync(
      process.execPath,
      ['bin/aiwg.mjs', 'show', 'metadata', entry.id, '--graph', 'framework', '--backend', 'fortemi-core', '--json'],
      'quick',
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          XDG_DATA_HOME: path.join(tmp, 'xdg'),
          AIWG_CONFIG: path.join(tmp, 'config-source'),
          AIWG_ROOT: repoRoot,
        },
      },
    );
    if (show.error || show.status !== 0) {
      if (show.error) console.error(show.error.message);
      console.error(show.stdout);
      console.error(show.stderr);
      fail(`Fortemi Core prebuilt fallback metadata lookup exited with status ${show.status}`);
    }
    metadataMatches.push(JSON.parse(show.stdout));
  }
  const hit = metadataMatches.some((entry) =>
    entry.paths?.indexed?.includes('agentic/code/frameworks/media-marketing-kit/skills/intake-start-campaign/SKILL.md') &&
    entry.type === 'skill'
  );
  if (!hit) {
    fail('Fortemi Core prebuilt fallback discovery did not return intake-start-campaign for "campaign intake"');
  }

  const packed = packJson?.[0];
  const tarball = packed?.filename ? path.join(tmp, packed.filename) : undefined;
  if (!tarball || !existsSync(tarball)) fail('npm pack did not produce a tarball for packed-install smoke');

  const installDir = path.join(tmp, 'install');
  // @fortemi/core is a first-party runtime dependency for Fortemi discovery.
  // The release-age override is scoped to this packed-install smoke so the
  // gate verifies production packaging even while the dependency is inside
  // the normal seven-day freshness window.
  const install = boundedSpawnSync('npm', ['install', '--omit=dev', '--min-release-age=0', '--prefix', installDir, tarball], 'long', {
    cwd: tmp,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (install.error || install.status !== 0) {
    // #3062 finding 17: install.error carries the enriched `long`-tier
    // timeout explanation that status/stdout/stderr alone do not.
    if (install.error) console.error(install.error.message);
    console.error(install.stdout);
    console.error(install.stderr);
    fail(`packed production install exited with status ${install.status}`);
  }
  const installedCli = path.join(installDir, 'node_modules', 'aiwg', 'bin', 'aiwg.mjs');
  const installedDiscover = boundedSpawnSync(
    process.execPath,
    [installedCli, 'discover', 'test', '--limit', '1', '--json'],
    'quick',
    {
      cwd: tmp,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(tmp, 'xdg-installed'),
        AIWG_CONFIG: path.join(tmp, 'config-installed'),
        AIWG_ROOT: path.join(installDir, 'node_modules', 'aiwg'),
      },
    },
  );
  if (installedDiscover.error || installedDiscover.status !== 0) {
    if (installedDiscover.error) console.error(installedDiscover.error.message);
    console.error(installedDiscover.stdout);
    console.error(installedDiscover.stderr);
    fail(`packed production install discover smoke exited with status ${installedDiscover.status}`);
  }
  if (installedDiscover.stderr.includes("Cannot find package '@fortemi/core'")) {
    fail('packed production install is missing @fortemi/core at runtime');
  }

  const installedRoot = path.join(installDir, 'node_modules', 'aiwg');
  const executableSkills = [
    {
      name: 'issue-create',
      args: ['plan', '--title', 'prebuilt package diagnostic', '--body', 'diagnostic', '--labels', 'bug', '--project-root', tmp],
    },
    {
      name: 'address-issues-threat-assess',
      args: ['--text', 'diagnostic', '--format', 'json'],
    },
  ];
  for (const executable of executableSkills) {
    const record = exported.items.find((item) => item.type === 'aiwg.skill' && item.name === executable.name);
    if (!record) fail(`prebuilt export is missing executable skill ${executable.name}`);
    for (const selector of [executable.name, record.id]) {
      const run = boundedSpawnSync(
        process.execPath,
        [installedCli, 'run', 'skill', selector, '--', ...executable.args],
        'long',
        {
          cwd: tmp,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          env: {
            ...process.env,
            XDG_DATA_HOME: path.join(tmp, `xdg-run-${executable.name}-${selector === record.id ? 'id' : 'name'}`),
            AIWG_CONFIG: path.join(tmp, 'config-installed'),
            AIWG_ROOT: installedRoot,
          },
        },
      );
      if (run.error || run.status !== 0) {
        if (run.error) console.error(run.error.message);
        console.error(run.stdout);
        console.error(run.stderr);
        fail(`packed production executable skill ${executable.name} failed via ${selector === record.id ? 'stable ID' : 'name'} (status ${run.status})`);
      }
    }
  }

  const installedDoctor = boundedSpawnSync(
    process.execPath,
    [path.join(installedRoot, 'tools', 'cli', 'doctor.mjs'), '--no-budget-check'],
    'quick',
    {
      cwd: tmp,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(tmp, 'xdg-doctor'),
        AIWG_CONFIG: path.join(tmp, 'config-installed'),
        AIWG_ROOT: installedRoot,
      },
    },
  );
  const doctorOutput = `${installedDoctor.stdout}\n${installedDoctor.stderr}`;
  if (
    doctorOutput.includes('ERR_MODULE_NOT_FOUND') ||
    doctorOutput.includes('Cannot find module') ||
    doctorOutput.includes('Cannot find package')
  ) {
    console.error(installedDoctor.stdout);
    console.error(installedDoctor.stderr);
    fail(`packed production install doctor import smoke hit module resolution failure (status ${installedDoctor.status})`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`✓ Fortemi Core prebuilt framework index package gate passed (${exported.items.length} items)`);
