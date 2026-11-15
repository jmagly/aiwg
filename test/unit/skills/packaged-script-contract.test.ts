// Every packaged script-bearing skill dispatches using its frontmatter alone.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { globSync } from 'glob';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import yaml from 'js-yaml';
import type { MetadataEntry } from '../../../src/artifacts/types.js';
const state = vi.hoisted(() => ({ entries: [] as MetadataEntry[], spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: state.spawn }));
vi.mock('../../../src/artifacts/fortemi-core-query-adapter.js', () => ({ loadFortemiCoreMetadataEntries: () => ({ entries: state.entries }) }));
import { runSkill } from '../../../src/skills/run.js';
import { resolveRuntime } from '../../../src/skills/runtime.js';

const skills = globSync('agentic/code/{addons,frameworks,extensions,plugins}/**/SKILL.md')
  .flatMap(file => {
    const front = readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const data = front ? yaml.load(front[1]) as Partial<MetadataEntry> : {};
    return data?.script ? [{ file, script: data.script }] : [];
  });
afterEach(() => { vi.unstubAllEnvs(); state.spawn.mockReset(); });

describe('packaged skill script declarations (#4183)', () => {
  it('contains the former issue-audit and aiwg-pr special cases', () => {
    expect(skills.some(s => s.file.endsWith('/issue-audit/SKILL.md'))).toBe(true);
    expect(skills.some(s => s.file.endsWith('/aiwg-pr/SKILL.md'))).toBe(true);
  });
  it.each(skills)('dispatches $file by declared runtime, entrypoint and cwd', async ({ file, script }) => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'aiwg-script-contract-'));
    const install = process.cwd();
    vi.stubEnv('AIWG_ROOT', install);
    const entrypoint = path.resolve(path.dirname(file), script.entrypoint);
    state.entries = [{ path: file, type: 'skill', script } as MetadataEntry];
    state.spawn.mockImplementation(() => { const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 0, null)); return child; });
    try {
      const invocation = await resolveRuntime(script.runtime, entrypoint);
      expect(invocation).not.toBeNull();
      expect(await runSkill({ cwd, name: file, args: ['sentinel'] })).toBe(0);
      const expectedCwd = script.cwd === 'skill-dir' ? path.resolve(path.dirname(file)) : script.cwd === 'aiwg-root' ? install : cwd;
      expect(state.spawn).toHaveBeenCalledWith(invocation!.command, [...invocation!.prefixArgs, entrypoint, 'sentinel'], expect.objectContaining({ cwd: expectedCwd, stdio: 'inherit' }));
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
