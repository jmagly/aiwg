/**
 * Unit Tests for Consolidated Rules Deployment
 *
 * Tests for the new base.mjs functions that support deploying a single
 * RULES-INDEX.md instead of 31 individual rule files.
 *
 * Issue #340 (parent #334)
 */

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

describe('Consolidated Rules Functions', () => {
  let base: any;

  beforeEach(async () => {
    base = await importBase();
    fs.mkdirSync(TEST_BASE, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  });

  // ==========================================================================
  // loadRulesManifest
  // ==========================================================================

  describe('loadRulesManifest', () => {
    it('loads manifest from real source root', () => {
      const manifest = base.loadRulesManifest(REPO_ROOT);
      expect(manifest).not.toBeNull();
      expect(manifest.version).toBe('2.0.0');
      expect(manifest.rules).toBeInstanceOf(Array);
      expect(manifest.rules.length).toBeGreaterThan(0);
    });

    it('returns null for non-existent source root', () => {
      const manifest = base.loadRulesManifest('/tmp/nonexistent-aiwg-test');
      expect(manifest).toBeNull();
    });

    it('manifest contains consolidation metadata', () => {
      const manifest = base.loadRulesManifest(REPO_ROOT);
      expect(manifest.consolidation).toBeDefined();
      expect(manifest.consolidation.strategy).toBe('index-with-links');
      expect(manifest.consolidation.indexFile).toBe('RULES-INDEX.md');
      expect(manifest.consolidation.deployIndexOnly).toBe(true);
    });

    it('manifest contains all 3 tiers', () => {
      const manifest = base.loadRulesManifest(REPO_ROOT);
      const tiers = new Set(manifest.rules.map((r: any) => r.tier));
      expect(tiers.has('core')).toBe(true);
      expect(tiers.has('sdlc')).toBe(true);
      expect(tiers.has('research')).toBe(true);
    });
  });

  // ==========================================================================
  // groupRulesByTier
  // ==========================================================================

  describe('groupRulesByTier', () => {
    it('groups rules into core, sdlc, and research', () => {
      const rules = [
        { name: 'no-attribution', tier: 'core' },
        { name: 'tao-loop', tier: 'sdlc' },
        { name: 'research-metadata', tier: 'research' },
        { name: 'anti-laziness', tier: 'core' },
      ];

      const groups = base.groupRulesByTier(rules);
      expect(groups.core).toHaveLength(2);
      expect(groups.sdlc).toHaveLength(1);
      expect(groups.research).toHaveLength(1);
    });

    it('defaults missing tier to sdlc', () => {
      const rules = [{ name: 'unknown-rule' }];
      const groups = base.groupRulesByTier(rules);
      expect(groups.sdlc).toHaveLength(1);
    });

    it('ignores unknown tier values', () => {
      const rules = [{ name: 'bad-rule', tier: 'nonexistent' }];
      const groups = base.groupRulesByTier(rules);
      expect(groups.core).toHaveLength(0);
      expect(groups.sdlc).toHaveLength(0);
      expect(groups.research).toHaveLength(0);
    });

    it('handles empty input', () => {
      const groups = base.groupRulesByTier([]);
      expect(groups.core).toHaveLength(0);
      expect(groups.sdlc).toHaveLength(0);
      expect(groups.research).toHaveLength(0);
    });

    it('groups real manifest rules correctly', () => {
      const manifest = base.loadRulesManifest(REPO_ROOT);
      const groups = base.groupRulesByTier(manifest.rules);
      // Core rules (aiwg-utils rules migrated to addon, sdlc-complete has 7)
      expect(groups.core.length).toBeGreaterThanOrEqual(7);
      // SDLC rules
      expect(groups.sdlc.length).toBeGreaterThanOrEqual(20);
      // Research has 2 rules
      expect(groups.research.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ==========================================================================
  // groupByEnforcement
  // ==========================================================================

  describe('groupByEnforcement', () => {
    it('groups rules by enforcement level', () => {
      const rules = [
        { name: 'no-attribution', enforcement: 'critical' },
        { name: 'anti-laziness', enforcement: 'high' },
        { name: 'reproducibility', enforcement: 'medium' },
        { name: 'token-security', enforcement: 'critical' },
      ];

      const groups = base.groupByEnforcement(rules);
      expect(groups.critical).toHaveLength(2);
      expect(groups.high).toHaveLength(1);
      expect(groups.medium).toHaveLength(1);
    });

    it('defaults missing enforcement to medium', () => {
      const rules = [{ name: 'unknown' }];
      const groups = base.groupByEnforcement(rules);
      expect(groups.medium).toHaveLength(1);
    });

    it('is case-insensitive', () => {
      const rules = [
        { name: 'a', enforcement: 'CRITICAL' },
        { name: 'b', enforcement: 'High' },
        { name: 'c', enforcement: 'Medium' },
      ];
      const groups = base.groupByEnforcement(rules);
      expect(groups.critical).toHaveLength(1);
      expect(groups.high).toHaveLength(1);
      expect(groups.medium).toHaveLength(1);
    });

    it('handles empty input', () => {
      const groups = base.groupByEnforcement([]);
      expect(groups.critical).toHaveLength(0);
      expect(groups.high).toHaveLength(0);
      expect(groups.medium).toHaveLength(0);
    });
  });

  // ==========================================================================
  // getRulesIndexPath
  // ==========================================================================

  describe('getRulesIndexPath', () => {
    it('returns path when RULES-INDEX.md exists', () => {
      const result = base.getRulesIndexPath(REPO_ROOT);
      expect(result).not.toBeNull();
      expect(result).toContain('RULES-INDEX.md');
      expect(fs.existsSync(result)).toBe(true);
    });

    it('returns null when source root does not exist', () => {
      const result = base.getRulesIndexPath('/tmp/nonexistent-aiwg-test');
      expect(result).toBeNull();
    });

    it('returns the correct relative path', () => {
      const result = base.getRulesIndexPath(REPO_ROOT);
      const expected = path.join(REPO_ROOT, 'agentic', 'code', 'frameworks', 'sdlc-complete', 'rules', 'RULES-INDEX.md');
      expect(result).toBe(expected);
    });
  });

  // ==========================================================================
  // generateConsolidatedRulesContent
  // ==========================================================================

  describe('generateConsolidatedRulesContent', () => {
    it('returns content from RULES-INDEX.md', () => {
      const content = base.generateConsolidatedRulesContent(REPO_ROOT, 'claude');
      expect(content).not.toBeNull();
      expect(content).toContain('# AIWG Rules Index');
    });

    it('content includes all 3 tier sections', () => {
      const content = base.generateConsolidatedRulesContent(REPO_ROOT, 'claude');
      expect(content).toContain('## Core Rules');
      expect(content).toContain('## SDLC Rules');
      expect(content).toContain('## Research Rules');
    });

    it('content includes enforcement level headings', () => {
      const content = base.generateConsolidatedRulesContent(REPO_ROOT, 'claude');
      expect(content).toContain('### CRITICAL');
      expect(content).toContain('### HIGH');
      expect(content).toContain('### MEDIUM');
    });

    it('content includes @-links to full rule files', () => {
      const content = base.generateConsolidatedRulesContent(REPO_ROOT, 'claude');
      expect(content).toContain('@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/no-attribution.md');
      expect(content).toContain('@$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/anti-laziness.md');
    });

    it('content includes Quick Reference table', () => {
      const content = base.generateConsolidatedRulesContent(REPO_ROOT, 'claude');
      expect(content).toContain('## Quick Reference by Context');
      expect(content).toContain('Writing code');
    });

    it('appends addon rules when provided', () => {
      const addonFiles = [
        path.join(REPO_ROOT, 'agentic', 'code', 'addons', 'voice-framework', 'rules', 'voice-rule.md'),
        path.join(REPO_ROOT, 'agentic', 'code', 'addons', 'testing', 'rules', 'test-rule.md'),
      ];
      const content = base.generateConsolidatedRulesContent(REPO_ROOT, 'claude', addonFiles);
      expect(content).toContain('## Additional Addon Rules');
      expect(content).toContain('**voice-rule**');
      expect(content).toContain('**test-rule**');
    });

    it('does not include addon section when no addons provided', () => {
      const content = base.generateConsolidatedRulesContent(REPO_ROOT, 'claude');
      expect(content).not.toContain('## Additional Addon Rules');
    });

    it('returns null when source root does not exist', () => {
      const content = base.generateConsolidatedRulesContent('/tmp/nonexistent-aiwg-test', 'claude');
      expect(content).toBeNull();
    });
  });

  // ==========================================================================
  // getComponentRulesIndexPath
  // ==========================================================================

  describe('getComponentRulesIndexPath', () => {
    it('returns path for aiwg-utils addon', () => {
      const utilsPath = path.join(REPO_ROOT, 'agentic', 'code', 'addons', 'aiwg-utils');
      const result = base.getComponentRulesIndexPath(utilsPath);
      expect(result).not.toBeNull();
      expect(result).toContain('RULES-INDEX.md');
      expect(fs.existsSync(result)).toBe(true);
    });

    it('returns path for sdlc-complete framework', () => {
      const sdlcPath = path.join(REPO_ROOT, 'agentic', 'code', 'frameworks', 'sdlc-complete');
      const result = base.getComponentRulesIndexPath(sdlcPath);
      expect(result).not.toBeNull();
      expect(result).toContain('RULES-INDEX.md');
      expect(fs.existsSync(result)).toBe(true);
    });

    it('returns null when manifest does not exist', () => {
      const tmpDir = path.join(TEST_BASE, 'no-manifest-component');
      fs.mkdirSync(tmpDir, { recursive: true });
      const result = base.getComponentRulesIndexPath(tmpDir);
      expect(result).toBeNull();
    });

    it('returns null when manifest has no consolidation field', () => {
      const tmpDir = path.join(TEST_BASE, 'no-consolidation-component');
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({ name: 'test' }));
      const result = base.getComponentRulesIndexPath(tmpDir);
      expect(result).toBeNull();
    });

    it('returns null when manifest consolidation.rulesIndex points to missing file', () => {
      const tmpDir = path.join(TEST_BASE, 'missing-index-component');
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({
        consolidation: { rulesIndex: 'rules/RULES-INDEX.md', deployIndexOnly: true }
      }));
      const result = base.getComponentRulesIndexPath(tmpDir);
      expect(result).toBeNull();
    });

    it('returns path when index file exists', () => {
      const tmpDir = path.join(TEST_BASE, 'valid-component');
      const rulesDir = path.join(tmpDir, 'rules');
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({
        consolidation: { rulesIndex: 'rules/RULES-INDEX.md', deployIndexOnly: true }
      }));
      fs.writeFileSync(path.join(rulesDir, 'RULES-INDEX.md'), '# Test Index');
      const result = base.getComponentRulesIndexPath(tmpDir);
      expect(result).toBe(path.join(rulesDir, 'RULES-INDEX.md'));
    });

    it('returns null for invalid JSON in manifest', () => {
      const tmpDir = path.join(TEST_BASE, 'bad-json-component');
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'manifest.json'), '{ invalid json }');
      const result = base.getComponentRulesIndexPath(tmpDir);
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // assembleRulesIndex
  // ==========================================================================

  describe('assembleRulesIndex', () => {
    it('returns content when global RULES-INDEX.md exists', () => {
      const result = base.assembleRulesIndex(REPO_ROOT);
      expect(result).not.toBeNull();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns null when global RULES-INDEX.md is missing', () => {
      const result = base.assembleRulesIndex('/tmp/nonexistent-aiwg-test');
      expect(result).toBeNull();
    });

    it('includes global header content', () => {
      const result = base.assembleRulesIndex(REPO_ROOT);
      // Global template header should appear before component sections
      expect(result).toContain('AIWG Rules Index');
      expect(result).toContain('Installed Components');
    });

    it('includes Quick Reference section from global template', () => {
      const result = base.assembleRulesIndex(REPO_ROOT);
      expect(result).toContain('## Quick Reference by Context');
    });

    it('includes sdlc-complete component rules', () => {
      const result = base.assembleRulesIndex(REPO_ROOT);
      // sdlc-complete RULES-INDEX.md should be embedded
      expect(result).toContain('# AIWG SDLC Rules Index');
      expect(result).toContain('## Core Rules');
      expect(result).toContain('## SDLC Rules');
    });

    it('includes aiwg-utils component rules', () => {
      const result = base.assembleRulesIndex(REPO_ROOT);
      expect(result).toContain('subagent-scoping');
    });

    it('component section headings appear in assembled output', () => {
      const result = base.assembleRulesIndex(REPO_ROOT);
      const sdlcPos = result.indexOf('# AIWG SDLC Rules Index');
      expect(sdlcPos).toBeGreaterThan(0);
    });

    it('global Quick Reference appears at the end of the assembled output', () => {
      const result = base.assembleRulesIndex(REPO_ROOT);
      // The global template's QR section (from agentic/code/RULES-INDEX.md)
      // is appended after all component sections as the final summary
      expect(result).toContain('## Quick Reference by Context');
      // The global QR footer should be the last occurrence
      const lastQrPos = result.lastIndexOf('## Quick Reference by Context');
      const sdlcPos = result.indexOf('# AIWG SDLC Rules Index');
      expect(lastQrPos).toBeGreaterThan(sdlcPos);
    });
  });

  // ==========================================================================
  // getAddonRuleFiles — consolidated addon skipping
  // ==========================================================================

  describe('getAddonRuleFiles (consolidated addon skipping)', () => {
    // Note (#1343 / 2026-05-14): aiwg-utils.manifest.json was changed from
    // deployIndexOnly=true to false so individual rule files (including
    // skill-discovery.md) deploy to every provider's rules directory
    // alongside the index. The "skipping" tests below now verify that
    // addons WITHOUT deployIndexOnly are included (positive contract) and
    // that excludeAddons still works to override.
    it('includes addons with consolidation.deployIndexOnly=false', () => {
      const files = base.getAddonRuleFiles(REPO_ROOT);
      // aiwg-utils now has deployIndexOnly=false and SHOULD be included
      const hasUtilsFiles = files.some((f: string) => f.includes('aiwg-utils'));
      expect(hasUtilsFiles).toBe(true);
    });

    it('returns the skill-discovery rule from aiwg-utils (cross-provider parity, #1343)', () => {
      const files = base.getAddonRuleFiles(REPO_ROOT);
      const hasSkillDiscovery = files.some((f: string) =>
        f.endsWith('aiwg-utils/rules/skill-discovery.md')
      );
      expect(hasSkillDiscovery).toBe(true);
    });

    it('still returns files from addons without consolidation', () => {
      // Addons without consolidation field should still have their rules returned
      // (most addons don't have rules at all, so we just verify the function runs)
      const files = base.getAddonRuleFiles(REPO_ROOT);
      expect(Array.isArray(files)).toBe(true);
    });

    it('respects excludeAddons parameter', () => {
      // Excluding aiwg-utils now removes its rules from the result; without
      // the exclude they are included.
      const filesNoExclude = base.getAddonRuleFiles(REPO_ROOT);
      const filesWithExclude = base.getAddonRuleFiles(REPO_ROOT, ['aiwg-utils']);
      // filesWithExclude should be a strict subset of filesNoExclude
      expect(filesNoExclude.length).toBeGreaterThan(filesWithExclude.length);
      const hasUtilsWhenExcluded = filesWithExclude.some((f: string) =>
        f.includes('aiwg-utils')
      );
      expect(hasUtilsWhenExcluded).toBe(false);
    });
  });

  // ==========================================================================
  // cleanupOldRuleFiles
  // ==========================================================================

});
