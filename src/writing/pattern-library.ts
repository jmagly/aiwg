/**
 * Pattern Library
 *
 * Comprehensive, categorized database of AI writing patterns with detection algorithms,
 * severity levels, and replacement suggestions.
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import * as yaml from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type PatternCategory =
  | 'banned-phrases'
  | 'formulaic-structures'
  | 'hedging-language'
  | 'transition-words'
  | 'weak-verbs'
  | 'passive-voice'
  | 'generic-adjectives'
  | 'list-structures'
  | 'conclusion-phrases'
  | 'introduction-phrases';

export type PatternSeverity = 'critical' | 'high' | 'medium' | 'low' | 'warning' | 'info';
export type PatternFrequency = 'very-common' | 'common' | 'occasional' | 'rare';
export type PatternDomain = 'academic' | 'technical' | 'executive' | 'casual';

export interface AIPattern {
  id: string;
  category: PatternCategory;
  subcategory?: string;
  pattern: string | RegExp;
  severity: PatternSeverity;
  confidence: number; // 0-1: How strongly this indicates AI
  examples: string[];
  replacements?: string[];
  context?: string;
  frequency: PatternFrequency;
  domains?: PatternDomain[];
}

export interface PatternMatch {
  pattern: AIPattern;
  match: string;
  position: { start: number; end: number };
  context: string;
  severity: PatternSeverity;
}

export interface PatternFilter {
  categories?: PatternCategory[];
  severities?: PatternSeverity[];
  domains?: PatternDomain[];
  minConfidence?: number;
  maxConfidence?: number;
  frequencies?: PatternFrequency[];
  subcategories?: string[];
}

export interface PatternAnalysisResult {
  totalMatches: number;
  matchesByCategory: Map<PatternCategory, number>;
  matchesBySeverity: Map<PatternSeverity, number>;
  uniquePatterns: number;
  averageConfidence: number;
  criticalMatches: PatternMatch[];
  highPriorityMatches: PatternMatch[];
  wordCount: number;
  patternDensity: number; // Matches per 100 words
}

export interface PatternComparisonResult {
  text1Matches: number;
  text2Matches: number;
  improvement: number; // Percentage reduction in patterns
  addedPatterns: PatternMatch[];
  removedPatterns: PatternMatch[];
  persistentPatterns: PatternMatch[];
}

/**
 * Pattern Library - Comprehensive AI pattern detection database
 */
export class PatternLibrary {
  private patterns: AIPattern[] = [];
  private patternsByCategory: Map<PatternCategory, AIPattern[]> = new Map();
  private patternsBySeverity: Map<PatternSeverity, AIPattern[]> = new Map();
  private patternsById: Map<string, AIPattern> = new Map();
  private initialized = false;

  constructor() {
    // Patterns loaded on first use (lazy loading)
  }

  /**
   * Initialize the library by loading all patterns
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const patternsDir = join(__dirname, 'patterns');
    const patternFiles = [
      'banned-phrases.json',
      'formulaic-structures.json',
      'hedging-language.json',
      'weak-verbs.json',
      'generic-adjectives.json',
      'transition-words.json'
    ];

    for (const file of patternFiles) {
      const filePath = join(patternsDir, file);
      if (existsSync(filePath)) {
        const content = await readFile(filePath, 'utf-8');
        const filePatterns: AIPattern[] = JSON.parse(content);

        // Convert string patterns to RegExp
        for (const pattern of filePatterns) {
          if (typeof pattern.pattern === 'string') {
            pattern.pattern = this.createRegExpFromPattern(pattern.pattern);
          }
          this.addPattern(pattern);
        }
      }
    }

    this.initialized = true;
  }

  /**
   * Get all patterns
   */
  getAllPatterns(): AIPattern[] {
    return [...this.patterns];
  }

  /**
   * Get pattern by ID
   */
  getPatternById(id: string): AIPattern | undefined {
    return this.patternsById.get(id);
  }

  /**
   * Get patterns by category
   */
  getPatternsByCategory(category: PatternCategory): AIPattern[] {
    return this.patternsByCategory.get(category) || [];
  }

  /**
   * Get patterns by severity
   */
  getPatternsBySeverity(severity: PatternSeverity): AIPattern[] {
    return this.patternsBySeverity.get(severity) || [];
  }

  /**
   * Get patterns by domain
   */
  getPatternsByDomain(domain: PatternDomain): AIPattern[] {
    return this.patterns.filter(p =>
      !p.domains || p.domains.length === 0 || p.domains.includes(domain)
    );
  }

  /**
   * Detect all patterns in text
   */
  detectPatterns(text: string): PatternMatch[] {
    const matches: PatternMatch[] = [];

    for (const pattern of this.patterns) {
      const patternMatches = this.findPatternMatches(text, pattern);
      matches.push(...patternMatches);
    }

    return matches;
  }

  /**
   * Detect patterns by category
   */
  detectPatternsByCategory(text: string, category: PatternCategory): PatternMatch[] {
    const categoryPatterns = this.getPatternsByCategory(category);
    const matches: PatternMatch[] = [];

    for (const pattern of categoryPatterns) {
      const patternMatches = this.findPatternMatches(text, pattern);
      matches.push(...patternMatches);
    }

    return matches;
  }

  /**
   * Detect only critical patterns
   */
  detectCriticalPatterns(text: string): PatternMatch[] {
    const criticalPatterns = this.getPatternsBySeverity('critical');
    const matches: PatternMatch[] = [];

    for (const pattern of criticalPatterns) {
      const patternMatches = this.findPatternMatches(text, pattern);
      matches.push(...patternMatches);
    }

    return matches;
  }

  /**
   * Get pattern count
   */
  getPatternCount(): number {
    return this.patterns.length;
  }

  /**
   * Get pattern count by category
   */
  getPatternCountByCategory(): Map<PatternCategory, number> {
    const counts = new Map<PatternCategory, number>();

    for (const [category, patterns] of this.patternsByCategory) {
      counts.set(category, patterns.length);
    }

    return counts;
  }

  /**
   * Get pattern count by severity
   */
  getPatternCountBySeverity(): Map<PatternSeverity, number> {
    const counts = new Map<PatternSeverity, number>();

    for (const [severity, patterns] of this.patternsBySeverity) {
      counts.set(severity, patterns.length);
    }

    return counts;
  }

  /**
   * Add a new pattern
   */
  addPattern(pattern: AIPattern): void {
    // Check for duplicate ID
    if (this.patternsById.has(pattern.id)) {
      throw new Error(`Pattern with ID "${pattern.id}" already exists`);
    }

    this.patterns.push(pattern);
    this.patternsById.set(pattern.id, pattern);

    // Add to category index
    if (!this.patternsByCategory.has(pattern.category)) {
      this.patternsByCategory.set(pattern.category, []);
    }
    this.patternsByCategory.get(pattern.category)!.push(pattern);

    // Add to severity index
    if (!this.patternsBySeverity.has(pattern.severity)) {
      this.patternsBySeverity.set(pattern.severity, []);
    }
    this.patternsBySeverity.get(pattern.severity)!.push(pattern);
  }

  /**
   * Remove a pattern by ID
   */
  removePattern(id: string): void {
    const pattern = this.patternsById.get(id);
    if (!pattern) {
      return;
    }

    // Remove from main array
    const index = this.patterns.findIndex(p => p.id === id);
    if (index !== -1) {
      this.patterns.splice(index, 1);
    }

    // Remove from indices
    this.patternsById.delete(id);

    const categoryPatterns = this.patternsByCategory.get(pattern.category);
    if (categoryPatterns) {
      const catIndex = categoryPatterns.findIndex(p => p.id === id);
      if (catIndex !== -1) {
        categoryPatterns.splice(catIndex, 1);
      }
    }

    const severityPatterns = this.patternsBySeverity.get(pattern.severity);
    if (severityPatterns) {
      const sevIndex = severityPatterns.findIndex(p => p.id === id);
      if (sevIndex !== -1) {
        severityPatterns.splice(sevIndex, 1);
      }
    }
  }

  /**
   * Update a pattern
   */
  updatePattern(id: string, updates: Partial<AIPattern>): void {
    const pattern = this.patternsById.get(id);
    if (!pattern) {
      throw new Error(`Pattern with ID "${id}" not found`);
    }

    // If category or severity changes, need to update indices
    if (updates.category && updates.category !== pattern.category) {
      // Remove from old category
      const oldCategoryPatterns = this.patternsByCategory.get(pattern.category);
      if (oldCategoryPatterns) {
        const index = oldCategoryPatterns.findIndex(p => p.id === id);
        if (index !== -1) {
          oldCategoryPatterns.splice(index, 1);
        }
      }

      // Add to new category
      if (!this.patternsByCategory.has(updates.category)) {
        this.patternsByCategory.set(updates.category, []);
      }
      this.patternsByCategory.get(updates.category)!.push(pattern);
    }

    if (updates.severity && updates.severity !== pattern.severity) {
      // Remove from old severity
      const oldSeverityPatterns = this.patternsBySeverity.get(pattern.severity);
      if (oldSeverityPatterns) {
        const index = oldSeverityPatterns.findIndex(p => p.id === id);
        if (index !== -1) {
          oldSeverityPatterns.splice(index, 1);
        }
      }

      // Add to new severity
      if (!this.patternsBySeverity.has(updates.severity)) {
        this.patternsBySeverity.set(updates.severity, []);
      }
      this.patternsBySeverity.get(updates.severity)!.push(pattern);
    }

    // Apply updates
    Object.assign(pattern, updates);
  }

  /**
   * Search patterns by query string
   */
  searchPatterns(query: string): AIPattern[] {
    const lowerQuery = query.toLowerCase();

    return this.patterns.filter(pattern => {
      return (
        pattern.id.toLowerCase().includes(lowerQuery) ||
        pattern.category.toLowerCase().includes(lowerQuery) ||
        (pattern.subcategory && pattern.subcategory.toLowerCase().includes(lowerQuery)) ||
        (pattern.context && pattern.context.toLowerCase().includes(lowerQuery)) ||
        pattern.examples.some(ex => ex.toLowerCase().includes(lowerQuery)) ||
        (pattern.replacements && pattern.replacements.some(r => r.toLowerCase().includes(lowerQuery)))
      );
    });
  }

  /**
   * Filter patterns by criteria
   */
  filterPatterns(filter: PatternFilter): AIPattern[] {
    let filtered = [...this.patterns];

    if (filter.categories && filter.categories.length > 0) {
      filtered = filtered.filter(p => filter.categories!.includes(p.category));
    }

    if (filter.severities && filter.severities.length > 0) {
      filtered = filtered.filter(p => filter.severities!.includes(p.severity));
    }

    if (filter.domains && filter.domains.length > 0) {
      filtered = filtered.filter(p =>
        !p.domains || p.domains.length === 0 ||
        p.domains.some(d => filter.domains!.includes(d))
      );
    }

    if (filter.minConfidence !== undefined) {
      filtered = filtered.filter(p => p.confidence >= filter.minConfidence!);
    }

    if (filter.maxConfidence !== undefined) {
      filtered = filtered.filter(p => p.confidence <= filter.maxConfidence!);
    }

    if (filter.frequencies && filter.frequencies.length > 0) {
      filtered = filtered.filter(p => filter.frequencies!.includes(p.frequency));
    }

    if (filter.subcategories && filter.subcategories.length > 0) {
      filtered = filtered.filter(p =>
        p.subcategory && filter.subcategories!.includes(p.subcategory)
      );
    }

    return filtered;
  }

  /**
   * Export patterns in various formats
   */
  exportPatterns(format: 'json' | 'yaml' | 'markdown'): string {
    // RegExp objects otherwise serialize as {}, losing executable behavior.
    const serialized = this.patterns.map(pattern => ({
      ...pattern,
      pattern: pattern.pattern instanceof RegExp
        ? { source: pattern.pattern.source, flags: pattern.pattern.flags }
        : pattern.pattern
    }));
    switch (format) {
      case 'json':
        return JSON.stringify(serialized, null, 2);

      case 'yaml':
        return yaml.stringify(serialized);

      case 'markdown':
        return this.exportAsMarkdown();

      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  /**
   * Import patterns from JSON or YAML
   */
  importPatterns(data: string, format: 'json' | 'yaml'): void {
    let patterns: Array<Omit<AIPattern, 'pattern'> & { pattern: unknown }>;

    if (format === 'json') {
      patterns = JSON.parse(data);
    } else if (format === 'yaml') {
      patterns = yaml.parse(data);
    } else {
      throw new Error(`Unsupported import format: ${format}`);
    }

    if (!Array.isArray(patterns)) {
      throw new Error('Imported patterns must be an array');
    }
    // Compile the complete input before changing any library index.
    const compiled = patterns.map(pattern => {
      const value = pattern?.pattern;
      let regex: RegExp;
      if (typeof value === 'string') {
        regex = this.createRegExpFromPattern(value);
      } else if (value && typeof value === 'object' &&
        'source' in value && typeof value.source === 'string' &&
        'flags' in value && typeof value.flags === 'string') {
        regex = new RegExp(value.source, value.flags);
      } else {
        throw new Error('Invalid pattern: expected a phrase string or regex source/flags');
      }
      return { ...pattern, pattern: regex };
    });

    for (const pattern of compiled) {
      // Skip duplicates
      if (!this.patternsById.has(pattern.id)) {
        this.addPattern(pattern);
      }
    }
  }

  /**
   * Analyze text for AI patterns
   */
  analyzeText(text: string): PatternAnalysisResult {
    const matches = this.detectPatterns(text);
    const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;

    const matchesByCategory = new Map<PatternCategory, number>();
    const matchesBySeverity = new Map<PatternSeverity, number>();
    const uniquePatternIds = new Set<string>();
    let totalConfidence = 0;

    for (const match of matches) {
      // Count by category
      const catCount = matchesByCategory.get(match.pattern.category) || 0;
      matchesByCategory.set(match.pattern.category, catCount + 1);

      // Count by severity
      const sevCount = matchesBySeverity.get(match.severity) || 0;
      matchesBySeverity.set(match.severity, sevCount + 1);

      // Track unique patterns
      uniquePatternIds.add(match.pattern.id);

      // Sum confidence
      totalConfidence += match.pattern.confidence;
    }

    const criticalMatches = matches.filter(m => m.severity === 'critical');
    const highPriorityMatches = matches.filter(m =>
      m.severity === 'critical' || m.severity === 'high'
    );

    return {
      totalMatches: matches.length,
      matchesByCategory,
      matchesBySeverity,
      uniquePatterns: uniquePatternIds.size,
      averageConfidence: matches.length > 0 ? totalConfidence / matches.length : 0,
      criticalMatches,
      highPriorityMatches,
      wordCount,
      patternDensity: wordCount > 0 ? (matches.length / wordCount) * 100 : 0
    };
  }

  /**
   * Compare two texts for pattern changes
   */
  compareTexts(text1: string, text2: string): PatternComparisonResult {
    const matches1 = this.detectPatterns(text1);
    const matches2 = this.detectPatterns(text2);

    // Calculate improvement
    const improvement = matches1.length > 0
      ? ((matches1.length - matches2.length) / matches1.length) * 100
      : 0;

    // Find pattern differences
    const patterns1 = new Set(matches1.map(m => m.pattern.id));
    const patterns2 = new Set(matches2.map(m => m.pattern.id));

    const addedPatterns = matches2.filter(m => !patterns1.has(m.pattern.id));
    const removedPatterns = matches1.filter(m => !patterns2.has(m.pattern.id));
    const persistentPatterns = matches2.filter(m => patterns1.has(m.pattern.id));

    return {
      text1Matches: matches1.length,
      text2Matches: matches2.length,
      improvement,
      addedPatterns,
      removedPatterns,
      persistentPatterns
    };
  }

  // Private helper methods

  /**
   * Find all matches of a pattern in text
   */
  private findPatternMatches(text: string, pattern: AIPattern): PatternMatch[] {
    const matches: PatternMatch[] = [];
    const regex = pattern.pattern as RegExp;

    // Reset regex state
    regex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      // Extract context (50 chars before and after)
      const contextStart = Math.max(0, start - 50);
      const contextEnd = Math.min(text.length, end + 50);
      const context = text.substring(contextStart, contextEnd);

      matches.push({
        pattern,
        match: match[0],
        position: { start, end },
        context,
        severity: pattern.severity
      });

      // Prevent infinite loop on zero-width matches
      if (match[0].length === 0) {
        regex.lastIndex++;
      }
    }

    return matches;
  }

  /**
   * Create RegExp from pattern string
   */
  private createRegExpFromPattern(patternStr: string): RegExp {
    // Check if pattern starts with ^ (line start anchor)
    const isLineStart = patternStr.startsWith('^');

    // Handle special pattern syntax
    if (patternStr.includes('\\b')) {
      // Already has word boundaries
      return new RegExp(patternStr, 'gi');
    } else if (isLineStart) {
      // Line start patterns don't need word boundaries
      return new RegExp(patternStr, 'gm');
    } else {
      // Add word boundaries for phrase matching
      const escaped = patternStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Check if pattern ends in punctuation - if so, don't add trailing word boundary
      const endsWithPunctuation = /[,.:;!?]$/.test(patternStr);
      const startBoundary = '\\b';
      const endBoundary = endsWithPunctuation ? '' : '\\b';
      return new RegExp(`${startBoundary}${escaped}${endBoundary}`, 'gi');
    }
  }

  /**
   * Export patterns as markdown documentation
   */
  private exportAsMarkdown(): string {
    const lines: string[] = [];

    lines.push('# AI Writing Patterns Library\n');
    lines.push(`Total Patterns: ${this.patterns.length}\n`);

    // Group by category
    const categories = Array.from(this.patternsByCategory.keys()).sort();

    for (const category of categories) {
      const categoryPatterns = this.patternsByCategory.get(category)!;
      lines.push(`## ${category} (${categoryPatterns.length} patterns)\n`);

      // Group by subcategory
      const subcategories = new Map<string, AIPattern[]>();
      for (const pattern of categoryPatterns) {
        const subcat = pattern.subcategory || 'General';
        if (!subcategories.has(subcat)) {
          subcategories.set(subcat, []);
        }
        subcategories.get(subcat)!.push(pattern);
      }

      for (const [subcat, patterns] of subcategories) {
        lines.push(`### ${subcat}\n`);

        for (const pattern of patterns) {
          lines.push(`**${pattern.id}** (${pattern.severity}, confidence: ${pattern.confidence})`);
          lines.push(`- Pattern: \`${pattern.pattern}\``);
          lines.push(`- Context: ${pattern.context}`);
          lines.push(`- Examples:`);
          for (const example of pattern.examples.slice(0, 2)) {
            lines.push(`  - "${example}"`);
          }
          if (pattern.replacements && pattern.replacements.length > 0) {
            lines.push(`- Replacements:`);
            for (const replacement of pattern.replacements.slice(0, 2)) {
              lines.push(`  - ${replacement}`);
            }
          }
          lines.push('');
        }
      }
    }

    return lines.join('\n');
  }
}
