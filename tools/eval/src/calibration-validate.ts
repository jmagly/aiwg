// Validate immutable output/config bindings and preserve independent human labels.
import { validateEvalContract } from './contracts.js';
import { digest, opaque } from './pilot-files.js';
import type { Bundle, CalibrationStudy, FixedOutput, Human, Adjudicated } from './calibration-types.js';

export function makeBundles(records: FixedOutput[], study: CalibrationStudy): Bundle[] {
  return records.map((row): Bundle => {
    const p = row.pilot!;
    if (!p || p.dataset_commitment !== study.dataset_commitment) throw new Error('Calibration dataset mismatch');
    const dev = study.split.dev.includes(p.family), held = study.split['held-out'].includes(p.family);
    if (dev === held) throw new Error('Calibration family split overlaps or is missing');
    const context = study.contexts[row.testCaseId];
    if (!context) throw new Error('Missing frozen task context');
    const evidence = { ...context, output: row.modelResponse, checks: row.details.check_outcomes,
      output_status: p.status, policy_receipt: null, checklist: null, uncertainty_inventory: null, recovery_alternatives: null };
    return { id: opaque('episode', { task: row.testCaseId, arm: p.arm_id }), task_id: row.testCaseId,
      family: p.family, split: dev ? 'dev' : 'held-out', digest: digest(evidence), evidence };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function blindedPacket(bundle: Bundle) {
  return { episode_id: bundle.id, bundle_digest: bundle.digest, evidence: bundle.evidence };
}

export function validateStudy(study: CalibrationStudy, records: FixedOutput[]): Bundle[] {
  validateEvalContract('CalibrationStudy', study);
  const { evaluators, votes, humans, adjudications, collection: _collection, commitment, ...frozen } = study;
  if (digest(frozen) !== commitment) throw new Error('Frozen rubric/split commitment mismatch');
  if (digest(study.prompt) !== study.prompt_digest) throw new Error('Prompt digest mismatch');
  if (new Set(study.criteria.map(c => c.id)).size !== 6) throw new Error('Duplicate criterion');
  for (const c of study.criteria) {
    if (Object.keys(c.anchors).sort().join('|') !== Object.keys(c.values).sort().join('|')) throw new Error('Criterion scale mismatch');
    if (c.type === 'nominal' && (c.weight !== 0 || Object.values(c.values).some(v => v !== null))) throw new Error('Nominal criterion cannot have numeric weight');
    if (c.type !== 'nominal' && Object.values(c.values).some(v => v === null)) throw new Error('Missing numeric anchor');
  }
  const bundles = makeBundles(records, study);
  if (new Set(bundles.map(b => b.id)).size !== bundles.length || bundles.length !== 384) throw new Error('Incomplete or duplicate fixed outputs');
  if (digest(bundles) !== study.outputs_digest) throw new Error('Frozen output bundle digest mismatch');
  const byId = new Map(bundles.map(b => [b.id, b]));
  const configs = new Map(evaluators.map(e => [e.id, e]));
  if (configs.size !== evaluators.length) throw new Error('Duplicate evaluator configuration');
  for (const e of evaluators) {
    const { config_digest, prompt_digest, ...config } = e;
    if (digest(config) !== config_digest || digest(e.prompt) !== prompt_digest) throw new Error('Evaluator configuration hash mismatch');
    // Calibration examples are episode IDs; even a related held-out family is forbidden.
    if (e.examples.some(id => byId.get(id)?.split !== 'dev')) throw new Error('Held-out or unknown calibration example');
    if (e.treatment === 'single' && e.examples.length) throw new Error('Single-judge treatment cannot include calibration examples');
  }
  function validateLabel(row: Pick<Human, 'episode_id' | 'bundle_digest' | 'criterion_id' | 'criterion_version' | 'label' | 'evidence'>) {
    const bundle = byId.get(row.episode_id);
    const criterion = study.criteria.find(c => c.id === row.criterion_id);
    if (!bundle || bundle.digest !== row.bundle_digest) throw new Error('Receipt bundle binding mismatch');
    if (!criterion || row.criterion_version !== criterion.version) throw new Error('Receipt criterion version mismatch');
    if (row.evidence.some(id => !Object.hasOwn(bundle.evidence, id) || bundle.evidence[id] === null)) throw new Error('Unresolved evidence span');
    if (row.label === 'NOT_APPLICABLE' && !criterion.allows_na) throw new Error('Criterion does not permit N/A');
    if (!['NOT_APPLICABLE', 'CANNOT_ASSESS'].includes(row.label) && !Object.hasOwn(criterion.anchors, row.label)) throw new Error('Invalid criterion label');
    if (Object.hasOwn(criterion.anchors, row.label) && !row.evidence.length) throw new Error('Assessed label requires evidence');
  }
  const executions = new Map<string, typeof votes[number]>();
  const latest = new Map<string, typeof votes[number]>();
  for (const vote of votes) {
    const evaluator = configs.get(vote.evaluator_id);
    if (!evaluator || vote.config_digest !== evaluator.config_digest) throw new Error('Vote evaluator configuration mismatch');
    if (executions.has(vote.execution_id)) throw new Error('Duplicate execution');
    const key = `${vote.evaluator_id}:${vote.episode_id}:${vote.criterion_id}`;
    const prior = latest.get(key);
    if ((prior?.execution_id ?? null) !== vote.retry_of || prior?.status === 'completed') throw new Error('Invalid retry lineage');
    if (vote.prompt !== undefined && digest(vote.prompt) !== vote.prompt_digest) throw new Error('Vote prompt digest mismatch');
    if (vote.settings !== undefined && digest(vote.settings) !== vote.settings_digest) throw new Error('Vote settings digest mismatch');
    if (digest(vote.raw_response) !== vote.raw_digest) throw new Error('Raw response digest mismatch');
    if ((vote.status === 'completed') !== (vote.label !== null)) throw new Error('Incomplete/provider error cannot supply a judgment');
    validateLabel({ ...vote, label: vote.label ?? 'CANNOT_ASSESS' });
    const criterion = study.criteria.find(c => c.id === vote.criterion_id)!;
    if (new Set(vote.option_order).size !== vote.option_order.length || vote.option_order.length !== Object.keys(criterion.anchors).length
      || vote.option_order.some(label => !Object.hasOwn(criterion.anchors, label))) throw new Error('Incomplete option order');
    executions.set(vote.execution_id, vote); latest.set(key, vote);
  }
  const humanKeys = new Set<string>();
  for (const human of humans) {
    validateLabel(human);
    const key = `${human.episode_id}:${human.criterion_id}:${human.annotator}`;
    if (humanKeys.has(key)) throw new Error('Duplicate human annotation');
    humanKeys.add(key);
  }
  const targets = new Set<string>();
  for (const target of adjudications) {
    validateLabel(target);
    const key = `${target.episode_id}:${target.criterion_id}`;
    if (targets.has(key)) throw new Error('Duplicate adjudication');
    targets.add(key);
    const labels = humans.filter(h => h.episode_id === target.episode_id && h.criterion_id === target.criterion_id);
    if (labels.length !== 2 || new Set(labels.map(h => h.annotator)).size !== 2 || labels.some(h => h.annotator === target.adjudicator)) throw new Error('Adjudication requires two blinded annotators and an independent adjudicator');
  }
  return bundles;
}

export function humanPair(humans: Human[], target: Pick<Adjudicated, 'episode_id' | 'criterion_id'>) {
  return humans.filter(h => h.episode_id === target.episode_id && h.criterion_id === target.criterion_id);
}
