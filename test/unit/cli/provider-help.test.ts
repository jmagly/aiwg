// Both help entrypoints must follow the canonical provider registry.
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateProviderHelp } from '../../../src/cli/help-generator.js';
import { helpHandler } from '../../../src/cli/handlers/help.js';
import { PROVIDER_IDS } from '../../../src/providers/provider-definitions.js';
import type { HandlerContext } from '../../../src/cli/handlers/types.js';

describe('provider help (#4182)', () => {
  it('lists every registered provider exactly once with the registry count', () => {
    const text = generateProviderHelp();
    expect(text).toContain(`Providers: ${PROVIDER_IDS.length} —`);
    const names = text.split(' — ')[1].split(' (default:')[0].split(', ')
      .map(name => name.replace(' (experimental)', ''));
    expect(names).toEqual(PROVIDER_IDS);
  });

  it('prints the same list from launcher aliases and the router help handler', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'aiwg-help-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await helpHandler.execute({ args: [] } as unknown as HandlerContext);
      expect(log.mock.calls.flat()).toContain(`  ${generateProviderHelp()}`);
      for (const command of ['help', '--help', '-h']) {
        const result = execFileSync(process.execPath, ['bin/aiwg.mjs', command], {
          cwd: process.cwd(), encoding: 'utf8', timeout: 30000,
          env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, AIWG_CONFIG: home },
        });
        expect(result.split('\n').find(line => line.includes('Providers:'))?.trim()).toBe(generateProviderHelp());
      }
    } finally { log.mockRestore(); rmSync(home, { recursive: true, force: true }); }
  });
});
