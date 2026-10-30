// Verify cleanup preserves operator rules and refreshes only managed files.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Import functions under test
const REPO_ROOT = path.resolve(__dirname, '../..');

// Dynamic import helper for ESM modules
async function importBase() {
  return import(path.join(REPO_ROOT, 'tools/agents/providers/base.mjs'));
}

const TEST_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-consolidated-rules-'));

describe('Consolidated rules cleanup', () => {
  let base: any;
  beforeEach(async () => { base = await importBase(); fs.mkdirSync(TEST_BASE, { recursive: true }); });
  afterEach(() => fs.rmSync(TEST_BASE, { recursive: true, force: true }));
  describe('cleanupOldRuleFiles', () => {
    // Per #1143 fix in commit b903841f: cleanupOldRuleFiles is now opt-in
    // via opts.cleanRules. The default-off mode preserves rules across
    // addon-after-main deploys. These tests pass cleanRules: true to
    // exercise the cleanup logic itself.
    const CLEAN_OPTS = { cleanRules: true } as const;

    // #1627: cleanupOldRuleFiles only removes AIWG-managed rule files (those
    // carrying the `aiwg:managed` marker AIWG stamps on every deployed rule).
    // These fixtures stand in for previously-deployed AIWG rules, so they get
    // the marker. `writeUserRule` writes an operator-authored rule (no marker).
    const MANAGED_MARKER = '<!-- aiwg:managed v0.0.0 bundled -->\n';
    const writeAiwgRule = (name: string, body = 'old rule') =>
      fs.writeFileSync(path.join(rulesDir, name), MANAGED_MARKER + body);
    const writeUserRule = (name: string, body = 'user rule') =>
      fs.writeFileSync(path.join(rulesDir, name), body);

    let rulesDir: string;

    beforeEach(() => {
      rulesDir = path.join(TEST_BASE, `rules-${Date.now()}`);
      fs.mkdirSync(rulesDir, { recursive: true });
    });

    it('is a no-op when cleanRules is not passed (#1143 default-off)', () => {
      fs.writeFileSync(path.join(rulesDir, 'old-rule.md'), 'old');
      const removed = base.cleanupOldRuleFiles(rulesDir);
      expect(removed).toHaveLength(0);
      expect(fs.existsSync(path.join(rulesDir, 'old-rule.md'))).toBe(true);
    });

    it('removes old .md files but keeps RULES-INDEX.md', () => {
      writeAiwgRule('no-attribution.md');
      writeAiwgRule('anti-laziness.md');
      fs.writeFileSync(path.join(rulesDir, 'RULES-INDEX.md'), 'index content');

      const removed = base.cleanupOldRuleFiles(rulesDir, CLEAN_OPTS);

      expect(removed).toHaveLength(2);
      expect(fs.existsSync(path.join(rulesDir, 'no-attribution.md'))).toBe(false);
      expect(fs.existsSync(path.join(rulesDir, 'anti-laziness.md'))).toBe(false);
      expect(fs.existsSync(path.join(rulesDir, 'RULES-INDEX.md'))).toBe(true);
    });

    it('does not remove non-.md files', () => {
      fs.writeFileSync(path.join(rulesDir, 'existing.mdc'), 'cursor rule');
      fs.writeFileSync(path.join(rulesDir, 'config.json'), '{}');
      writeAiwgRule('old-rule.md');

      const removed = base.cleanupOldRuleFiles(rulesDir, CLEAN_OPTS);

      expect(removed).toHaveLength(1);
      expect(fs.existsSync(path.join(rulesDir, 'existing.mdc'))).toBe(true);
      expect(fs.existsSync(path.join(rulesDir, 'config.json'))).toBe(true);
    });

    it('skips directories', () => {
      fs.mkdirSync(path.join(rulesDir, 'subdir'));
      fs.writeFileSync(path.join(rulesDir, 'subdir', 'nested.md'), 'nested');

      const removed = base.cleanupOldRuleFiles(rulesDir, CLEAN_OPTS);

      expect(removed).toHaveLength(0);
      expect(fs.existsSync(path.join(rulesDir, 'subdir', 'nested.md'))).toBe(true);
    });

    it('dry-run mode does not delete files', () => {
      writeAiwgRule('old-rule.md');

      const removed = base.cleanupOldRuleFiles(rulesDir, { ...CLEAN_OPTS, dryRun: true });

      expect(removed).toHaveLength(1);
      expect(fs.existsSync(path.join(rulesDir, 'old-rule.md'))).toBe(true);
    });

    it('handles non-existent directory gracefully', () => {
      const removed = base.cleanupOldRuleFiles('/tmp/nonexistent-rules-dir', CLEAN_OPTS);
      expect(removed).toHaveLength(0);
    });

    it('handles empty directory', () => {
      const removed = base.cleanupOldRuleFiles(rulesDir, CLEAN_OPTS);
      expect(removed).toHaveLength(0);
    });

    it('handles case sensitivity for RULES-INDEX.md', () => {
      fs.writeFileSync(path.join(rulesDir, 'RULES-INDEX.md'), 'index');
      writeAiwgRule('rules-index.md', 'lowercase variant');

      const removed = base.cleanupOldRuleFiles(rulesDir, CLEAN_OPTS);

      expect(removed).toHaveLength(1);
      expect(fs.existsSync(path.join(rulesDir, 'RULES-INDEX.md'))).toBe(true);
      expect(fs.existsSync(path.join(rulesDir, 'rules-index.md'))).toBe(false);
    });

    it('skips files in incomingFiles (per-deploy refresh)', () => {
      writeAiwgRule('keep-me.md', 'keep');
      writeAiwgRule('remove-me.md', 'remove');

      const removed = base.cleanupOldRuleFiles(rulesDir, {
        ...CLEAN_OPTS,
        incomingFiles: ['/anywhere/keep-me.md'],
      });

      expect(removed).toHaveLength(1);
      expect(fs.existsSync(path.join(rulesDir, 'keep-me.md'))).toBe(true);
      expect(fs.existsSync(path.join(rulesDir, 'remove-me.md'))).toBe(false);
    });

    it('treats empty incomingFiles array as no-op even with cleanRules:true', () => {
      writeAiwgRule('should-survive.md', 'survive');
      const removed = base.cleanupOldRuleFiles(rulesDir, { ...CLEAN_OPTS, incomingFiles: [] });
      expect(removed).toHaveLength(0);
      expect(fs.existsSync(path.join(rulesDir, 'should-survive.md'))).toBe(true);
    });

    // #1627: user-authored rules (no aiwg:managed marker) must never be
    // deleted by cleanupOldRuleFiles, even with cleanRules:true.
    it('preserves operator-authored rules lacking the aiwg:managed marker', () => {
      writeUserRule('my-custom-rule.md');          // no marker → user file
      writeAiwgRule('stale-aiwg-rule.md');          // marker → AIWG file

      const removed = base.cleanupOldRuleFiles(rulesDir, {
        ...CLEAN_OPTS,
        incomingFiles: ['/anywhere/something-else.md'],
      });

      expect(removed).toHaveLength(1);
      expect(fs.existsSync(path.join(rulesDir, 'my-custom-rule.md'))).toBe(true);
      expect(fs.existsSync(path.join(rulesDir, 'stale-aiwg-rule.md'))).toBe(false);
    });
  });
});
