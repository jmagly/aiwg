// Guard direct-worker execution against the captured scheduler fan-out bypass.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GrokBuildAdapter } from '../../../tools/ralph-external/lib/grok-build-adapter.mjs';

const fixture = resolve('test/fixtures/providers/grok-build/fake-grok-build.mjs');
const denied = 'workflow,scheduler_create,scheduler_list,scheduler_delete';

describe('Grok Build direct-worker fan-out guard (T-OG-03)', () => {
  it.each(['workflow', ...denied.split(',').map(tool => denied.split(',').filter(name => name !== tool).join(','))])(
    'rejects a direct invocation with an incomplete tool ban: %s', toolBan => {
      const cwd = mkdtempSync(join(tmpdir(), 'aiwg-grok-fanout-'));
      try {
        const briefPath = join(cwd, 'brief.md');
        writeFileSync(briefPath, 'Offline fixture only.');
        const argv = new GrokBuildAdapter().buildWorkerArgs({ cwd, briefPath,
          selected: { model: 'synthetic-grok/model', effort: { value: 'low' } } }, null, { sandbox: 'read-only' });
        expect(argv[argv.indexOf('--disallowed-tools') + 1]).toBe(denied);
        const run = (args: string[]) => execFileSync(process.execPath, [fixture, ...args], {
          cwd, env: {}, encoding: 'utf8', timeout: 5_000, stdio: 'pipe',
        });
        expect(run(argv)).toContain('"stopReason":"end_turn"');
        const incomplete = [...argv];
        incomplete[incomplete.indexOf('--disallowed-tools') + 1] = toolBan;
        expect(() => run(incomplete)).toThrow(/--no-subagents also requires --disallowed-tools/);
        expect(() => run(argv.filter(arg => arg !== '--no-subagents'))).toThrow(/--no-subagents/);
      } finally { rmSync(cwd, { recursive: true, force: true }); }
    });
});
