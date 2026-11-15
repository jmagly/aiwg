/**
 * Workflow Orchestrator
 *
 * Core orchestration engine that chains validation → optimization → re-validation.
 * Supports batch processing, watch mode, auto-fix, and multiple output formats.
 *
 * @implements @.aiwg/requirements/use-cases/UC-001-validate-ai-generated-content.md
 * @architecture @docs/architecture/cli/index.md
 * @tests @test/unit/cli/workflow-orchestrator.test.ts
 * @depends @src/writing/validation-engine.ts
 * @depends @src/writing/prompt-optimizer.ts
 * @depends @src/cli/config-loader.ts
 * @depends @src/cli/watch-service.ts
 * @cli @docs/cli/agent-usage.md - workflow command
 */

import { readFile, writeFile, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { basename } from 'path';
import { glob } from 'glob';
import { WritingValidationEngine, ValidationResult } from '../writing/validation-engine.js';
import { PromptOptimizer, OptimizationResult } from '../writing/prompt-optimizer.js';
import { AiwgConfig, ConfigLoader } from './config-loader.js';
import { WatchService, WatchEvent } from './watch-service.js';

export interface WorkflowResult {
  filePath: string;
  validation: {
    before: ValidationResult;
    after?: ValidationResult;
  };
  optimization?: OptimizationResult;
  applied: boolean;
  error?: string;
  duration: number; // ms
}

export interface BatchProgress {
  total: number;
  processed: number;
  passed: number;
  failed: number;
  errors: number;
}

export type ProgressCallback = (progress: BatchProgress) => void;

/**
 * Core Workflow Orchestrator
 */
export class WorkflowOrchestrator {
  private configLoader: ConfigLoader;
  private validator: WritingValidationEngine;
  private optimizer: PromptOptimizer;
  private watchService: WatchService;
  private config: AiwgConfig | null = null;

  constructor(guideBasePath?: string) {
    this.configLoader = new ConfigLoader();
    this.validator = new WritingValidationEngine(guideBasePath);
    this.optimizer = new PromptOptimizer();
    this.watchService = new WatchService();
  }

  /**
   * Process a single file through the workflow
   */
  async processFile(filePath: string, config?: AiwgConfig): Promise<WorkflowResult> {
    const startTime = Date.now();
    const cfg = config || await this.loadConfig();

    const result: WorkflowResult = {
      filePath,
      validation: {
        before: {} as ValidationResult
      },
      applied: false,
      duration: 0
    };

    try {
      // Ensure file exists
      if (!existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Read file content
      const content = await readFile(filePath, 'utf-8');

      // Step 1: Validate
      result.validation.before = await this.validateStep(content, cfg);

      // Step 2: Optimize (if needed)
      const needsOptimization =
        result.validation.before.score < cfg.validation.threshold ||
        cfg.optimization.autoApply;

      if (needsOptimization && cfg.optimization.enabled) {
        result.optimization = await this.optimizeStep(content, cfg);

        // Step 3: Re-validate (if optimization applied)
        if (result.optimization) {
          result.validation.after = await this.revalidateStep(
            result.optimization.optimizedPrompt,
            cfg
          );

          // Step 4: Auto-apply (if configured)
          if (cfg.optimization.autoApply) {
            await this.applyOptimization(filePath, result.optimization, cfg);
            result.applied = true;
          }
        }
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * Process multiple files in batch
   */
  async processBatch(
    files: string[],
    config?: AiwgConfig,
    onProgress?: ProgressCallback
  ): Promise<Map<string, WorkflowResult>> {
    const cfg = config || await this.loadConfig();
    const results = new Map<string, WorkflowResult>();

    const progress: BatchProgress = {
      total: files.length,
      processed: 0,
      passed: 0,
      failed: 0,
      errors: 0
    };

    // Process files sequentially to avoid overwhelming the system
    for (const file of files) {
      try {
        const result = await this.processFile(file, cfg);
        results.set(file, result);

        // Update progress
        progress.processed++;
        if (result.error) {
          progress.errors++;
        } else if (result.validation.after) {
          if (result.validation.after.score >= cfg.validation.threshold) {
            progress.passed++;
          } else {
            progress.failed++;
          }
        } else if (result.validation.before.score >= cfg.validation.threshold) {
          progress.passed++;
        } else {
          progress.failed++;
        }

        // Call progress callback
        if (onProgress) {
          onProgress(progress);
        }
      } catch (error) {
        console.error(`Failed to process ${file}:`, error);
        progress.processed++;
        progress.errors++;

        if (onProgress) {
          onProgress(progress);
        }
      }
    }

    return results;
  }

  /**
   * Validate step
   */
  async validateStep(content: string, config: AiwgConfig): Promise<ValidationResult> {
    await this.validator.initialize();

    if (config.validation.context) {
      return this.validator.validateForContext(content, config.validation.context);
    }

    return this.validator.validate(content, config.validation.context);
  }

  /**
   * Optimize step
   */
  async optimizeStep(content: string, config: AiwgConfig): Promise<OptimizationResult> {
    const context = config.validation.context
      ? {
          voice: config.validation.context as 'academic' | 'technical' | 'executive',
          constraints: config.optimization.strategies
        }
      : undefined;

    return this.optimizer.optimize(content, context);
  }

  /**
   * Re-validate step
   */
  async revalidateStep(content: string, config: AiwgConfig): Promise<ValidationResult> {
    return this.validateStep(content, config);
  }

  /**
   * Apply optimization to file
   */
  private async applyOptimization(
    filePath: string,
    optimization: OptimizationResult,
    config: AiwgConfig
  ): Promise<void> {
    // Create backup if configured
    if (config.optimization.createBackup) {
      const backupPath = `${filePath}.original`;
      await copyFile(filePath, backupPath);
    }

    // Write optimized content
    await writeFile(filePath, optimization.optimizedPrompt, 'utf-8');
  }

  /**
   * Start watch mode
   */
  async startWatchMode(config?: AiwgConfig): Promise<void> {
    const cfg = config || await this.loadConfig();

    if (!cfg.watch.enabled) {
      throw new Error('Watch mode is not enabled in configuration');
    }

    // Set up watch callback
    this.watchService.onFileChange(async (event: WatchEvent) => {
      if (event.type === 'unlink') {
        return; // Skip deleted files
      }

      console.log(`Processing ${event.path}...`);
      const result = await this.processFile(event.path, cfg);

      if (result.error) {
        console.error(`Error: ${result.error}`);
      } else if (result.applied) {
        console.log(`Applied optimization (score: ${result.validation.before.score} → ${result.validation.after?.score})`);
      } else {
        console.log(`Validated (score: ${result.validation.before.score})`);
      }
    });

    // Start watching
    await this.watchService.start(cfg.watch.patterns, cfg.watch);

    console.log(`Watching ${cfg.watch.patterns.join(', ')}...`);
    console.log('Press Ctrl+C to stop');
  }

  /**
   * Stop watch mode
   */
  async stopWatchMode(): Promise<void> {
    await this.watchService.stop();
  }

  /**
   * Load configuration
   */
  async loadConfig(configPath?: string): Promise<AiwgConfig> {
    if (this.config) {
      return this.config;
    }

    this.config = await this.configLoader.load(configPath);
    return this.config;
  }

  /**
   * Validate configuration
   */
  validateConfig(config: AiwgConfig) {
    return this.configLoader.validate(config);
  }

  /**
   * Generate report from results
   */
  generateReport(
    results: Map<string, WorkflowResult>,
    format: 'text' | 'json' | 'html' | 'junit'
  ): string {
    switch (format) {
      case 'json':
        return this.generateJsonReport(results);
      case 'html':
        return this.generateHtmlReport(results);
      case 'junit':
        return this.generateJunitReport(results);
      case 'text':
      default:
        return this.generateTextReport(results);
    }
  }

  /**
   * Save report to file
   */
  async saveReport(report: string, destination: string): Promise<void> {
    await writeFile(destination, report, 'utf-8');
  }

  /**
   * Expand glob patterns to file list
   */
  async expandGlob(patterns: string[]): Promise<string[]> {
    const files: string[] = [];

    for (const pattern of patterns) {
      const matches = await glob(pattern, {
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
        nodir: true
      });
      files.push(...matches);
    }

    return [...new Set(files)]; // Remove duplicates
  }

  // Private report generation methods

  private generateTextReport(results: Map<string, WorkflowResult>): string {
    const lines: string[] = [];

    lines.push('=== AIWG Workflow Report ===\n');
    lines.push(`Total Files: ${results.size}`);

    let passed = 0;
    let failed = 0;
    let errors = 0;
    let optimized = 0;

    results.forEach((result) => {
      if (result.error) {
        errors++;
      } else {
        const finalScore = result.validation.after?.score || result.validation.before.score;
        if (finalScore >= 70) {
          passed++;
        } else {
          failed++;
        }
        if (result.applied) {
          optimized++;
        }
      }
    });

    lines.push(`Passed: ${passed}`);
    lines.push(`Failed: ${failed}`);
    lines.push(`Errors: ${errors}`);
    lines.push(`Optimized: ${optimized}\n`);

    lines.push('=== File Results ===\n');

    results.forEach((result, filePath) => {
      if (result.error) {
        lines.push(`[ERROR] ${filePath}`);
        lines.push(`  ${result.error}\n`);
      } else {
        const beforeScore = result.validation.before.score;
        const afterScore = result.validation.after?.score;

        if (afterScore !== undefined) {
          const delta = afterScore - beforeScore;
          const status = afterScore >= 70 ? 'PASS' : 'FAIL';
          lines.push(`[${status}] ${filePath}`);
          lines.push(`  Before: ${beforeScore}/100, After: ${afterScore}/100 (${delta > 0 ? '+' : ''}${delta})`);
          if (result.applied) {
            lines.push(`  Applied optimization`);
          }
        } else {
          const status = beforeScore >= 70 ? 'PASS' : 'FAIL';
          lines.push(`[${status}] ${filePath}`);
          lines.push(`  Score: ${beforeScore}/100`);
        }

        lines.push(`  Duration: ${result.duration}ms\n`);
      }
    });

    return lines.join('\n');
  }

  private generateJsonReport(results: Map<string, WorkflowResult>): string {
    const obj: Record<string, WorkflowResult> = {};
    results.forEach((result, filePath) => {
      obj[filePath] = result;
    });
    return JSON.stringify(obj, null, 2);
  }

  private generateHtmlReport(results: Map<string, WorkflowResult>): string {
    let passed = 0;
    let failed = 0;
    let errors = 0;

    const rows: string[] = [];

    results.forEach((result, filePath) => {
      const fileName = basename(filePath);

      if (result.error) {
        errors++;
        rows.push(`
          <tr class="error">
            <td>${fileName}</td>
            <td>ERROR</td>
            <td>-</td>
            <td>-</td>
            <td>${result.error}</td>
          </tr>
        `);
      } else {
        const beforeScore = result.validation.before.score;
        const afterScore = result.validation.after?.score || beforeScore;
        const status = afterScore >= 70 ? 'PASS' : 'FAIL';

        if (afterScore >= 70) {
          passed++;
        } else {
          failed++;
        }

        const delta = result.validation.after ? afterScore - beforeScore : 0;

        rows.push(`
          <tr class="${status.toLowerCase()}">
            <td>${fileName}</td>
            <td>${status}</td>
            <td>${beforeScore}</td>
            <td>${afterScore}${delta !== 0 ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}</td>
            <td>${result.applied ? 'Yes' : 'No'}</td>
          </tr>
        `);
      }
    });

    return `<!DOCTYPE html>
<html>
<head>
  <title>AIWG Workflow Report</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1200px; margin: 0 auto; padding: 2rem; }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin: 2rem 0; }
    .metric { background: #f3f4f6; padding: 1rem; border-radius: 0.5rem; text-align: center; }
    .metric-value { font-size: 2rem; font-weight: bold; margin: 0.5rem 0; }
    .metric.passed .metric-value { color: #22c55e; }
    .metric.failed .metric-value { color: #ef4444; }
    .metric.errors .metric-value { color: #f59e0b; }
    table { width: 100%; border-collapse: collapse; margin: 2rem 0; }
    th { background: #1f2937; color: white; padding: 0.75rem; text-align: left; }
    td { padding: 0.75rem; border-bottom: 1px solid #e5e7eb; }
    tr.pass { background: #f0fdf4; }
    tr.fail { background: #fef2f2; }
    tr.error { background: #fffbeb; }
  </style>
</head>
<body>
  <h1>AIWG Workflow Report</h1>

  <div class="summary">
    <div class="metric">
      <div>Total Files</div>
      <div class="metric-value">${results.size}</div>
    </div>
    <div class="metric passed">
      <div>Passed</div>
      <div class="metric-value">${passed}</div>
    </div>
    <div class="metric failed">
      <div>Failed</div>
      <div class="metric-value">${failed}</div>
    </div>
    <div class="metric errors">
      <div>Errors</div>
      <div class="metric-value">${errors}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>File</th>
        <th>Status</th>
        <th>Before</th>
        <th>After</th>
        <th>Optimized</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join('')}
    </tbody>
  </table>
</body>
</html>`;
  }

  private generateJunitReport(results: Map<string, WorkflowResult>): string {
    let passed = 0;
    let failed = 0;
    let errors = 0;
    let totalTime = 0;

    const testCases: string[] = [];

    results.forEach((result, filePath) => {
      const fileName = basename(filePath);
      totalTime += result.duration / 1000; // Convert to seconds

      if (result.error) {
        errors++;
        testCases.push(`
    <testcase name="${fileName}" classname="AIWG.Validation" time="${(result.duration / 1000).toFixed(3)}">
      <error message="${this.escapeXml(result.error)}"/>
    </testcase>`);
      } else {
        const finalScore = result.validation.after?.score || result.validation.before.score;
        if (finalScore >= 70) {
          passed++;
          testCases.push(`
    <testcase name="${fileName}" classname="AIWG.Validation" time="${(result.duration / 1000).toFixed(3)}"/>`);
        } else {
          failed++;
          testCases.push(`
    <testcase name="${fileName}" classname="AIWG.Validation" time="${(result.duration / 1000).toFixed(3)}">
      <failure message="Score ${finalScore} below threshold 70"/>
    </testcase>`);
        }
      }
    });

    return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="AIWG Validation" tests="${results.size}" failures="${failed}" errors="${errors}" time="${totalTime.toFixed(3)}">
${testCases.join('\n')}
  </testsuite>
</testsuites>`;
  }

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
