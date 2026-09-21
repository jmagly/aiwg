import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureClaudeMdHook } from '../../../src/smiths/context-pipeline/claude-hook.js';
import { ensureManagedHook } from '../../../src/smiths/context-pipeline/managed-hook.js';

const roots: string[] = [];
const temporaryRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'aiwg-context-link-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('provider instruction hooks', () => {
  it.each(['AGENTS.md', 'CLAUDE.md'])('refuses a symlinked %s without changing its target', async name => {
    const project = temporaryRoot();
    const outside = temporaryRoot();
    const outsideFile = join(outside, name);
    writeFileSync(outsideFile, '# Operator instructions\n');
    symlinkSync(outsideFile, join(project, name));

    if (name === 'AGENTS.md') {
      await expect(ensureManagedHook(join(project, name), { provider: 'grok-build' }))
        .rejects.toThrow(/Refusing unsafe AGENTS\.md target/);
    } else {
      await expect(ensureClaudeMdHook(project)).rejects.toThrow(/Refusing unsafe CLAUDE\.md target/);
    }
    expect(readFileSync(outsideFile, 'utf8')).toBe('# Operator instructions\n');
  });
});
