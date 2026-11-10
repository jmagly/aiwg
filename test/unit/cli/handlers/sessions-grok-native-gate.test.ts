// Check that CLI capability and import messages match the experimental native gate.
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sessionsHandler } from '../../../../src/cli/handlers/sessions.js';

const optIn = 'AIWG_GROK_BUILD_NATIVE_EXPERIMENTAL';
const native = resolve('test/fixtures/sessions/grok-build/native-layout',
  '%2Fsynthetic%2Fgrok-workspace', '0199b111-1111-7111-8111-111111111111', 'chat_history.jsonl');
beforeEach(() => vi.stubEnv(optIn, undefined));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function run(args: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const result = await sessionsHandler.execute({
    args: [...args, '--json'], rawArgs: [], cwd: process.cwd(), frameworkRoot: process.cwd(),
  });
  return { result, output: JSON.parse(String(log.mock.calls.at(-1)?.[0])) };
}

it.each([false, true])('labels native availability and explains the boundary with opt-in %s', async enabled => {
  if (enabled) { vi.stubEnv(optIn, '1'); vi.stubEnv('AIWG_GROK_BUILD_NATIVE_VERSION', '1.0.77'); }
  const { result, output } = await run(['sources']);
  expect(result.exitCode).toBe(0);
  const provider = output.data.providers.find((item: { provider: string }) => item.provider === 'grok-build');
  expect(provider).toMatchObject({
    supportedOperations: enabled ? ['discover', 'inspect', 'stream'] : ['inspect', 'stream'],
    acquisitionModes: enabled ? ['manual-export', 'jsonl'] : ['manual-export'],
    reasonCode: enabled ? 'GROK_BUILD_NATIVE_EXPERIMENTAL_ENABLED' : 'GROK_BUILD_NATIVE_EXPERIMENTAL_DISABLED',
    remediation: expect.stringMatching(/experimental.*unqualified/),
    discovery: { disposition: enabled ? 'discoverable' : 'manual-export',
      liveDetection: enabled ? 'supported' : 'unsupported' },
  });
  expect(provider.remediation).toContain(`${optIn}=1`);
  expect(provider.remediation).toContain('grok export');
});

it('rejects an explicitly selected native file without opt-in and explains how to proceed', async () => {
  const { result, output } = await run(['import', native, '--provider', 'grok-build',
    '--source-id', 'native-fixture', '--workspace', process.cwd(), '--dry-run']);
  expect(result.exitCode).not.toBe(0);
  expect(output.error).toMatchObject({ code: 'UNSUPPORTED_OPERATION',
    message: expect.stringContaining(`${optIn}=1`) });
});

it('keeps explicit native fixture import available with opt-in', async () => {
  vi.stubEnv(optIn, '1'); vi.stubEnv('AIWG_GROK_BUILD_NATIVE_VERSION', '1.0.77');
  const { result, output } = await run(['import', native, '--provider', 'grok-build',
    '--source-id', 'native-fixture', '--workspace', process.cwd(), '--dry-run']);
  expect(result.exitCode).toBe(0);
  expect(output.status).toBe('preview');
});
