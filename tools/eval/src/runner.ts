/**
 * AIWG Evaluation Runner — orchestrates test execution across AIWG-specific dimensions,
 * with optional delegation to the matric-eval framework for standard benchmarks.
 *
 * Extends matric-eval via composition: @matric/eval-client
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { validateEvalContract } from './contracts.js';
import type { EvalSummary } from '@matric/eval-client';
import type {
  GenerationModel,
  TestCase,
  EvalResult,
  DimensionScore,
  EvalIntegrityMetadata,
  EvalReportWithIntegrity,
  IntegrityMode,
  PairedBaselineInput,
  ProtectedEvalArtifact,
  ReleaseGateThresholds,
} from './models/types.js';
import { DIMENSION_WEIGHTS, scoreTier, calculateOverall } from './scoring/weights.js';
import { buildIntegrityMetadata, detectArtifactChanges, snapshotArtifacts } from './integrity.js';

export interface RunnerOptions {
  dimensions?: string[];
  outputFormat?: 'json' | 'markdown';
  verbose?: boolean;
  /** Include standard matric-eval benchmark scores when matric-eval binary is available */
  includeMatricBenchmarks?: boolean;
  /** Standard keeps legacy smoke-eval behavior; stricter modes emit verifiable integrity evidence. */
  integrityMode?: IntegrityMode;
  /** Declare that results are invalid for promotion unless workspace freshness is independently verified. */
  freshWorkspaceRequired?: boolean;
  /** Evidence supplied by the caller/runtime after creating or checking an isolated workspace. */
  freshWorkspaceVerified?: boolean;
  /** Optional paired score used for delta reporting. */
  pairedBaseline?: PairedBaselineInput;
  /** Additional protected paths, such as evaluator tests owned by a wrapping harness. */
  protectedArtifacts?: ProtectedEvalArtifact[];
  /** Project-specific calibrated release thresholds. */
  releaseThresholds?: Partial<ReleaseGateThresholds>;
}

export class AiwgEvalRunner {
  static async runOfflinePilot(datasetPath: string, fixtureRoot: string): Promise<EvalReportWithIntegrity> {
    const { runOfflinePilot } = await import('./pilot.js');
    return runOfflinePilot(datasetPath, fixtureRoot);
  }
  private model: GenerationModel;
  private datasetsDir: string;

  constructor(model: GenerationModel, datasetsDir: string) {
    this.model = model;
    this.datasetsDir = datasetsDir;
  }

  async run(options: RunnerOptions = {}): Promise<EvalReportWithIntegrity> {
    const integrityMode = options.integrityMode ?? 'standard';
    const freshWorkspaceRequired = options.freshWorkspaceRequired
      ?? (integrityMode === 'fresh' || integrityMode === 'full-locked');
    const protectedArtifacts: ProtectedEvalArtifact[] = integrityMode === 'standard'
      ? []
      : [
          { path: this.datasetsDir, family: 'fixture_edit' },
          { path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'scoring'), family: 'scorer_edit' },
          ...(options.protectedArtifacts ?? []),
        ];
    const artifactSnapshot = await snapshotArtifacts(protectedArtifacts);
    const dimensions = options.dimensions || Object.keys(DIMENSION_WEIGHTS);
    const results: EvalResult[] = [];
    const dimensionScores: DimensionScore[] = [];

    for (const dimension of dimensions) {
      const testCases = await this.loadTestCases(dimension);
      if (testCases.length === 0) {
        if (options.verbose) console.log(`  Skipping ${dimension}: no test cases found`);
        continue;
      }

      if (options.verbose) console.log(`\nEvaluating: ${dimension} (${testCases.length} test cases)`);

      const dimResults: EvalResult[] = [];

      for (const testCase of testCases) {
        if (options.verbose) console.log(`  Running: ${testCase.id}`);
        const result = await this.evaluateTestCase(testCase);
        dimResults.push(result);
        results.push(result);
      }

      const totalScore = dimResults.reduce((s, r) => s + r.score, 0);
      const maxScore = dimResults.reduce((s, r) => s + r.maxScore, 0);
      const dimScore = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

      dimensionScores.push({
        dimension,
        score: dimScore,
        tier: scoreTier(dimScore),
        testCases: testCases.length,
        passed: dimResults.filter((r) => r.score / r.maxScore >= 0.5).length,
      });
    }

    const dimScoreMap: Record<string, number> = {};
    for (const ds of dimensionScores) {
      dimScoreMap[ds.dimension] = ds.score;
    }

    const overall = calculateOverall(dimScoreMap);
    const totalLatency = results.reduce((s, r) => s + r.latencyMs, 0);
    const changedArtifacts = await detectArtifactChanges(artifactSnapshot, protectedArtifacts);
    const integrity = buildIntegrityMetadata({
      mode: integrityMode,
      freshWorkspaceRequired,
      freshWorkspaceVerified: options.freshWorkspaceVerified === true,
      changedArtifacts,
      sampleN: results.length,
      passedN: results.filter(result => result.maxScore > 0 && result.score / result.maxScore >= 0.5).length,
      overallScore: overall,
      pairedBaseline: options.pairedBaseline,
      thresholds: options.releaseThresholds,
    });

    // Optionally include standard matric-eval benchmark scores
    let matricSummary: EvalSummary | undefined;
    if (options.includeMatricBenchmarks) {
      // Keep the optional client behind a runtime boundary. Root-level AIWG tests do
      // not install tools/eval's isolated dependencies, while the tool package does.
      const { createMatricClient } = await import('./matric-client.js');
      const matricClient = createMatricClient();
      if (!(await matricClient.isAvailable())) return this.buildReport(dimensionScores, overall, totalLatency, integrity);
      if (options.verbose) console.log('\nRunning standard matric-eval benchmarks...');
      matricSummary = await matricClient.run({
        models: [this.model.name],
        tier: 'smoke',
        logLevel: options.verbose ? 'INFO' : 'WARNING',
      });
    }

    return this.buildReport(dimensionScores, overall, totalLatency, integrity, matricSummary);
  }

  private buildReport(
    dimensionScores: DimensionScore[],
    overall: number,
    totalLatency: number,
    integrity: EvalIntegrityMetadata,
    matricSummary?: EvalSummary,
  ): EvalReportWithIntegrity {
    return {
      model: this.model.name,
      backend: 'ollama',
      date: new Date().toISOString(),
      aiwgVersion: '2026.3.2',
      dimensions: dimensionScores,
      overall,
      overallTier: scoreTier(overall),
      totalLatencyMs: totalLatency,
      ...integrity,
      matricBenchmarks: matricSummary
        ? matricSummary.results.find((r) => r.model === this.model.name)
        : undefined,
    };
  }

  private async loadTestCases(dimension: string): Promise<TestCase[]> {
    const dimDir = path.join(this.datasetsDir, dimension);
    try {
      const files = await fs.readdir(dimDir);
      const testCases: TestCase[] = [];

      for (const file of files) {
        if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
        const content = await fs.readFile(path.join(dimDir, file), 'utf-8');
        const parsed = yaml.load(content) as TestCase;
        validateEvalContract('TestCase', parsed);
        testCases.push(parsed);
      }

      return testCases;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async evaluateTestCase(testCase: TestCase): Promise<EvalResult> {
    const startTime = Date.now();

    try {
      const result = await this.model.generate(testCase.prompt, {
        temperature: 0,
        maxTokens: 2048,
      });

      const latencyMs = Date.now() - startTime;
      const { score, maxScore, details } = scoreResponse(result.text, testCase);

      return {
        testCaseId: testCase.id,
        dimension: testCase.dimension,
        score,
        maxScore,
        details,
        latencyMs,
        modelResponse: result.text.slice(0, 500),
      };
    } catch (error) {
      return {
        testCaseId: testCase.id,
        dimension: testCase.dimension,
        score: 0,
        maxScore: 1,
        details: { error: (error as Error).message },
        latencyMs: Date.now() - startTime,
        modelResponse: '',
      };
    }
  }
}

/** Backward-compatible alias — use AiwgEvalRunner for new code */
export const EvalRunner = AiwgEvalRunner;

function scoreResponse(response: string, testCase: TestCase): { score: number; maxScore: number; details: Record<string, unknown> } {
  const scoring = testCase.scoring;
  const expected = testCase.expected;
  let score = 0;
  let maxScore = 0;
  const details: Record<string, unknown> = {};

  // Check for expected tool calls
  if (expected.tool_calls) {
    const toolCalls = expected.tool_calls as Array<{ tool: string; params_contain?: Record<string, string> }>;
    for (const tc of toolCalls) {
      maxScore += scoring.correct_tool || 0.5;
      if (response.toLowerCase().includes(tc.tool.toLowerCase())) {
        score += scoring.correct_tool || 0.5;
        details[`tool_${tc.tool}`] = 'found';
      }

      if (tc.params_contain) {
        maxScore += scoring.correct_params || 0.5;
        const paramsFound = Object.values(tc.params_contain).every((v) =>
          response.includes(String(v))
        );
        if (paramsFound) {
          score += scoring.correct_params || 0.5;
          details[`params_${tc.tool}`] = 'correct';
        }
      }
    }
  }

  // Check for expected content
  if (expected.contains) {
    const contains = expected.contains as string[];
    for (const c of contains) {
      maxScore += 1;
      if (response.toLowerCase().includes(c.toLowerCase())) {
        score += 1;
        details[`contains_${c}`] = true;
      }
    }
  }

  // Check for forbidden content
  if (expected.must_not_contain) {
    const forbidden = expected.must_not_contain as string[];
    maxScore += scoring.no_hallucination || 0.2;
    const clean = forbidden.every((f) => !response.toLowerCase().includes(f.toLowerCase()));
    if (clean) {
      score += scoring.no_hallucination || 0.2;
      details.no_hallucination = true;
    }
  }

  // Check JSON/YAML validity
  if (expected.valid_json) {
    maxScore += 1;
    try {
      JSON.parse(response);
      score += 1;
      details.valid_json = true;
    } catch {
      details.valid_json = false;
    }
  }

  if (expected.valid_yaml) {
    maxScore += 1;
    try {
      yaml.load(response);
      score += 1;
      details.valid_yaml = true;
    } catch {
      details.valid_yaml = false;
    }
  }

  // Fallback: at least 1 point max
  if (maxScore === 0) maxScore = 1;

  return { score, maxScore, details };
}
