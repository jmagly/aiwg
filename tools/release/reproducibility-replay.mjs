#!/usr/bin/env node
// Replay normal release pack paths five times and retain content reproducibility evidence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveProjectAiwgDirForWrite } from '../../src/config/project-artifacts-runtime.mjs';

export const RUNS = 5;
export const THRESHOLD = 0.95;
export const THRESHOLD_PERCENT = 95;
const ROOT = path.resolve(import.meta.dirname, '../..');
const surfaces = [
  { name: 'aiwg', dir: '.', manifest: 'package.json' },
  { name: '@aiwg/cli', dir: 'dist/packages/cli', manifest: 'packages/cli/package.json' },
  { name: '@aiwg/flue', dir: 'dist/packages/flue', manifest: 'packages/flue/package.json' },
  { name: '@aiwg/cockpit', dir: 'apps/cockpit', manifest: 'apps/cockpit/package.json' },
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const same = values => new Set(values).size === 1;
function command(executable, args, { cwd = ROOT, env = process.env, input, timeout = 15 * 60_000 } = {}) {
  const result = spawnSync(executable, args, { cwd, env, input, timeout, killSignal: 'SIGKILL',
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${executable} ${args.slice(0, 2).join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  return result.stdout;
}

// Read archives without extracting paths; tarfile handles npm's PAX and long names.
const inspectTar = String.raw`
import sys, tarfile, hashlib, json, re
h = lambda b: hashlib.sha256(b).hexdigest()
files, order, metadata, times = {}, [], {}, {}
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for m in archive:
        if m.isdir(): continue
        if not m.isfile() or not m.name.startswith('package/') or '..' in m.name.split('/'):
            raise ValueError('Unsafe or unsupported tar member: ' + m.name)
        name = m.name[len('package/'):]
        if not name or name in files: raise ValueError('Empty or duplicate tar member')
        data = archive.extractfile(m).read()
        item = {'sha256': h(data)}
        try:
            text = data.decode('utf-8')
            normalized = {
                'timestamps': re.sub(r'\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b', '<timestamp>', text),
                'generated build IDs': re.sub(r'("(?:buildId|build_id|buildID)"\s*:\s*")[^"]+(")', r'\1<build-id>\2', text),
                'build directory paths': text.replace(sys.argv[2], '<build-root>') if sys.argv[2] else text,
                'line ordering': '\n'.join(sorted(text.splitlines()))}
            try: normalized['JSON ordering'] = json.dumps(json.loads(text), sort_keys=True, separators=(',', ':'))
            except (ValueError, TypeError): pass
            item['normalized'] = {k: h(v.encode()) for k, v in normalized.items()}
        except UnicodeDecodeError: pass
        files[name] = item
        order.append(name)
        metadata[name] = [m.mode, m.uid, m.gid, m.uname, m.gname, m.type.decode(),
                          {k: v for k, v in m.pax_headers.items() if k not in ('mtime', 'atime', 'ctime')}]
        times[name] = [m.mtime, {k: v for k, v in m.pax_headers.items() if k in ('mtime', 'atime', 'ctime')}]
print(json.dumps({'files': files, 'order_sha256': h(json.dumps(order).encode()),
    'metadata_sha256': h(json.dumps(metadata, sort_keys=True).encode()),
    'timestamps_sha256': h(json.dumps(times, sort_keys=True).encode())}))
`;

export function inspectTarball(file, buildRoot = '') {
  const inspected = JSON.parse(command('python3', ['-I', '-S', '-c', inspectTar, file, buildRoot]));
  if (!Object.keys(inspected.files).length) throw new Error('Empty package tarball');
  return { filename: path.basename(file), tarball_sha256: digest(fs.readFileSync(file)), ...inspected };
}
function sourceFor(entries) {
  if (entries.some(entry => !entry)) return ['file inventory (added or missing)'];
  const candidates = Object.keys(entries[0].normalized ?? {}).filter(source =>
    entries.every(entry => entry.normalized?.[source]) && same(entries.map(entry => entry.normalized[source])));
  return candidates.length ? candidates : ['unclassified content variation (requires investigation)'];
}
export function comparePackage(name, runs) {
  if (runs.length !== RUNS) throw new Error('Exactly five independent runs are required');
  const files = [...new Set(runs.flatMap(run => Object.keys(run.files)))].sort();
  if (!files.length) throw new Error('Cannot compare an empty package');
  const differing_files = files.flatMap(file => {
    const entries = runs.map(run => run.files[file]);
    const digests = entries.map(entry => entry?.sha256 ?? null);
    return entries.every(Boolean) && same(digests) ? [] : [{ file, digests, sources: sourceFor(entries) }];
  });
  const identical_files = files.length - differing_files.length;
  const match_rate = identical_files / files.length;
  const match_percentage = match_rate * 100;
  const tarball_identical = same(runs.map(run => run.tarball_sha256));
  const archive_sources = [];
  if (!tarball_identical) {
    for (const [key, source] of [['order_sha256', 'archive ordering'], ['metadata_sha256', 'archive metadata'],
      ['timestamps_sha256', 'archive timestamps']]) {
      if (!same(runs.map(run => run[key]))) archive_sources.push(source);
    }
    if (differing_files.length) archive_sources.push('file content variation');
    if (!archive_sources.length) archive_sources.push('compression/container encoding');
  }
  return { package: name, total_files: files.length, identical_files, match_rate, match_percentage,
    threshold: THRESHOLD, threshold_percent: THRESHOLD_PERCENT, pass: match_rate >= THRESHOLD,
    tarball_identical, archive_sources, differing_files };
}
export function evaluateReplay(runs, names) {
  if (runs.length !== RUNS) throw new Error('Exactly five independent runs are required');
  const packages = names.map(name => comparePackage(name, runs.map(run => {
    if (!run.packages[name]) throw new Error(`Missing package ${name} in run ${run.run}`);
    return run.packages[name];
  })));
  const total_files = packages.reduce((n, pkg) => n + pkg.total_files, 0);
  const identical_files = packages.reduce((n, pkg) => n + pkg.identical_files, 0);
  const match_rate = total_files ? identical_files / total_files : 0;
  const match_percentage = match_rate * 100;
  const reasons = packages.filter(pkg => !pkg.pass).map(pkg => `${pkg.package}: ${pkg.match_percentage.toFixed(4)}% < ${THRESHOLD_PERCENT}%`);
  if (match_rate < THRESHOLD) reasons.push(`Overall: ${match_percentage.toFixed(4)}% < ${THRESHOLD_PERCENT}%`);
  return { packages, total_files, identical_files, match_rate, match_percentage,
    threshold: THRESHOLD, threshold_percent: THRESHOLD_PERCENT,
    pass: packages.length > 0 && reasons.length === 0, reasons };
}
export const replayExitCode = report => report.pass ? 0 : 1;

export function isolatedEnv(temp, root, index) {
  const home = path.join(temp, `home-${index}`), cache = path.join(temp, `npm-cache-${index}`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  return { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
    AIWG_ROOT: root, AIWG_CONFIG: path.join(home, '.aiwg'), AIWG_ARTIFACTS_PATH: path.join(root, '.aiwg'),
    AIWG_NO_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1',
    npm_config_userconfig: path.join(home, '.npmrc'), npm_config_cache: cache,
    npm_config_offline: 'true',
    npm_config_ignore_scripts: 'false', npm_config_dry_run: 'false',
    npm_config_prefer_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
}
export function packEnv(env, name) {
  return { ...env, npm_config_offline: name === '@aiwg/cockpit' ? 'false' : 'true' };
}
export function parsePackIdentity(text, name, version) {
  // npm lifecycle banners precede the trailing JSON array.
  const match = text.match(/(?:^|\n)(\[[\s\S]*\])\s*$/);
  let info;
  try { info = JSON.parse(match?.[1]); }
  catch { throw new Error(`pack identity unreadable for ${name}: expected trailing npm pack JSON array`); }
  if (!Array.isArray(info) || info.length !== 1 || info[0]?.name !== name || info[0]?.version !== version
    || typeof info[0]?.filename !== 'string' || path.basename(info[0].filename) !== info[0].filename) {
    throw new Error(`Invalid packed identity: ${name}`);
  }
  return info[0];
}
function packRun({ workspace, snapshot, temp, index, selected }) {
  const started_at = new Date().toISOString(), start = performance.now();
  const root = path.join(temp, `run-${index}`), output = path.join(temp, `packs-${index}`);
  fs.mkdirSync(root); fs.mkdirSync(output);
  const record = { run: index, started_at, packages: {}, pass: false };
  try {
    command('tar', ['-xf', snapshot, '-C', root]);
    fs.symlinkSync(path.join(workspace, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    const env = isolatedEnv(temp, root, index);
    command('npm', ['run', 'build:cli'], { cwd: root, env });
    command('npm', ['run', 'package:cli'], { cwd: root, env });
    for (const surface of selected) {
      const text = command('npm', ['pack', '--json', '--pack-destination', output], {
        cwd: path.join(root, surface.dir), env: packEnv(env, surface.name) });
      const manifest = readJson(path.join(root, surface.manifest));
      const info = parsePackIdentity(text, surface.name, manifest.version);
      record.packages[surface.name] = { manifest_version: manifest.version,
        ...inspectTarball(path.join(output, info.filename), root) };
    }
    record.pass = true;
  } catch (error) { record.error = error.message; }
  finally {
    record.completed_at = new Date().toISOString();
    record.duration_seconds = (performance.now() - start) / 1000;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(output, { recursive: true, force: true });
  }
  return record;
}
function writeEvidence(directory, report) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const lines = [`# Release reproducibility: ${report.version}`, '',
    `${report.verdict}: ${report.match_percentage?.toFixed(4) ?? 'unavailable'}% (threshold ≥${THRESHOLD_PERCENT}%, five runs).`,
    `Commit: ${report.git_commit}. Node: ${report.node_version}; npm: ${report.npm_version}.`, '',
    ...(report.packages ?? []).map(pkg => `- ${pkg.package}: ${pkg.match_percentage.toFixed(4)}%; ${pkg.differing_files.length} differing files; tarball identical: ${pkg.tarball_identical}.`),
    ...report.runs.map(run => `- Run ${run.run}: ${run.duration_seconds?.toFixed(2) ?? '?'}s; ${run.pass ? 'completed' : 'failed'}.`),
    '', ...report.reasons.map(reason => `- ${reason}`), '',
    'File digests, differing files and non-determinism classifications are retained in report.json.', ''];
  fs.writeFileSync(path.join(directory, 'summary.md'), lines.join('\n'));
}
export function runReplay({ workspace = ROOT, version, runs = RUNS, includeCockpit = false } = {}) {
  if (runs !== RUNS) throw new Error('Run count is fixed at 5');
  if (!/^(?:19|20)\d{2}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)(?:-rc\.[1-9]\d*)?$/.test(version ?? '')) throw new Error('--version requires a stable or RC CalVer');
  const directory = path.join(resolveProjectAiwgDirForWrite(workspace), 'releases/evidence', version, 'reproducibility');
  const git_commit = command('git', ['rev-parse', 'HEAD'], { cwd: workspace }).trim();
  const selected = surfaces.filter(surface => includeCockpit || surface.name !== '@aiwg/cockpit');
  const report = { workflow: 'flow-release', artifact_type: 'ci_cd', execution_mode: 'strict',
    version, git_commit, node_version: process.version, npm_version: command('npm', ['--version']).trim(),
    started_at: new Date().toISOString(), run_count: RUNS, threshold: THRESHOLD,
    threshold_percent: THRESHOLD_PERCENT, match_rate: null,
    dependency_policy: 'Existing workspace node_modules reused; Cockpit builder-owned npm ci is the exception.',
    included_packages: selected.map(surface => surface.name), runs: [], non_deterministic_sources: [], pass: false, verdict: 'FAIL', reasons: [] };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-reproducibility-'));
  try {
    const snapshot = path.join(temp, 'source.tar');
    command('git', ['archive', '--format=tar', `--output=${snapshot}`, git_commit], { cwd: workspace });
    for (let index = 1; index <= RUNS; index++) {
      const run = packRun({ workspace, snapshot, temp, index, selected });
      report.runs.push(run);
      console.log(`Replay ${index}/${RUNS}: ${run.duration_seconds.toFixed(2)}s (${run.pass ? 'packed' : 'failed'})`);
      if (!run.pass) throw new Error(`Run ${index}: ${run.error}`);
    }
    Object.assign(report, evaluateReplay(report.runs, report.included_packages));
    report.non_deterministic_sources = report.packages.flatMap(pkg => [
      ...pkg.differing_files.map(file => ({ package: pkg.package, file: file.file, sources: file.sources })),
      ...pkg.archive_sources.map(source => ({ package: pkg.package, file: '<tarball>', sources: [source] }))]);
    report.verdict = report.pass ? 'PASS' : 'FAIL';
  } catch (error) { report.pass = false; report.reasons.push(error.message); }
  finally {
    report.completed_at = new Date().toISOString();
    fs.rmSync(temp, { recursive: true, force: true });
    writeEvidence(directory, report);
  }
  console.log(`${report.verdict}: ${report.match_percentage?.toFixed(4) ?? 'unavailable'}%; evidence: ${directory}`);
  return { ...report, evidence_directory: directory };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { version: { type: 'string' }, runs: { type: 'string', default: '5' }, include: { type: 'string' } } });
    if (values.include && values.include !== 'cockpit') throw new Error('--include only accepts cockpit');
    process.exitCode = replayExitCode(runReplay({ version: values.version, runs: Number(values.runs), includeCockpit: values.include === 'cockpit' }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
