// Keep repository import CLI argument errors and preflight ordering observable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBundleImport } from '../../../src/skills/bundle-import-cli.js';
import { importSkillBundle } from '../../../src/skills/bundle-import.js';
import { main as skillsMain } from '../../../src/skills/cli.js';
vi.mock('../../../src/skills/bundle-import.js', () => ({ importSkillBundle: vi.fn() }));
const importMock = vi.mocked(importSkillBundle);
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
});
afterEach(() => { vi.restoreAllMocks(); importMock.mockReset(); });

describe('repository bundle import CLI', () => {
  it.each([false, true])('emits preflight before result, JSON=%s', async (json) => {
    const plan: any = {
      manifest: { id: 'community', skills: ['demo'], upstream: [{ repo: 'source', commit: 'a'.repeat(40) }] },
      installed: false, dryRun: true,
      diagnostics: [{ code: 'collision', file: 'SKILL.md', message: 'proposed name' }],
      diff: { added: ['manifest.json'], modified: [], removed: [] },
    };
    importMock.mockImplementation(async options => { options.report?.(plan); return plan; });
    await skillsMain(['import', 'source', '--into', 'community', '--ref', 'main', '--only', 'demo*', '--dry-run', ...(json ? ['--json'] : [])]);
    expect(importMock).toHaveBeenCalledWith(expect.objectContaining({ source: 'source', into: 'community', ref: 'main', only: 'demo*', dryRun: true }));
    const lines = vi.mocked(console.log).mock.calls.map(args => args[0]);
    if (json) expect(lines.map(line => JSON.parse(line).phase)).toEqual(['preflight', 'result']);
    else {
      expect(lines[0]).toContain('[DRY RUN]');
      expect(lines.at(-1)).toBe('Planned 1 skills; installed: false');
    }
  });

  it('parses refresh and reports indexed results without optional metadata', async () => {
    const plan: any = { manifest: { id: 'community' }, diagnostics: [], diff: { added: [] }, dryRun: false };
    importMock.mockImplementation(async options => { options.report?.(plan); return plan; });
    await handleBundleImport(['--refresh', 'community']);
    expect(importMock).toHaveBeenCalledWith(expect.objectContaining({ refresh: 'community', source: undefined }));
    expect(console.log).toHaveBeenLastCalledWith('Indexed 0 skills; installed: false');
  });

  it.each([
    ['--into'], ['--into', '--dry-run'], ['--into', 'a', '--into', 'b'],
    ['source', '--into', 'community', '--unknown'], ['one', 'two', '--into', 'community'],
  ])('fails invalid arguments %j', async (...args) => {
    await expect(handleBundleImport(args)).rejects.toThrow('exit:1');
    expect(importMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
  it.each([new Error('invalid repository'), 'invalid repository'])('returns JSON failure for importer errors %j', async error => {
    importMock.mockRejectedValue(error);
    await expect(handleBundleImport(['--refresh', 'community', '--json'])).rejects.toThrow('exit:1');
    expect(console.log).toHaveBeenCalledWith(JSON.stringify({ phase: 'error', message: 'invalid repository' }));
  });
  it('keeps legacy import errors and advertises both repository import forms', async () => {
    await expect(skillsMain(['import', '--unknown'])).rejects.toThrow('exit:1');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('import <repo-url|path> --into'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('import --refresh <addon>'));
  });
});
