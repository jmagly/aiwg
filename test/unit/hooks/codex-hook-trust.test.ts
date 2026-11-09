// Keep Codex trust advice read-only and visible through the public deploy/doctor owners.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diagnoseWorkspaceContext } from '../../../src/smiths/context-pipeline/workspace-doctor.js';
import type { HandlerResult } from '../../../src/cli/handlers/types.js';
import * as codexTrust from '../../../src/smiths/hook-bridge/codex-trust.js';

vi.mock('../../../src/cli/services/deployment-verification.js', { spy: true });
vi.mock('../../../src/smiths/hook-bridge/codex-trust.js', { spy: true });
import { verifyProviderDeployment } from '../../../src/cli/services/deployment-verification.js';
import { UseHandler } from '../../../src/cli/handlers/use.js';

let root: string;
let project: string;
let config: string;
const nextStep = 'Trust this project in Codex and approve its AIWG hook; codex exec needs both.';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aiwg-codex-trust-'));
  project = path.join(root, 'project with spaces');
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex-home');
  vi.stubEnv('HOME', home);
  vi.stubEnv('CODEX_HOME', codexHome);
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
  vi.stubEnv('AIWG_USER_REGISTRY_PATH', path.join(root, 'registry.json'));
  await mkdir(home);
  await mkdir(codexHome);
  config = path.join(codexHome, 'config.toml');
  await mkdir(path.join(project, '.codex/hooks'), { recursive: true });
  await writeFile(path.join(project, '.codex/hooks/aiwg-prompt-discovery.cjs'), '// fixture\n');
  await writeFile(path.join(project, '.codex/hooks.json'), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node fixture.cjs',
      _aiwg_managed: true, _aiwg_id: 'aiwg-prompt-discovery' }] }],
  } }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it.each(['trusted', 'untrusted', 'missing-config'])('doctor advises for %s with unknown hook review', async state => {
  const bytes = `[projects.${JSON.stringify(project)}]\ntrust_level = "${state}"\n`;
  if (state !== 'missing-config') await writeFile(config, bytes);
  const diagnostics = await diagnoseWorkspaceContext(project);
  expect(diagnostics).toContainEqual(expect.objectContaining({
    code: 'codex-prompt-discovery-trust', severity: state === 'trusted' ? 'info' : 'warning',
    message: expect.stringContaining('hook review: unknown'),
  }));
  expect(diagnostics.find(item => item.code === 'codex-prompt-discovery-trust')?.message).toContain(nextStep);
  expect(diagnostics.find(item => item.code === 'codex-prompt-discovery-trust')?.message)
    .toContain(`Project trust: ${state === 'missing-config' ? 'unknown' : state}`);
  if (state !== 'missing-config') expect(await readFile(config, 'utf8')).toBe(bytes);
  else await expect(readFile(config)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['untrusted', 'trusted', 'approved'].flatMap(state => [{ state, json: false }, { state, json: true }]))
('includes one Codex deploy next step only when needed (%j)', async ({ state, json }) => {
  await writeFile(config, `[projects.${JSON.stringify(project)}]\ntrust_level = "${state === 'untrusted' ? 'untrusted' : 'trusted'}"\n`);
  // Exercise the known-approved policy without inventing persisted review data.
  if (state === 'approved') vi.mocked(codexTrust.readCodexHookTrust)
    .mockResolvedValue({ project: 'trusted', hookReview: 'approved' });
  const frameworkRoot = path.join(root, 'source');
  await mkdir(frameworkRoot);
  await writeFile(path.join(frameworkRoot, 'package.json'), '{"name":"aiwg","version":"1.0.0"}');
  vi.mocked(verifyProviderDeployment).mockResolvedValue({
    provider: 'codex', scope: 'project', outcome: 'ready', restartRequired: false,
    restartAction: null, restartReason: null, reloadPolicy: 'live-refresh', reloadFallback: null,
    counts: { agents: 0, commands: 0, skills: 0, rules: 0, behaviors: 0 }, phases: [], findings: [],
  });
  const handler = new UseHandler();
  vi.spyOn(handler as unknown as { executeCore(): Promise<HandlerResult> }, 'executeCore')
    .mockResolvedValue({ exitCode: 0 });
  const args = ['all', '--provider', 'codex', '--target', project, ...(json ? ['--json'] : [])];
  const result = await handler.execute({ cwd: project, frameworkRoot, args, rawArgs: ['use', ...args] });
  expect(result.exitCode).toBe(0);
  if (json) expect(JSON.parse(result.message!).findings.filter((item: { id: string }) => item.id === 'codex-prompt-discovery-trust'))
    .toHaveLength(state === 'approved' ? 0 : 1);
  else expect(result.message?.trimEnd().endsWith(nextStep)).toBe(state !== 'approved');
  expect(result.message?.split(nextStep)).toHaveLength(state === 'approved' ? 1 : 2);
});

it('requires both project and hook trust before suppressing advice', () => {
  expect(codexTrust.codexHookTrustNextStep({ project: 'untrusted', hookReview: 'approved' })).toBe(nextStep);
  expect(codexTrust.codexHookTrustNextStep({ project: 'trusted', hookReview: 'unreviewed' })).toBe(nextStep);
  expect(codexTrust.codexHookTrustNextStep(null)).toBe('');
});

it('deploy advice names the saved-trust prerequisite for Codex exec 0.167 (#4035)', () => {
  const advice = codexTrust.codexHookTrustNextStep({ project: 'untrusted', hookReview: 'unknown' });
  expect(advice).toContain('codex exec');
  // Deploy output stays readable at 80 columns; the full explanation is in doctor and docs.
  expect(advice.length).toBeLessThanOrEqual(80);
  const detail = codexTrust.CODEX_EXEC_HOOK_TRUST_DETAIL;
  expect(detail).toContain('saved folder and hook trust');
  expect(detail).toContain('per-run -c');
  expect(detail).toContain('does not enable project hooks');
});

it('doctor explains the Codex exec trust limitation in full (#4035)', async () => {
  const diagnostic = await codexTrust.diagnoseCodexHookTrust(project);
  expect(diagnostic?.message).toContain(codexTrust.CODEX_EXEC_HOOK_TRUST_DETAIL);
});

it('parses quoted TOML paths and ignores trust for other projects and project-local config', async () => {
  await writeFile(config, `[projects.${JSON.stringify(project + '-other')}]\ntrust_level = "trusted"\n`);
  await writeFile(path.join(project, '.codex/config.toml'), `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
  expect(await codexTrust.readCodexHookTrust(project)).toEqual({ project: 'untrusted', hookReview: 'unknown' });
  await writeFile(config, `[projects.${JSON.stringify(project)}] # exact project\ntrust_level = 'trusted'\n`);
  expect(await codexTrust.readCodexHookTrust(project)).toEqual({ project: 'trusted', hookReview: 'unknown' });
});

it('resolves the default config from HOME when CODEX_HOME is absent', async () => {
  vi.stubEnv('CODEX_HOME', '');
  const defaultHome = path.join(root, 'home/.codex');
  await mkdir(defaultHome);
  await writeFile(path.join(defaultHome, 'config.toml'), `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);
  await writeFile(config, `[projects.${JSON.stringify(project)}]\ntrust_level = "untrusted"\n`);
  expect(await codexTrust.readCodexHookTrust(project)).toEqual({ project: 'trusted', hookReview: 'unknown' });
});

it('keeps malformed config unchanged and reports unknown trust', async () => {
  const bytes = 'this is not TOML';
  await writeFile(config, bytes);
  expect(await codexTrust.readCodexHookTrust(project)).toEqual({ project: 'unknown', hookReview: 'unknown' });
  expect(await readFile(config, 'utf8')).toBe(bytes);
});

it.each(['registration', 'script'])('does not advise without the installed %s', async missing => {
  await rm(path.join(project, missing === 'registration' ? '.codex/hooks.json' : '.codex/hooks/aiwg-prompt-discovery.cjs'));
  expect(await codexTrust.readCodexHookTrust(project)).toBeNull();
  expect(await diagnoseWorkspaceContext(project))
    .not.toContainEqual(expect.objectContaining({ code: 'codex-prompt-discovery-trust' }));
});
