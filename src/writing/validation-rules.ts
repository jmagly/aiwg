/**
 * Validation Rules Module
 *
 * Loads and manages validation rules from AIWG markdown files.
 * Provides structured rule definitions for banned phrases, AI patterns, and authenticity markers.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { rhetoricalTriad } from './current-patterns.js';

export type ValidationContext = 'academic' | 'technical' | 'executive' | 'casual';
export type RuleType = 'banned_phrase' | 'ai_pattern' | 'authenticity_marker' | 'formulaic_structure';
export type Severity = 'critical' | 'warning' | 'info';

export interface ValidationRule {
  id: string;
  type: RuleType;
  pattern: string | RegExp;
  severity: Severity;
  message: string;
  suggestion?: string;
  contexts?: ValidationContext[];
  category?: string;
}

export interface RuleSet {
  bannedPhrases: ValidationRule[];
  aiPatterns: ValidationRule[];
  authenticityMarkers: ValidationRule[];
  structuralPatterns: ValidationRule[];
}

/**
 * Loads validation rules from AIWG markdown files
 */
export class ValidationRuleLoader {
  private ruleCache: Map<string, RuleSet> = new Map();

  constructor(private guideBasePath?: string) {
    // Default to ~/.local/share/ai-writing-guide if not specified
    this.guideBasePath = guideBasePath || join(process.env.HOME || '', '.local/share/ai-writing-guide');
  }

  /**
   * Load complete rule set from AIWG
   */
  async loadRuleSet(): Promise<RuleSet> {
    const cacheKey = this.guideBasePath || 'default';

    if (this.ruleCache.has(cacheKey)) {
      return this.ruleCache.get(cacheKey)!;
    }

    // New addon structure paths (preferred)
    const addonBase = join(this.guideBasePath!, 'agentic', 'code', 'addons', 'writing-quality');
    // Legacy paths (fallback for backward compatibility)
    const legacyBase = this.guideBasePath!;

    // Check for addon structure first, fall back to legacy
    const bannedPatternsPath = existsSync(join(addonBase, 'validation/banned-patterns.md'))
      ? join(addonBase, 'validation/banned-patterns.md')
      : join(legacyBase, 'validation/banned-patterns.md');
    const aiTellsPath = existsSync(join(addonBase, 'patterns/common-ai-tells.md'))
      ? join(addonBase, 'patterns/common-ai-tells.md')
      : join(legacyBase, 'patterns/common-ai-tells.md');
    const sophisticationPath = existsSync(join(addonBase, 'core/sophistication-guide.md'))
      ? join(addonBase, 'core/sophistication-guide.md')
      : join(legacyBase, 'core/sophistication-guide.md');

    // Start with default rules (core patterns that should always be present)
    const defaults = this.getDefaultRules();
    const ruleSet: RuleSet = {
      bannedPhrases: [...defaults.bannedPhrases],
      aiPatterns: [...defaults.aiPatterns],
      authenticityMarkers: [...defaults.authenticityMarkers],
      structuralPatterns: [...defaults.structuralPatterns]
    };

    // Load and merge banned phrases from guide
    if (existsSync(bannedPatternsPath)) {
      const bannedRules = await this.loadFromMarkdown(bannedPatternsPath);
      ruleSet.bannedPhrases = this.mergeRules(ruleSet.bannedPhrases, bannedRules.filter(r => r.type === 'banned_phrase'));
      ruleSet.structuralPatterns = this.mergeRules(ruleSet.structuralPatterns, bannedRules.filter(r => r.type === 'formulaic_structure'));
    }

    // Load and merge AI tells from guide
    if (existsSync(aiTellsPath)) {
      const aiRules = await this.loadFromMarkdown(aiTellsPath);
      ruleSet.aiPatterns = this.mergeRules(ruleSet.aiPatterns, aiRules);
    }

    // Load authenticity markers from sophistication guide
    if (existsSync(sophisticationPath)) {
      const authRules = await this.loadAuthenticityMarkers(sophisticationPath);
      ruleSet.authenticityMarkers = this.mergeRules(ruleSet.authenticityMarkers, authRules);
    }

    this.ruleCache.set(cacheKey, ruleSet);
    return ruleSet;
  }

  /**
   * Load rules from a markdown file
   */
  async loadFromMarkdown(path: string): Promise<ValidationRule[]> {
    if (!existsSync(path)) {
      return [];
    }

    const content = await readFile(path, 'utf-8');
    return this.parseMarkdownRules(content, path);
  }

  /**
   * Parse markdown content into validation rules
   */
  private parseMarkdownRules(markdown: string, sourcePath: string): ValidationRule[] {
    const rules: ValidationRule[] = [];
    const lines = markdown.split('\n');

    let currentSection = '';
    let currentCategory = '';
    let currentSeverity: Severity = 'warning';

    // Determine base severity from file type
    if (sourcePath.includes('banned-patterns')) {
      currentSeverity = 'critical';
    } else if (sourcePath.includes('common-ai-tells')) {
      currentSeverity = 'warning';
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Track sections for context
      if (line.startsWith('## ')) {
        currentSection = line.replace('## ', '');
        currentCategory = currentSection;
      } else if (line.startsWith('### ')) {
        currentCategory = line.replace('### ', '');
      }

      // Parse banned phrase patterns
      if (line.startsWith('- ')) {
        const phrase = line.substring(2).trim();

        // Skip example lines, explanations, and replacement guides
        if (phrase.startsWith('❌') || phrase.startsWith('✅') || phrase.startsWith('**')) {
          continue;
        }

        // Skip replacement guide lines (e.g., "revolutionary" → "different")
        if (phrase.includes('→') || phrase.includes('->')) {
          continue;
        }

        // Skip lines that are quoted replacement mappings (e.g., "phrase" → "replacement")
        if (phrase.startsWith('"') && (phrase.includes('→') || phrase.includes('->'))) {
          continue;
        }

        const rule = this.createRuleFromPhrase(phrase, currentCategory, currentSeverity, sourcePath);
        if (rule) {
          rules.push(rule);
        }
      }

      // Parse structural patterns
      if (line.includes('❌') && line.includes('"')) {
        const matches = line.match(/"([^"]+)"/g);
        if (matches) {
          matches.forEach(match => {
            const pattern = match.replace(/"/g, '');
            const rule: ValidationRule = {
              id: `struct_${this.generateId(pattern)}`,
              type: 'formulaic_structure',
              pattern: this.createPattern(pattern),
              severity: 'warning',
              message: `Formulaic structure detected: ${pattern}`,
              suggestion: this.extractSuggestion(line),
              category: currentCategory
            };
            rules.push(rule);
          });
        }
      }
    }

    return rules;
  }

  /**
   * Create a validation rule from a banned phrase
   */
  private createRuleFromPhrase(phrase: string, category: string, severity: Severity, sourcePath: string): ValidationRule | null {
    // Clean up the phrase
    let cleanPhrase = phrase;
    let suggestion: string | undefined;

    // Extract suggestion if present (format: "phrase (use X instead)")
    const suggestionMatch = phrase.match(/\(([^)]+)\)/);
    if (suggestionMatch) {
      suggestion = suggestionMatch[1];
      cleanPhrase = phrase.replace(/\([^)]+\)/, '').trim();
    }

    // Skip empty or meta-instructions
    if (!cleanPhrase || cleanPhrase.startsWith('just use')) {
      return null;
    }

    // Determine rule type
    let ruleType: RuleType = 'banned_phrase';
    if (category.toLowerCase().includes('structure') || category.toLowerCase().includes('pattern')) {
      ruleType = 'formulaic_structure';
    } else if (sourcePath.includes('ai-tells')) {
      ruleType = 'ai_pattern';
    }

    return {
      id: `${ruleType}_${this.generateId(cleanPhrase)}`,
      type: ruleType,
      pattern: this.createPattern(cleanPhrase),
      severity,
      message: `Avoid: "${cleanPhrase}" (${category})`,
      suggestion,
      category
    };
  }

  /**
   * Load authenticity markers from sophistication guide
   */
  private async loadAuthenticityMarkers(_path: string): Promise<ValidationRule[]> {
    const markers: ValidationRule[] = [];

    // Positive markers (things that indicate human writing)
    const humanMarkers = [
      { pattern: /\bI think\b/gi, message: 'Opinion statement (human marker)' },
      { pattern: /\bin my experience\b/gi, message: 'Personal experience (human marker)' },
      { pattern: /\bwe found that\b/gi, message: 'Specific finding (human marker)' },
      { pattern: /\bwe chose\b/gi, message: 'Decision explanation (human marker)' },
      { pattern: /\bwe decided\b/gi, message: 'Decision explanation (human marker)' },
      { pattern: /\bwhile .+ (is|was|are|were).+, .+ (must|should|need)/gi, message: 'Trade-off acknowledgment (human marker)' },
      { pattern: /\breduced .+ by \d+(%|ms|s|KB|MB)/gi, message: 'Specific metric (human marker)' },
      { pattern: /\bincreased .+ by \d+(%|ms|s|KB|MB)/gi, message: 'Specific metric (human marker)' },
      { pattern: /\bp\d{2} latency/gi, message: 'Specific performance metric (human marker)' },
      { pattern: /\bversion \d+\.\d+/gi, message: 'Specific version (human marker)' },
      { pattern: /\b\d+% (improvement|reduction|increase)/gi, message: 'Specific percentage (human marker)' }
    ];

    humanMarkers.forEach((marker, idx) => {
      markers.push({
        id: `auth_positive_${idx}`,
        type: 'authenticity_marker',
        pattern: marker.pattern,
        severity: 'info',
        message: marker.message,
        category: 'Human Markers'
      });
    });

    return markers;
  }

  /**
   * Create a regex pattern from a phrase string
   */
  private createPattern(phrase: string): RegExp {
    // Handle wildcard patterns (e.g., "vital/crucial/key" or "cutting-edge technology/solution")
    if (phrase.includes('/')) {
      // Split the phrase and check if we have multi-word alternatives
      // For "plays a vital/crucial/key role" we want to match the alternatives in context
      const parts = phrase.split('/').map(p => p.trim());

      // If first/last parts contain multi-word context, extract the common prefix/suffix
      // e.g., "cutting-edge technology/solution/platform" should match full phrases
      const firstPart = parts[0];
      const hasPrefix = firstPart.includes(' ');

      if (hasPrefix) {
        // Has leading context - match each alternative with the prefix
        // e.g., "seamlessly integrates/integrated" -> match "seamlessly integrates" OR "seamlessly integrated"
        const words = firstPart.split(' ');
        const prefix = words.slice(0, -1).join(' '); // All but last word
        const firstAlt = words[words.length - 1]; // Last word is first alternative

        const alternatives = [firstAlt, ...parts.slice(1)].map(alt => {
          const escaped = `${prefix} ${alt}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return escaped;
        });

        return new RegExp(`\\b(${alternatives.join('|')})\\b`, 'gi');
      }

      // Simple alternatives without context - escape each and join
      const alternatives = parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      return new RegExp(`\\b(${alternatives})\\b`, 'gi');
    }

    // Handle variable parts in brackets
    if (phrase.includes('[') && phrase.includes(']')) {
      const patternStr = phrase
        .replace(/\[([^\]]+)\]/g, '(?:$1)?')
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${patternStr}\\b`, 'gi');
    }

    // Standard phrase matching (word boundaries)
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'gi');
  }

  /**
   * Generate a unique ID from a phrase
   */
  private generateId(phrase: string): string {
    return phrase
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .substring(0, 50);
  }

  /**
   * Extract suggestion from a line
   */
  private extractSuggestion(line: string): string | undefined {
    const suggestionMatch = line.match(/✅[^"]*"([^"]+)"/);
    return suggestionMatch ? suggestionMatch[1] : undefined;
  }

  /**
   * Merge multiple rule sets
   */
  mergeRules(rules1: ValidationRule[], rules2: ValidationRule[]): ValidationRule[] {
    const merged = [...rules1];
    const existingIds = new Set(rules1.map(r => r.id));

    for (const rule of rules2) {
      if (!existingIds.has(rule.id)) {
        merged.push(rule);
        existingIds.add(rule.id);
      }
    }

    return merged;
  }

  /**
   * Filter rules by context
   */
  filterByContext(rules: ValidationRule[], context: ValidationContext): ValidationRule[] {
    return rules.filter(rule => {
      if (!rule.contexts || rule.contexts.length === 0) {
        return true; // Apply to all contexts if not specified
      }
      return rule.contexts.includes(context);
    });
  }

  /**
   * Get default rule set (built-in rules when guide is not available)
   */
  getDefaultRules(): RuleSet {
    return {
      bannedPhrases: this.getDefaultBannedPhrases(),
      aiPatterns: this.getDefaultAIPatterns(),
      authenticityMarkers: this.getDefaultAuthenticityMarkers(),
      structuralPatterns: this.getDefaultStructuralPatterns()
    };
  }

  private getDefaultBannedPhrases(): ValidationRule[] {
    const criticalPhrases = [
      'seamlessly', 'cutting-edge', 'state-of-the-art', 'revolutionary',
      'game-changing', 'paradigm shift', 'best-in-class', 'industry-leading',
      'comprehensive solution', 'robust and scalable', 'innovative approach',
      'next-generation', 'transformative', 'groundbreaking'
    ];

    return criticalPhrases.map((phrase, idx) => ({
      id: `default_banned_${idx}`,
      type: 'banned_phrase' as const,
      pattern: new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
      severity: 'critical' as const,
      message: `Banned phrase: "${phrase}"`,
      category: 'Critical Banned Phrases'
    }));
  }

  private getDefaultAIPatterns(): ValidationRule[] {
    return [
      {
        id: 'ai_moreover',
        type: 'ai_pattern',
        pattern: /^Moreover,/gm,
        severity: 'warning',
        message: 'Formulaic transition word',
        suggestion: 'Remove transition or rephrase',
        category: 'Transitions'
      },
      {
        id: 'ai_furthermore',
        type: 'ai_pattern',
        pattern: /^Furthermore,/gm,
        severity: 'warning',
        message: 'Formulaic transition word',
        suggestion: 'Remove transition or rephrase',
        category: 'Transitions'
      },
      {
        id: 'ai_in_conclusion',
        type: 'ai_pattern',
        pattern: /\bIn conclusion,/gi,
        severity: 'warning',
        message: 'Formulaic conclusion phrase',
        suggestion: 'Just end when done',
        category: 'Conclusions'
      }
    ];
  }

  private getDefaultAuthenticityMarkers(): ValidationRule[] {
    return [
      {
        id: 'auth_metric',
        type: 'authenticity_marker',
        pattern: /\d+(%|ms|s|KB|MB|GB|x)\b/g,
        severity: 'info',
        message: 'Specific metric found (human marker)',
        category: 'Metrics'
      }
    ];
  }

  private getDefaultStructuralPatterns(): ValidationRule[] {
    return [
      {
        id: 'struct_three_items',
        type: 'formulaic_structure',
        pattern: rhetoricalTriad,
        severity: 'info',
        message: 'Rhetorical three-item predicate detected',
        suggestion: 'Replace generic claims with supported details; retain real inventories',
        category: 'Lists'
      }
    ];
  }
}
