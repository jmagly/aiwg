import type { BatchCostEvidence, BatchProviderUsage, DecisionBatchReceipt, EstimatedTokenAllocation, PriceCatalogRecord } from './types.js';

export interface BatchAccountingTotals {
  usage: BatchProviderUsage;
  cost: { knownAmountMicros: number; unknownAttemptCount: number; conservativeUpperBoundMicros: number | null };
}

/** Adds every dispatched attempt once, including failed, retry, and fallback consumption. */
export function batchAccountingTotals(receipt: DecisionBatchReceipt): BatchAccountingTotals {
  let input: number | null = 0; let output: number | null = 0;
  let known = 0; let unknown = 0; let bound = 0; let hasBound = false;
  for (const attempt of receipt.attempts) {
    input = addKnown(input, attempt.usage.inputTokens);
    output = addKnown(output, attempt.usage.outputTokens);
    if (attempt.cost.kind === 'provider-authoritative' || attempt.cost.kind === 'client-derived') known += attempt.cost.amountMicros;
    else if (attempt.cost.kind === 'bounded-unknown') { unknown++; bound += attempt.cost.upperBoundMicros; hasBound = true; }
    else unknown++;
  }
  return { usage: { inputTokens: input, outputTokens: output },
    cost: { knownAmountMicros: known, unknownAttemptCount: unknown,
      conservativeUpperBoundMicros: unknown === 0 ? known : hasBound && receipt.attempts.every(a => a.cost.kind !== 'unknown') ? known + bound : null } };
}

/** Admission consumes receipt-level evidence only; per-answer estimates are deliberately ignored. */
export function batchEnforcementCostMicros(receipt: DecisionBatchReceipt): number | null {
  const total = batchAccountingTotals(receipt).cost;
  return total.unknownAttemptCount === 0 ? total.knownAmountMicros : total.conservativeUpperBoundMicros;
}

/** Exact integer arithmetic; USD 0.042/million is 42,000 micros/million. */
export function deriveCost(usage: BatchProviderUsage, catalog: PriceCatalogRecord): BatchCostEvidence {
  if (usage.inputTokens === null || usage.outputTokens === null) return { kind: 'unknown' };
  validateRate(catalog.inputMicrosPerMillionTokens); validateRate(catalog.outputMicrosPerMillionTokens);
  const numerator = BigInt(usage.inputTokens) * BigInt(catalog.inputMicrosPerMillionTokens)
    + BigInt(usage.outputTokens) * BigInt(catalog.outputMicrosPerMillionTokens);
  const micros = Number((numerator + 500_000n) / 1_000_000n);
  if (!Number.isSafeInteger(micros)) throw new RangeError('Derived batch cost exceeds safe integer range');
  return { kind: 'client-derived', currency: 'USD', amountMicros: micros,
    priceCatalogId: catalog.id, priceCatalogVersion: catalog.version, effectiveAt: catalog.effectiveAt };
}

/** Largest remainder makes integer allocations deterministic and exactly reconciling. */
export function allocateEstimatedUsage(questionIds: readonly string[], total: BatchProviderUsage,
  weights: Readonly<Record<string, number>> = {}): EstimatedTokenAllocation[] {
  if (!questionIds.length || new Set(questionIds).size !== questionIds.length) throw new RangeError('Unique question IDs are required');
  const normalized = questionIds.map(id => weights[id] ?? 1);
  if (normalized.some(weight => !Number.isSafeInteger(weight) || weight <= 0)) throw new RangeError('Allocation weights must be positive integers');
  const input = allocate(total.inputTokens, normalized, questionIds);
  const output = allocate(total.outputTokens, normalized, questionIds);
  return questionIds.map((questionId, index) => ({ questionId, kind: 'estimated',
    algorithm: 'largest-remainder-weighted', algorithmVersion: '1',
    inputTokens: input?.[index] ?? null, outputTokens: output?.[index] ?? null }));
}

function allocate(total: number | null, weights: number[], ids: readonly string[]): number[] | null {
  if (total === null) return null;
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError('Usage must be a non-negative safe integer or null');
  const denominator = weights.reduce((sum, value) => sum + BigInt(value), 0n);
  const base = weights.map(weight => Number(BigInt(total) * BigInt(weight) / denominator));
  let remaining = total - base.reduce((sum, value) => sum + value, 0);
  const order = weights.map((weight, index) => ({ index, remainder: (BigInt(total) * BigInt(weight)) % denominator, id: ids[index]! }))
    .sort((a, b) => a.remainder === b.remainder ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1);
  for (let index = 0; index < remaining; index++) base[order[index]!.index]!++;
  return base;
}
function addKnown(sum: number | null, value: number | null): number | null { return sum === null || value === null ? null : sum + value; }
function validateRate(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Catalog rates must be non-negative integer micros'); }
