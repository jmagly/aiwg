import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { runResourceDoctor } from '../../../tools/cli/doctor-resources.mjs';
import { parseDoctorArgsOrExit } from '../../../tools/cli/doctor-args.mjs';
import { parsePublicDoctorFlags } from '../../../src/cli/handlers/doctor-args.js';
import { hostResourceReport } from '../../../src/config/host-resource-report.mjs';
import { hostResourceReaders, ownedWorkerReaders } from '../../fixtures/host-resources.js';
import { main as configMain } from '../../../src/config/cli.js';
import { emptyConfig, readAiwgConfigCandidate, writeAiwgConfig } from '../../../src/config/aiwg-config.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('raises the worker cap through the documented project config command', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-worker-cap-config-')); roots.push(root);
  const initial = emptyConfig();
  initial.parallelism!.max_parallel_subagents = 20;
  await writeAiwgConfig(root, initial);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await configMain(['set', '--project', '--target', root, 'parallelism.admission.hostResources.max_workers', '10']);
  const config = (await readAiwgConfigCandidate(root))!;
  expect(config.parallelism!.admission!.hostResources!.max_workers).toBe(10);
  expect(hostResourceReport({ config, readers: { ...hostResourceReaders(), countWorkers: () => 6,
    statfsPath: () => ({ bavail: 32, bsize: 1024 ** 3 }) } })).toMatchObject({ ok: true, slots: 4 });
});

it('prints max_workers=5 with default origin and exposes its remaining slots in JSON', async () => {
  const readers = { ...hostResourceReaders(), countWorkers: () => 3,
    statfsPath: () => ({ bavail: 32, bsize: 1024 ** 3 }) };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runResourceDoctor('/synthetic', { config: {}, readers })).toBe(0);
  expect(log.mock.calls.flat()).toContain('max_workers=5 (default)');
  log.mockClear();
  expect(await runResourceDoctor('/synthetic', { config: {}, readers, json: true })).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ slots: 2,
    thresholds: { max_workers: 5 }, origins: { max_workers: ['default'] },
    limits: expect.arrayContaining([{ threshold: 'max_workers', slots: 2 }]) });
});

it('accepts the resource mode in both strict doctor parsers and honors the terminator', () => {
  expect(parsePublicDoctorFlags(['--resources', '--json']).hasSwitch('--resources')).toBe(true);
  expect(parseDoctorArgsOrExit(['--resources', '--json'])).toMatchObject({ resources: true, json: true });
  expect(parseDoctorArgsOrExit(['--', '--resources'])).toMatchObject({ resources: false });
  for (const flag of ['--probe-workers', '--decision-offload', '--deployment', '--user', '--project-local', '--scope=user']) {
    expect(() => parsePublicDoctorFlags(['--resources', flag])).toThrow(/separately/);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => parseDoctorArgsOrExit(['--resources', flag])).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(2); expect(stderr).toHaveBeenCalled();
    exit.mockRestore(); stderr.mockRestore();
  }
});

it('emits exactly the shared resource report as one JSON document and a matching text exit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-doctor-resources-')); roots.push(root);
  const config = { parallelism: { max_parallel_subagents: 3, admission: { hostResources: { max_workers: 1 } } } } as any;
  const readers = { ...hostResourceReaders(), now: () => Date.parse('2026-10-30T12:00:00Z'), statfsPath: () => ({ bavail: 32, bsize: 1024 ** 3 }) };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runResourceDoctor(root, { json: true, readers, config })).toBe(1);
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual(hostResourceReport({ config, readers, paths: [root] }));
  log.mockClear();
  expect(await runResourceDoctor(root, { readers, config })).toBe(1);
  expect(log.mock.calls.flat().join('\n')).toContain('max_workers');
  config.parallelism.admission.hostResources.max_workers = 4;
  expect(await runResourceDoctor(root, { json: true, readers, config })).toBe(0);
});

it('reports owned-process fallback and labels raw CLI counts informational in text and JSON', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiwg-doctor-owned-')); roots.push(root);
  const readers = { ...ownedWorkerReaders(undefined, [{ invocation: 'one' }, { invocation: 'one' }, {}]),
    statfsPath: () => ({ bavail: 32, bsize: 1024 ** 3 }) };
  const config = { parallelism: { max_parallel_subagents: 2 } } as any;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runResourceDoctor(root, { json: true, readers, config })).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ slots: 1, measured: {
    workers: 1, hostCliProcesses: { codex: 3, muse: 0 }, workerCountingSource: 'owned-process-fallback' } });
  log.mockClear();
  expect(await runResourceDoctor(root, { readers, config })).toBe(0);
  expect(log.mock.calls.flat().join('\n')).toContain('systemd unavailable: owned-process fallback');
  expect(log.mock.calls.flat().join('\n')).toContain('not used for admission');
});

it('parses group values strictly in both parsers and requires resource mode', () => {
  for (const args of [['--resources', '--group', 'harness'], ['--resources', '--group=harness']]) {
    expect(parsePublicDoctorFlags(args).values.get('--group')).toBe('harness');
    expect(parseDoctorArgsOrExit(args)).toMatchObject({ group: 'harness' });
  }
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const args of [['--group', 'harness'], ['--resources', '--group'], ['--resources', '--group=']]) {
    expect(() => parsePublicDoctorFlags(args)).toThrow(/group/);
    expect(() => parseDoctorArgsOrExit(args)).toThrow('exit');
  }
  expect(exit).toHaveBeenCalledWith(2);
});

it('prints every group separately and names each threshold once per diagnostic', async () => {
  const config = { parallelism: { max_parallel_subagents: 10,
    groups: { harness: { maxParallel: 3 }, muse: { maxParallel: 1 } } } } as any;
  const readers = { ...hostResourceReaders(), now: () => Date.parse('2026-10-30T12:00:00Z'), statfsPath: () => ({ bavail: 32, bsize: 1024 ** 3 }) };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runResourceDoctor('/synthetic', { config, readers })).toBe(0);
  expect(log.mock.calls.flat().join('\n')).toMatch(/Group harness:.*slots=2/);
  expect(log.mock.calls.flat().join('\n')).toMatch(/Group muse:.*slots=0/);
  log.mockClear();
  expect(await runResourceDoctor('/synthetic', { config, readers, group: 'muse' })).toBe(1);
  const lines = log.mock.calls.flat().map(String);
  expect(lines).toContain('groups.muse.maxParallel: admission capacity exhausted or worker count unavailable');
  expect(lines.join('\n')).not.toMatch(/(groups\.muse\.maxParallel): \1:/);
  log.mockClear();
  expect(await runResourceDoctor('/synthetic', { config, readers, group: 'harness', json: true })).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ slots: 2, limitingThreshold: 'groups.harness.maxParallel' });
  await expect(runResourceDoctor('/synthetic', { config, readers, group: 'missing' })).rejects.toThrow(/harness.*muse/);
});

it('documents the group resource gate before each launch', () => {
  for (const filename of ['docs/orchestration/guide.md', 'agentic/code/addons/aiwg-utils/rules/subagent-scoping.md']) {
    expect(readFileSync(filename, 'utf8')).toContain('aiwg doctor --resources --group <group>');
  }
});

it('prints a blocking project threshold only once per diagnostic', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const readers = { ...hostResourceReaders(), now: () => Date.parse('2026-10-30T12:00:00Z'), statfsPath: () => ({ bavail: 32, bsize: 1024 ** 3 }) };
  expect(await runResourceDoctor('/synthetic', { readers, config: { parallelism: { max_parallel_subagents: 1 } } })).toBe(1);
  expect(log.mock.calls.flat()).toContain('max_parallel_subagents: admission capacity exhausted or worker count unavailable');
  expect(log.mock.calls.flat().join('\n')).not.toContain('max_parallel_subagents: max_parallel_subagents:');
});

it.each([
  ['fresh', 240_000, {}, 0], ['stale', 360_000, {}, 1],
  ['unavailable', 1000, { collectedAt: undefined }, 1],
  ['unavailable', 1000, { freeDiskGb: undefined }, 1],
] as const)('prints %s synthetic SSH snapshot collection time and age in text and JSON', async (status, ageMs, fields, exit) => {
  const remote = JSON.parse(readFileSync('test/fixtures/host-resource-remote.json', 'utf8'));
  const live = { ...remote, ...fields };
  const now = () => Date.parse(remote.collectedAt) + ageMs;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runResourceDoctor('/synthetic/remote', { config: {}, live, now, json: true })).toBe(exit);
  const result = JSON.parse(String(log.mock.calls[0][0]));
  expect(result.freshness).toMatchObject({ status, collectedAt: live.collectedAt ?? null,
    ageMs: live.collectedAt ? ageMs : null });
  log.mockClear();
  expect(await runResourceDoctor('/synthetic/remote', { config: {}, live, now })).toBe(exit);
  const text = log.mock.calls.flat().join('\n');
  expect(text).toContain(`Snapshot: ${status}; collectedAt=${live.collectedAt ?? 'unavailable'}; ageMs=${live.collectedAt ? ageMs : 'unavailable'}`);
  for (const failure of result.failures) expect(text).toContain(`${failure.signal}: ${failure.reason}`);
});
