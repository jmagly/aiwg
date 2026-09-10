/**
 * Traceability Checker - Maintain 100% bidirectional traceability
 * from requirements → code → tests → deployment
 *
 * Features:
 * - Bidirectional tracing (requirements ↔ code ↔ tests)
 * - Orphan detection (requirements without code, code without requirements)
 * - Coverage analysis (percentage of requirements traced)
 * - Gap identification (missing code, tests, documentation)
 * - Matrix generation (CSV, Excel, Markdown, HTML)
 * - Construction gate validation (100% P0 requirements traced)
 *
 * Performance targets:
 * - NFR-TRACE-001: ID extraction <1min for 1000 files
 * - NFR-TRACE-05: Matrix generation <30s for 1000 requirements
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { IDExtractor } from './id-extractor.js';
import { MatrixGenerator, TraceabilityMatrix, MatrixExportOptions } from './matrix-generator.js';

export interface Requirement {
  id: string;
  type: 'use-case' | 'nfr' | 'user-story' | 'feature' | 'acceptance-criteria';
  title: string;
  priority?: 'P0' | 'P1' | 'P2';
  filePath: string;
}

export interface CodeReference {
  filePath: string;
  requirementIds: string[];
  lineNumbers: number[];
  linkMetadata?: Map<string, LinkMetadata>;
}

export interface TestReference {
  filePath: string;
  requirementIds: string[];
  testNames: string[];
  linkMetadata?: Map<string, LinkMetadata>;
}

interface LinkMetadata {
  verified: boolean;
  confidence: number;
}

export interface ScanResult {
  requirements: Map<string, Requirement>;
  code: Map<string, CodeReference>;
  tests: Map<string, TestReference>;
  scanTime: number;
}

export interface TraceabilityLink {
  requirementId: string;
  type: 'use-case' | 'nfr' | 'user-story' | 'feature' | 'acceptance-criteria';
  linkedItems: LinkedItem[];
  coverage: CoverageMetrics;
  lastVerified: Date;
}

export interface LinkedItem {
  type: 'code' | 'test' | 'documentation' | 'deployment';
  path: string;
  lineNumber?: number;
  verified: boolean;
  confidence: number;
}

export interface CoverageMetrics {
  hasCode: boolean;
  hasTests: boolean;
  hasDocumentation: boolean;
  hasDeployment: boolean;
  completeness: number;
}

export interface TraceabilityReport {
  totalRequirements: number;
  tracedRequirements: number;
  coveragePercentage: number;
  orphanedRequirements: string[];
  orphanedCode: string[];
  orphanedTests: string[];
  gapsByRequirement: Map<string, string[]>;
  matrix: TraceabilityMatrix;
}

export interface VerificationResult {
  verified: boolean;
  issues: string[];
  warnings: string[];
}

export interface OrphanReport {
  orphanedRequirements: string[];
  orphanedCode: string[];
  orphanedTests: string[];
  severity: Map<string, 'critical' | 'warning' | 'info'>;
}

export interface CoverageReport {
  percentage: number;
  byType: Map<string, number>;
  byPriority: Map<string, number>;
  gaps: GapAnalysis;
}

export interface GapAnalysis {
  requirementsWithoutCode: string[];
  requirementsWithoutTests: string[];
  requirementsWithoutDocumentation: string[];
  codeWithoutRequirements: string[];
  testsWithoutRequirements: string[];
}

export interface ValidationResult {
  passed: boolean;
  coverage: number;
  threshold: number;
  issues: string[];
}

export interface GateValidationResult {
  passed: boolean;
  p0Coverage: number;
  p1Coverage: number;
  issues: string[];
  warnings: string[];
}

/**
 * TraceabilityChecker - Main class for traceability analysis
 */
export class TraceabilityChecker {
  private projectPath: string;
  private idExtractor: IDExtractor;
  private matrixGenerator: MatrixGenerator;

  // Cached scan results
  private requirements: Map<string, Requirement> = new Map();
  private codeReferences: Map<string, CodeReference> = new Map();
  private testReferences: Map<string, TestReference> = new Map();

  constructor(projectPath: string) {
    this.projectPath = path.resolve(projectPath);
    this.idExtractor = new IDExtractor();
    this.matrixGenerator = new MatrixGenerator();
  }

  /**
   * Scan requirements directory for requirement IDs
   */
  async scanRequirements(requirementsPath?: string): Promise<Map<string, Requirement>> {
    const scanPath = requirementsPath || path.join(this.projectPath, '.aiwg/requirements');
    const requirements = new Map<string, Requirement>();

    try {
      // Find all markdown and YAML files
      const files = await glob('**/*.{md,yaml,yml}', {
        cwd: scanPath,
        absolute: true,
        nodir: true
      });

      // Process files in parallel
      await Promise.all(
        files.map(async (filePath) => {
          const content = await fs.readFile(filePath, 'utf-8');
          const ids = this.idExtractor.extractFromContent(content, filePath);

          // Extract requirement details
          for (const reqId of ids) {
            if (!requirements.has(reqId.id)) {
              const title = this.extractTitle(content, reqId.id);
              const priority = this.extractPriority(content);

              requirements.set(reqId.id, {
                id: reqId.id,
                type: reqId.type,
                title,
                priority,
                filePath
              });
            }
          }
        })
      );

      this.requirements = requirements;
      return requirements;
    } catch (error) {
      // Directory doesn't exist or other error
      this.requirements = new Map();
      return new Map();
    }
  }

  /**
   * Scan code directory for requirement IDs
   */
  async scanCode(codePath?: string): Promise<Map<string, CodeReference>> {
    const scanPath = codePath || path.join(this.projectPath, 'src');
    const codeRefs = new Map<string, CodeReference>();

    try {
      // Find all source files
      const files = await glob('**/*.{ts,js,mjs,tsx,jsx}', {
        cwd: scanPath,
        absolute: true,
        nodir: true,
        ignore: ['**/node_modules/**', '**/dist/**', '**/*.test.{ts,js}', '**/*.spec.{ts,js}']
      });

      // Process files in parallel
      await Promise.all(
        files.map(async (filePath) => {
          const content = await fs.readFile(filePath, 'utf-8');
          const ids = this.idExtractor.extractFromContent(content, filePath);

          // Always add file, even if no IDs (needed for orphan detection)
          codeRefs.set(filePath, {
            filePath,
            requirementIds: ids.map(id => id.id),
            lineNumbers: ids.map(id => id.lineNumber || 0)
          });
        })
      );

      this.codeReferences = codeRefs;
      return codeRefs;
    } catch (error) {
      this.codeReferences = new Map();
      return new Map();
    }
  }

  /**
   * Scan test directory for requirement IDs
   */
  async scanTests(testPath?: string): Promise<Map<string, TestReference>> {
    const scanPath = testPath || path.join(this.projectPath, 'test');
    const testRefs = new Map<string, TestReference>();

    try {
      // Find all test files
      const files = await glob('**/*.{test,spec}.{ts,js,mjs}', {
        cwd: scanPath,
        absolute: true,
        nodir: true,
        ignore: ['**/node_modules/**', '**/dist/**']
      });

      // Process files in parallel
      await Promise.all(
        files.map(async (filePath) => {
          const content = await fs.readFile(filePath, 'utf-8');
          const ids = this.idExtractor.extractFromContent(content, filePath);
          const testNames = this.extractTestNames(content);

          // Always add file, even if no IDs (needed for orphan detection)
          testRefs.set(filePath, {
            filePath,
            requirementIds: ids.map(id => id.id),
            testNames
          });
        })
      );

      this.testReferences = testRefs;
      return testRefs;
    } catch (error) {
      this.testReferences = new Map();
      return new Map();
    }
  }

  /**
   * Scan all directories (requirements, code, tests)
   */
  async scanAll(): Promise<ScanResult> {
    const startTime = performance.now();

    // Scan in parallel
    const [requirements, code, tests] = await Promise.all([
      this.scanRequirements(),
      this.scanCode(),
      this.scanTests()
    ]);

    const scanTime = performance.now() - startTime;

    return {
      requirements,
      code,
      tests,
      scanTime
    };
  }

  /**
   * Build traceability links from scan results
   */
  async buildTraceabilityLinks(): Promise<Map<string, TraceabilityLink>> {
    const links = new Map<string, TraceabilityLink>();

    // Build links for each requirement
    for (const [reqId, req] of this.requirements) {
      const linkedItems: LinkedItem[] = [];

      // Find code references
      for (const [filePath, codeRef] of this.codeReferences) {
        if (codeRef.requirementIds.includes(reqId)) {
          const metadata = codeRef.linkMetadata?.get(reqId);
          linkedItems.push({
            type: 'code',
            path: filePath,
            lineNumber: codeRef.lineNumbers[codeRef.requirementIds.indexOf(reqId)],
            verified: metadata?.verified ?? true,
            confidence: metadata?.confidence ?? 1.0
          });
        }
      }

      // Find test references
      for (const [filePath, testRef] of this.testReferences) {
        if (testRef.requirementIds.includes(reqId)) {
          const metadata = testRef.linkMetadata?.get(reqId);
          linkedItems.push({
            type: 'test',
            path: filePath,
            verified: metadata?.verified ?? true,
            confidence: metadata?.confidence ?? 1.0
          });
        }
      }

      // Calculate coverage
      const hasCode = linkedItems.some(item => item.type === 'code');
      const hasTests = linkedItems.some(item => item.type === 'test');
      const hasDocumentation = linkedItems.some(item => item.type === 'documentation');
      const hasDeployment = linkedItems.some(item => item.type === 'deployment');

      const completeness =
        (hasCode ? 0.4 : 0) +
        (hasTests ? 0.4 : 0) +
        (hasDocumentation ? 0.1 : 0) +
        (hasDeployment ? 0.1 : 0);

      links.set(reqId, {
        requirementId: reqId,
        type: req.type,
        linkedItems,
        coverage: {
          hasCode,
          hasTests,
          hasDocumentation,
          hasDeployment,
          completeness
        },
        lastVerified: new Date()
      });
    }

    return links;
  }

  /**
   * Verify links integrity
   */
  async verifyLinks(links: Map<string, TraceabilityLink>): Promise<VerificationResult> {
    const issues: string[] = [];
    const warnings: string[] = [];

    for (const [reqId, link] of links) {
      // Check if requirement exists
      if (!this.requirements.has(reqId)) {
        issues.push(`Link references non-existent requirement: ${reqId}`);
        continue;
      }

      // Check if linked files exist
      for (const item of link.linkedItems) {
        try {
          await fs.access(item.path);
        } catch {
          issues.push(`Linked file not found: ${item.path} (for ${reqId})`);
        }
      }

      // Warn if no code
      if (!link.coverage.hasCode) {
        warnings.push(`Requirement ${reqId} has no code implementation`);
      }

      // Warn if no tests
      if (!link.coverage.hasTests) {
        warnings.push(`Requirement ${reqId} has no tests`);
      }
    }

    return {
      verified: issues.length === 0,
      issues,
      warnings
    };
  }

  /**
   * Detect orphaned requirements, code, and tests
   */
  async detectOrphans(): Promise<OrphanReport> {
    const orphanedRequirements: string[] = [];
    const orphanedCode: string[] = [];
    const orphanedTests: string[] = [];
    const severity = new Map<string, 'critical' | 'warning' | 'info'>();

    // Find requirements without code
    for (const [reqId, req] of this.requirements) {
      const hasCode = Array.from(this.codeReferences.values()).some(ref =>
        ref.requirementIds.includes(reqId)
      );

      if (!hasCode) {
        orphanedRequirements.push(reqId);
        severity.set(reqId, req.priority === 'P0' ? 'critical' : req.priority === 'P1' ? 'warning' : 'info');
      }
    }

    // Find code without requirements
    for (const [filePath, codeRef] of this.codeReferences) {
      if (codeRef.requirementIds.length === 0) {
        orphanedCode.push(filePath);
        severity.set(filePath, 'warning');
      }
    }

    // Find tests without requirements
    for (const [filePath, testRef] of this.testReferences) {
      if (testRef.requirementIds.length === 0) {
        orphanedTests.push(filePath);
        severity.set(filePath, 'info');
      }
    }

    return {
      orphanedRequirements,
      orphanedCode,
      orphanedTests,
      severity
    };
  }

  /**
   * Calculate overall coverage
   */
  async calculateCoverage(): Promise<CoverageReport> {
    const links = await this.buildTraceabilityLinks();

    let totalRequirements = this.requirements.size;
    let tracedRequirements = 0;

    for (const link of links.values()) {
      if (link.coverage.hasCode && link.coverage.hasTests) {
        tracedRequirements++;
      }
    }

    const percentage = totalRequirements > 0 ? (tracedRequirements / totalRequirements) * 100 : 0;

    // Calculate coverage by type
    const byType = await this.calculateCoverageByType('use-case');
    const nfrCoverage = await this.calculateCoverageByType('nfr');
    byType.set('nfr', nfrCoverage.get('nfr') || 0);

    // Calculate coverage by priority
    const byPriority = new Map<string, number>();
    const p0Reqs = Array.from(this.requirements.values()).filter(r => r.priority === 'P0');
    const p1Reqs = Array.from(this.requirements.values()).filter(r => r.priority === 'P1');
    const p2Reqs = Array.from(this.requirements.values()).filter(r => r.priority === 'P2');

    byPriority.set('P0', this.calculateCoverageForRequirements(p0Reqs, links));
    byPriority.set('P1', this.calculateCoverageForRequirements(p1Reqs, links));
    byPriority.set('P2', this.calculateCoverageForRequirements(p2Reqs, links));

    // Identify gaps
    const gaps = await this.identifyGaps();

    return {
      percentage,
      byType,
      byPriority,
      gaps
    };
  }

  /**
   * Calculate coverage by requirement type
   */
  async calculateCoverageByType(type: 'use-case' | 'nfr'): Promise<Map<string, number>> {
    const links = await this.buildTraceabilityLinks();
    const byType = new Map<string, number>();

    const reqs = Array.from(this.requirements.values()).filter(r => r.type === type);
    const coverage = this.calculateCoverageForRequirements(reqs, links);

    byType.set(type, coverage);
    return byType;
  }

  /**
   * Identify gaps in traceability
   */
  async identifyGaps(): Promise<GapAnalysis> {
    const links = await this.buildTraceabilityLinks();

    const requirementsWithoutCode: string[] = [];
    const requirementsWithoutTests: string[] = [];
    const requirementsWithoutDocumentation: string[] = [];

    for (const [reqId, link] of links) {
      if (!link.coverage.hasCode) requirementsWithoutCode.push(reqId);
      if (!link.coverage.hasTests) requirementsWithoutTests.push(reqId);
      if (!link.coverage.hasDocumentation) requirementsWithoutDocumentation.push(reqId);
    }

    const codeWithoutRequirements = Array.from(this.codeReferences.keys()).filter(
      filePath => this.codeReferences.get(filePath)!.requirementIds.length === 0
    );

    const testsWithoutRequirements = Array.from(this.testReferences.keys()).filter(
      filePath => this.testReferences.get(filePath)!.requirementIds.length === 0
    );

    return {
      requirementsWithoutCode,
      requirementsWithoutTests,
      requirementsWithoutDocumentation,
      codeWithoutRequirements,
      testsWithoutRequirements
    };
  }

  /**
   * Generate traceability matrix
   */
  async generateMatrix(): Promise<TraceabilityMatrix> {
    const links = await this.buildTraceabilityLinks();

    const requirements = Array.from(this.requirements.keys());
    const codeFiles = Array.from(this.codeReferences.keys());
    const testFiles = Array.from(this.testReferences.keys());

    // Build links map
    const linksMap = new Map<string, { code: string[]; tests: string[] }>();
    for (const [reqId, link] of links) {
      const code = link.linkedItems.filter(item => item.type === 'code').map(item => item.path);
      const tests = link.linkedItems.filter(item => item.type === 'test').map(item => item.path);
      linksMap.set(reqId, { code, tests });
    }

    return this.matrixGenerator.generateMatrix(requirements, codeFiles, testFiles, linksMap);
  }

  /**
   * Export matrix to file
   */
  async exportMatrix(format: 'csv' | 'excel' | 'markdown' | 'html', outputPath?: string): Promise<string> {
    const matrix = await this.generateMatrix();
    const options: MatrixExportOptions = {
      format,
      includeVerification: true,
      includeConfidence: true
    };

    let content: string;
    let defaultFilename: string;

    switch (format) {
      case 'csv':
        content = this.matrixGenerator.exportToCSV(matrix, options);
        defaultFilename = 'traceability-matrix.csv';
        break;
      case 'excel':
        content = this.matrixGenerator.exportToExcel(matrix, options);
        defaultFilename = 'traceability-matrix.tsv';
        break;
      case 'markdown':
        content = this.matrixGenerator.exportToMarkdown(matrix, options);
        defaultFilename = 'traceability-matrix.md';
        break;
      case 'html':
        content = this.matrixGenerator.exportToHTML(matrix, options);
        defaultFilename = 'traceability-matrix.html';
        break;
    }

    const filePath = outputPath || path.join(this.projectPath, '.aiwg/reports', defaultFilename);

    // Ensure directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Write file
    await fs.writeFile(filePath, content, 'utf-8');

    return filePath;
  }

  /**
   * Generate comprehensive traceability report
   */
  async generateReport(): Promise<TraceabilityReport> {
    const links = await this.buildTraceabilityLinks();
    const orphans = await this.detectOrphans();
    await this.identifyGaps();
    const matrix = await this.generateMatrix();

    const totalRequirements = this.requirements.size;
    let tracedRequirements = 0;

    for (const link of links.values()) {
      if (link.coverage.hasCode && link.coverage.hasTests) {
        tracedRequirements++;
      }
    }

    const coveragePercentage = totalRequirements > 0 ? (tracedRequirements / totalRequirements) * 100 : 0;

    // Build gaps by requirement
    const gapsByRequirement = new Map<string, string[]>();
    for (const [reqId, link] of links) {
      const reqGaps: string[] = [];
      if (!link.coverage.hasCode) reqGaps.push('Missing code implementation');
      if (!link.coverage.hasTests) reqGaps.push('Missing tests');
      if (!link.coverage.hasDocumentation) reqGaps.push('Missing documentation');

      if (reqGaps.length > 0) {
        gapsByRequirement.set(reqId, reqGaps);
      }
    }

    return {
      totalRequirements,
      tracedRequirements,
      coveragePercentage,
      orphanedRequirements: orphans.orphanedRequirements,
      orphanedCode: orphans.orphanedCode,
      orphanedTests: orphans.orphanedTests,
      gapsByRequirement,
      matrix
    };
  }

  /**
   * Generate gap report (markdown format)
   */
  async generateGapReport(): Promise<string> {
    const report = await this.generateReport();
    const lines: string[] = [];

    lines.push('# Traceability Gap Report\n');
    lines.push(`Generated: ${new Date().toISOString()}\n`);
    lines.push('## Summary\n');
    lines.push(`- Total Requirements: ${report.totalRequirements}`);
    lines.push(`- Traced Requirements: ${report.tracedRequirements}`);
    lines.push(`- Coverage: ${report.coveragePercentage.toFixed(1)}%\n`);

    lines.push('## Orphaned Requirements\n');
    if (report.orphanedRequirements.length > 0) {
      for (const reqId of report.orphanedRequirements) {
        const req = this.requirements.get(reqId);
        lines.push(`- **${reqId}** (${req?.priority || 'N/A'}): ${req?.title || 'Unknown'}`);
      }
    } else {
      lines.push('*None*\n');
    }

    lines.push('\n## Orphaned Code\n');
    if (report.orphanedCode.length > 0) {
      for (const filePath of report.orphanedCode) {
        lines.push(`- ${filePath}`);
      }
    } else {
      lines.push('*None*\n');
    }

    lines.push('\n## Orphaned Tests\n');
    if (report.orphanedTests.length > 0) {
      for (const filePath of report.orphanedTests) {
        lines.push(`- ${filePath}`);
      }
    } else {
      lines.push('*None*\n');
    }

    lines.push('\n## Gaps by Requirement\n');
    if (report.gapsByRequirement.size > 0) {
      for (const [reqId, gaps] of report.gapsByRequirement) {
        lines.push(`\n### ${reqId}\n`);
        for (const gap of gaps) {
          lines.push(`- ${gap}`);
        }
      }
    } else {
      lines.push('*None*\n');
    }

    return lines.join('\n');
  }

  /**
   * Export report to file
   */
  async exportReport(format: 'markdown' | 'json' | 'html', outputPath?: string): Promise<string> {
    const report = await this.generateReport();
    let content: string;
    let defaultFilename: string;

    switch (format) {
      case 'markdown':
        content = await this.generateGapReport();
        defaultFilename = 'traceability-report.md';
        break;
      case 'json':
        content = JSON.stringify(
          {
            ...report,
            gapsByRequirement: Array.from(report.gapsByRequirement.entries())
          },
          null,
          2
        );
        defaultFilename = 'traceability-report.json';
        break;
      case 'html':
        content = this.matrixGenerator.exportToHTML(report.matrix, { format: 'html' });
        defaultFilename = 'traceability-report.html';
        break;
    }

    const filePath = outputPath || path.join(this.projectPath, '.aiwg/reports', defaultFilename);

    // Ensure directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Write file
    await fs.writeFile(filePath, content, 'utf-8');

    return filePath;
  }

  /**
   * Validate traceability against threshold
   */
  async validateTraceability(threshold: number): Promise<ValidationResult> {
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new RangeError('Traceability threshold must be a finite number between 0 and 1');
    }
    const coverage = await this.calculateCoverage();

    const issues: string[] = [];
    if (coverage.percentage < threshold * 100) {
      issues.push(`Coverage ${coverage.percentage.toFixed(1)}% is below threshold ${(threshold * 100).toFixed(1)}%`);
    }

    // Check P0 requirements
    const p0Coverage = coverage.byPriority.get('P0') || 0;
    const hasP0Requirements = Array.from(this.requirements.values()).some(requirement => requirement.priority === 'P0');
    if (hasP0Requirements && p0Coverage < 100) {
      issues.push(`P0 coverage ${p0Coverage.toFixed(1)}% is not 100%`);
    }

    return {
      passed: issues.length === 0,
      coverage: coverage.percentage,
      threshold: threshold * 100,
      issues
    };
  }

  /**
   * Check Construction gate criteria (100% P0 requirements traced)
   */
  async checkConstructionGate(): Promise<GateValidationResult> {
    const coverage = await this.calculateCoverage();
    const p0Coverage = coverage.byPriority.get('P0') || 0;
    const p1Coverage = coverage.byPriority.get('P1') || 0;

    const issues: string[] = [];
    const warnings: string[] = [];

    // Critical: P0 must be 100%
    if (p0Coverage < 100) {
      const p0Reqs = Array.from(this.requirements.values()).filter(r => r.priority === 'P0');
      const links = await this.buildTraceabilityLinks();

      for (const req of p0Reqs) {
        const link = links.get(req.id);
        if (!link || !link.coverage.hasCode || !link.coverage.hasTests) {
          issues.push(`P0 requirement ${req.id} is not fully traced`);
        }
      }
    }

    // Warning: P1 should be high
    if (p1Coverage < 80) {
      warnings.push(`P1 coverage ${p1Coverage.toFixed(1)}% is below 80%`);
    }

    return {
      passed: p0Coverage === 100,
      p0Coverage,
      p1Coverage,
      issues,
      warnings
    };
  }

  /**
   * Add a traceability link manually
   */
  async addLink(requirementId: string, linkedItem: LinkedItem): Promise<void> {
    // Verify requirement exists
    if (!this.requirements.has(requirementId)) {
      throw new Error(`Requirement ${requirementId} not found`);
    }
    this.validateLinkedItem(linkedItem);

    // Add to appropriate cache
    if (linkedItem.type === 'code') {
      const existing = this.codeReferences.get(linkedItem.path) || {
        filePath: linkedItem.path,
        requirementIds: [],
        lineNumbers: []
      };
      const index = existing.requirementIds.indexOf(requirementId);
      if (index === -1) {
        existing.requirementIds.push(requirementId);
        existing.lineNumbers.push(linkedItem.lineNumber ?? 0);
      } else {
        existing.lineNumbers[index] = linkedItem.lineNumber ?? existing.lineNumbers[index] ?? 0;
      }
      existing.linkMetadata ??= new Map();
      existing.linkMetadata.set(requirementId, { verified: linkedItem.verified, confidence: linkedItem.confidence });
      this.codeReferences.set(linkedItem.path, existing);
    } else if (linkedItem.type === 'test') {
      const existing = this.testReferences.get(linkedItem.path) || {
        filePath: linkedItem.path,
        requirementIds: [],
        testNames: []
      };
      if (!existing.requirementIds.includes(requirementId)) existing.requirementIds.push(requirementId);
      existing.linkMetadata ??= new Map();
      existing.linkMetadata.set(requirementId, { verified: linkedItem.verified, confidence: linkedItem.confidence });
      this.testReferences.set(linkedItem.path, existing);
    } else {
      throw new Error(`Manual link type ${linkedItem.type} is not supported`);
    }
  }

  /**
   * Remove a traceability link
   */
  async removeLink(requirementId: string, itemPath: string): Promise<void> {
    // Remove from code references
    const codeRef = this.codeReferences.get(itemPath);
    if (codeRef) {
      const index = codeRef.requirementIds.indexOf(requirementId);
      if (index !== -1) {
        codeRef.requirementIds.splice(index, 1);
        codeRef.lineNumbers.splice(index, 1);
        codeRef.linkMetadata?.delete(requirementId);
      }
    }

    // Remove from test references
    const testRef = this.testReferences.get(itemPath);
    if (testRef) {
      const index = testRef.requirementIds.indexOf(requirementId);
      if (index !== -1) {
        testRef.requirementIds.splice(index, 1);
        testRef.linkMetadata?.delete(requirementId);
      }
    }
  }

  /**
   * Update a traceability link
   */
  async updateLink(requirementId: string, itemPath: string, updates: Partial<LinkedItem>): Promise<void> {
    const codeRef = this.codeReferences.get(itemPath);
    const codeIndex = codeRef?.requirementIds.indexOf(requirementId) ?? -1;
    const testRef = this.testReferences.get(itemPath);
    const testIndex = testRef?.requirementIds.indexOf(requirementId) ?? -1;
    let current: LinkedItem | null = null;
    if (codeRef && codeIndex >= 0) {
      const metadata = codeRef.linkMetadata?.get(requirementId);
      current = { type: 'code', path: itemPath, lineNumber: codeRef.lineNumbers[codeIndex], verified: metadata?.verified ?? true, confidence: metadata?.confidence ?? 1 };
    } else if (testRef && testIndex >= 0) {
      const metadata = testRef.linkMetadata?.get(requirementId);
      current = { type: 'test', path: itemPath, verified: metadata?.verified ?? true, confidence: metadata?.confidence ?? 1 };
    }
    if (!current) throw new Error(`Link ${requirementId} -> ${itemPath} not found`);
    const updated = { ...current, ...updates } as LinkedItem;
    this.validateLinkedItem(updated);
    await this.removeLink(requirementId, itemPath);
    await this.addLink(requirementId, updated);
  }

  // Helper methods

  private extractTitle(content: string, reqId: string): string {
    // Try to find title near the requirement ID
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(reqId)) {
        // Check surrounding lines for title
        const title = lines[i].match(/(?:Title|Name|Description):\s*(.+)/i);
        if (title) return title[1].trim();

        // Check for markdown heading
        const heading = lines[i].match(/^#+\s+(.+)/);
        if (heading) return heading[1].trim();

        // Check next line
        if (i + 1 < lines.length) {
          const nextHeading = lines[i + 1].match(/^#+\s+(.+)/);
          if (nextHeading) return nextHeading[1].trim();
        }
      }
    }
    return 'Unknown';
  }

  private extractPriority(content: string): 'P0' | 'P1' | 'P2' | undefined {
    const match = content.match(/\*?\*?Priority\*?\*?:\s*(P[012])/i);
    return match ? (match[1].toUpperCase() as 'P0' | 'P1' | 'P2') : undefined;
  }

  private extractTestNames(content: string): string[] {
    const testNames: string[] = [];
    const matches = content.matchAll(/(?:it|test)\s*\(\s*['"`](.+?)['"`]/g);
    for (const match of matches) {
      testNames.push(match[1]);
    }
    return testNames;
  }

  private calculateCoverageForRequirements(
    reqs: Requirement[],
    links: Map<string, TraceabilityLink>
  ): number {
    if (reqs.length === 0) return 0;

    let traced = 0;
    for (const req of reqs) {
      const link = links.get(req.id);
      if (link && link.coverage.hasCode && link.coverage.hasTests) {
        traced++;
      }
    }

    return (traced / reqs.length) * 100;
  }

  private validateLinkedItem(linkedItem: LinkedItem): void {
    if ((linkedItem.type !== 'code' && linkedItem.type !== 'test') || typeof linkedItem.path !== 'string' || linkedItem.path.length === 0) {
      throw new TypeError('Manual links require a non-empty path and a code or test type');
    }
    if (typeof linkedItem.verified !== 'boolean') throw new TypeError('Manual link verified must be boolean');
    if (typeof linkedItem.confidence !== 'number' || !Number.isFinite(linkedItem.confidence) || linkedItem.confidence < 0 || linkedItem.confidence > 1) {
      throw new RangeError('Manual link confidence must be a finite number between 0 and 1');
    }
    if (linkedItem.lineNumber !== undefined && (!Number.isInteger(linkedItem.lineNumber) || linkedItem.lineNumber < 0)) {
      throw new RangeError('Manual link line number must be a non-negative integer');
    }
  }
}
