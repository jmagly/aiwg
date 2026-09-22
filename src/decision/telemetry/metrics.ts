import type { TelemetryAttributes } from './types.js';

const METRIC_DIMENSIONS = new Set([
  'aiwg.decision.status', 'aiwg.decision.reason', 'aiwg.adapter.id', 'aiwg.adapter.version',
  'gen_ai.request.model', 'gen_ai.response.model', 'aiwg.acceptance.disposition',
  'aiwg.batch.mode', 'aiwg.cache.result', 'aiwg.review.status', 'aiwg.usage.cost_provenance',
]);

export interface DecisionMetricPoint { name: string; value: number; dimensions: TelemetryAttributes }

export class BoundedDecisionMetrics {
  private readonly points: DecisionMetricPoint[] = [];
  constructor(private readonly capacity = 1_000, private readonly maximumDimensionValues = 100) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(maximumDimensionValues) || maximumDimensionValues < 1) throw new Error('Invalid metric bounds');
  }

  record(name: string, value: number, attributes: TelemetryAttributes): boolean {
    if (!Number.isFinite(value) || this.points.length >= this.capacity) return false;
    const dimensions = Object.fromEntries(Object.entries(attributes).filter(([key, dimension]) => METRIC_DIMENSIONS.has(key)
      && (typeof dimension === 'boolean' || typeof dimension === 'number' || typeof dimension === 'string' && dimension.length <= 64)));
    const signature = JSON.stringify(dimensions);
    const distinct = new Set(this.points.filter(point => point.name === name).map(point => JSON.stringify(point.dimensions)));
    if (!distinct.has(signature) && distinct.size >= this.maximumDimensionValues) return false;
    this.points.push({ name, value, dimensions });
    return true;
  }

  snapshot(): DecisionMetricPoint[] { return structuredClone(this.points); }
}
