import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const overrides = join(root, 'docs', 'overrides');
const shell = readFileSync(join(overrides, 'index.html'), 'utf8');
const theme = readFileSync(join(overrides, 'open-kit.css'), 'utf8');
const copyControl = readFileSync(join(overrides, 'code-copy.js'), 'utf8');
const config = JSON.parse(readFileSync(join(root, 'docs', 'config.json'), 'utf8'));
const blogWriter = readFileSync(join(root, 'tools', 'docs', 'write-blog-static-pages.mjs'), 'utf8');

describe('docs.aiwg.io open-kit theme contract', () => {
  it('keeps the Pagenary runtime hooks required by the app shell', () => {
    for (const id of [
      'app',
      'nav',
      'year',
      'mobileMenuToggle',
      'commandToggle',
      'commandPalette',
      'commandInput',
      'commandList',
      'shareBtn',
      'exportBtn',
      'brandHome',
    ]) {
      expect(shell).toContain(`id="${id}"`);
    }
    const baseStylesheet = shell.indexOf('href="./styles.css"');
    const themeStylesheet = shell.indexOf('href="./open-kit.css"');
    expect(baseStylesheet, 'base stylesheet must be present').toBeGreaterThanOrEqual(0);
    expect(themeStylesheet, 'theme stylesheet must be present').toBeGreaterThanOrEqual(0);
    expect(baseStylesheet).toBeLessThan(themeStylesheet);
    expect(shell).toContain('src="./app.js"');
  });

  it('uses an additive open-kit theme and removes the retired terminal runtime', () => {
    expect(existsSync(join(overrides, 'styles.css'))).toBe(false);
    expect(existsSync(join(overrides, 'terminal.js'))).toBe(false);
    expect(theme).toContain('--ink: #17212b');
    expect(theme).toContain('--paper: #e8edf0');
    expect(theme).toContain('--blue: #0068ff');
    expect(theme).toContain('--yellow: #ffcf33');
    expect(theme).toContain('--coral: #ff6f59');
    expect(theme).toContain('--mint: #65d6a6');
    expect(theme).toContain('width: min(calc(100% - 0.75rem), 92rem)');
    expect(theme).toContain('.section.doc .content-box > :not(.box-title)');
    expect(theme).toContain('overflow-wrap: anywhere');
    expect(theme).toContain('.doc-content pre.has-code-copy');
    expect(theme).toContain('white-space: pre-wrap');
    expect(theme).toMatch(/\.code-copy \{[\s\S]*?opacity: 1/);
    expect(copyControl).toContain("navigator.clipboard.writeText(text)");
    expect(copyControl).toContain("document.execCommand('copy')");
    expect(copyControl).toContain("label.setAttribute('aria-live', 'polite')");
    expect(theme).toMatch(/@media \(max-width: 960px\)[\s\S]*?\.layout \{\s*grid-template-columns: minmax\(0, 1fr\)/);
    expect(shell).not.toContain('consoleInput');
    expect(shell).not.toContain('terminal.js');
  });

  it('keeps the publisher on a light, left-navigation configuration', () => {
    expect(config.theme.colorScheme).toBe('light');
    expect(config.theme.surface).toBe('#e8edf0');
    expect(config.theme.ink).toBe('#17212b');
    expect(config.theme.accent).toBe('#0068ff');
    expect(config.navPosition).toBe('left');
    expect(config.navCollapse).toBe('instant');
    expect(config.codeCopy).toBe(true);
  });

  it('carries the same visual system into generated blog routes', () => {
    expect(blogWriter).toContain('--paper: #e8edf0');
    expect(blogWriter).toContain('--yellow: #ffcf33');
    expect(blogWriter).toContain('AIWG <span>/ BLOG</span>');
    expect(blogWriter).toContain("join(distRoot, 'open-kit.css')");
    expect(blogWriter).toContain("join(distRoot, 'code-copy.js')");
    expect(blogWriter).toContain("join(repoRoot, 'docs', 'overrides', 'code-copy.js')");
    expect(blogWriter).toContain('linked open-kit.css');
    expect(blogWriter).not.toContain('color-scheme: dark');
  });
});
