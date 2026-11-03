// Keep a shared-home conflict attached to its provider in the top-level use report.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyConfig, writeAiwgConfig } from '../../../../src/config/aiwg-config.js';
import { deployEachProvider } from '../../../../src/cli/handlers/use-provider-results.js';
import type { HandlerResult } from '../../../../src/cli/handlers/types.js';

vi.mock('../../../../src/channel/manager.mjs', () => ({
  getVersionInfo: async () => ({ version: '1.0.0', devMode: true }),
}));
vi.mock('../../../../src/cli/services/deployment-verification.js', { spy: true });
import { verifyProviderDeployment } from '../../../../src/cli/services/deployment-verification.js';
import { UseHandler } from '../../../../src/cli/handlers/use.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

it('verifies each provider with its own deploy exit code and error message (#3802)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiwg-use-provider-result-')); roots.push(root);
  const project = join(root, 'project'), frameworkRoot = join(root, 'source');
  mkdirSync(project); mkdirSync(frameworkRoot);
  writeFileSync(join(frameworkRoot, 'package.json'), '{"name":"aiwg","version":"1.0.0"}');
  const providers = ['muse', 'hermes', 'codex', 'claude'];
  await writeAiwgConfig(project, emptyConfig(providers));
  const failure = { exitCode: 1, message: `Provider deployment preimage changed: ${join(root, 'home/.hermes/skills')}` };
  const outcome = await deployEachProvider(providers, async provider => provider === 'hermes' ? failure : { exitCode: 0 });
  const handler = new UseHandler();
  vi.spyOn(handler as unknown as { executeCore(): Promise<HandlerResult> }, 'executeCore').mockResolvedValue(outcome);
  const args = ['all', '--json', '--target', project];
  const result = await handler.execute({ cwd: project, frameworkRoot, args, rawArgs: ['use', ...args] });
  expect(result.exitCode).toBe(1);
  const calls = vi.mocked(verifyProviderDeployment).mock.calls.map(([options]) => options);
  expect(calls.map(options => options.provider)).toEqual(providers);
  for (const options of calls) {
    expect(options.deploymentExitCode).toBe(options.provider === 'hermes' ? 1 : 0);
    expect(options.deploymentMessage).toBe(options.provider === 'hermes' ? failure.message : undefined);
  }
  const report = JSON.parse(result.message!);
  expect(report.findings.filter((finding: { id: string }) => finding.id === 'deployment-command-failed')
    .map((finding: { provider: string }) => finding.provider)).toEqual(['hermes']);
});
