import { planDecisionGraph, type DecisionGraph, type GraphPlan } from './graph.js';

type NodeConfig = Omit<DecisionGraph['nodes'][number], 'id' | 'stage' | 'input' | 'output'>;
type Budget = DecisionGraph['budget'];
interface TemplateBase { id: string; budget: Budget; resolvedPins: ReadonlySet<string> }
export interface DecisionGraphTemplate { graph: DecisionGraph; plan: GraphPlan }
function validated(graph: DecisionGraph, pins: ReadonlySet<string>): DecisionGraphTemplate {
  return { graph, plan: planDecisionGraph(graph, pins) };
}
/** Entry obtains an explicit shortlist; only its declared candidates reach reranking. */
export function shortlistRerankTemplate(base: TemplateBase & { shortlist: NodeConfig; rerank: NodeConfig }): DecisionGraphTemplate {
  return validated({ schemaVersion: 'decision-graph/v1', id: base.id, pattern: 'shortlist-rerank',
    entry: 'shortlist', terminals: ['rerank'], budget: base.budget,
    nodes: [
      { ...base.shortlist, id: 'shortlist', stage: 0, input: [], output: ['candidates'] },
      { ...base.rerank, id: 'rerank', stage: 1, input: ['candidates'], output: ['result'] },
    ], edges: [{ from: 'shortlist', to: 'rerank', source: 'candidates', destination: 'candidates' }] }, base.resolvedPins);
}
/** Fixed, caller-authored taxonomy candidates fan out; no model may create new nodes. */
export function taxonomyBeamTemplate(base: TemplateBase & {
  taxonomy: NodeConfig; branches: Array<{ id: string; config: NodeConfig }>; select: NodeConfig;
  /** Opt-in guarded detail stage, one fixed child per declared branch. Selector runs locally. */
  details?: NodeConfig;
}): DecisionGraphTemplate {
  const ordered = [...base.branches].sort((a, b) => a.id.localeCompare(b.id));
  if (base.details && base.select.target !== 'beam') throw new Error('guarded beam requires a deterministic selector target');
  const terminals = base.details ? ordered.map(branch => `detail-${branch.id}`) : ['select'];
  return validated({ schemaVersion: 'decision-graph/v1', id: base.id, pattern: 'taxonomy-beam',
    entry: 'taxonomy', terminals, budget: base.budget,
    nodes: [
      { ...base.taxonomy, id: 'taxonomy', stage: 0, input: [], output: ['children'] },
      ...ordered.map(branch => ({ ...branch.config, id: branch.id, stage: 1, input: ['children'], output: ['score'] })),
      { ...base.select, id: 'select', stage: 2, input: ordered.map(branch => branch.id),
        output: ['result', ...(base.details ? ordered.map(branch => `chosen-${branch.id}`) : [])] },
      ...(base.details ? ordered.map(branch => ({ ...base.details!, id: `detail-${branch.id}`,
        stage: 3, input: ['seed'], output: ['result'] })) : []),
    ], edges: [
      ...ordered.map(branch => ({ from: 'taxonomy', to: branch.id, source: 'children', destination: 'children' })),
      ...ordered.map(branch => ({ from: branch.id, to: 'select', source: 'score', destination: branch.id })),
      ...(base.details ? ordered.map(branch => ({ from: 'select', to: `detail-${branch.id}`,
        source: 'result', destination: 'seed', when: { source: `chosen-${branch.id}`, equals: true } })) : []),
    ] }, base.resolvedPins);
}
/** A declared boolean from the verifier controls the ordinary-LLM fallback.
 * If false, verifier is terminal; if true, the fallback result supersedes it.
 */
export function extractorVerifierFallbackTemplate(base: TemplateBase & {
  extractor: NodeConfig; verifier: NodeConfig; fallback: NodeConfig;
}): DecisionGraphTemplate {
  return validated({ schemaVersion: 'decision-graph/v1', id: base.id, pattern: 'extractor-verifier-fallback',
    entry: 'extractor', terminals: ['verifier', 'fallback'], budget: base.budget,
    nodes: [
      { ...base.extractor, id: 'extractor', stage: 0, input: [], output: ['evidence'] },
      { ...base.verifier, id: 'verifier', stage: 1, input: ['evidence'], output: ['result', 'needs-fallback'] },
      { ...base.fallback, id: 'fallback', stage: 2, input: ['prior'], output: ['result'] },
    ], edges: [
      { from: 'extractor', to: 'verifier', source: 'evidence', destination: 'evidence' },
      { from: 'verifier', to: 'fallback', source: 'result', destination: 'prior',
        when: { source: 'needs-fallback', equals: true } },
    ] }, base.resolvedPins);
}
