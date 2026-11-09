// Reproduce receipt-free October prompts through the existing Codex deploy pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fixtures from '../../fixtures/providers/codex/legacy-prompts/2026.10.3.json';
import { captureDeploymentOutputs, recordDeploymentOutputs } from '../../../src/providers/deployment-ownership.mjs';
import { preserveDeploymentOutputs } from '../../../src/providers/deployment-preservation.mjs';
// @ts-expect-error tool module has no TypeScript declaration
import { main } from '../../../tools/commands/deploy-prompts-codex.mjs';

let root: string, home: string, source: string, prompts: string;
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const write = (file: string, value: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
};
const receipt = () => JSON.parse(fs.readFileSync(path.join(prompts, '.aiwg-manifest.json'), 'utf8')).managed;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-codex-upgrade-'));
  home = path.join(root, 'home'); source = path.join(root, 'corpus');
  prompts = path.join(home, '.codex/prompts');
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) vi.stubEnv(key, path.join(home, key));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const [name, fixture] of Object.entries(fixtures)) {
    write(path.join(prompts, name), fixture.prompt);
    write(path.join(source, 'agentic/code/addons', fixture.owner, 'commands', name.slice(5)), fixture.source);
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

async function deploy(dryRun = false) {
  const before = captureDeploymentOutputs([home]);
  await main(['--source', source, ...(dryRun ? ['--dry-run'] : [])], { homeDir: home });
  if (dryRun) return;
  const opts = { provider: 'codex', target: home, mode: 'all' };
  preserveDeploymentOutputs(before, [home], opts);
  recordDeploymentOutputs(before, [home], opts);
}

it('adopts all three unchanged 2026.10.3 prompts without force and records their bundle owners', async () => {
  expect(fs.existsSync(path.join(prompts, '.aiwg-manifest.json'))).toBe(false);
  await deploy();
  for (const [name, fixture] of Object.entries(fixtures)) {
    expect(fs.readFileSync(path.join(prompts, name), 'utf8')).toBe(fixture.prompt);
    expect(receipt()[name]).toMatchObject({ hash: hash(fixture.prompt), kind: 'command', owners: [fixture.owner] });
  }
  const original = receipt(); await deploy(); expect(receipt()).toEqual(original);
});

it('updates known legacy content but preserves user-edited and unrelated prompts', async () => {
  const dataset = fixtures['aiwg-dataset.md'];
  write(path.join(source, 'agentic/code/addons', dataset.owner, 'commands/dataset.md'), dataset.source + '\nCurrent release.\n');
  const edited = fixtures['aiwg-schema.md'].prompt + '\nOperator changes.\n';
  write(path.join(prompts, 'aiwg-schema.md'), edited);
  write(path.join(prompts, 'personal.md'), 'My own prompt');
  write(path.join(prompts, 'aiwg-unknown.md'), dataset.prompt);
  write(path.join(source, 'commands/unknown.md'), 'Other source');
  write(path.join(source, 'commands/personal.md'), 'AIWG replacement');
  await deploy();
  expect(fs.readFileSync(path.join(prompts, 'aiwg-dataset.md'), 'utf8')).toContain('Current release.');
  expect(fs.readFileSync(path.join(prompts, 'aiwg-schema.md'), 'utf8')).toBe(edited);
  expect(fs.readFileSync(path.join(prompts, 'personal.md'), 'utf8')).toBe('My own prompt');
  expect(fs.readFileSync(path.join(prompts, 'aiwg-unknown.md'), 'utf8')).toBe(dataset.prompt);
  expect(receipt()['aiwg-schema.md']).toBeUndefined();
  expect(receipt()['personal.md']).toBeUndefined();
  expect(receipt()['aiwg-unknown.md']).toBeUndefined();
});

it('honors provenance markers, then protects subsequent edits using the recorded digest', async () => {
  write(path.join(prompts, 'aiwg-schema.md'), '<!-- aiwg:managed v2026.10.3 bundled -->\nOld prompt');
  await deploy();
  expect(receipt()['aiwg-schema.md'].hash).toBe(hash(fixtures['aiwg-schema.md'].prompt));
  const edited = fixtures['aiwg-schema.md'].prompt + '\nMy changes';
  write(path.join(prompts, 'aiwg-schema.md'), edited);
  await deploy();
  expect(fs.readFileSync(path.join(prompts, 'aiwg-schema.md'), 'utf8')).toBe(edited);
  expect(receipt()['aiwg-schema.md'].hash).toBe(hash(fixtures['aiwg-schema.md'].prompt));
});

it('does not adopt matching bytes under another provider or outside the Codex prompt surface', () => {
  const before = captureDeploymentOutputs([home]);
  recordDeploymentOutputs(before, [home], { provider: 'claude', target: home, mode: 'all' });
  expect(fs.existsSync(path.join(prompts, '.aiwg-manifest.json'))).toBe(false);
  const other = path.join(root, 'other/prompts/aiwg-dataset.md');
  write(other, fixtures['aiwg-dataset.md'].prompt);
  recordDeploymentOutputs(captureDeploymentOutputs([path.dirname(other)]), [path.dirname(other)], { provider: 'codex', mode: 'all' });
  expect(fs.existsSync(path.join(path.dirname(other), '.aiwg-manifest.json'))).toBe(false);
});

it('leaves legacy receipts absent during a dry run', async () => {
  await deploy(true);
  expect(fs.existsSync(path.join(prompts, '.aiwg-manifest.json'))).toBe(false);
});

it('adopts October prompts through aiwg use all --global without force', () => {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const output = execFileSync(process.execPath, [path.join(repo, 'bin/aiwg.mjs'),
    'use', 'all', '--global', '--providers', 'codex', '--no-hooks'], {
    cwd: root, env: { ...process.env, AIWG_RESOLVE_IMPL_FROM: 'dist' },
    encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const [name, fixture] of Object.entries(fixtures)) {
    expect(receipt()[name]).toMatchObject({ hash: hash(fixture.prompt), owners: [fixture.owner] });
  }
  expect(output).not.toContain('unmanaged command file(s)');
}, 150_000);
