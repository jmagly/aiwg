// Script bridges preserve native owner arguments, project CWD and environment.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('native skill bridges (#4183)', () => {
  it.each([
    ['agentic/code/frameworks/sdlc-complete/skills/issue-audit/scripts/audit.mjs', 'issues/audit-cli.js'],
    ['agentic/code/addons/aiwg-utils/skills/aiwg-pr/scripts/deliver.mjs', 'delivery/pr.js'],
  ])('forwards %s to its source owner', async (script, owner) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-skill-bridge-'));
    const project = path.join(root, 'project');
    try {
      await mkdir(project);
      await mkdir(path.join(root, 'dist/src', path.dirname(owner)), { recursive: true });
      await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
      await writeFile(path.join(root, 'dist/src', owner), `import { writeFileSync } from 'node:fs';
export async function main(args, cwd = process.cwd()) { writeFileSync('bridge.json', JSON.stringify({ args, cwd, policy: process.env.AIWG_OUTPUT_MODES })); return 23; }`);
      await cp(script, path.join(root, 'bridge.mjs'));
      let status = 0;
      try {
        execFileSync(process.execPath, [path.join(root, 'bridge.mjs'), '--format', 'json'], {
          cwd: project, timeout: 30000,
          env: { ...process.env, HOME: root, AIWG_ROOT: root, AIWG_PROJECT_ROOT: project, AIWG_OUTPUT_MODES: 'fixture' },
        });
      } catch (error) { status = (error as { status: number }).status; }
      expect(status).toBe(23);
      expect(JSON.parse(await readFile(path.join(project, 'bridge.json'), 'utf8'))).toEqual({ args: ['--format', 'json'], cwd: project, policy: 'fixture' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
