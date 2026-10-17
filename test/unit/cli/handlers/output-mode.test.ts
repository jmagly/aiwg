import { mkdtemp } from '../../../helpers/temp-dir.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';
import type { HandlerContext } from '../../../../src/cli/handlers/types.js';
import { outputModeHandler } from '../../../../src/cli/handlers/output-mode.js';
import { readOutputModeState } from '../../../../src/output-modes/registry.js';

function context(cwd: string, args: string[]): HandlerContext {
  return { cwd, frameworkRoot: cwd, args, rawArgs: ['output-mode', ...args] };
}

afterEach(() => { delete process.env.AIWG_SESSION_ID; });

describe('output-mode handler', () => {
  it('rejects an invalid proposed project stack without persisting it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'aiwg-output-mode-handler-'));
    process.env.AIWG_SESSION_ID = `test-${Date.now()}`;
    const profileDir = join(cwd, '.aiwg', 'output-modes');
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'dependent.yaml'), [
      'id: dependent', 'version: 1.0.0', 'description: requires a missing mode',
      'kind: structure', 'stage: structure', 'instructions: test',
      'requires: [missing-mode]', 'provenance:', '  source: test', '  license: MIT',
      'validation:', '  level: advisory', '',
    ].join('\n'));

    const result = await outputModeHandler.execute(context(cwd, ['enable', 'dependent', '--scope', 'project']));
    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.message).toContain("requires 'missing-mode'");
    expect(await readOutputModeState(cwd, 'project')).toEqual({ version: 1, modes: [] });
  });

  it('provides command-specific help', async () => {
    const result = await outputModeHandler.help!(context(process.cwd(), ['--help']));
    expect(result.message).toContain('aiwg output-mode status');
    expect(result.message).toContain('--scope invocation|session|project');
  });
});
