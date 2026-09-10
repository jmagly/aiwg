/**
 * Matrix Generator - Generate traceability matrices in various formats
 * Supports: CSV, Excel (TSV), Markdown, HTML
 */

export interface TraceabilityMatrix {
  requirements: string[];
  code: string[];
  tests: string[];
  links: MatrixCell[][];
}

export interface MatrixCell {
  requirementId: string;
  itemPath: string;
  itemType: 'code' | 'test' | 'documentation';
  linked: boolean;
  verified: boolean;
  confidence: number;
}

export interface MatrixExportOptions {
  format: 'csv' | 'excel' | 'markdown' | 'html';
  includeVerification?: boolean;
  includeConfidence?: boolean;
  sortBy?: 'requirement' | 'coverage' | 'type';
}

/**
 * MatrixGenerator - Generate and export traceability matrices
 */
export class MatrixGenerator {
  /**
   * Generate traceability matrix from links
   */
  generateMatrix(
    requirements: string[],
    codeFiles: string[],
    testFiles: string[],
    links: Map<string, { code: string[]; tests: string[] }>
  ): TraceabilityMatrix {
    const matrix: MatrixCell[][] = [];

    // Build matrix rows (one per requirement)
    for (const reqId of requirements) {
      const row: MatrixCell[] = [];
      const reqLinks = links.get(reqId) || { code: [], tests: [] };

      // Add code file cells
      for (const codeFile of codeFiles) {
        row.push({
          requirementId: reqId,
          itemPath: codeFile,
          itemType: 'code',
          linked: reqLinks.code.includes(codeFile),
          verified: reqLinks.code.includes(codeFile),
          confidence: reqLinks.code.includes(codeFile) ? 1.0 : 0.0
        });
      }

      // Add test file cells
      for (const testFile of testFiles) {
        row.push({
          requirementId: reqId,
          itemPath: testFile,
          itemType: 'test',
          linked: reqLinks.tests.includes(testFile),
          verified: reqLinks.tests.includes(testFile),
          confidence: reqLinks.tests.includes(testFile) ? 1.0 : 0.0
        });
      }

      matrix.push(row);
    }

    return {
      requirements,
      code: codeFiles,
      tests: testFiles,
      links: matrix
    };
  }

  /**
   * Export matrix to CSV format
   */
  exportToCSV(matrix: TraceabilityMatrix, options: MatrixExportOptions = { format: 'csv' }): string {
    const lines: string[] = [];

    // Header row
    const headers = ['Requirement', 'Code Files', 'Tests', 'Documentation', 'Coverage'];
    if (options.includeVerification) headers.push('Verified');
    if (options.includeConfidence) headers.push('Confidence');
    lines.push(headers.join(','));

    // Data rows
    for (let i = 0; i < matrix.requirements.length; i++) {
      const reqId = matrix.requirements[i];
      const row = matrix.links[i];

      // Find linked items
      const linkedCode = row.filter(cell => cell.itemType === 'code' && cell.linked).map(cell => cell.itemPath);
      const linkedTests = row.filter(cell => cell.itemType === 'test' && cell.linked).map(cell => cell.itemPath);
      const linkedDocs = row.filter(cell => cell.itemType === 'documentation' && cell.linked).map(cell => cell.itemPath);

      // Calculate coverage
      const hasCode = linkedCode.length > 0;
      const hasTests = linkedTests.length > 0;
      const hasDocs = linkedDocs.length > 0;
      const coverage = ((hasCode ? 33 : 0) + (hasTests ? 33 : 0) + (hasDocs ? 34 : 0));

      const csvRow = [
        this.escapeCSV(reqId),
        this.escapeCSV(linkedCode.join('; ') || 'NONE'),
        this.escapeCSV(linkedTests.join('; ') || 'NONE'),
        this.escapeCSV(linkedDocs.join('; ') || 'NONE'),
        `${coverage}%`
      ];

      if (options.includeVerification) {
        const verified = row.every(cell => !cell.linked || cell.verified);
        csvRow.push(verified ? 'YES' : 'NO');
      }

      if (options.includeConfidence) {
        const avgConfidence = row.length > 0
          ? row.reduce((sum, cell) => sum + cell.confidence, 0) / row.length
          : 0;
        csvRow.push(`${(avgConfidence * 100).toFixed(1)}%`);
      }

      lines.push(csvRow.join(','));
    }

    return lines.join('\n');
  }

  /**
   * Export matrix to Excel (TSV) format
   */
  exportToExcel(matrix: TraceabilityMatrix, options: MatrixExportOptions = { format: 'excel' }): string {
    const lines: string[] = [];
    const headers = ['Requirement', 'Code Files', 'Tests', 'Documentation', 'Coverage'];
    if (options.includeVerification) headers.push('Verified');
    if (options.includeConfidence) headers.push('Confidence');
    lines.push(headers.map(value => this.escapeTSV(value)).join('\t'));

    for (let i = 0; i < matrix.requirements.length; i++) {
      const reqId = matrix.requirements[i];
      const row = matrix.links[i];
      const linkedCode = row.filter(cell => cell.itemType === 'code' && cell.linked).map(cell => cell.itemPath);
      const linkedTests = row.filter(cell => cell.itemType === 'test' && cell.linked).map(cell => cell.itemPath);
      const linkedDocs = row.filter(cell => cell.itemType === 'documentation' && cell.linked).map(cell => cell.itemPath);
      const coverage = (linkedCode.length > 0 ? 33 : 0) + (linkedTests.length > 0 ? 33 : 0) + (linkedDocs.length > 0 ? 34 : 0);
      const fields = [
        reqId,
        linkedCode.join('; ') || 'NONE',
        linkedTests.join('; ') || 'NONE',
        linkedDocs.join('; ') || 'NONE',
        `${coverage}%`
      ];
      if (options.includeVerification) {
        fields.push(row.every(cell => !cell.linked || cell.verified) ? 'YES' : 'NO');
      }
      if (options.includeConfidence) {
        const average = row.length > 0 ? row.reduce((sum, cell) => sum + cell.confidence, 0) / row.length : 0;
        fields.push(`${(average * 100).toFixed(1)}%`);
      }
      lines.push(fields.map(value => this.escapeTSV(value)).join('\t'));
    }

    return lines.join('\n');
  }

  /**
   * Export matrix to Markdown format
   */
  exportToMarkdown(matrix: TraceabilityMatrix, options: MatrixExportOptions = { format: 'markdown' }): string {
    const lines: string[] = [];

    // Title
    lines.push('# Traceability Matrix\n');
    lines.push(`Generated: ${new Date().toISOString()}\n`);
    lines.push(`Total Requirements: ${matrix.requirements.length}\n`);

    // Table header
    const headers = ['Requirement', 'Code Files', 'Tests', 'Documentation', 'Coverage'];
    if (options.includeVerification) headers.push('Verified');
    if (options.includeConfidence) headers.push('Confidence');

    lines.push('| ' + headers.join(' | ') + ' |');
    lines.push('|' + headers.map(() => '---').join('|') + '|');

    // Data rows
    for (let i = 0; i < matrix.requirements.length; i++) {
      const reqId = matrix.requirements[i];
      const row = matrix.links[i];

      // Find linked items
      const linkedCode = row.filter(cell => cell.itemType === 'code' && cell.linked).map(cell => this.formatPath(cell.itemPath));
      const linkedTests = row.filter(cell => cell.itemType === 'test' && cell.linked).map(cell => this.formatPath(cell.itemPath));
      const linkedDocs = row.filter(cell => cell.itemType === 'documentation' && cell.linked).map(cell => this.formatPath(cell.itemPath));

      // Calculate coverage
      const hasCode = linkedCode.length > 0;
      const hasTests = linkedTests.length > 0;
      const hasDocs = linkedDocs.length > 0;
      const coverage = ((hasCode ? 33 : 0) + (hasTests ? 33 : 0) + (hasDocs ? 34 : 0));

      const mdRow = [
        `**${reqId}**`,
        linkedCode.length > 0 ? linkedCode.join('<br>') : '*NONE*',
        linkedTests.length > 0 ? linkedTests.join('<br>') : '*NONE*',
        linkedDocs.length > 0 ? linkedDocs.join('<br>') : '*NONE*',
        this.getCoverageEmoji(coverage) + ` ${coverage}%`
      ];

      if (options.includeVerification) {
        const verified = row.every(cell => !cell.linked || cell.verified);
        mdRow.push(verified ? '✅' : '❌');
      }

      if (options.includeConfidence) {
        const avgConfidence = row.length > 0
          ? row.reduce((sum, cell) => sum + cell.confidence, 0) / row.length
          : 0;
        mdRow.push(`${(avgConfidence * 100).toFixed(1)}%`);
      }

      lines.push('| ' + mdRow.join(' | ') + ' |');
    }

    return lines.join('\n');
  }

  /**
   * Export matrix to HTML format
   */
  exportToHTML(matrix: TraceabilityMatrix, options: MatrixExportOptions = { format: 'html' }): string {
    const lines: string[] = [];

    // HTML header
    lines.push('<!DOCTYPE html>');
    lines.push('<html lang="en">');
    lines.push('<head>');
    lines.push('  <meta charset="UTF-8">');
    lines.push('  <meta name="viewport" content="width=device-width, initial-scale=1.0">');
    lines.push('  <title>Traceability Matrix</title>');
    lines.push('  <style>');
    lines.push('    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }');
    lines.push('    h1 { color: #333; }');
    lines.push('    table { width: 100%; border-collapse: collapse; background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }');
    lines.push('    th, td { padding: 12px; text-align: left; border: 1px solid #ddd; }');
    lines.push('    th { background: #4CAF50; color: white; font-weight: bold; }');
    lines.push('    tr:nth-child(even) { background: #f9f9f9; }');
    lines.push('    tr:hover { background: #f1f1f1; }');
    lines.push('    .coverage-high { color: #4CAF50; font-weight: bold; }');
    lines.push('    .coverage-medium { color: #FF9800; font-weight: bold; }');
    lines.push('    .coverage-low { color: #f44336; font-weight: bold; }');
    lines.push('    .verified { color: #4CAF50; }');
    lines.push('    .not-verified { color: #f44336; }');
    lines.push('    .none { color: #999; font-style: italic; }');
    lines.push('    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }');
    lines.push('  </style>');
    lines.push('</head>');
    lines.push('<body>');
    lines.push('  <h1>Traceability Matrix</h1>');
    lines.push(`  <p>Generated: ${new Date().toISOString()}</p>`);
    lines.push(`  <p>Total Requirements: ${matrix.requirements.length}</p>`);
    lines.push('  <table>');

    // Table header
    lines.push('    <thead>');
    lines.push('      <tr>');
    lines.push('        <th>Requirement</th>');
    lines.push('        <th>Code Files</th>');
    lines.push('        <th>Tests</th>');
    lines.push('        <th>Documentation</th>');
    lines.push('        <th>Coverage</th>');
    if (options.includeVerification) lines.push('        <th>Verified</th>');
    if (options.includeConfidence) lines.push('        <th>Confidence</th>');
    lines.push('      </tr>');
    lines.push('    </thead>');

    // Table body
    lines.push('    <tbody>');
    for (let i = 0; i < matrix.requirements.length; i++) {
      const reqId = matrix.requirements[i];
      const row = matrix.links[i];

      // Find linked items
      const linkedCode = row.filter(cell => cell.itemType === 'code' && cell.linked).map(cell => cell.itemPath);
      const linkedTests = row.filter(cell => cell.itemType === 'test' && cell.linked).map(cell => cell.itemPath);
      const linkedDocs = row.filter(cell => cell.itemType === 'documentation' && cell.linked).map(cell => cell.itemPath);

      // Calculate coverage
      const hasCode = linkedCode.length > 0;
      const hasTests = linkedTests.length > 0;
      const hasDocs = linkedDocs.length > 0;
      const coverage = ((hasCode ? 33 : 0) + (hasTests ? 33 : 0) + (hasDocs ? 34 : 0));

      const coverageClass = coverage >= 75 ? 'coverage-high' : coverage >= 50 ? 'coverage-medium' : 'coverage-low';

      lines.push('      <tr>');
      lines.push(`        <td><strong>${this.escapeHTML(reqId)}</strong></td>`);
      lines.push(`        <td>${linkedCode.length > 0 ? linkedCode.map(f => `<code>${this.escapeHTML(f)}</code>`).join('<br>') : '<span class="none">NONE</span>'}</td>`);
      lines.push(`        <td>${linkedTests.length > 0 ? linkedTests.map(f => `<code>${this.escapeHTML(f)}</code>`).join('<br>') : '<span class="none">NONE</span>'}</td>`);
      lines.push(`        <td>${linkedDocs.length > 0 ? linkedDocs.map(f => `<code>${this.escapeHTML(f)}</code>`).join('<br>') : '<span class="none">NONE</span>'}</td>`);
      lines.push(`        <td class="${coverageClass}">${coverage}%</td>`);

      if (options.includeVerification) {
        const verified = row.every(cell => !cell.linked || cell.verified);
        lines.push(`        <td class="${verified ? 'verified' : 'not-verified'}">${verified ? '✅ YES' : '❌ NO'}</td>`);
      }

      if (options.includeConfidence) {
        const avgConfidence = row.length > 0
          ? row.reduce((sum, cell) => sum + cell.confidence, 0) / row.length
          : 0;
        lines.push(`        <td>${(avgConfidence * 100).toFixed(1)}%</td>`);
      }

      lines.push('      </tr>');
    }
    lines.push('    </tbody>');
    lines.push('  </table>');
    lines.push('</body>');
    lines.push('</html>');

    return lines.join('\n');
  }

  /**
   * Escape CSV values
   */
  private escapeCSV(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  /** Escape a value without changing commas, which are ordinary TSV data. */
  private escapeTSV(value: string): string {
    if (value.includes('\t') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  /**
   * Escape HTML entities
   */
  private escapeHTML(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Format file path for display (shorten if too long)
   */
  private formatPath(filePath: string): string {
    if (filePath.length <= 40) return filePath;

    const parts = filePath.split('/');
    if (parts.length <= 2) return filePath;

    // Show first and last parts
    return `${parts[0]}/.../${parts[parts.length - 1]}`;
  }

  /**
   * Get coverage emoji
   */
  private getCoverageEmoji(coverage: number): string {
    if (coverage >= 75) return '✅';
    if (coverage >= 50) return '⚠️';
    return '❌';
  }
}
