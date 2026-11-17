// Trusted projects see the advisory once per installed hook digest, without granting trust.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { diagnoseCodexHookTrust, readCodexHookTrust } from '../../../src/smiths/hook-bridge/codex-trust.js';

let root: string;
let project: string;
let config: string;
let script: string;
let registration: string;
let state: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aiwg-codex-advisory-'));
  project = path.join(root, 'project with spaces');
  script = path.join(project, '.codex/hooks/aiwg-prompt-discovery.cjs');
  registration = path.join(project, '.codex/hooks.json');
  state = path.join(root, 'state');
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex-home');
  const bin = path.join(root, 'bin');
  await mkdir(path.dirname(script), { recursive: true });
  await mkdir(home);
  await mkdir(codexHome);
  await mkdir(bin);
  vi.stubEnv('HOME', home);
  vi.stubEnv('CODEX_HOME', codexHome);
  vi.stubEnv('XDG_STATE_HOME', state);
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  await copyFile(path.resolve('test/fixtures/providers/codex/version-cli.cjs'), path.join(bin, 'codex'));
  await chmod(path.join(bin, 'codex'), 0o755);
  config = path.join(codexHome, 'config.toml');
  await writeFile(config, `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
  await writeFile(script, '// original hook\n');
  await writeFile(registration, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{
    type: 'command', command: 'node fixture.cjs', _aiwg_managed: true, _aiwg_id: 'aiwg-prompt-discovery',
  }] }] } }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it('quiets a trusted project after showing the advisory for its current hook digest', async () => {
  const before = await readFile(config, 'utf8');
  const first = await diagnoseCodexHookTrust(project);
  expect(first?.severity).toBe('info');
  expect(first?.message).toContain('once per hook digest');
  expect(await diagnoseCodexHookTrust(project)).toBeNull();
  expect(await readCodexHookTrust(project)).toEqual({ project: 'trusted', hookReview: 'unknown' });
  expect(await readFile(config, 'utf8')).toBe(before);
});

it('re-raises the advisory when hook script bytes change, then quiets that digest', async () => {
  await diagnoseCodexHookTrust(project);
  expect(await diagnoseCodexHookTrust(project)).toBeNull();
  await writeFile(script, '// changed hook\n');
  expect(await diagnoseCodexHookTrust(project)).toMatchObject({ code: 'codex-prompt-discovery-trust' });
  expect(await diagnoseCodexHookTrust(project)).toBeNull();
});

it('re-raises the advisory when the hook registration changes', async () => {
  await diagnoseCodexHookTrust(project);
  expect(await diagnoseCodexHookTrust(project)).toBeNull();
  const doc = JSON.parse(await readFile(registration, 'utf8'));
  doc.hooks.UserPromptSubmit[0].hooks[0].command = 'node changed.cjs';
  await writeFile(registration, JSON.stringify(doc));
  expect(await diagnoseCodexHookTrust(project)).not.toBeNull();
});

it.each(['untrusted', 'unknown'])('always warns with a next step for %s project trust, even after a trusted run', async trust => {
  await diagnoseCodexHookTrust(project);
  if (trust === 'unknown') await writeFile(config, 'invalid TOML');
  else await writeFile(config, `[projects.${JSON.stringify(project)}]\ntrust_level = "untrusted"\n`);
  for (let run = 0; run < 2; run++) {
    expect(await diagnoseCodexHookTrust(project)).toMatchObject({ severity: 'warning',
      message: expect.stringContaining('Trust this project in Codex and approve its AIWG hook'),
    });
  }
});

it('isolates the digest notice by Codex home and AIWG user state', async () => {
  await diagnoseCodexHookTrust(project);
  expect(await diagnoseCodexHookTrust(project)).toBeNull();
  const otherHome = path.join(root, 'other-codex-home');
  await mkdir(otherHome);
  await copyFile(config, path.join(otherHome, 'config.toml'));
  vi.stubEnv('CODEX_HOME', otherHome);
  expect(await diagnoseCodexHookTrust(project)).not.toBeNull();
  expect(await diagnoseCodexHookTrust(project)).toBeNull();
  vi.stubEnv('XDG_STATE_HOME', path.join(root, 'other-state'));
  expect(await diagnoseCodexHookTrust(project)).not.toBeNull();
});

it('does not silence another trusted project with identical hook bytes', async () => {
  await diagnoseCodexHookTrust(project);
  const other = path.join(root, 'other-project');
  await mkdir(path.join(other, '.codex/hooks'), { recursive: true });
  await copyFile(script, path.join(other, '.codex/hooks/aiwg-prompt-discovery.cjs'));
  await copyFile(registration, path.join(other, '.codex/hooks.json'));
  await writeFile(config, `[projects.${JSON.stringify(other)}]\ntrust_level = "trusted"\n`);
  expect(await diagnoseCodexHookTrust(other)).not.toBeNull();
  expect(await diagnoseCodexHookTrust(other)).toBeNull();
});

it('emits exactly one notice when trusted-project checks run concurrently', async () => {
  const results = await Promise.all([diagnoseCodexHookTrust(project), diagnoseCodexHookTrust(project)]);
  expect(results.filter(Boolean)).toHaveLength(1);
});

it('does not count untrusted warnings as a trusted-project digest notice', async () => {
  await writeFile(config, `[projects.${JSON.stringify(project)}]\ntrust_level = "untrusted"\n`);
  expect((await diagnoseCodexHookTrust(project))?.severity).toBe('warning');
  await writeFile(config, `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
  expect((await diagnoseCodexHookTrust(project))?.severity).toBe('info');
  expect(await diagnoseCodexHookTrust(project)).toBeNull();
});

it('deduplicates notices using the default Codex home when CODEX_HOME is unset', async () => {
  const defaultHome = path.join(root, 'home/.codex');
  await mkdir(defaultHome);
  await copyFile(config, path.join(defaultHome, 'config.toml'));
  vi.stubEnv('CODEX_HOME', '');
  expect(await diagnoseCodexHookTrust(project)).not.toBeNull();
  expect(await diagnoseCodexHookTrust(project)).toBeNull();
});

it('shows the detected Codex version rather than a pinned release', async () => {
  const diagnostic = await diagnoseCodexHookTrust(project);
  expect(diagnostic?.message).toContain('Detected Codex version: 0.169.0');
  expect(diagnostic?.message).not.toContain('0.167');
});

it.each(['fail', 'unexpected banner'])('reports an unknown version when the probe returns %s', async banner => {
  await writeFile(path.join(root, 'bin/codex-version.txt'), banner);
  expect((await diagnoseCodexHookTrust(project))?.message).toContain('Detected Codex version: unknown');
});

it('runs the version probe with a cleared environment', async () => {
  vi.stubEnv('AIWG_TEST_SENSITIVE_INPUT', 'must-not-reach-probe');
  expect((await diagnoseCodexHookTrust(project))?.message).toContain('Detected Codex version: 0.169.0');
  const seen = JSON.parse(await readFile(path.join(root, 'bin/codex-env-seen.json'), 'utf8')) as string[];
  expect(seen).toContain('PATH');
  expect(seen).not.toContain('AIWG_TEST_SENSITIVE_INPUT');
  expect(seen).not.toContain('HOME');
  expect(seen).not.toContain('CODEX_HOME');
});

it('keeps advising if the local notice marker cannot be written', async () => {
  await writeFile(state, 'not a directory');
  expect(await diagnoseCodexHookTrust(project)).not.toBeNull();
  expect(await diagnoseCodexHookTrust(project)).not.toBeNull();
});

it('reports an unknown version when the Codex executable is missing', async () => {
  await rm(path.join(root, 'bin/codex'));
  vi.stubEnv('PATH', path.join(root, 'bin'));
  expect((await diagnoseCodexHookTrust(project))?.message).toContain('Detected Codex version: unknown');
});

it('keeps advising when marker creation fails after the state directory is available', async () => {
  vi.spyOn(fs, 'writeFile').mockRejectedValue(Object.assign(new Error('unwritable marker'), { code: 'EACCES' }));
  expect(await diagnoseCodexHookTrust(project)).not.toBeNull();
  expect(await diagnoseCodexHookTrust(project)).not.toBeNull();
});
