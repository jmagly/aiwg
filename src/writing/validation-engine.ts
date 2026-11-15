/**
 * Writing Validation Engine
 *
 * Contextual writing review with a deprecated heuristic scoring adapter.
 * Pattern matches and legacy scores do not establish human or machine authorship.
 *
 * @implements @.aiwg/requirements/use-cases/UC-001-validate-ai-generated-content.md
 * @architecture @docs/architecture/cli/index.md
 * @nfr @.aiwg/requirements/nfr-modules/performance.md - NFR-PERF-001 (<60s validation)
 * @nfr @.aiwg/requirements/nfr-modules/accuracy.md - NFR-ACC-001 (<5% false positives)
 * @tests @test/unit/writing/validation-engine.test.ts
 * @depends @src/writing/validation-rules.ts
 * @depends @src/writing/pattern-library.ts
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { ValidationRuleLoader, RuleSet, ValidationContext, Severity } from './validation-rules.js';
import { loadScoringConfig, getScoringConfig } from './scoring-config-loader.js';
import { diagnoseWriting, type DiagnosticOptions, type ContextualDiagnosticResult } from './contextual-diagnostics.js';

export interface ValidationIssue {
  type: 'banned_phrase' | 'ai_pattern' | 'missing_authenticity' | 'formulaic_structure';
  severity: Severity;
  message: string;
  location: {
    start: number;
    end: number;
    line: number;
    column: number;
  };
  suggestion?: string;
  context?: string;
  ruleId?: string;
}

export interface ValidationSummary {
  totalIssues: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  /** @deprecated Uncalibrated legacy feature heuristic, not authorship evidence. */
  authenticityScore: number;
  /** @deprecated Uncalibrated legacy pattern heuristic, not authorship evidence. */
  aiPatternScore: number;
  wordCount: number;
  sentenceCount: number;
}

export interface ValidationResult {
  /** @deprecated Uncalibrated compatibility heuristic; never a publication gate. */
  score: number;
  scoreSemantics?: 'deprecated-uncalibrated-heuristic';
  contextualDiagnostics?: ContextualDiagnosticResult;
  issues: ValidationIssue[];
  summary: ValidationSummary;
  suggestions: string[];
  humanMarkers: string[];
  aiTells: string[];
}

export interface AuthenticityAnalysis {
  score: number;
  humanMarkers: string[];
  missingMarkers: string[];
  aiTells: string[];
}

/**
 * Core Writing Validation Engine
 */
export class WritingValidationEngine {
  /** Contextual editorial review without an authorship score or publication gate. */
  diagnose(content: string, options?: DiagnosticOptions): ContextualDiagnosticResult {
    return diagnoseWriting(content, options);
  }

  private ruleLoader: ValidationRuleLoader;
  private ruleSet: RuleSet | null = null;
  private initialized = false;

  constructor(guideBasePath?: string) {
    this.ruleLoader = new ValidationRuleLoader(guideBasePath);
  }

  /**
   * Initialize the engine by loading rules
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Load scoring configuration
    await loadScoringConfig();

    try {
      this.ruleSet = await this.ruleLoader.loadRuleSet();
      // If loaded rules are empty (files not found), use defaults
      if (this.ruleSet.bannedPhrases.length === 0 &&
          this.ruleSet.aiPatterns.length === 0 &&
          this.ruleSet.structuralPatterns.length === 0) {
        this.ruleSet = this.ruleLoader.getDefaultRules();
      }
    } catch (error) {
      // Fall back to default rules if guide is not available
      console.warn('Failed to load AIWG rules, using defaults:', error);
      this.ruleSet = this.ruleLoader.getDefaultRules();
    }

    this.initialized = true;
  }

  /**
   * Validate content and return comprehensive results
   */
  async validate(content: string, context?: ValidationContext): Promise<ValidationResult> {
    await this.initialize();

    const issues: ValidationIssue[] = [];

    // Run all detections
    issues.push(...this.detectBannedPhrases(content, context));
    issues.push(...this.detectAIPatterns(content, context));
    issues.push(...this.detectFormulicStructures(content));

    // Analyze authenticity
    const authenticityAnalysis = this.analyzeAuthenticity(content);

    // Check for missing authenticity markers
    if (authenticityAnalysis.missingMarkers.length > 0) {
      issues.push({
        type: 'missing_authenticity',
        severity: 'info',
        message: 'Legacy heuristic found few specificity features; this says nothing about authorship',
        location: { start: 0, end: 0, line: 1, column: 1 },
        suggestion: `Only if supported by supplied facts and author intent, consider: ${authenticityAnalysis.missingMarkers.join(', ')}`,
        context: authenticityAnalysis.missingMarkers.slice(0, 3).join('; ')
      });
    }

    // Calculate summary
    const summary = this.calculateSummary(content, issues, authenticityAnalysis);

    // Generate overall score
    const score = this.calculateOverallScore(summary, authenticityAnalysis);

    // Generate actionable suggestions
    const suggestions = this.generateSuggestions(issues, authenticityAnalysis, summary);

    return {
      score,
      issues,
      summary,
      suggestions,
      scoreSemantics: 'deprecated-uncalibrated-heuristic',
      contextualDiagnostics: this.diagnose(content),
      humanMarkers: authenticityAnalysis.humanMarkers,
      aiTells: authenticityAnalysis.aiTells
    };
  }

  /**
   * Validate a file
   */
  async validateFile(filePath: string, context?: ValidationContext): Promise<ValidationResult> {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = await readFile(filePath, 'utf-8');
    return this.validate(content, context);
  }

  /**
   * Validate multiple files in batch
   */
  async validateBatch(
    files: string[],
    context?: ValidationContext
  ): Promise<Map<string, ValidationResult>> {
    const results = new Map<string, ValidationResult>();

    // Process in parallel
    await Promise.all(
      files.map(async (file) => {
        try {
          const result = await this.validateFile(file, context);
          results.set(file, result);
        } catch (error) {
          console.error(`Failed to validate ${file}:`, error);
        }
      })
    );

    return results;
  }

  /**
   * Detect banned phrases in content
   */
  detectBannedPhrases(content: string, context?: ValidationContext): ValidationIssue[] {
    if (!this.ruleSet) {
      return [];
    }

    const issues: ValidationIssue[] = [];
    let rules = this.ruleSet.bannedPhrases;

    if (context) {
      rules = this.ruleLoader.filterByContext(rules, context);
    }

    for (const rule of rules) {
      const matches = this.findPatternMatches(content, rule.pattern);

      for (const match of matches) {
        issues.push({
          type: 'banned_phrase',
          severity: rule.severity,
          message: rule.message,
          location: match.location,
          suggestion: rule.suggestion,
          context: match.context,
          ruleId: rule.id
        });
      }
    }

    return issues;
  }

  /**
   * Detect AI writing patterns
   */
  detectAIPatterns(content: string, context?: ValidationContext): ValidationIssue[] {
    if (!this.ruleSet) {
      return [];
    }

    const issues: ValidationIssue[] = [];
    let rules = this.ruleSet.aiPatterns;

    if (context) {
      rules = this.ruleLoader.filterByContext(rules, context);
    }

    for (const rule of rules) {
      const matches = this.findPatternMatches(content, rule.pattern);

      for (const match of matches) {
        issues.push({
          type: 'ai_pattern',
          severity: rule.severity,
          message: rule.message,
          location: match.location,
          suggestion: rule.suggestion,
          context: match.context,
          ruleId: rule.id
        });
      }
    }

    return issues;
  }

  /**
   * Detect formulaic structures
   */
  detectFormulicStructures(content: string): ValidationIssue[] {
    if (!this.ruleSet) {
      return [];
    }

    const issues: ValidationIssue[] = [];

    for (const rule of this.ruleSet.structuralPatterns) {
      const matches = this.findPatternMatches(content, rule.pattern);

      for (const match of matches) {
        issues.push({
          type: 'formulaic_structure',
          severity: rule.severity,
          message: rule.message,
          location: match.location,
          suggestion: rule.suggestion,
          context: match.context,
          ruleId: rule.id
        });
      }
    }

    return issues;
  }

  /**
   * Analyze content for authenticity markers
   */
  analyzeAuthenticity(content: string): AuthenticityAnalysis {
    const humanMarkers: string[] = [];
    const aiTells: string[] = [];
    const missingMarkers: string[] = [];

    // Detect human markers
    const humanPatterns = [
      { pattern: /\b(I think|in my experience|we found|we chose|we decided)\b/gi, name: 'personal statements' },
      { pattern: /\bwhile .+, .+ (must|should|need|have to)/gi, name: 'trade-off acknowledgments' },
      { pattern: /\b(reduced|increased|improved) .+ by \d+(%|ms|s|KB|MB)/gi, name: 'specific metrics' },
      { pattern: /\b(p\d{2}|99\.9%|version \d+\.\d+)/gi, name: 'technical specifics' },
      { pattern: /\b(bug|issue|problem|challenge|failed|broke|difficult)\b/gi, name: 'problem mentions' },
      { pattern: /\b(\w+DB|Redis|Kubernetes|Docker|React|Vue|Angular)\b/g, name: 'specific technologies' }
    ];

    for (const { pattern, name } of humanPatterns) {
      const matches = content.match(pattern);
      if (matches && matches.length > 0) {
        humanMarkers.push(`${name} (${matches.length})`);
      }
    }

    // Detect AI tells
    const aiTellPatterns = [
      { pattern: /\b(seamlessly|cutting-edge|revolutionary|transformative|groundbreaking)\b/gi, name: 'marketing buzzwords' },
      { pattern: /^(Moreover|Furthermore|Additionally|Consequently),/gm, name: 'formulaic transitions' },
      { pattern: /\b(comprehensive|robust|innovative|optimal|best-in-class)\b/gi, name: 'vague intensifiers' },
      { pattern: /\b(it is important to note|it is worth noting|it should be mentioned)\b/gi, name: 'throat-clearing phrases' },
      { pattern: /\b(may help to|can serve to|has the potential to)\b/gi, name: 'excessive hedging' },
      { pattern: /\b(\w+, \w+, and \w+)\b/g, name: 'three-item lists' }
    ];

    for (const { pattern, name } of aiTellPatterns) {
      const matches = content.match(pattern);
      if (matches && matches.length > 0) {
        aiTells.push(`${name} (${matches.length})`);
      }
    }

    // Check for missing markers
    const contentLower = content.toLowerCase();
    if (!contentLower.includes('i think') && !contentLower.includes('we found') && !contentLower.includes('we chose')) {
      missingMarkers.push('personal statements or opinions');
    }

    if (!/\d+(%|ms|s|KB|MB|GB)/.test(content)) {
      missingMarkers.push('specific metrics or measurements');
    }

    if (!/(bug|issue|problem|challenge|failed|broke|difficult)/i.test(content)) {
      missingMarkers.push('acknowledgment of challenges or problems');
    }

    // Calculate authenticity score using configured weights
    const config = getScoringConfig();
    const humanScore = humanMarkers.length * config.authenticity.humanMarkerWeight;
    const aiPenalty = aiTells.length * config.authenticity.aiTellPenalty;
    const score = Math.max(0, Math.min(100, humanScore - aiPenalty + config.authenticity.baseScore));

    return {
      score,
      humanMarkers,
      missingMarkers,
      aiTells
    };
  }

  /**
   * Validate content for specific context
   */
  async validateForContext(
    content: string,
    context: 'academic' | 'technical' | 'executive' | 'casual'
  ): Promise<ValidationResult> {
    const result = await this.validate(content, context);

    // Apply context-specific adjustments
    const contextAdjustments = this.getContextAdjustments(content, context);

    // Modify score based on context
    result.score = Math.max(0, Math.min(100, result.score + contextAdjustments.scoreModifier));

    // Add context-specific suggestions
    result.suggestions.push(...contextAdjustments.suggestions);

    return result;
  }

  /**
   * Load rules from AIWG
   */
  loadRulesFromGuide(guidePath: string): void {
    this.ruleLoader = new ValidationRuleLoader(guidePath);
    this.initialized = false;
  }

  /**
   * Update rules with custom rule set
   */
  updateRules(rules: Partial<RuleSet>): void {
    if (!this.ruleSet) {
      this.ruleSet = this.ruleLoader.getDefaultRules();
    }

    if (rules.bannedPhrases) {
      this.ruleSet.bannedPhrases = this.ruleLoader.mergeRules(
        this.ruleSet.bannedPhrases,
        rules.bannedPhrases
      );
    }

    if (rules.aiPatterns) {
      this.ruleSet.aiPatterns = this.ruleLoader.mergeRules(
        this.ruleSet.aiPatterns,
        rules.aiPatterns
      );
    }

    if (rules.authenticityMarkers) {
      this.ruleSet.authenticityMarkers = this.ruleLoader.mergeRules(
        this.ruleSet.authenticityMarkers,
        rules.authenticityMarkers
      );
    }

    if (rules.structuralPatterns) {
      this.ruleSet.structuralPatterns = this.ruleLoader.mergeRules(
        this.ruleSet.structuralPatterns,
        rules.structuralPatterns
      );
    }
  }

  /**
   * Generate report from validation results
   */
  generateReport(
    results: ValidationResult | Map<string, ValidationResult>,
    format: 'text' | 'json' | 'html'
  ): string {
    if (results instanceof Map) {
      return this.generateBatchReport(results, format);
    }

    switch (format) {
      case 'json':
        return JSON.stringify(results, null, 2);
      case 'html':
        return this.generateHtmlReport(results);
      case 'text':
      default:
        return this.generateTextReport(results);
    }
  }

  // Private helper methods

  private findPatternMatches(content: string, pattern: string | RegExp): Array<{
    match: string;
    location: { start: number; end: number; line: number; column: number };
    context: string;
  }> {
    const matches: Array<{
      match: string;
      location: { start: number; end: number; line: number; column: number };
      context: string;
    }> = [];

    const regex = typeof pattern === 'string' ? new RegExp(pattern, 'gi') : pattern;
    const lines = content.split('\n');

    let absolutePos = 0;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const lineMatches = Array.from(line.matchAll(new RegExp(regex.source, regex.flags)));

      for (const match of lineMatches) {
        const start = absolutePos + (match.index || 0);
        const end = start + match[0].length;

        // Extract context (surrounding text)
        const contextStart = Math.max(0, (match.index || 0) - 30);
        const contextEnd = Math.min(line.length, (match.index || 0) + match[0].length + 30);
        const context = line.substring(contextStart, contextEnd);

        matches.push({
          match: match[0],
          location: {
            start,
            end,
            line: lineIdx + 1,
            column: (match.index || 0) + 1
          },
          context
        });
      }

      absolutePos += line.length + 1; // +1 for newline
    }

    return matches;
  }

  private calculateSummary(
    content: string,
    issues: ValidationIssue[],
    authenticityAnalysis: AuthenticityAnalysis
  ): ValidationSummary {
    const criticalCount = issues.filter(i => i.severity === 'critical').length;
    const warningCount = issues.filter(i => i.severity === 'warning').length;
    const infoCount = issues.filter(i => i.severity === 'info').length;

    // Count words and sentences
    const words = content.split(/\s+/).filter(w => w.length > 0);
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0);

    // Calculate AI pattern score (0-100, higher = more AI-like)
    const config = getScoringConfig();
    const aiPatternCount = issues.filter(i => i.type === 'ai_pattern' || i.type === 'banned_phrase').length;
    const aiPatternScore = Math.min(100, (aiPatternCount / Math.max(1, words.length / 100)) * config.issueScoring.aiPatternNormalizer);

    return {
      totalIssues: issues.length,
      criticalCount,
      warningCount,
      infoCount,
      authenticityScore: authenticityAnalysis.score,
      aiPatternScore,
      wordCount: words.length,
      sentenceCount: sentences.length
    };
  }

  private calculateOverallScore(summary: ValidationSummary, authenticityAnalysis: AuthenticityAnalysis): number {
    const config = getScoringConfig();

    // Start with authenticity score
    let score = authenticityAnalysis.score;

    // Deduct for critical issues (heavy penalty)
    score -= summary.criticalCount * config.issueScoring.criticalPenalty;

    // Deduct for warnings (moderate penalty)
    score -= summary.warningCount * config.issueScoring.warningPenalty;

    // Deduct for high AI pattern score
    score -= summary.aiPatternScore * config.issueScoring.aiPatternMultiplier;

    // Clamp to 0-100
    return Math.max(0, Math.min(100, score));
  }

  private generateSuggestions(
    issues: ValidationIssue[],
    authenticityAnalysis: AuthenticityAnalysis,
    summary: ValidationSummary
  ): string[] {
    const suggestions: string[] = [];

    // Critical issues first
    if (summary.criticalCount > 0) {
      suggestions.push(`Remove ${summary.criticalCount} banned phrase(s) immediately`);
    }

    // AI patterns
    const config = getScoringConfig();
    if (summary.aiPatternScore > config.thresholds.highAIPatternWarning) {
      suggestions.push('High AI pattern score - review formulaic transitions and vague intensifiers');
    }

    // Missing authenticity
    if (authenticityAnalysis.missingMarkers.length > 0) {
      suggestions.push(`Legacy authenticity heuristic: add details only when supported by supplied facts and author intent (${authenticityAnalysis.missingMarkers.slice(0, 2).join(', ')}); never invent experiences or numbers`);
    }

    // Specific improvements
    const hasTransitionIssues = issues.some(i => i.message.includes('transition'));
    if (hasTransitionIssues) {
      suggestions.push('Remove formulaic transitions (Moreover, Furthermore) - just start the next sentence');
    }

    const hasVagueIntensifiers = issues.some(i => i.message.includes('comprehensive') || i.message.includes('robust'));
    if (hasVagueIntensifiers) {
      suggestions.push('Replace vague descriptors with specific details');
    }

    // If score is low, provide general guidance
    const score = this.calculateOverallScore(summary, authenticityAnalysis);
    if (score < config.thresholds.lowScoreWarning) {
      suggestions.push('Consider adding supplied metrics, problem acknowledgments and technical details where relevant; never invent them to raise a legacy heuristic score');
    }

    return suggestions;
  }

  private getContextAdjustments(content: string, context: ValidationContext): {
    scoreModifier: number;
    suggestions: string[];
  } {
    const adjustments = { scoreModifier: 0, suggestions: [] as string[] };

    switch (context) {
      case 'academic':
        // Allow more formal language
        if (/\bcitation|reference|study|research\b/i.test(content)) {
          adjustments.scoreModifier += 5;
        }
        if (!/\b(cited|et al|figure \d+)\b/i.test(content)) {
          adjustments.suggestions.push('Academic context: Consider adding citations or references');
        }
        break;

      case 'technical':
        // Require technical specificity
        if (/\b(algorithm|O\(|API|protocol|architecture)\b/i.test(content)) {
          adjustments.scoreModifier += 10;
        }
        if (!/\b\d+(%|ms|MB|GB)\b/.test(content)) {
          adjustments.suggestions.push('Technical context: Include metrics and performance numbers only when supplied and relevant');
        }
        break;

      case 'executive':
        // Penalize hedging heavily
        const hedgeCount = (content.match(/\b(may|might|could|perhaps)\b/gi) || []).length;
        if (hedgeCount > 3) {
          adjustments.scoreModifier -= 10;
          adjustments.suggestions.push('Executive context: Review unnecessary hedging while preserving uncertainty and evidence strength');
        }
        break;

      case 'casual':
        // Allow contractions and informal language
        if (/\b(don't|won't|can't|it's)\b/.test(content)) {
          adjustments.scoreModifier += 5;
        }
        break;
    }

    return adjustments;
  }

  private generateTextReport(result: ValidationResult): string {
    const lines: string[] = [];

    lines.push('=== Writing Validation Report ===\n');
    lines.push('Legacy scores below are deprecated, uncalibrated heuristics; they do not identify authorship or determine publication readiness.');
    lines.push(`Overall Score (legacy heuristic): ${result.score}/100`);
    lines.push(`Specificity features (legacy authenticityScore): ${result.summary.authenticityScore}/100`);
    lines.push(`Pattern matches (legacy aiPatternScore): ${result.summary.aiPatternScore}/100\n`);
    if (result.contextualDiagnostics) {
      lines.push('=== Contextual Editorial Review ===');
      for (const d of result.contextualDiagnostics.diagnostics) lines.push(`[${d.resolution}] ${d.start}:${d.end} ${d.ruleId}: ${d.explanation}${d.reason ? ` Retained: ${d.reason}` : ''}`);
      lines.push(...result.contextualDiagnostics.notices);
      lines.push('Zero highlights is not a publication gate.\n');
    }

    lines.push(`Total Issues: ${result.summary.totalIssues}`);
    lines.push(`  Critical: ${result.summary.criticalCount}`);
    lines.push(`  Warnings: ${result.summary.warningCount}`);
    lines.push(`  Info: ${result.summary.infoCount}\n`);

    lines.push(`Word Count: ${result.summary.wordCount}`);
    lines.push(`Sentence Count: ${result.summary.sentenceCount}\n`);

    if (result.issues.length > 0) {
      lines.push('=== Issues ===\n');
      for (const issue of result.issues.slice(0, 20)) {
        lines.push(`[${issue.severity.toUpperCase()}] Line ${issue.location.line}: ${issue.message}`);
        if (issue.context) {
          lines.push(`  Context: ...${issue.context}...`);
        }
        if (issue.suggestion) {
          lines.push(`  Suggestion: ${issue.suggestion}`);
        }
        lines.push('');
      }

      if (result.issues.length > 20) {
        lines.push(`... and ${result.issues.length - 20} more issues\n`);
      }
    }

    if (result.suggestions.length > 0) {
      lines.push('=== Suggestions ===\n');
      result.suggestions.forEach((s, i) => {
        lines.push(`${i + 1}. ${s}`);
      });
      lines.push('');
    }

    if (result.humanMarkers.length > 0) {
      lines.push('=== Legacy Specificity Features ===');
      result.humanMarkers.forEach(m => lines.push(`  ✓ ${m}`));
      lines.push('');
    }

    if (result.aiTells.length > 0) {
      lines.push('=== Legacy Pattern Matches ===');
      result.aiTells.forEach(t => lines.push(`  ✗ ${t}`));
      lines.push('');
    }

    return lines.join('\n');
  }

  private generateBatchReport(results: Map<string, ValidationResult>, format: string): string {
    if (format === 'json') {
      const obj: Record<string, ValidationResult> = {};
      results.forEach((result, filePath) => {
        obj[filePath] = result;
      });
      return JSON.stringify(obj, null, 2);
    }

    const lines: string[] = [];
    lines.push('=== Batch Validation Report ===\n');
    lines.push('Deprecated heuristic threshold comparisons only; these are not authorship or publication judgments.\n');
    lines.push(`Total Files: ${results.size}\n`);

    let totalScore = 0;
    let passed = 0;
    let failed = 0;
    const config = getScoringConfig();
    const passThreshold = config.thresholds.passScore;

    results.forEach((result) => {
      totalScore += result.score;
      if (result.score >= passThreshold) {
        passed++;
      } else {
        failed++;
      }
    });

    const avgScore = results.size > 0 ? totalScore / results.size : 0;

    lines.push(`Average Score: ${avgScore.toFixed(1)}/100`);
    lines.push(`Passed (>=${passThreshold}): ${passed}`);
    lines.push(`Failed (<${passThreshold}): ${failed}\n`);

    lines.push('=== File Results ===\n');

    results.forEach((result, filePath) => {
      const status = result.score >= passThreshold ? 'PASS' : 'FAIL';
      lines.push(`[${status}] ${filePath}: ${result.score}/100`);
      if (result.summary.criticalCount > 0) {
        lines.push(`  ${result.summary.criticalCount} critical issue(s)`);
      }
    });

    return lines.join('\n');
  }

  private generateHtmlReport(result: ValidationResult): string {
    const config = getScoringConfig();
    const statusColor = result.score >= config.thresholds.passScore ? '#22c55e' : result.score >= config.thresholds.lowScoreWarning ? '#eab308' : '#ef4444';

    return `<!DOCTYPE html>
<html>
<head>
  <title>Writing Validation Report</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1200px; margin: 0 auto; padding: 2rem; }
    .score { font-size: 3rem; font-weight: bold; color: ${statusColor}; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin: 2rem 0; }
    .metric { background: #f3f4f6; padding: 1rem; border-radius: 0.5rem; }
    .metric-value { font-size: 1.5rem; font-weight: bold; }
    .issue { border-left: 3px solid #ef4444; padding: 0.5rem 1rem; margin: 0.5rem 0; background: #fef2f2; }
    .issue.warning { border-color: #eab308; background: #fefce8; }
    .issue.info { border-color: #3b82f6; background: #eff6ff; }
    .suggestion { padding: 0.5rem 1rem; margin: 0.5rem 0; background: #f0fdf4; border-left: 3px solid #22c55e; }
  </style>
</head>
<body>
  <h1>Writing Validation Report</h1>
  <p>Deprecated, uncalibrated legacy heuristics. These scores do not identify authorship or determine publication readiness. Zero highlights is not a publication gate.</p>
  <div class="score">${result.score}/100</div>

  <div class="summary">
    <div class="metric">
      <div>Legacy specificity heuristic (authenticityScore)</div>
      <div class="metric-value">${result.summary.authenticityScore}/100</div>
    </div>
    <div class="metric">
      <div>Legacy pattern heuristic (aiPatternScore)</div>
      <div class="metric-value">${result.summary.aiPatternScore}/100</div>
    </div>
    <div class="metric">
      <div>Total Issues</div>
      <div class="metric-value">${result.summary.totalIssues}</div>
    </div>
    <div class="metric">
      <div>Word Count</div>
      <div class="metric-value">${result.summary.wordCount}</div>
    </div>
  </div>

  <h2>Issues (${result.issues.length})</h2>
  ${result.issues.slice(0, 50).map(issue => `
    <div class="issue ${issue.severity}">
      <strong>Line ${issue.location.line}:</strong> ${issue.message}
      ${issue.suggestion ? `<br><em>Suggestion: ${issue.suggestion}</em>` : ''}
    </div>
  `).join('')}

  ${result.suggestions.length > 0 ? `
    <h2>Suggestions</h2>
    ${result.suggestions.map(s => `<div class="suggestion">${s}</div>`).join('')}
  ` : ''}
</body>
</html>`;
  }
}
