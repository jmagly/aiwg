import { DecisionGraphError } from './graph.js';

/** Deterministic, bounded ranking primitive for shortlist/rerank and taxonomy beams.
 * The trusted caller supplies candidate IDs and scores; model evidence cannot widen
 * the graph or confer action authority. This primitive performs no dispatch.
 */
export function selectDecisionBeam<T extends { id: string; score: number }>(
  candidates: readonly T[], width: number, ceiling: number,
): T[] {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(ceiling) || ceiling < 1 || width > ceiling) {
    throw new DecisionGraphError('invalid beam width');
  }
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(candidate.id) || ids.has(candidate.id) ||
        typeof candidate.score !== 'number' || !Number.isFinite(candidate.score)) throw new DecisionGraphError('invalid beam candidate');
    ids.add(candidate.id);
  }
  // Explicit secondary key: binary code-point order, never locale or completion order.
  return [...candidates].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, width);
}
