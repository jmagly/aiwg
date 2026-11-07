// Refresh must expose an actionable prebuilt repair even when doctor output is captured.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { frameworkSourceDigest } from '../../../../src/artifacts/framework-source-digest.js';
import { refreshHandler } from '../../../../src/cli/handlers/refresh.js';
import { getFrameworkRoot } from '../../../../src/channel/manager.mjs';
import * as ui from '../../../../src/cli/ui.js';

const { run, refreshCapabilities } = vi.hoisted(() => ({ run: vi.fn(), refreshCapabilities: vi.fn() }));
vi.mock('../../../../src/cli/handlers/script-runner.js', () => ({ createScriptRunner: () => ({ run }) }));
vi.mock('../../../../src/cli/handlers/use.js', () => ({ createUseHandler: () => ({ execute: vi.fn() }) }));
vi.mock('../../../../src/channel/manager.mjs', () => ({ getFrameworkRoot: vi.fn() }));
vi.mock('../../../../src/packages/registry.js', () => ({ refreshAllPackages: async () => [] }));
vi.mock('../../../../src/artifacts/framework-capabilities.js', () => ({ refreshFrameworkCapabilities: refreshCapabilities }));
vi.mock('../../../../src/cli/provider-resolution.js', () => ({ resolveActiveProvider: async () => ({ provider: 'codex' }) }));
vi.mock('../../../../src/config/aiwg-config.js', () => ({
  readAiwgConfig: async () => null, writeAiwgConfig: vi.fn(), hashManifest: vi.fn(),
  getProviderParallelismDefaults: () => ({}),
}));
vi.mock('../../../../src/models/worker-dispatch-offer.js', () => ({
  detectInstalledWorkerClis: () => [], evaluateWorkerDispatchOffer: () => ({ shouldOffer: false }), workerDispatchOfferHint: vi.fn(),
}));
vi.mock('../../../../src/cli/ui.js', () => ({
  blank: vi.fn(), rule: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  bold: (text: string) => text, brandMark: () => '◆', dimText: (text: string) => text,
}));

describe('source-git refresh prebuilt repair (#3914)', () => {
  let root: string;
  let project: string;
  let manifestPath: string;
  let repairCommand: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aiwg-refresh-source's checkout-"));
    project = path.join(root, 'operator-project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /unused\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'aiwg', version: '2026.11.1' }));
    manifestPath = path.join(root, 'prebuilt/fortemi-core/framework/manifest.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const exported = JSON.stringify({ schema_version: 'aiwg.fortemi.index.export.v2', source: { graph: 'framework' }, items: [] });
    fs.writeFileSync(path.join(path.dirname(manifestPath), 'aiwg-fortemi-index-v2.json'), exported);
    fs.writeFileSync(manifestPath, JSON.stringify({
      schema_version: 'aiwg.fortemi.prebuilt.v1', backend: 'fortemi-core', graph: 'framework',
      export_path: 'aiwg-fortemi-index-v2.json', export_schema_version: 'aiwg.fortemi.index.export.v2',
      export_checksum: createHash('sha256').update(exported).digest('hex'), item_count: 0,
      package_version: '2026.10.16', source_digest: frameworkSourceDigest(root, false),
    }));
    repairCommand = `npm --prefix '${root.replaceAll("'", "'\\''")}' run release:fortemi-index`;
    vi.mocked(getFrameworkRoot).mockResolvedValue(root);
    run.mockResolvedValue({ exitCode: 0 });
    refreshCapabilities.mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function refresh(args: string[] = []) {
    return refreshHandler.execute({ args, rawArgs: ['refresh', ...args], cwd: project, frameworkRoot: root });
  }

  it.each([[], ['--skip-update']])('prints the source repair command after refresh %j', async (args) => {
    expect((await refresh(args)).exitCode).toBe(0);
    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining(repairCommand));
    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining('2026.10.16'));
  });

  it('includes the command in quiet JSON when doctor output is captured', async () => {
    await refresh(['--quiet']);
    const output = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0]));
    expect(output.prebuiltIndexRepair).toContain(repairCommand);
    expect(run).toHaveBeenCalledWith('tools/cli/doctor.mjs', [], { capture: true });
  });

  it('emits a shell command that preserves spaces and apostrophes in the checkout path', async () => {
    await refresh(['--quiet']);
    const hint = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0])).prebuiltIndexRepair as string;
    const command = hint.slice(hint.indexOf('npm --prefix'), hint.indexOf(' to rebuild'));
    // Parse arguments with shell builtins; never execute npm or a release build.
    const words = execFileSync('sh', ['-c', `set -- ${command}; printf '%s\\n' "$@"`], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
    expect(words.trimEnd().split('\n')).toEqual(['npm', '--prefix', root, 'run', 'release:fortemi-index']);
  });

  it('checks freshness after the installation update', async () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.package_version = '2026.11.1';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    run.mockImplementation(async (script: string) => {
      if (script === 'tools/cli/update.mjs') {
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'aiwg', version: '2026.11.2' }));
      }
      return { exitCode: 0 };
    });
    await refresh();
    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining('2026.11.2'));
  });

  it('prints the repair command when the prebuilt index is missing', async () => {
    fs.rmSync(path.dirname(manifestPath), { recursive: true });
    await refresh();
    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining(repairCommand));
  });

  it.each(['current', 'npm', 'dry-run'])('does not warn for %s', async (mode) => {
    if (mode === 'current') {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.package_version = '2026.11.1';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    }
    if (mode === 'npm') fs.unlinkSync(path.join(root, '.git'));
    await refresh(mode === 'dry-run' ? ['--dry-run'] : []);
    expect(ui.warn).not.toHaveBeenCalledWith(expect.stringContaining('release:fortemi-index'));
  });
});
