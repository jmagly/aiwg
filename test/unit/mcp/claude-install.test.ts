import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeDesktopConfigPath, resolveClaudeInstallTarget } from '../../../src/mcp/claude-install.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'aiwg-claude-paths-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('Claude Desktop platform paths', () => {
  it.each([
    ['darwin', 'Library/Application Support'],
    ['linux', '.config'],
    ['win32', 'AppData/Roaming'],
  ])('resolves %s under an isolated home', (platform, base) => {
    expect(claudeDesktopConfigPath(platform, { HOME: root })).toBe(join(root, base, 'Claude/claude_desktop_config.json'));
  });
  it('uses Windows APPDATA with USERPROFILE fallback', () => {
    expect(claudeDesktopConfigPath('win32', { USERPROFILE: root, APPDATA: join(root, 'roaming') }))
      .toBe(join(root, 'roaming/Claude/claude_desktop_config.json'));
    expect(claudeDesktopConfigPath('win32', { USERPROFILE: root }))
      .toBe(join(root, 'AppData/Roaming/Claude/claude_desktop_config.json'));
  });
  it.each(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_DESKTOP_APP_VERSION'])('detects Code via %s', marker => {
    expect(resolveClaudeInstallTarget('claude', 'project', { [marker]: '1' })).toBe('claude-code');
    expect(resolveClaudeInstallTarget('claude-desktop', 'project', { [marker]: '1' })).toBe('claude-desktop');
  });
});
