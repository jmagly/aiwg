import { mkdtempSync } from '../../helpers/temp-dir.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_SKILLS_BASELINE } from '../../../src/skills/agent-skills.js';

const tool = path.resolve('tools/cli/validate-metadata.mjs');
const fixtures = path.resolve(
  'test/fixtures/agent-skills',
  `upstream-${AGENT_SKILLS_BASELINE.revision}`,
);

function run(...args: string[]) {
  return spawnSync(process.execPath, [tool, ...args], { timeout: 60_000,
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });
}

describe('validate-metadata Agent Skills integration', () => {
  it('emits deterministic structured JSON from the shared validator', () => {
    const args = [
      '--ci',
      '--format',
      'json',
      '--profile',
      'strict',
      path.join(fixtures, 'minimal', 'SKILL.md'),
    ];
    const first = run(...args);
    const second = run(...args);

    expect(first.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    const report = JSON.parse(first.stdout) as {
      agentSkills: {
        profile: string;
        files: Array<{ state: string }>;
      };
    };
    expect(report.agentSkills.profile).toBe('strict');
    expect(report.agentSkills.files[0]?.state).toBe('valid');
  });

  it('fails CI for conformance errors and strict warning escalation', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-metadata-invalid-'));
    const invalidFile = path.join(root, 'invalid-metadata', 'SKILL.md');
    fs.mkdirSync(path.dirname(invalidFile));
    fs.copyFileSync(
      path.join(fixtures, 'invalid-metadata', 'SKILL.invalid.md'),
      invalidFile,
    );
    const invalid = run(
      '--ci',
      '--format',
      'json',
      '--profile',
      'strict',
      invalidFile,
    );
    const warning = run(
      '--ci',
      '--strict',
      '--format',
      'json',
      '--profile',
      'strict',
      path.join(fixtures, 'flow-syntax', 'SKILL.md'),
    );

    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toContain('AS_METADATA_VALUE_TYPE');
    expect(warning.status).toBe(1);
    expect(warning.stdout).toContain('AS_ALLOWED_TOOLS_EXPERIMENTAL');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('scans skill directories recursively', () => {
    const result = run(
      '--ci',
      '--recursive',
      '--format',
      'json',
      '--profile',
      'discovery',
      fixtures,
    );
    const report = JSON.parse(result.stdout) as {
      agentSkills: { summary: { scanned: number } };
    };

    expect(report.agentSkills.summary.scanned).toBe(2);
  });
});
