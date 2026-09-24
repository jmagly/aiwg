#!/usr/bin/env node
/** Repeat the synthetic durable-store matrix. Not a production latency claim. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runOfflineReviewMatrixFixture } from '../../dist/src/decision/patterns/index.js';

const argument = process.argv[2];
const iterations = argument === undefined ? 5 :
  process.argv.length === 4 && argument === '--iterations' ? Number(process.argv[3]) : NaN;
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 89) {
  process.stderr.write('Usage: node tools/decision/review-offline-benchmark.mjs [--iterations N] (1..89)\n');
  process.exitCode = 2;
} else {
  const samplesMs = [];
  let effects = 0;
  let reviews = 0;
  for (let index = 0; index < iterations; index += 1) {
    const directory = await mkdtemp(join(tmpdir(), 'aiwg-review-benchmark-'));
    try {
      const started = performance.now();
      const result = await runOfflineReviewMatrixFixture(directory);
      samplesMs.push(performance.now() - started);
      effects += result.executorCalls;
      reviews += 5;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  process.stdout.write(`${JSON.stringify({ schema: 'decision-review-offline-benchmark/v1', fixture: 'decision-review-offline-matrix/v1',
    environment: 'local-file-store', iterations, reviews, effects, overrideCount: iterations,
    durationMs: samplesMs.reduce((sum, sample) => sum + sample, 0), samplesMs,
    productionLatencyQualification: false })}\n`);
}
