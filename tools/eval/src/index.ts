#!/usr/bin/env tsx
/**
 * AIWG Model Evaluation Suite — CLI entry point
 *
 * Usage:
 *   npx tsx src/index.ts <model-id> [options]
 *   npx tsx src/index.ts hermes3:latest --backend ollama
 *   npx tsx src/index.ts hermes3:latest --dimensions tool-use,coding
 *
 * @issue #433
 */

import { Command } from 'commander';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { OllamaModel } from './models/ollama.js';
import { EvalRunner } from './runner.js';
import { generateMarkdownReport } from './reporters/markdown.js';
import { generateJsonReport } from './reporters/json.js';
import type { IntegrityMode } from './models/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASETS_DIR = path.resolve(__dirname, '../datasets');

const program = new Command();

program
  .name('aiwg-eval')
  .description('AIWG model evaluation suite (use model-id offline-fixture for the frozen offline H1/H2 pilot)')
  .version('0.1.0')
  .argument('<model-id>', 'Model identifier (e.g., hermes3:latest)')
  .option('--backend <type>', 'Backend: ollama or api', 'ollama')
  .option('--dimensions <list>', 'Comma-separated dimensions to evaluate')
  .option('--output <format>', 'Output format: json or markdown', 'markdown')
  .option('--ollama-url <url>', 'Ollama API URL', 'http://localhost:11434')
  .option('--integrity-mode <mode>', 'Integrity mode: standard, fresh, locked, or full-locked', 'standard')
  .option('--fresh-workspace-required', 'Require independently verified workspace freshness', false)
  .option('--fresh-workspace-verified', 'Record that the calling runtime verified workspace freshness', false)
  .option('--baseline-score <score>', 'Paired baseline overall score')
  .option('--baseline-label <label>', 'Paired baseline label', 'baseline')
  .option('--verbose', 'Show detailed progress', false)
  .action(async (modelId: string, options: Record<string, string | boolean>) => {
    const integrityMode = options.integrityMode as IntegrityMode;
    if (!['standard', 'fresh', 'locked', 'full-locked'].includes(integrityMode)) {
      throw new Error(`Unsupported integrity mode: ${integrityMode}`);
    }
    const baselineScore = options.baselineScore === undefined
      ? undefined
      : Number(options.baselineScore);
    if (baselineScore !== undefined && (!Number.isFinite(baselineScore) || baselineScore < 0 || baselineScore > 100)) {
      throw new Error('--baseline-score must be a number from 0 to 100');
    }
    const offline = modelId === 'offline-fixture';
    console.log(`\nAIWG Model Evaluation Suite`);
    console.log(`Model: ${modelId}`);
    console.log(`Backend: ${offline ? 'fixture' : options.backend}`);
    if (!offline) console.log(`Ollama URL: ${options['ollama-url'] || 'http://localhost:11434'}`);
    console.log('');

    // Parse dimensions
    const dimensions = options.dimensions
      ? (options.dimensions as string).split(',').map((d: string) => d.trim())
      : undefined;

    // Run evaluation
    const report = offline
      ? await EvalRunner.runOfflinePilot(path.join(DATASETS_DIR, 'composition-pilot.json'), path.resolve(__dirname, '../../../test/fixtures/eval-pilot'))
      : await new EvalRunner(new OllamaModel(modelId, options['ollama-url'] as string), DATASETS_DIR).run({
      dimensions,
      verbose: options.verbose as boolean,
      integrityMode,
      freshWorkspaceRequired: options.freshWorkspaceRequired as boolean,
      freshWorkspaceVerified: options.freshWorkspaceVerified as boolean,
      pairedBaseline: baselineScore !== undefined
        ? {
            label: options.baselineLabel as string,
            score: baselineScore,
          }
        : undefined,
    });

    // Generate report
    const output = options.output === 'json'
      ? generateJsonReport(report)
      : generateMarkdownReport(report);

    console.log(output);

    // Save report
    const reportsDir = path.resolve(__dirname, '../reports');
    await fs.mkdir(reportsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ext = options.output === 'json' ? 'json' : 'md';
    const reportPath = path.join(reportsDir, `eval-${modelId.replace(/[:/]/g, '-')}-${timestamp}.${ext}`);
    await fs.writeFile(reportPath, output);
    console.log(`\nReport saved: ${reportPath}`);
  });

program.parse();
