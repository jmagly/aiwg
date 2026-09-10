/**
 * ID Extractor - Extract requirement IDs from various file types
 * Supports: Use Cases (UC-xxx), NFRs (NFR-XXX-xxx), User Stories (US-xxx), Features (F-xxx)
 */

export interface RequirementId {
  id: string;
  type: 'use-case' | 'nfr' | 'user-story' | 'feature' | 'acceptance-criteria';
  lineNumber?: number;
  context?: string;
}

export interface ExtractionResult {
  filePath: string;
  ids: RequirementId[];
  extractionTime: number;
}

/**
 * IDExtractor - Extract requirement IDs from code, tests, and documentation
 */
export class IDExtractor {
  // Regex patterns for different ID types
  private readonly patterns = {
    useCase: /\bUC-\d{3}\b/g,
    nfr: /\bNFR-[A-Z]{3,10}-\d{3}\b/g,
    userStory: /\bUS-\d{3}\b/g,
    feature: /\bF-\d{3}\b/g,
    acceptanceCriteria: /\bAC-\d{3}\b/g
  };

  // Combined pattern for all ID types
  private readonly combinedPattern = /\b(?:UC-\d{3}|NFR-[A-Z]{3,10}-\d{3}|US-\d{3}|F-\d{3}|AC-\d{3})\b/g;

  /**
   * Extract IDs from a single line of text
   */
  extractFromLine(line: string, lineNumber?: number): RequirementId[] {
    const ids: RequirementId[] = [];
    const matches = line.match(this.combinedPattern);

    if (!matches) {
      return ids;
    }

    // Remove duplicates
    const uniqueMatches = Array.from(new Set(matches));

    for (const id of uniqueMatches) {
      ids.push({
        id,
        type: this.determineType(id),
        lineNumber,
        context: this.extractContext(line, id)
      });
    }

    return ids;
  }

  /**
   * Extract IDs from file content
   */
  extractFromContent(content: string, _filePath?: string): RequirementId[] {
    const lines = content.split('\n');
    const allIds: RequirementId[] = [];

    for (let i = 0; i < lines.length; i++) {
      const lineIds = this.extractFromLine(lines[i], i + 1);
      allIds.push(...lineIds);
    }

    // Remove duplicate IDs (keep first occurrence)
    const seen = new Set<string>();
    const uniqueIds: RequirementId[] = [];

    for (const reqId of allIds) {
      if (!seen.has(reqId.id)) {
        seen.add(reqId.id);
        uniqueIds.push(reqId);
      }
    }

    return uniqueIds;
  }

  /**
   * Extract IDs from multiple files (parallel processing)
   */
  async extractFromFiles(files: Map<string, string>): Promise<Map<string, ExtractionResult>> {
    const results = new Map<string, ExtractionResult>();

    // Process all files in parallel
    const promises = Array.from(files.entries()).map(async ([filePath, content]) => {
      const startTime = performance.now();
      const ids = this.extractFromContent(content, filePath);
      const extractionTime = performance.now() - startTime;

      return {
        filePath,
        result: {
          filePath,
          ids,
          extractionTime
        }
      };
    });

    const completed = await Promise.all(promises);

    for (const { filePath, result } of completed) {
      results.set(filePath, result);
    }

    return results;
  }

  /**
   * Determine requirement type from ID pattern
   */
  private determineType(id: string): RequirementId['type'] {
    if (id.startsWith('UC-')) return 'use-case';
    if (id.startsWith('NFR-')) return 'nfr';
    if (id.startsWith('US-')) return 'user-story';
    if (id.startsWith('F-')) return 'feature';
    if (id.startsWith('AC-')) return 'acceptance-criteria';

    // Should never happen due to regex, but TypeScript needs it
    return 'use-case';
  }

  /**
   * Extract context around the ID (up to 50 characters before/after)
   */
  private extractContext(line: string, id: string): string {
    const index = line.indexOf(id);
    if (index === -1) return line.trim();

    const start = Math.max(0, index - 50);
    const end = Math.min(line.length, index + id.length + 50);

    let context = line.substring(start, end).trim();

    // Add ellipsis if truncated
    if (start > 0) context = '...' + context;
    if (end < line.length) context = context + '...';

    return context;
  }

  /**
   * Validate ID format
   */
  isValidId(id: string): boolean {
    const pattern = /\b(?:UC-\d{3}|NFR-[A-Z]{3,10}-\d{3}|US-\d{3}|F-\d{3}|AC-\d{3})\b/;
    return pattern.test(id);
  }

  /**
   * Parse ID to extract components (e.g., NFR-PERF-001 -> {prefix: 'NFR', category: 'PERF', number: '001'})
   */
  parseId(id: string): { prefix: string; category?: string; number: string } | null {
    // Use case: UC-001
    const ucMatch = id.match(/^(UC)-(\d{3})$/);
    if (ucMatch) {
      return { prefix: ucMatch[1], number: ucMatch[2] };
    }

    // NFR: NFR-PERF-001
    const nfrMatch = id.match(/^(NFR)-([A-Z]{3,10})-(\d{3})$/);
    if (nfrMatch) {
      return { prefix: nfrMatch[1], category: nfrMatch[2], number: nfrMatch[3] };
    }

    // User Story: US-001
    const usMatch = id.match(/^(US)-(\d{3})$/);
    if (usMatch) {
      return { prefix: usMatch[1], number: usMatch[2] };
    }

    // Feature: F-001
    const fMatch = id.match(/^(F)-(\d{3})$/);
    if (fMatch) {
      return { prefix: fMatch[1], number: fMatch[2] };
    }

    // Acceptance Criteria: AC-001
    const acMatch = id.match(/^(AC)-(\d{3})$/);
    if (acMatch) {
      return { prefix: acMatch[1], number: acMatch[2] };
    }

    return null;
  }

  /**
   * Get all patterns for testing/validation
   */
  getPatterns() {
    return { ...this.patterns };
  }
}
