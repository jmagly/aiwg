// Preserve hook content and legacy backup/warning reporting while stabilizing receipt digests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureCoreStartup } from '../../../src/rules/core-startup.mjs';
import { generate } from '../../../src/smiths/context-pipeline/generator.js';
import { generateAiwgMd, generateAiwgMdForPipeline } from '../../../src/smiths/context-pipeline/aiwg-md.js';
import { buildClaudeHookBlock, ensureClaudeMdHook } from '../../../src/smiths/context-pipeline/claude-hook.js';

const roots: string[] = [];
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-hook-order-')); roots.push(root); return root; };
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('context hook ordering compatibility', () => {
  it('does not mirror generated hook-only input, while preserving surrounding operator prose', async () => {
    const project = temporary();
    const fresh = await generateAiwgMdForPipeline(project);
    await ensureClaudeMdHook(project);
    const hookFile = path.join(project, 'CLAUDE.md');
    fs.writeFileSync(hookFile, ensureCoreStartup(fs.readFileSync(hookFile, 'utf8')));
    expect(await generateAiwgMdForPipeline(project)).toBe(fresh);
    expect(await generateAiwgMd(project)).toContain('# Provider workspace bootstrap');
    fs.appendFileSync(hookFile, '\n<!-- Operator note: preserve this exact text. -->\n');
    expect(await generateAiwgMdForPipeline(project)).toContain('<!-- Operator note: preserve this exact text. -->');
  });

  it('renders existing CLAUDE.md before adding its hook, preserving legacy shared content', async () => {
    const project = temporary();
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Operator context\n\nKeep these instructions.\n');
    const expected = await generateAiwgMd(project);
    const result = await generate({ projectPath: project, provider: 'claude', sections: [], detectExistingFiles: true });
    expect(fs.readFileSync(path.join(project, 'AIWG.md'), 'utf8')).toBe(expected);
    expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toContain(buildClaudeHookBlock());
    expect(result.claudeMdHookAction).toBe('inserted');
    expect(result.backupPaths).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it.each([false, true])('preserves legacy context, hook bytes, backups and warnings (force=%s)', async force => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const project = temporary(), reference = temporary();
    const original = `# Operator\n\n${buildClaudeHookBlock().replace('Artifact destination authority:', 'Old artifact authority:')}\n\nKeep these instructions.\n`;
    for (const root of [project, reference]) {
      fs.writeFileSync(path.join(root, 'CLAUDE.md'), original);
      fs.writeFileSync(path.join(root, 'AIWG.md'), '# Operator AIWG context\n');
    }
    // The legacy generator renders AIWG.md before invoking the hook writer.
    const expectedContext = await generateAiwgMd(reference);
    const expectedHook = await ensureClaudeMdHook(reference, { force, detectExistingFiles: true });
    const result = await generate({ projectPath: project, provider: 'claude', sections: [], force, detectExistingFiles: true });
    expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toBe(ensureCoreStartup(fs.readFileSync(expectedHook.claudeMdPath, 'utf8')));
    expect(result.claudeMdHookAction).toBe(expectedHook.action);
    if (force) {
      expect(fs.readFileSync(path.join(project, 'AIWG.md'), 'utf8')).toBe(expectedContext);
      expect(result.backupPaths.map(file => path.basename(file))).toEqual([
        'AIWG.md.bak.2026-01-01T00-00-00-000Z', 'CLAUDE.md.bak.2026-01-01T00-00-00-000Z',
      ]);
      expect(fs.readFileSync(result.backupPaths[0], 'utf8')).toBe('# Operator AIWG context\n');
      expect(fs.readFileSync(result.backupPaths[1], 'utf8')).toBe(original);
      expect(result.warnings).toEqual(expectedHook.warnings);
    } else {
      expect(fs.readFileSync(path.join(project, 'AIWG.md'), 'utf8')).toBe('# Operator AIWG context\n');
      expect(result.backupPaths).toEqual([]);
      expect(result.warnings).toEqual([
        'WARNING: AIWG.md exists and is not AIWG-managed — left untouched. The stale file keeps loading instead of the lean managed bridge, so the Discover-First Protocol never reaches the agent and it may fabricate CLI commands. Run `aiwg regenerate --force` to back up and replace it.',
        ...expectedHook.warnings,
      ]);
    }
  });
});
