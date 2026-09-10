/**
 * Traceability Checker Tests
 * Comprehensive test suite for requirements traceability system
 *
 * Test Coverage:
 * - ID extraction (consolidated)
 * - Link building
 * - Orphan detection
 * - Coverage analysis
 * - Matrix generation
 * - Reporting
 * - Validation
 * - Maintenance
 *
 * Target: 35-45 tests, >85% coverage
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDExtractor } from '../../../src/traceability/id-extractor.ts';
import { MatrixGenerator } from '../../../src/traceability/matrix-generator.ts';
import { TraceabilityChecker } from '../../../src/traceability/traceability-checker.ts';
import { FilesystemSandbox } from '../../../src/testing/mocks/filesystem-sandbox.ts';

describe('IDExtractor', () => {
  let extractor: IDExtractor;

  beforeEach(() => {
    extractor = new IDExtractor();
  });

  describe('extractFromLine', () => {
    it('should extract all ID types from lines', () => {
      const testCases = [
        { line: '// Implements UC-001: Validate AI-Generated Content', expectedId: 'UC-001', expectedType: 'use-case' },
        { line: '// NFR-PERF-001: Context loading <5s', expectedId: 'NFR-PERF-001', expectedType: 'nfr' },
        { line: '// Covers: US-042', expectedId: 'US-042', expectedType: 'user-story' },
        { line: '// Feature F-005: Requirements Traceability', expectedId: 'F-005', expectedType: 'feature' },
        { line: '// AC-012: Must complete within 5 seconds', expectedId: 'AC-012', expectedType: 'acceptance-criteria' },
      ];

      for (const { line, expectedId, expectedType } of testCases) {
        const ids = extractor.extractFromLine(line, 1);
        expect(ids, `failed for: ${line}`).toHaveLength(1);
        expect(ids[0].id, `wrong id for: ${line}`).toBe(expectedId);
        expect(ids[0].type, `wrong type for: ${line}`).toBe(expectedType);
        expect(ids[0].lineNumber).toBe(1);
      }
    });

    it('should extract multiple IDs from one line', () => {
      const line = '// @traceability UC-001, NFR-ACC-001, F-003';
      const ids = extractor.extractFromLine(line);

      expect(ids).toHaveLength(3);
      expect(ids[0].id).toBe('UC-001');
      expect(ids[1].id).toBe('NFR-ACC-001');
      expect(ids[2].id).toBe('F-003');
    });

    it('should deduplicate IDs on same line', () => {
      const line = '// UC-001 and UC-001 again';
      const ids = extractor.extractFromLine(line);

      expect(ids).toHaveLength(1);
      expect(ids[0].id).toBe('UC-001');
    });

    it('should extract context around ID', () => {
      const line = '// This function implements UC-001 for validation';
      const ids = extractor.extractFromLine(line);

      expect(ids[0].context).toContain('UC-001');
      expect(ids[0].context).toContain('implements');
    });

    it('should handle lines without IDs and test descriptions', () => {
      const noIdLine = '// Just a regular comment';
      expect(extractor.extractFromLine(noIdLine)).toHaveLength(0);

      const testLine = `  it('should validate UC-001: AI Pattern Detection', () => {`;
      const ids = extractor.extractFromLine(testLine);
      expect(ids).toHaveLength(1);
      expect(ids[0].id).toBe('UC-001');
    });
  });

  describe('extractFromContent', () => {
    it('should extract IDs from multiline content', () => {
      const content = `
/**
 * ValidationEngine - Implements UC-001
 * Performance target: NFR-PERF-001
 * Accuracy target: NFR-ACC-001
 */
export class ValidationEngine {
  // Covers: F-001
}
      `.trim();

      const ids = extractor.extractFromContent(content);

      expect(ids.length).toBeGreaterThanOrEqual(4);
      expect(ids.map(id => id.id)).toContain('UC-001');
      expect(ids.map(id => id.id)).toContain('NFR-PERF-001');
      expect(ids.map(id => id.id)).toContain('NFR-ACC-001');
      expect(ids.map(id => id.id)).toContain('F-001');
    });

    it('should deduplicate IDs across lines', () => {
      const content = `
// UC-001
// UC-001 again
// UC-001 third time
      `.trim();

      const ids = extractor.extractFromContent(content);

      expect(ids).toHaveLength(1);
      expect(ids[0].id).toBe('UC-001');
    });

    it('should preserve line numbers', () => {
      const content = `Line 1
Line 2
// UC-001 on line 3
Line 4`;

      const ids = extractor.extractFromContent(content);

      expect(ids[0].lineNumber).toBe(3);
    });

    it('should handle empty content and content with no IDs', () => {
      expect(extractor.extractFromContent('')).toHaveLength(0);

      const noIdContent = `
export class Foo {
  bar() {
    return 42;
  }
}
      `.trim();

      expect(extractor.extractFromContent(noIdContent)).toHaveLength(0);
    });
  });

  describe('extractFromFiles', () => {
    it('should extract IDs from multiple files in parallel', async () => {
      const files = new Map<string, string>();
      files.set('file1.ts', '// UC-001: First file');
      files.set('file2.ts', '// UC-002: Second file\n// NFR-PERF-001: Performance');
      files.set('file3.ts', '// F-003: Third file');

      const results = await extractor.extractFromFiles(files);

      expect(results.size).toBe(3);
      expect(results.get('file1.ts')?.ids).toHaveLength(1);
      expect(results.get('file2.ts')?.ids).toHaveLength(2);
      expect(results.get('file3.ts')?.ids).toHaveLength(1);
    });

    it('should track extraction time per file', async () => {
      const files = new Map<string, string>();
      files.set('file1.ts', '// UC-001');

      const results = await extractor.extractFromFiles(files);
      const result = results.get('file1.ts')!;

      expect(result.extractionTime).toBeGreaterThan(0);
    });

    it('should handle empty file map', async () => {
      const files = new Map<string, string>();
      const results = await extractor.extractFromFiles(files);

      expect(results.size).toBe(0);
    });
  });

  describe('isValidId', () => {
    it('should validate all ID types and formats', () => {
      const validCases = [
        { id: 'UC-001', type: 'use-case' },
        { id: 'UC-999', type: 'use-case' },
        { id: 'NFR-PERF-001', type: 'nfr' },
        { id: 'NFR-SECURITY-999', type: 'nfr' },
        { id: 'US-001', type: 'user-story' },
        { id: 'F-001', type: 'feature' },
      ];

      for (const { id, type } of validCases) {
        expect(extractor.isValidId(id), `should be valid: ${id} (${type})`).toBe(true);
      }

      const invalidCases = [
        'UC-1',       // Too short
        'UC-1234',    // Too long
        'NFR-P-001',  // NFR category too short
        'NFR-VERYLONGCATEGORY-001', // NFR category too long
        'US-1',       // US number too short
        'F-1',        // Feature number too short
        'invalid',    // No format match
        'UC001',      // Missing dash
        'UC-',        // Missing number
      ];

      for (const id of invalidCases) {
        expect(extractor.isValidId(id), `should be invalid: ${id}`).toBe(false);
      }
    });
  });

  describe('parseId', () => {
    it('should parse all ID formats correctly', () => {
      const testCases = [
        { id: 'UC-001', expected: { prefix: 'UC', number: '001' } },
        { id: 'NFR-PERF-001', expected: { prefix: 'NFR', category: 'PERF', number: '001' } },
        { id: 'NFR-SECURITY-999', expected: { prefix: 'NFR', category: 'SECURITY', number: '999' } },
        { id: 'US-042', expected: { prefix: 'US', number: '042' } },
        { id: 'F-005', expected: { prefix: 'F', number: '005' } },
        { id: 'INVALID', expected: null },
      ];

      for (const { id, expected } of testCases) {
        const parsed = extractor.parseId(id);
        expect(parsed, `parse failed for: ${id}`).toEqual(expected);
      }
    });
  });
});

describe('MatrixGenerator', () => {
  let generator: MatrixGenerator;

  beforeEach(() => {
    generator = new MatrixGenerator();
  });

  describe('generateMatrix', () => {
    it('should generate matrix from links', () => {
      const requirements = ['UC-001', 'UC-002'];
      const codeFiles = ['src/engine.ts'];
      const testFiles = ['test/engine.test.ts'];
      const links = new Map([
        ['UC-001', { code: ['src/engine.ts'], tests: ['test/engine.test.ts'] }],
        ['UC-002', { code: [], tests: [] }]
      ]);

      const matrix = generator.generateMatrix(requirements, codeFiles, testFiles, links);

      expect(matrix.requirements).toEqual(requirements);
      expect(matrix.code).toEqual(codeFiles);
      expect(matrix.tests).toEqual(testFiles);
      expect(matrix.links).toHaveLength(2);
    });

    it('should mark linked and unlinked cells correctly', () => {
      const requirements = ['UC-001'];
      const codeFiles = ['src/engine.ts'];
      const testFiles = ['test/engine.test.ts'];

      // Test with links
      const withLinks = new Map([
        ['UC-001', { code: ['src/engine.ts'], tests: ['test/engine.test.ts'] }]
      ]);
      const matrixLinked = generator.generateMatrix(requirements, codeFiles, testFiles, withLinks);
      const rowLinked = matrixLinked.links[0];

      const codeCellLinked = rowLinked.find(cell => cell.itemType === 'code');
      const testCellLinked = rowLinked.find(cell => cell.itemType === 'test');

      expect(codeCellLinked?.linked).toBe(true);
      expect(testCellLinked?.linked).toBe(true);

      // Test without links
      const withoutLinks = new Map([['UC-001', { code: [], tests: [] }]]);
      const matrixUnlinked = generator.generateMatrix(requirements, codeFiles, testFiles, withoutLinks);
      const rowUnlinked = matrixUnlinked.links[0];

      const codeCellUnlinked = rowUnlinked.find(cell => cell.itemType === 'code');
      const testCellUnlinked = rowUnlinked.find(cell => cell.itemType === 'test');

      expect(codeCellUnlinked?.linked).toBe(false);
      expect(testCellUnlinked?.linked).toBe(false);
    });
  });

  describe('export formats', () => {
    const createTestMatrix = (itemPath = 'src/engine.ts') => ({
      requirements: ['UC-001'],
      code: [itemPath],
      tests: ['test/engine.test.ts'],
      links: [
        [
          {
            requirementId: 'UC-001',
            itemPath,
            itemType: 'code' as const,
            linked: true,
            verified: true,
            confidence: 1.0
          },
          {
            requirementId: 'UC-001',
            itemPath: 'test/engine.test.ts',
            itemType: 'test' as const,
            linked: true,
            verified: true,
            confidence: 1.0
          }
        ]
      ]
    });

    it('should export to CSV with proper escaping and optional columns', () => {
      const matrix = createTestMatrix();
      const csv = generator.exportToCSV(matrix);

      expect(csv).toContain('Requirement');
      expect(csv).toContain('UC-001');
      expect(csv).toContain('src/engine.ts');
      expect(csv).toContain('test/engine.test.ts');

      // Test CSV escaping
      const matrixWithCommas = createTestMatrix('src/file,with,commas.ts');
      const csvEscaped = generator.exportToCSV(matrixWithCommas);
      expect(csvEscaped).toContain('"src/file,with,commas.ts"');

      // Test optional columns
      const csvWithVerification = generator.exportToCSV(matrix, { format: 'csv', includeVerification: true });
      expect(csvWithVerification).toContain('Verified');

      const csvWithConfidence = generator.exportToCSV(matrix, { format: 'csv', includeConfidence: true });
      expect(csvWithConfidence).toContain('Confidence');
    });

    it('should export to Markdown with coverage indicators', () => {
      const matrix = createTestMatrix();
      const md = generator.exportToMarkdown(matrix);

      expect(md).toContain('# Traceability Matrix');
      expect(md).toContain('**UC-001**');
      expect(md).toContain('src/engine.ts');
      expect(md).toContain('test/engine.test.ts');
      expect(md).toMatch(/[✅⚠️❌]/);

      // Test missing links
      const emptyMatrix = { requirements: ['UC-001'], code: [], tests: [], links: [[]] };
      const mdEmpty = generator.exportToMarkdown(emptyMatrix);
      expect(mdEmpty).toContain('*NONE*');
    });

    it('should export to HTML with CSS and entity escaping', () => {
      const matrix = createTestMatrix();
      const html = generator.exportToHTML(matrix);

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<title>Traceability Matrix</title>');
      expect(html).toContain('UC-001');
      expect(html).toContain('src/engine.ts');
      expect(html).toContain('<style>');
      expect(html).toContain('coverage-high');

      // Test HTML entity escaping
      const matrixWithScript = createTestMatrix('src/<script>.ts');
      const htmlEscaped = generator.exportToHTML(matrixWithScript);
      expect(htmlEscaped).toContain('&lt;script&gt;');
      expect(htmlEscaped).not.toContain('<script>');
    });

    it('should export to Excel (TSV)', () => {
      const matrix = createTestMatrix('src/file,with\ttab"and\nnewline.ts');
      const tsv = generator.exportToExcel(matrix, { format: 'excel', includeVerification: true, includeConfidence: true });

      expect(tsv).toContain('\t');
      expect(tsv).toContain('file,with');
      expect(tsv).toContain('""and');

      const logicalRows = tsv.match(/(?:[^"\n]|"(?:[^"]|"")*")+(?:\n|$)/g) ?? [];
      expect(logicalRows).toHaveLength(2);
      const countFields = (row: string) => {
        let fields = 1;
        let quoted = false;
        for (let i = 0; i < row.length; i++) {
          if (row[i] === '"' && row[i + 1] === '"') i++;
          else if (row[i] === '"') quoted = !quoted;
          else if (row[i] === '\t' && !quoted) fields++;
        }
        return fields;
      };
      expect(countFields(logicalRows[0])).toBe(7);
      expect(countFields(logicalRows[1])).toBe(7);
    });
  });
});

describe('TraceabilityChecker', () => {
  let sandbox: FilesystemSandbox;
  let checker: TraceabilityChecker;

  beforeEach(async () => {
    sandbox = new FilesystemSandbox();
    await sandbox.initialize();
    checker = new TraceabilityChecker(sandbox.getPath());
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  describe('scanRequirements', () => {
    it('should scan requirements directory and extract all ID types', async () => {
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.writeFile(
        '.aiwg/requirements/use-cases.md',
        `# UC-001: Validate AI-Generated Content

**Priority**: P0

Validate content against AI patterns.
`
      );
      await sandbox.writeFile(
        '.aiwg/requirements/nfrs.md',
        `# NFR-PERF-001: Context Loading Performance

**Priority**: P0

Context loading must complete in <5s for 95% of requests.
`
      );

      const requirements = await checker.scanRequirements();

      expect(requirements.size).toBeGreaterThan(0);
      expect(requirements.has('UC-001')).toBe(true);
      expect(requirements.has('NFR-PERF-001')).toBe(true);

      const uc001 = requirements.get('UC-001')!;
      expect(uc001.type).toBe('use-case');
      expect(uc001.priority).toBe('P0');

      const nfr = requirements.get('NFR-PERF-001')!;
      expect(nfr.type).toBe('nfr');
    });

    it('should process YAML files', async () => {
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.writeFile(
        '.aiwg/requirements/requirements.yaml',
        `requirements:
  - id: UC-002
    title: Deploy Agent
    priority: P0
`
      );

      const requirements = await checker.scanRequirements();
      expect(requirements.has('UC-002')).toBe(true);
    });

    it('should handle missing requirements directory', async () => {
      const requirements = await checker.scanRequirements();
      expect(requirements.size).toBe(0);
    });
  });

  describe('scanCode', () => {
    it('should scan code directory and track line numbers', async () => {
      await sandbox.createDirectory('src');
      await sandbox.writeFile(
        'src/engine.ts',
        `Line 1
Line 2
// UC-001
Line 4
/**
 * ValidationEngine - Implements UC-001
 * NFR-PERF-001: Context loading <5s
 */
export class ValidationEngine {
  // Implementation
}
`
      );

      const codeRefs = await checker.scanCode();

      expect(codeRefs.size).toBeGreaterThan(0);
      const engineRef = Array.from(codeRefs.values())[0];
      expect(engineRef.requirementIds).toContain('UC-001');
      expect(engineRef.requirementIds).toContain('NFR-PERF-001');
      expect(engineRef.lineNumbers[0]).toBe(3);
    });

    it('should ignore test files and handle missing directory', async () => {
      await sandbox.createDirectory('src');
      await sandbox.writeFile('src/engine.test.ts', '// UC-001');

      const codeRefs = await checker.scanCode();
      expect(codeRefs.size).toBe(0);

      // Clean up and test missing directory
      await sandbox.cleanup();
      await sandbox.initialize();
      const checker2 = new TraceabilityChecker(sandbox.getPath());
      const codeRefs2 = await checker2.scanCode();
      expect(codeRefs2.size).toBe(0);
    });
  });

  describe('scanTests', () => {
    it('should scan test directory and extract test names', async () => {
      await sandbox.createDirectory('test');
      await sandbox.writeFile(
        'test/engine.test.ts',
        `describe('UC-001: AI Pattern Detection', () => {
  it('should detect banned phrases (NFR-ACC-001)', () => {
    // Test implementation
  });
});
it('should validate UC-001', () => {});
it('should handle errors', () => {});
`
      );

      const testRefs = await checker.scanTests();

      expect(testRefs.size).toBeGreaterThan(0);
      const engineTest = Array.from(testRefs.values())[0];
      expect(engineTest.requirementIds).toContain('UC-001');
      expect(engineTest.requirementIds).toContain('NFR-ACC-001');
      expect(engineTest.testNames).toContain('should validate UC-001');
      expect(engineTest.testNames).toContain('should handle errors');
    });

    it('should handle missing test directory', async () => {
      const testRefs = await checker.scanTests();
      expect(testRefs.size).toBe(0);
    });
  });

  describe('scanAll', () => {
    it('should scan all directories in parallel', async () => {
      // Create test structure
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.createDirectory('src');
      await sandbox.createDirectory('test');

      await sandbox.writeFile('.aiwg/requirements/uc.md', '# UC-001');
      await sandbox.writeFile('src/engine.ts', '// UC-001');
      await sandbox.writeFile('test/engine.test.ts', '// UC-001');

      const result = await checker.scanAll();

      expect(result.requirements.size).toBeGreaterThan(0);
      expect(result.code.size).toBeGreaterThan(0);
      expect(result.tests.size).toBeGreaterThan(0);
      expect(result.scanTime).toBeGreaterThan(0);
    });

    it.skipIf(!process.env.RUN_PERF_TESTS)('should complete scan in <1min for 1000 files (NFR-TRACE-001)', async () => {
      // Create 1000 small files
      await sandbox.createDirectory('src');
      for (let i = 0; i < 1000; i++) {
        await sandbox.writeFile(`src/file${i}.ts`, `// UC-${String(i % 100).padStart(3, '0')}`);
      }

      const startTime = performance.now();
      await checker.scanAll();
      const scanTime = performance.now() - startTime;

      // Should complete in <60s (60000ms)
      expect(scanTime).toBeLessThan(60000);
    });
  });

  describe('buildTraceabilityLinks', () => {
    it('should build links and calculate coverage metrics', async () => {
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.createDirectory('src');
      await sandbox.createDirectory('test');

      await sandbox.writeFile('.aiwg/requirements/uc.md', '# UC-001\n**Priority**: P0');
      await sandbox.writeFile('src/engine.ts', '// Implements UC-001');
      await sandbox.writeFile('test/engine.test.ts', '// Tests UC-001');

      await checker.scanAll();
      const links = await checker.buildTraceabilityLinks();

      expect(links.has('UC-001')).toBe(true);
      const link = links.get('UC-001')!;
      expect(link.linkedItems.length).toBeGreaterThan(0);
      expect(link.coverage.hasCode).toBe(true);
      expect(link.coverage.hasTests).toBe(true);
      expect(link.coverage.completeness).toBeGreaterThan(0);
    });

    it('should handle requirements without code', async () => {
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.writeFile('.aiwg/requirements/uc.md', '# UC-999');

      await checker.scanAll();
      const links = await checker.buildTraceabilityLinks();
      const link = links.get('UC-999')!;

      expect(link.coverage.hasCode).toBe(false);
      expect(link.coverage.hasTests).toBe(false);
    });
  });

  describe('detectOrphans', () => {
    it('should detect orphaned requirements, code, and tests with severity', async () => {
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.writeFile('.aiwg/requirements/p0.md', '# UC-001\n**Priority**: P0');
      await sandbox.writeFile('.aiwg/requirements/p1.md', '# UC-002\n**Priority**: P1');
      await sandbox.writeFile('.aiwg/requirements/p2.md', '# UC-003\n**Priority**: P2');

      await sandbox.createDirectory('src');
      await sandbox.writeFile('src/orphan.ts', 'export class Orphan {}');

      await sandbox.createDirectory('test');
      await sandbox.writeFile('test/orphan.test.ts', "it('orphaned test', () => {});");

      await checker.scanAll();
      const orphans = await checker.detectOrphans();

      expect(orphans.orphanedRequirements).toContain('UC-001');
      expect(orphans.orphanedCode.length).toBeGreaterThan(0);
      expect(orphans.orphanedTests.length).toBeGreaterThan(0);

      expect(orphans.severity.get('UC-001')).toBe('critical');
      expect(orphans.severity.get('UC-002')).toBe('warning');
      expect(orphans.severity.get('UC-003')).toBe('info');
    });
  });

  describe('calculateCoverage', () => {
    it('should calculate overall, by-type, and by-priority coverage', async () => {
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.createDirectory('src');
      await sandbox.createDirectory('test');

      await sandbox.writeFile('.aiwg/requirements/uc1.md', '# UC-001');
      await sandbox.writeFile('.aiwg/requirements/uc2.md', '# UC-002');
      await sandbox.writeFile('.aiwg/requirements/nfr.md', '# NFR-PERF-001');
      await sandbox.writeFile('.aiwg/requirements/p0.md', '# UC-003\n**Priority**: P0');

      await sandbox.writeFile('src/engine.ts', '// UC-001\n// UC-003');
      await sandbox.writeFile('test/engine.test.ts', '// UC-001\n// UC-003');

      await checker.scanAll();
      const coverage = await checker.calculateCoverage();

      // 2 out of 4 requirements traced = 50%
      expect(coverage.percentage).toBe(50);
      expect(coverage.byType.has('use-case')).toBe(true);
      expect(coverage.byType.has('nfr')).toBe(true);
      expect(coverage.byPriority.has('P0')).toBe(true);
      expect(coverage.byPriority.get('P0')).toBe(100);
    });

    it('should identify gaps', async () => {
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.writeFile('.aiwg/requirements/uc.md', '# UC-001');

      await checker.scanAll();
      const coverage = await checker.calculateCoverage();

      expect(coverage.gaps.requirementsWithoutCode).toContain('UC-001');
      expect(coverage.gaps.requirementsWithoutTests).toContain('UC-001');
    });
  });

  describe('generateMatrix', () => {
    it('should generate traceability matrix', async () => {
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.createDirectory('src');
      await sandbox.createDirectory('test');

      await sandbox.writeFile('.aiwg/requirements/uc.md', '# UC-001');
      await sandbox.writeFile('src/engine.ts', '// UC-001');
      await sandbox.writeFile('test/engine.test.ts', '// UC-001');

      await checker.scanAll();
      const matrix = await checker.generateMatrix();

      expect(matrix.requirements).toContain('UC-001');
      expect(matrix.links.length).toBeGreaterThan(0);
    });

    it.skipIf(!process.env.RUN_PERF_TESTS)('should generate matrix in <30s for 1000 requirements (NFR-TRACE-05)', async () => {
      // Create 1000 requirements
      await sandbox.createDirectory('.aiwg/requirements');
      for (let i = 0; i < 1000; i++) {
        await sandbox.writeFile(
          `.aiwg/requirements/uc${i}.md`,
          `# UC-${String(i).padStart(3, '0')}`
        );
      }

      await checker.scanAll();

      const startTime = performance.now();
      await checker.generateMatrix();
      const genTime = performance.now() - startTime;

      // Should complete in <30s (30000ms)
      expect(genTime).toBeLessThan(30000);
    });
  });

  describe('exportMatrix', () => {
    beforeEach(async () => {
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.createDirectory('src');
      await sandbox.createDirectory('test');

      await sandbox.writeFile('.aiwg/requirements/uc.md', '# UC-001');
      await sandbox.writeFile('src/engine.ts', '// UC-001');
      await sandbox.writeFile('test/engine.test.ts', '// UC-001');

      await checker.scanAll();
    });

    it('should export matrix to all formats', async () => {
      const formats = [
        { format: 'csv' as const, expectedContent: 'UC-001' },
        { format: 'markdown' as const, expectedContent: '# Traceability Matrix' },
        { format: 'html' as const, expectedContent: '<!DOCTYPE html>' },
        { format: 'excel' as const, expectedContent: '\t' },
      ];

      for (const { format, expectedContent } of formats) {
        const filePath = await checker.exportMatrix(format);
        const exists = await sandbox.fileExists(filePath.replace(sandbox.getPath() + '/', ''));
        expect(exists, `file should exist for: ${format}`).toBe(true);

        const content = await sandbox.readFile(filePath.replace(sandbox.getPath() + '/', ''));
        expect(content, `wrong content for: ${format}`).toContain(expectedContent);
      }
    });
  });

  describe('generateReport', () => {
    it('should generate comprehensive report', async () => {
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.createDirectory('src');

      await sandbox.writeFile('.aiwg/requirements/uc1.md', '# UC-001');
      await sandbox.writeFile('.aiwg/requirements/uc2.md', '# UC-002');
      await sandbox.writeFile('src/engine.ts', '// UC-001');

      await checker.scanAll();
      const report = await checker.generateReport();

      expect(report.totalRequirements).toBe(2);
      expect(report.orphanedRequirements.length).toBeGreaterThan(0);
      expect(report.gapsByRequirement.size).toBeGreaterThan(0);
    });
  });

  describe('exportReport', () => {
    beforeEach(async () => {
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.writeFile('.aiwg/requirements/uc.md', '# UC-001');
      await checker.scanAll();
    });

    it('should export report to all formats', async () => {
      const formats = [
        { format: 'markdown' as const },
        { format: 'json' as const },
        { format: 'html' as const },
      ];

      for (const { format } of formats) {
        const filePath = await checker.exportReport(format);
        const exists = await sandbox.fileExists(filePath.replace(sandbox.getPath() + '/', ''));
        expect(exists, `file should exist for: ${format}`).toBe(true);

        if (format === 'json') {
          const content = await sandbox.readFile(filePath.replace(sandbox.getPath() + '/', ''));
          const json = JSON.parse(content);
          expect(json.totalRequirements).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('validateTraceability', () => {
    it('should validate against threshold', async () => {
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.createDirectory('src');
      await sandbox.createDirectory('test');

      await sandbox.writeFile('.aiwg/requirements/uc.md', '# UC-001');
      await sandbox.writeFile('src/engine.ts', '// UC-001');
      await sandbox.writeFile('test/engine.test.ts', '// UC-001');

      await checker.scanAll();
      const result = await checker.validateTraceability(0.8); // 80% threshold

      expect(result.passed).toBe(true);
      expect(result.coverage).toBe(100);
    });

    it('should fail when below threshold', async () => {
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.writeFile('.aiwg/requirements/uc.md', '# UC-001');

      await checker.scanAll();
      const result = await checker.validateTraceability(0.5);

      expect(result.passed).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('should reject invalid thresholds and never pass with blocking P0 gaps', async () => {
      for (const threshold of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(checker.validateTraceability(threshold)).rejects.toThrow(/finite number between 0 and 1/);
      }
      await expect(checker.validateTraceability('0.8' as unknown as number)).rejects.toThrow(/finite number between 0 and 1/);

      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.writeFile('.aiwg/requirements/p0.md', '# UC-001\n**Priority**: P0');
      await checker.scanAll();
      const result = await checker.validateTraceability(0);
      expect(result.passed).toBe(false);
      expect(result.issues).toContain('P0 coverage 0.0% is not 100%');
    });
  });

  describe('checkConstructionGate', () => {
    it('should pass when all P0 requirements traced', async () => {
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.createDirectory('src');
      await sandbox.createDirectory('test');

      await sandbox.writeFile('.aiwg/requirements/p0.md', '# UC-001\n**Priority**: P0');
      await sandbox.writeFile('src/engine.ts', '// UC-001');
      await sandbox.writeFile('test/engine.test.ts', '// UC-001');

      await checker.scanAll();
      const result = await checker.checkConstructionGate();

      expect(result.passed).toBe(true);
      expect(result.p0Coverage).toBe(100);
    });

    it('should fail when P0 requirements not traced and warn for low P1 coverage', async () => {
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.writeFile('.aiwg/requirements/p0.md', '# UC-001\n**Priority**: P0');
      await sandbox.writeFile('.aiwg/requirements/p1.md', '# UC-002\n**Priority**: P1');

      await checker.scanAll();
      const result = await checker.checkConstructionGate();

      expect(result.passed).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('link management', () => {
    it('should add, remove, and update links', async () => {
      await sandbox.createDirectory('.aiwg/requirements');
      await sandbox.createDirectory('src');
      await sandbox.writeFile('.aiwg/requirements/uc.md', '# UC-001');
      await sandbox.writeFile('src/engine.ts', '// UC-001');
      await checker.scanAll();

      // Add link
      await checker.addLink('UC-001', {
        type: 'code',
        path: 'src/new-file.ts',
        verified: true,
        confidence: 1.0
      });

      await checker.addLink('UC-001', {
        type: 'test',
        path: 'test/new-test.test.ts',
        verified: true,
        confidence: 1.0
      });

      let links = await checker.buildTraceabilityLinks();
      let link = links.get('UC-001')!;

      expect(link.linkedItems.some(item => item.path === 'src/new-file.ts')).toBe(true);
      expect(link.linkedItems.some(item => item.path === 'test/new-test.test.ts')).toBe(true);
      const addedCode = link.linkedItems.find(item => item.path === 'src/new-file.ts')!;
      expect(addedCode.verified).toBe(true);
      expect(addedCode.confidence).toBe(1);

      // Remove link
      await checker.removeLink('UC-001', sandbox.getPath() + '/src/engine.ts');
      links = await checker.buildTraceabilityLinks();
      link = links.get('UC-001')!;
      expect(link.linkedItems.some(item => item.path.includes('engine.ts'))).toBe(false);

      // Update link
      const oldPath = 'src/new-file.ts';
      const newPath = 'src/updated-file.ts';
      await checker.updateLink('UC-001', oldPath, {
        confidence: 0.9
      });

      links = await checker.buildTraceabilityLinks();
      link = links.get('UC-001')!;
      expect(link.linkedItems.find(item => item.path === oldPath)).toMatchObject({
        type: 'code', verified: true, confidence: 0.9
      });

      await checker.updateLink('UC-001', oldPath, { path: newPath });

      links = await checker.buildTraceabilityLinks();
      link = links.get('UC-001')!;
      const updated = link.linkedItems.find(item => item.path === newPath)!;
      expect(updated).toMatchObject({ type: 'code', verified: true, confidence: 0.9 });

      await checker.addLink('UC-001', {
        type: 'code',
        path: 'src/unverified.ts',
        lineNumber: 7,
        verified: false,
        confidence: 0.25
      });
      await checker.addLink('UC-001', {
        type: 'code',
        path: 'src/unverified.ts',
        lineNumber: 8,
        verified: false,
        confidence: 0.5
      });
      link = (await checker.buildTraceabilityLinks()).get('UC-001')!;
      const unverified = link.linkedItems.filter(item => item.path === 'src/unverified.ts');
      expect(unverified).toHaveLength(1);
      expect(unverified[0]).toMatchObject({ lineNumber: 8, verified: false, confidence: 0.5 });
    });

    it('should throw error for non-existent requirement', async () => {
      await checker.scanAll();

      await expect(
        checker.addLink('UC-999', {
          type: 'code',
          path: 'src/file.ts',
          verified: true,
          confidence: 1.0
        })
      ).rejects.toThrow();
    });
  });
});
