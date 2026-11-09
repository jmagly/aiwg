import { useWindowsSimulation } from '../../helpers/windows-simulation.mjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eval-harness resolves bounded-child-process via importImpl, which prefers dist/
// when it exists (as in CI); pin src before the module loads so the mock applies.
const { execFile } = vi.hoisted(() => {
  process.env.AIWG_RESOLVE_IMPL_FROM = 'src';
  return { execFile: vi.fn() };
});
vi.mock('../../../src/process/bounded-child-process.mjs', () => ({ boundedExecFileSync: execFile }));

import { EvalHarness } from '../../../tools/ralph-external/eval-harness.mjs';

describe('EvalHarness Windows shell invocation', () => {
  useWindowsSimulation({ beforeEach, afterEach });
  beforeEach(() => {
    execFile.mockReturnValue('{"score":1,"pass_count":1,"total_count":1}');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, 'C:\\Windows\\System32\\custom-cmd.exe'])('preserves Node shell quoting with ComSpec=%s', comSpec => {
    vi.stubEnv('ComSpec', comSpec);
    const command = '"C:\\Program Files\\instrument.exe" "literal argument" | more';
    const harness = new EvalHarness({ score: { command } }, { workingDir: process.cwd() });

    expect(harness.run().status).toBe('pass');
    expect(execFile).toHaveBeenCalledWith(comSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], 'long', {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: true,
    });
  });
});
