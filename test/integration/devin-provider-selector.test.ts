import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const DEPLOY = join(REPO_ROOT, 'tools', 'agents', 'deploy-agents.mjs');
const ROOT = mkdtempSync(join(tmpdir(), 'aiwg-devin-selector-'));

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative(root, absolute));
    }
  };
  visit(root);
  return files.sort();
}

function deploy(selector: string): Map<string, string> {
  const target = join(ROOT, selector);
  const result = spawnSync(process.execPath, [
    DEPLOY,
    '--source', REPO_ROOT,
    '--target', target,
    '--mode', 'general',
    '--provider', selector,
    '--deploy-commands',
    '--deploy-skills',
    '--deploy-rules',
    '--quiet',
  ], { timeout: 60_000, cwd: REPO_ROOT, encoding: 'utf8' });

  expect(result.status, `${selector}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
  return new Map(filesUnder(target).map((file) => [
    file,
    createHash('sha256').update(readFileSync(join(target, file))).digest('hex'),
  ]));
}

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('Devin Desktop provider selectors', () => {
  it('emits byte-identical artifacts for devin, devin-desktop, and windsurf', () => {
    const preferred = deploy('devin');
    expect(deploy('devin-desktop')).toEqual(preferred);
    expect(deploy('windsurf')).toEqual(preferred);
    expect(preferred.size).toBeGreaterThan(0);
    for (const selector of ['devin', 'devin-desktop', 'windsurf']) {
      expect(existsSync(join(ROOT, selector, '.devin')), `${selector}: keep legacy native paths`).toBe(false);
    }
  });
});
