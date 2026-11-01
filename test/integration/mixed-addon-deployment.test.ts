import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UseHandler } from '../../src/cli/handlers/use.js';

let projectDir: string;

function context(addon: string) {
  return {
    args: [addon, '--target', projectDir, '--provider', 'claude'],
    rawArgs: ['use', addon, '--target', projectDir, '--provider', 'claude'],
    cwd: projectDir,
    frameworkRoot: path.resolve(__dirname, '../..'),
  };
}

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(os.tmpdir(), 'aiwg-mixed-addon-'));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('mixed agent and skill addon deployment', () => {
  it('copies complete skill trees and persists installed records', async () => {
    const handler = new UseHandler();

    const writing = await handler.execute(context('writing-quality'));
    expect(writing.exitCode, writing.message).toBe(0);
    expect(await readFile(
      path.join(projectDir, '.claude/.aiwg/skills/ai-pattern-detection/scripts/pattern_scanner.py'),
      'utf8',
    )).toContain('pattern');

    const sampling = await handler.execute(context('verbalized-sampling'));
    expect(sampling.exitCode, sampling.message).toBe(0);
    expect(await readFile(
      path.join(projectDir, '.claude/agents/verbalized-content-diversifier.md'), 'utf8',
    )).toContain('Verbalized Sampling');
    expect(await readFile(
      path.join(projectDir, '.claude/.aiwg/skills/diversity-tuning/SKILL.md'),
      'utf8',
    )).toContain('name: diversity-tuning');

    const config = JSON.parse(
      await readFile(path.join(projectDir, '.aiwg/aiwg.config'), 'utf8'),
    );
    expect(config.installed['writing-quality'].deployedTo.claude).toMatchObject({
      agents: 3,
      skills: 1,
    });
    expect(config.installed['verbalized-sampling'].deployedTo.claude).toMatchObject({
      agents: 1,
      skills: 1,
      rules: 1,
    });
  }, 180_000);
});
