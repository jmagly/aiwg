/**
 * Pattern Library Tests
 *
 * Comprehensive test suite for the PatternLibrary class.
 * Consolidated from 71 tests to ~37 tests while preserving all assertions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PatternLibrary, AIPattern, PatternCategory, PatternSeverity, PatternFilter } from '../../../src/writing/pattern-library.ts';

describe('PatternLibrary', () => {
  let library: PatternLibrary;

  beforeEach(async () => {
    library = new PatternLibrary();
    await library.initialize();
  });

  // ============================================================
  // Pattern Initialization Tests (5 tests)
  // ============================================================

  describe('Pattern Initialization', () => {
    it('should initialize with patterns from all categories and validate schema', () => {
      const count = library.getPatternCount();
      expect(count).toBeGreaterThan(0);
      expect(count).toBeGreaterThanOrEqual(150);

      const counts = library.getPatternCountByCategory();
      expect(counts.size).toBeGreaterThanOrEqual(6);

      const categories: PatternCategory[] = [
        'banned-phrases',
        'formulaic-structures',
        'hedging-language',
        'weak-verbs',
        'generic-adjectives',
        'transition-words'
      ];

      for (const category of categories) {
        const patterns = library.getPatternsByCategory(category);
        expect(patterns.length, `${category} should have patterns`).toBeGreaterThan(0);
      }

      // Validate schema
      const patterns = library.getAllPatterns();
      for (const pattern of patterns) {
        expect(pattern).toHaveProperty('id');
        expect(pattern).toHaveProperty('category');
        expect(pattern).toHaveProperty('pattern');
        expect(pattern).toHaveProperty('severity');
        expect(pattern).toHaveProperty('confidence');
        expect(pattern).toHaveProperty('examples');
        expect(pattern).toHaveProperty('frequency');
        expect(pattern.pattern).toBeInstanceOf(RegExp);
      }
    });

    it('should have unique IDs and valid severity/confidence for all patterns', () => {
      const patterns = library.getAllPatterns();

      // Unique IDs
      const ids = patterns.map(p => p.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);

      // Valid severities
      const validSeverities: PatternSeverity[] = ['critical', 'high', 'medium', 'low', 'warning', 'info'];
      for (const pattern of patterns) {
        expect(validSeverities, `${pattern.id} has invalid severity`).toContain(pattern.severity);
      }

      // Confidence range
      for (const pattern of patterns) {
        expect(pattern.confidence, `${pattern.id} confidence out of range`).toBeGreaterThanOrEqual(0);
        expect(pattern.confidence, `${pattern.id} confidence out of range`).toBeLessThanOrEqual(1);
      }
    });

    it('should not initialize twice', async () => {
      const count1 = library.getPatternCount();
      await library.initialize();
      const count2 = library.getPatternCount();
      expect(count1).toBe(count2);
    });
  });

  // ============================================================
  // Pattern Retrieval Tests (5 tests)
  // ============================================================

  describe('Pattern Retrieval', () => {
    it('should get all patterns, by ID, and return copies', () => {
      const patterns1 = library.getAllPatterns();
      const patterns2 = library.getAllPatterns();

      expect(Array.isArray(patterns1)).toBe(true);
      expect(patterns1.length).toBeGreaterThan(0);
      expect(patterns1).not.toBe(patterns2);
      expect(patterns1.length).toBe(patterns2.length);

      // By ID
      const firstPattern = patterns1[0];
      const retrieved = library.getPatternById(firstPattern.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(firstPattern.id);

      const nonExistent = library.getPatternById('non-existent-id-12345');
      expect(nonExistent).toBeUndefined();
    });

    it('should get patterns by category for all categories', () => {
      const categories: PatternCategory[] = [
        'banned-phrases',
        'formulaic-structures',
        'hedging-language',
        'weak-verbs',
        'generic-adjectives',
        'transition-words'
      ];

      for (const category of categories) {
        const patterns = library.getPatternsByCategory(category);
        expect(patterns.length, `${category} should have patterns`).toBeGreaterThan(0);
        patterns.forEach(p => expect(p.category, `Pattern in ${category} has wrong category`).toBe(category));
      }

      const nonExistent = library.getPatternsByCategory('non-existent' as PatternCategory);
      expect(nonExistent).toEqual([]);
    });

    it('should get patterns by severity and domain', () => {
      const severities: PatternSeverity[] = ['critical', 'high', 'medium', 'low'];
      for (const severity of severities) {
        const patterns = library.getPatternsBySeverity(severity);
        expect(patterns.length, `${severity} severity should have patterns`).toBeGreaterThan(0);
        patterns.forEach(p => expect(p.severity).toBe(severity));
      }

      const domains = ['technical', 'academic', 'executive', 'casual'];
      for (const domain of domains) {
        const patterns = library.getPatternsByDomain(domain);
        expect(patterns.length, `${domain} domain should have patterns`).toBeGreaterThan(0);
      }
    });

    it('should get pattern counts and validate totals', () => {
      const count = library.getPatternCount();
      expect(count).toBeGreaterThan(0);

      const byCategoryCount = library.getPatternCountByCategory();
      expect(byCategoryCount.size).toBeGreaterThan(0);

      let categorySum = 0;
      for (const c of byCategoryCount.values()) {
        categorySum += c;
      }
      expect(categorySum).toBe(count);

      const bySeverityCount = library.getPatternCountBySeverity();
      expect(bySeverityCount.size).toBeGreaterThan(0);

      let severitySum = 0;
      for (const s of bySeverityCount.values()) {
        severitySum += s;
      }
      expect(severitySum).toBe(count);
    });
  });

  // ============================================================
  // Pattern Detection Tests (6 tests)
  // ============================================================

  describe('Pattern Detection', () => {
    it('should detect all pattern categories', () => {
      const testCases: Array<{ category: PatternCategory; text: string }> = [
        { category: 'banned-phrases', text: 'It is important to note that this is seamlessly integrated.' },
        { category: 'formulaic-structures', text: 'Firstly, consider this. Secondly, think about that. In conclusion, both matter.' },
        { category: 'hedging-language', text: 'This may potentially help. It arguably improves things somewhat.' },
        { category: 'weak-verbs', text: 'We utilize resources and leverage infrastructure to facilitate growth.' },
        { category: 'generic-adjectives', text: 'A comprehensive, robust, and innovative solution.' },
        { category: 'transition-words', text: 'Moreover, this works. Furthermore, it scales. Additionally, it is fast.' }
      ];

      for (const { category, text } of testCases) {
        const matches = library.detectPatternsByCategory(text, category);
        expect(matches.length, `Should detect patterns in ${category}`).toBeGreaterThan(0);
        matches.forEach(m => expect(m.pattern.category).toBe(category));
      }
    });

    it('should detect multiple patterns with complete metadata', () => {
      const text = 'It is important to note that we utilize a robust solution. Moreover, it seamlessly integrates.';
      const matches = library.detectPatterns(text);

      expect(matches.length).toBeGreaterThan(3);
      expect(matches[0].pattern).toBeDefined();
      expect(matches[0].pattern.id).toBeTruthy();
      expect(matches[0].severity).toBeTruthy();
      expect(matches[0].position.start).toBeGreaterThanOrEqual(0);
      expect(matches[0].position.end).toBeGreaterThan(matches[0].position.start);
      expect(matches[0].context).toBeTruthy();
    });

    it('should detect only critical patterns', () => {
      const text = 'It is important to note that we use seamless integration. The system is robust.';
      const matches = library.detectCriticalPatterns(text);
      const allMatches = library.detectPatterns(text);

      expect(matches.length).toBeGreaterThan(0);
      matches.forEach(m => expect(m.severity).toBe('critical'));
      expect(matches.length).toBeLessThanOrEqual(allMatches.length);
    });

    it('should handle edge cases, special characters, and boundaries', () => {
      // Empty and clean text
      expect(library.detectPatterns('')).toEqual([]);
      const cleanText = 'We use Redis. Latency dropped from 200ms to 45ms.';
      const cleanMatches = library.detectPatterns(cleanText);
      expect(cleanMatches.length).toBeLessThan(5);

      // Case insensitive
      const upperText = 'IT IS IMPORTANT TO NOTE THAT caching helps.';
      const upperMatches = library.detectPatterns(upperText);
      expect(upperMatches.some(m => m.pattern.id.includes('banned'))).toBe(true);

      // Special characters
      const specialChars = 'It is important to note that: caching helps! (Really?)';
      expect(library.detectPatterns(specialChars).length).toBeGreaterThan(0);

      // Boundaries
      const startText = 'Moreover, caching helps.';
      const startMatches = library.detectPatterns(startText);
      expect(startMatches.some(m => m.position.start === 0)).toBe(true);

      const endText = 'The system works seamlessly';
      expect(library.detectPatterns(endText).length).toBeGreaterThan(0);
    });

    it('should detect patterns in multiline and repeated text', () => {
      const multilineText = `It is important to note that caching helps.
Moreover, it improves performance.
Furthermore, it scales well.`;
      const multilineMatches = library.detectPatterns(multilineText);
      expect(multilineMatches.length).toBeGreaterThan(2);

      // Repeated patterns
      const repeatedText = 'seamlessly integrated, seamlessly deployed, seamlessly scaled';
      const repeatedMatches = library.detectPatterns(repeatedText);
      const seamlessMatches = repeatedMatches.filter(m => m.match.toLowerCase().includes('seamlessly'));
      expect(seamlessMatches.length).toBe(3);

      // Partial words should not match
      const partialText = 'The seam is less visible.';
      const partialMatches = library.detectPatterns(partialText);
      expect(partialMatches.some(m => m.match.toLowerCase().includes('seamlessly'))).toBe(false);
    });
  });

  // ============================================================
  // Pattern Management Tests (5 tests)
  // ============================================================

  describe('Pattern Management', () => {
    it('should add new pattern and retrieve from indices', () => {
      const initialCount = library.getPatternCount();
      const initialCategoryCount = library.getPatternsByCategory('banned-phrases').length;
      const initialSeverityCount = library.getPatternsBySeverity('high').length;

      const newPattern: AIPattern = {
        id: 'test-pattern-001',
        category: 'banned-phrases',
        pattern: /test phrase/gi,
        severity: 'high',
        confidence: 0.85,
        examples: ['This is a test phrase.'],
        frequency: 'rare'
      };

      library.addPattern(newPattern);

      expect(library.getPatternCount()).toBe(initialCount + 1);

      const retrieved = library.getPatternById('test-pattern-001');
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('test-pattern-001');

      expect(library.getPatternsByCategory('banned-phrases').length).toBe(initialCategoryCount + 1);
      expect(library.getPatternsBySeverity('high').length).toBe(initialSeverityCount + 1);
    });

    it('should throw error for duplicate ID', () => {
      const pattern1: AIPattern = {
        id: 'duplicate-id',
        category: 'banned-phrases',
        pattern: /test/gi,
        severity: 'low',
        confidence: 0.65,
        examples: ['Test'],
        frequency: 'rare'
      };

      const pattern2: AIPattern = {
        id: 'duplicate-id',
        category: 'hedging-language',
        pattern: /other/gi,
        severity: 'medium',
        confidence: 0.75,
        examples: ['Other'],
        frequency: 'common'
      };

      library.addPattern(pattern1);
      expect(() => library.addPattern(pattern2)).toThrow('already exists');
    });

    it('should remove pattern, update pattern, and clean up indices', () => {
      const newPattern: AIPattern = {
        id: 'test-pattern-remove',
        category: 'banned-phrases',
        pattern: /remove me/gi,
        severity: 'low',
        confidence: 0.6,
        examples: ['Remove me'],
        frequency: 'rare'
      };

      library.addPattern(newPattern);
      const beforeCount = library.getPatternCount();

      library.removePattern('test-pattern-remove');

      expect(library.getPatternCount()).toBe(beforeCount - 1);
      expect(library.getPatternById('test-pattern-remove')).toBeUndefined();
      expect(() => library.removePattern('non-existent-id')).not.toThrow();

      // Update pattern
      const updatePattern: AIPattern = {
        id: 'test-pattern-update',
        category: 'banned-phrases',
        pattern: /update/gi,
        severity: 'low',
        confidence: 0.6,
        examples: ['Update'],
        frequency: 'rare'
      };

      library.addPattern(updatePattern);
      library.updatePattern('test-pattern-update', { severity: 'critical', confidence: 0.95 });

      const updated = library.getPatternById('test-pattern-update');
      expect(updated?.severity).toBe('critical');
      expect(updated?.confidence).toBe(0.95);
    });

    it('should update pattern indices when changing category and severity', () => {
      const newPattern: AIPattern = {
        id: 'test-pattern-update-indices',
        category: 'banned-phrases',
        pattern: /update/gi,
        severity: 'low',
        confidence: 0.6,
        examples: ['Update'],
        frequency: 'rare'
      };

      library.addPattern(newPattern);

      const beforeHedgingCount = library.getPatternsByCategory('hedging-language').length;
      const beforeCriticalCount = library.getPatternsBySeverity('critical').length;

      library.updatePattern('test-pattern-update-indices', {
        category: 'hedging-language',
        severity: 'critical'
      });

      expect(library.getPatternsByCategory('hedging-language').length).toBe(beforeHedgingCount + 1);
      expect(library.getPatternsBySeverity('critical').length).toBe(beforeCriticalCount + 1);

      const bannedPatterns = library.getPatternsByCategory('banned-phrases');
      expect(bannedPatterns.some(p => p.id === 'test-pattern-update-indices')).toBe(false);

      expect(() => library.updatePattern('non-existent', { severity: 'high' })).toThrow('not found');
    });

    it('should handle pattern lifecycle and optional properties', () => {
      const lifecyclePattern: AIPattern = {
        id: 'test-detect-lifecycle',
        category: 'banned-phrases',
        pattern: /banana phone/gi,
        severity: 'critical',
        confidence: 0.99,
        examples: ['banana phone'],
        frequency: 'rare'
      };

      library.addPattern(lifecyclePattern);

      const text = 'This is a banana phone test.';
      let matches = library.detectPatterns(text);
      expect(matches.some(m => m.pattern.id === 'test-detect-lifecycle')).toBe(true);

      library.removePattern('test-detect-lifecycle');
      matches = library.detectPatterns(text);
      expect(matches.some(m => m.pattern.id === 'test-detect-lifecycle')).toBe(false);

      // Optional properties
      const patterns: AIPattern[] = [
        {
          id: 'test-replacements',
          category: 'banned-phrases',
          pattern: /bad word/gi,
          severity: 'high',
          confidence: 0.9,
          examples: ['bad word'],
          replacements: ['good word', 'better phrase'],
          frequency: 'common'
        },
        {
          id: 'test-domains',
          category: 'banned-phrases',
          pattern: /domain test/gi,
          severity: 'medium',
          confidence: 0.75,
          examples: ['domain test'],
          frequency: 'occasional',
          domains: ['technical', 'academic']
        }
      ];

      for (const pattern of patterns) {
        library.addPattern(pattern);
        const retrieved = library.getPatternById(pattern.id);
        expect(retrieved).toBeDefined();

        if (pattern.replacements) {
          expect(retrieved?.replacements).toEqual(pattern.replacements);
        }
        if (pattern.domains) {
          expect(retrieved?.domains).toEqual(pattern.domains);
        }
      }
    });
  });

  // ============================================================
  // Search and Filter Tests (4 tests)
  // ============================================================

  describe('Search and Filter', () => {
    it('should search patterns by keywords and in replacements', () => {
      const searchTests = [
        { query: 'banned-phrase', checkField: (p: AIPattern) => p.id.includes('banned-phrase') },
        { query: 'formulaic', checkField: (p: AIPattern) => true },
        { query: 'AI', checkField: (p: AIPattern) => true },
        { query: 'caching', checkField: (p: AIPattern) => true }
      ];

      for (const { query, checkField } of searchTests) {
        const results = library.searchPatterns(query);
        expect(results.length, `Should find results for: ${query}`).toBeGreaterThan(0);
      }

      // Case insensitive
      const results1 = library.searchPatterns('IMPORTANT');
      const results2 = library.searchPatterns('important');
      expect(results1.length).toBe(results2.length);

      expect(library.searchPatterns('xyzabc123notfound')).toEqual([]);

      // Replacements search
      const allPatterns = library.getAllPatterns();
      const withReplacements = allPatterns.filter(p => p.replacements && p.replacements.length > 0);

      if (withReplacements.length > 0) {
        const exampleReplacement = withReplacements[0].replacements![0];
        const searchTerm = exampleReplacement.split(' ')[0];
        const results = library.searchPatterns(searchTerm);
        expect(results.length).toBeGreaterThan(0);
      }
    });

    it('should filter patterns by category, severity, and domain', () => {
      // Single category
      let filter: PatternFilter = { categories: ['banned-phrases'] };
      let results = library.filterPatterns(filter);
      expect(results.length).toBeGreaterThan(0);
      results.forEach(p => expect(p.category).toBe('banned-phrases'));

      // Multiple categories
      filter = { categories: ['banned-phrases', 'formulaic-structures'] };
      results = library.filterPatterns(filter);
      expect(results.length).toBeGreaterThan(0);
      results.forEach(p => {
        expect(['banned-phrases', 'formulaic-structures']).toContain(p.category);
      });

      // Severity
      filter = { severities: ['critical', 'high'] };
      results = library.filterPatterns(filter);
      expect(results.length).toBeGreaterThan(0);
      results.forEach(p => {
        expect(['critical', 'high']).toContain(p.severity);
      });

      // Domain
      filter = { domains: ['technical', 'academic'] };
      results = library.filterPatterns(filter);
      expect(results.length).toBeGreaterThan(0);
    });

    it('should filter patterns by confidence range and frequency', () => {
      // Confidence range
      let filter: PatternFilter = { minConfidence: 0.9 };
      let results = library.filterPatterns(filter);
      expect(results.length).toBeGreaterThan(0);
      results.forEach(p => expect(p.confidence).toBeGreaterThanOrEqual(0.9));

      filter = { minConfidence: 0.7, maxConfidence: 0.9 };
      results = library.filterPatterns(filter);
      expect(results.length).toBeGreaterThan(0);
      results.forEach(p => {
        expect(p.confidence).toBeGreaterThanOrEqual(0.7);
        expect(p.confidence).toBeLessThanOrEqual(0.9);
      });

      // Frequency
      filter = { frequencies: ['very-common', 'common'] };
      results = library.filterPatterns(filter);
      expect(results.length).toBeGreaterThan(0);
      results.forEach(p => {
        expect(['very-common', 'common']).toContain(p.frequency);
      });
    });

    it('should filter patterns by combined criteria', () => {
      const filter: PatternFilter = {
        categories: ['banned-phrases'],
        severities: ['critical'],
        minConfidence: 0.9
      };
      const results = library.filterPatterns(filter);
      expect(results.length).toBeGreaterThan(0);
      results.forEach(p => {
        expect(p.category).toBe('banned-phrases');
        expect(p.severity).toBe('critical');
        expect(p.confidence).toBeGreaterThanOrEqual(0.9);
      });

      // Strict filter (may return no results)
      const strictFilter: PatternFilter = {
        minConfidence: 0.999,
        maxConfidence: 1.0,
        severities: ['critical'],
        frequencies: ['rare']
      };
      const strictResults = library.filterPatterns(strictFilter);
      expect(Array.isArray(strictResults)).toBe(true);
    });
  });

  // ============================================================
  // Export/Import Tests (4 tests)
  // ============================================================

  describe('Export/Import', () => {
    it('should export patterns in all formats', () => {
      // JSON
      const json = library.exportPatterns('json');
      expect(json).toBeTruthy();
      expect(typeof json).toBe('string');

      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(library.getPatternCount());

      // YAML
      const yamlStr = library.exportPatterns('yaml');
      expect(yamlStr).toBeTruthy();
      expect(typeof yamlStr).toBe('string');
      expect(yamlStr.includes('id:')).toBe(true);

      // Markdown
      const md = library.exportPatterns('markdown');
      expect(md).toBeTruthy();
      expect(typeof md).toBe('string');
      expect(md.includes('#')).toBe(true);
      expect(md.includes('Total Patterns:')).toBe(true);
      expect(md.includes('banned-phrases')).toBe(true);

      expect(() => library.exportPatterns('xml' as any)).toThrow('Unsupported');
    });

    it('should import patterns from JSON and YAML', () => {
      // JSON import
      const newPatterns: AIPattern[] = [
        {
          id: 'import-test-001',
          category: 'banned-phrases',
          pattern: 'import test',
          severity: 'medium',
          confidence: 0.75,
          examples: ['import test'],
          frequency: 'rare'
        }
      ];

      const json = JSON.stringify(newPatterns);
      const beforeCount = library.getPatternCount();

      library.importPatterns(json, 'json');

      expect(library.getPatternCount()).toBeGreaterThan(beforeCount);
      const imported = library.getPatternById('import-test-001');
      expect(imported).toBeDefined();
      expect(imported?.pattern).toBeInstanceOf(RegExp);

      // YAML import
      const yamlStr = `
- id: import-test-yaml-001
  category: banned-phrases
  pattern: yaml test
  severity: high
  confidence: 0.85
  examples:
    - yaml test
  frequency: occasional
`;

      const beforeYamlCount = library.getPatternCount();
      library.importPatterns(yamlStr, 'yaml');

      expect(library.getPatternCount()).toBeGreaterThan(beforeYamlCount);
      const yamlImported = library.getPatternById('import-test-yaml-001');
      expect(yamlImported).toBeDefined();
    });

    it('should handle import edge cases', () => {
      // Skip duplicate IDs
      const existingPattern = library.getAllPatterns()[0];
      const duplicatePatterns: AIPattern[] = [{
        id: existingPattern.id,
        category: 'banned-phrases',
        pattern: 'duplicate',
        severity: 'low',
        confidence: 0.5,
        examples: ['duplicate'],
        frequency: 'rare'
      }];

      const beforeCount = library.getPatternCount();
      library.importPatterns(JSON.stringify(duplicatePatterns), 'json');
      expect(library.getPatternCount()).toBe(beforeCount);

      // Unsupported format
      expect(() => library.importPatterns('data', 'xml' as any)).toThrow('Unsupported');

      // Malformed JSON
      expect(() => library.importPatterns('{invalid json}', 'json')).toThrow();

      // Empty library
      const emptyLibrary = new PatternLibrary();
      const emptyJson = emptyLibrary.exportPatterns('json');
      expect(JSON.parse(emptyJson)).toEqual([]);
    });

    it.each(['json', 'yaml'] as const)('should export and re-import without loss (%s)', (format) => {
      const text = 'It is important to note that we utilize a robust solution.';
      const expectedMatches = library.detectPatterns(text);
      expect(expectedMatches.length).toBeGreaterThan(0);
      const restored = new PatternLibrary();
      restored.importPatterns(library.exportPatterns(format), format);

      expect(restored.getPatternCount()).toBe(library.getPatternCount());
      expect(restored.getAllPatterns()).toEqual(library.getAllPatterns());
      for (const pattern of library.getAllPatterns()) {
        const regex = restored.getPatternById(pattern.id)!.pattern as RegExp;
        expect(regex).toBeInstanceOf(RegExp);
        expect(regex.source).toBe((pattern.pattern as RegExp).source);
        expect(regex.flags).toBe((pattern.pattern as RegExp).flags);
      }
      expect(restored.detectPatterns(text)).toEqual(expectedMatches);
      expect(restored.detectPatterns(text)).toEqual(expectedMatches);
    });

    it.each([{}, { source: '[', flags: 'g' }, { source: 'ok', flags: 'gg' },
      { source: 12, flags: 'g' }, { source: 'ok' }])('rejects malformed regex envelopes atomically: %j', (invalid) => {
      const before = library.getAllPatterns();
      const template = before[0];
      expect(() => library.importPatterns(JSON.stringify([
        { ...template, id: 'staged-valid', pattern: 'legacy phrase' },
        { ...template, id: 'staged-invalid', pattern: invalid }
      ]), 'json')).toThrow();
      expect(library.getAllPatterns()).toEqual(before);
      expect(library.getPatternById('staged-valid')).toBeUndefined();
    });
  });

  // ============================================================
  // Analysis Tests (5 tests)
  // ============================================================

  describe('Analysis', () => {
    it('should analyze text and return complete statistics', () => {
      const text = 'It is important to note that we utilize a robust solution. Moreover, it works seamlessly.';
      const analysis = library.analyzeText(text);

      expect(analysis.totalMatches).toBeGreaterThan(0);
      expect(analysis.wordCount).toBeGreaterThan(0);
      expect(analysis.uniquePatterns).toBeGreaterThan(0);
      expect(analysis.averageConfidence).toBeGreaterThan(0);
      expect(analysis.averageConfidence).toBeLessThanOrEqual(1);
      expect(analysis.patternDensity).toBeGreaterThan(0);
    });

    it('should count matches by category and severity with correct totals', () => {
      const text = 'It is important to note that this works. Moreover, we use it. Firstly, it is fast.';
      const analysis = library.analyzeText(text);

      expect(analysis.matchesByCategory.size).toBeGreaterThan(0);
      expect(analysis.matchesBySeverity.size).toBeGreaterThan(0);

      // Verify category totals
      let totalCategoryMatches = 0;
      for (const count of analysis.matchesByCategory.values()) {
        totalCategoryMatches += count;
      }
      expect(totalCategoryMatches).toBe(analysis.totalMatches);

      // Verify severity totals
      let totalSeverityMatches = 0;
      for (const count of analysis.matchesBySeverity.values()) {
        totalSeverityMatches += count;
      }
      expect(totalSeverityMatches).toBe(analysis.totalMatches);

      // Critical and high priority
      expect(analysis.criticalMatches.length).toBeGreaterThan(0);
      analysis.criticalMatches.forEach(m => expect(m.severity).toBe('critical'));
      expect(analysis.highPriorityMatches.length).toBeGreaterThan(0);
    });

    it('should calculate word count, pattern density, and unique patterns', () => {
      const text1 = 'This is a test sentence with exactly ten words here.';
      const analysis1 = library.analyzeText(text1);
      expect(analysis1.wordCount).toBe(10);

      const text2 = 'It is important to note that.';
      const analysis2 = library.analyzeText(text2);
      expect(analysis2.wordCount).toBe(6);

      const expectedDensity = (analysis2.totalMatches / analysis2.wordCount) * 100;
      expect(analysis2.patternDensity).toBeCloseTo(expectedDensity, 2);

      // Unique patterns
      const text3 = 'seamlessly integrated, seamlessly deployed';
      const analysis3 = library.analyzeText(text3);
      expect(analysis3.uniquePatterns).toBeLessThanOrEqual(analysis3.totalMatches);

      const matches = library.detectPatterns(text3);
      expect(analysis3.totalMatches).toBe(matches.length);
    });

    it('should handle empty text and clean text', () => {
      const cleanText = 'Quick brown fox jumps over lazy dog.';
      const cleanAnalysis = library.analyzeText(cleanText);
      expect(cleanAnalysis.totalMatches).toBeLessThan(5);
      expect(cleanAnalysis.wordCount).toBe(7);

      const emptyAnalysis = library.analyzeText('');
      expect(emptyAnalysis.totalMatches).toBe(0);
      expect(emptyAnalysis.wordCount).toBe(0);
      expect(emptyAnalysis.patternDensity).toBe(0);
    });

    it('should compare texts and identify removed, added, and persistent patterns', () => {
      const text1 = 'It is important to note that this works seamlessly.';
      const text2 = 'This works well.';
      const comparison = library.compareTexts(text1, text2);

      expect(comparison.text1Matches).toBeGreaterThan(comparison.text2Matches);
      expect(comparison.improvement).toBeGreaterThan(0);
      expect(comparison.improvement).toBeGreaterThan(50);

      // Removed patterns
      expect(comparison.removedPatterns.length).toBeGreaterThan(0);

      // Added patterns
      const text3 = 'This works well.';
      const text4 = 'It is important to note that this works.';
      const comparison2 = library.compareTexts(text3, text4);
      expect(comparison2.addedPatterns.length).toBeGreaterThan(0);

      // Persistent patterns
      const text5 = 'It is important to note that we use Redis.';
      const text6 = 'It is important to note that we use PostgreSQL.';
      const comparison3 = library.compareTexts(text5, text6);
      expect(comparison3.persistentPatterns.length).toBeGreaterThan(0);

      // Edge cases
      const sameComparison = library.compareTexts(text1, text1);
      expect(sameComparison.improvement).toBe(0);
      expect(sameComparison.addedPatterns.length).toBe(0);
      expect(sameComparison.removedPatterns.length).toBe(0);

      const cleanText = 'This works well.';
      const dirtyText = 'It is important to note that this is seamlessly integrated.';
      const regression = library.compareTexts(cleanText, dirtyText);
      expect(regression.improvement).toBeLessThanOrEqual(0);
    });
  });

  // ============================================================
  // Performance Tests (3 tests)
  // ============================================================

  describe('Performance', () => {
    it('should detect patterns quickly for various text sizes', () => {
      // 1000-word text
      const text1k = 'It is important to note that caching improves performance. '.repeat(150);
      const start1k = Date.now();
      library.detectPatterns(text1k);
      expect(Date.now() - start1k).toBeLessThan(100);

      // 10k-word text
      const text10k = 'It is important to note that caching helps. '.repeat(1000);
      const start10k = Date.now();
      library.detectPatterns(text10k);
      expect(Date.now() - start10k).toBeLessThan(1000);

      // Initialize quickly
      const newLibrary = new PatternLibrary();
      const initStart = Date.now();
      newLibrary.initialize();
      expect(Date.now() - initStart).toBeLessThan(200);

      // Concurrent operations
      const texts = [
        'It is important to note that this works.',
        'Moreover, caching helps performance.',
        'Firstly, consider scalability.'
      ];

      const concurrentStart = Date.now();
      for (const text of texts) {
        library.detectPatterns(text);
      }
      expect(Date.now() - concurrentStart).toBeLessThan(50);
    });

    it('should perform search, filter, analyze, and compare operations quickly', () => {
      // Filter
      const filterStart = Date.now();
      library.filterPatterns({
        categories: ['banned-phrases'],
        severities: ['critical'],
        minConfidence: 0.9
      });
      expect(Date.now() - filterStart).toBeLessThan(10);

      // Search
      const searchStart = Date.now();
      library.searchPatterns('important');
      expect(Date.now() - searchStart).toBeLessThan(10);

      // Analyze
      const analyzeStart = Date.now();
      library.analyzeText('It is important to note that this works seamlessly. Moreover, it scales.');
      expect(Date.now() - analyzeStart).toBeLessThan(50);

      // Compare
      const compareStart = Date.now();
      library.compareTexts(
        'It is important to note that this works.',
        'This works well.'
      );
      expect(Date.now() - compareStart).toBeLessThan(50);
    });

    it('should export and maintain performance with added patterns', () => {
      // Export
      const exportStart = Date.now();
      library.exportPatterns('json');
      expect(Date.now() - exportStart).toBeLessThan(100);

      // Add 100 patterns and test
      for (let i = 0; i < 100; i++) {
        library.addPattern({
          id: `perf-test-${i}`,
          category: 'banned-phrases',
          pattern: new RegExp(`perftest${i}`, 'gi'),
          severity: 'low',
          confidence: 0.5,
          examples: [`perftest${i}`],
          frequency: 'rare'
        });
      }

      const text = 'It is important to note that this works.';
      const detectStart = Date.now();
      library.detectPatterns(text);
      expect(Date.now() - detectStart).toBeLessThan(100);
    });
  });
});
