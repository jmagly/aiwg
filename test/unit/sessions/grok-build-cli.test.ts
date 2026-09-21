import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sessionsHandler } from '../../../src/cli/handlers/sessions.js';

afterEach(() => vi.restoreAllMocks());

it('routes an explicit Grok Build CLI export through the distinct session adapter', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const fixture = resolve(
    'test/fixtures/sessions/grok-build/0199a111-1111-7111-8111-111111111111.md',
  );
  const result = await sessionsHandler.execute({
    args: [
      'import', fixture,
      '--provider', 'grok-build',
      '--source-id', 'grok-build-cli-fixture',
      '--workspace', process.cwd(),
      '--dry-run', '--json',
    ],
    rawArgs: [], cwd: process.cwd(), frameworkRoot: process.cwd(),
  });
  const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(result.exitCode).toBe(0);
  expect(output).toMatchObject({
    status: 'preview',
    data: {
      source: {
        provider: 'grok-build',
        providerProfile: 'documented-cli-markdown-export',
        locatorClass: 'grok-build-cli-markdown-export',
        disposition: 'implemented',
        extensions: {
          'native.grok-build': { acquisition: 'grok-cli-export-markdown' },
        },
      },
      wouldPersist: false,
    },
  });
});
