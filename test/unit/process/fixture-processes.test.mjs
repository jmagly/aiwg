import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { signalChild } from '../../../src/process/signal-child.mjs';
import { useFixtureProcesses } from '../../helpers/fixture-processes.mjs';

const trackFixture = useFixtureProcesses();
const fixture = fileURLToPath(new URL('../../fixtures/process/ignore-sigterm.mjs', import.meta.url));
let child;

describe.sequential('fixture cleanup after a failed test (#3205)', () => {
  it.fails('fails mid-way after starting a child that ignores SIGTERM', async () => {
    child = trackFixture(spawn(process.execPath, [fixture], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
    await once(child, 'message'); // The SIGTERM handler is installed.
    signalChild(child, 'SIGTERM');
    await delay(50);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    throw new Error('Intentional mid-test failure before cleanup');
  });

  it('reaps the failed test child in afterEach before the next test', () => {
    expect(child.signalCode).toBe('SIGKILL');
    expect(() => process.kill(child.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });
});
