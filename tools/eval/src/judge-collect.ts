// Collect blinded criterion votes into the existing calibration archive, with resumable caps.
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PilotDataset } from './pilot-types.js';
import { validateStudy, blindedPacket } from './calibration-validate.js';
import { validateEvalContract } from './contracts.js';
import { digest, shuffle, random, opaque, loadPilot } from './pilot-files.js';
import { invokeJudge, httpPayload } from './judge-transport.js';
import { prepareJudgeProject, lockJudgeProject, JudgeProjectIsolationError } from './judge-project.js';
import type { Bundle, CalibrationStudy, Criterion, Vote, Evaluator } from './calibration-types.js';
import type { CollectOptions, JudgeConfiguration, Observation, ExecutableReference } from './judge-types.js';

function validateOptions(options: CollectOptions) {
  if (!Number.isInteger(options.maxCalls) || options.maxCalls < 0) throw new Error('--max-calls requires a nonnegative integer');
  if (!['dev', 'heldout'].includes(options.tranche)) throw new Error('--tranche dev|heldout is required');
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) throw new Error('Seed requires a uint32');
  if (!Number.isInteger(options.maxAttempts ?? 2) || (options.maxAttempts ?? 2) < 1) throw new Error('Invalid max attempts');
  if (!options.runDir || !options.evaluators.length) throw new Error('Run directory and evaluator configurations are required');
  if (new Set(options.evaluators.map(e => e.id)).size !== options.evaluators.length) throw new Error('Duplicate evaluator');
  for (const config of options.evaluators) {
    validateEvalContract('JudgeConfiguration', config);
    if (config.transport === 'cli' && (!config.role || !config.group || config.model || config.max_tokens || config.max_call_usd)) throw new Error('CLI judges require group and role, with optional task');
    if (config.transport === 'openrouter' && (!config.model || !config.max_call_usd || !config.max_tokens || config.group || config.role || config.task)) throw new Error('HTTP judges require model, max_tokens and max_call_usd');
  }
  if (options.evaluators.some(e => e.transport === 'openrouter') && (options.maxUsd === undefined || !Number.isFinite(options.maxUsd) || options.maxUsd < 0)) throw new Error('--max-usd requires a nonnegative HTTP budget');
}
export function renderJudgePrompt(study: CalibrationStudy, bundle: Bundle, criterion: Criterion, order: string[]) {
  // No task, evaluator, arm, family, resource, provenance or decoding metadata enters this object.
  const { anchors, values: _values, ...definition } = criterion;
  const citable = Object.keys(bundle.evidence).filter(id => bundle.evidence[id] !== null).sort();
  return `${study.prompt}\nCitable evidence span IDs (only non-null top-level packet.evidence keys, sorted): ${JSON.stringify(citable)}\nCite only IDs from this list. Express missing evidence with label CANNOT_ASSESS and explain what is missing in the rationale; never cite an absent or null span ID. The evidence citation list may be empty only for CANNOT_ASSESS or, when permitted, NOT_APPLICABLE. Every assessed label requires at least one listed span ID.\nReturn one JSON object: {"label":"...","evidence":[],"rationale":"...","critical_flags":[],"secondary_flags":[],"confidence":null}.\nFor a CLI worker final envelope, write this judgment to answer.json beside the requested final-output file. Declare exactly one artifact in the envelope: {"path":"answer.json","digest":"sha256:<SHA-256 of the exact file bytes>"}; use a prose summary. The JSON artifact must remain inside this attempt directory. Bare judgment JSON or JSON embedded in the envelope summary with no artifacts is also accepted.\n${JSON.stringify({
    packet: blindedPacket(bundle), criterion: { ...definition, anchors: order.map(label => ({ label, description: anchors[label] })) },
    abstentions: criterion.allows_na ? ['CANNOT_ASSESS', 'NOT_APPLICABLE'] : ['CANNOT_ASSESS'],
  })}`;
}
function evaluator(config: JudgeConfiguration, study: CalibrationStudy, options: CollectOptions): Evaluator {
  const base = { id: config.id, version: 'judge-collect-v1', treatment: 'shuffling' as const,
    observed_model: 'unknown', observed_vendor: 'unknown', observed_family: 'unknown', revision: 'unknown',
    prompt: study.prompt, settings: { declaration: config, seed: options.seed, defaults: 'unknown',
      response_format: 'criterion-json-v1', ordering: 'seed+episode+criterion', max_attempts: options.maxAttempts ?? 2 }, examples: [] };
  return { ...base, config_digest: digest(base), prompt_digest: digest(base.prompt) };
}
function references(bundles: Bundle[], options: CollectOptions, dataset: PilotDataset): ExecutableReference[] {
  return bundles.map(bundle => {
    const row = options.records.find(r => opaque('episode', { task: r.testCaseId, arm: r.pilot!.arm_id }) === bundle.id)!;
    const task = dataset.tasks.find(t => t.id === row.testCaseId)!;
    const outcomes = bundle.evidence.checks as { passed: boolean }[];
    return { type: 'executable-reference', episode_id: bundle.id, bundle_digest: bundle.digest,
      criterion_id: 'hidden-executable-artifact-correctness', label: bundle.evidence.output_status === 'completed' && outcomes.every(c => c.passed) ? 'MET' : 'UNMET',
      provenance: { checker: dataset.pins.checker, checks: task.pilot.checks, outcomes_digest: digest(row.details.check_outcomes), output_status: row.pilot!.status } };
  });
}
async function checkpoint(runDir: string, study: CalibrationStudy) {
  validateEvalContract('CalibrationStudy', study);
  await writeFile(path.join(runDir, 'study.json.tmp'), JSON.stringify(study, null, 2) + '\n');
  await rename(path.join(runDir, 'study.json.tmp'), path.join(runDir, 'study.json'));
}
async function parseJudgment(observation: Observation, vote: Vote, study: CalibrationStudy, records: CollectOptions['records'], attemptDir: string) {
  if (observation.judgmentArtifact) await writeFile(path.join(attemptDir, 'judgment-artifact.json'), observation.judgmentArtifact);
  vote.raw_response = observation.raw; vote.raw_digest = digest(observation.raw);
  vote.cost_usd = observation.cost; vote.tokens = observation.tokens;
  vote.settings = observation.settings; vote.settings_digest = digest(observation.settings);
  for (const key of ['observed_model', 'observed_vendor', 'observed_family', 'revision'] as const) vote[key] = observation[key];
  vote.critical_flags = observation.flags;
  vote.status = observation.status ?? 'partial';
  vote.rationale = observation.settings.diagnostic ? `Resolver blocked: ${JSON.stringify(observation.settings.diagnostic)}`
    : observation.status ? `Transport outcome: ${observation.status}` : 'Invalid or incomplete judgment';
  if (observation.status) return;
  try {
    if (observation.judgmentError) throw new Error(observation.judgmentError);
    let parsed = JSON.parse(observation.judgmentArtifact?.toString('utf8') ?? observation.content);
    // CLI final-output contracts may wrap the answer JSON in their summary.
    if (!observation.judgmentArtifact && parsed.version === 1 && parsed.status && typeof parsed.summary === 'string') parsed = JSON.parse(parsed.summary);
    const candidate = { ...vote, status: 'completed' as const, label: parsed.label, evidence: parsed.evidence,
      rationale: parsed.rationale, critical_flags: parsed.critical_flags, secondary_flags: parsed.secondary_flags ?? [], confidence: parsed.confidence ?? null };
    validateStudy({ ...study, votes: [...study.votes.slice(0, -1), candidate] }, records);
    Object.assign(vote, candidate);
  } catch (error) {
    vote.critical_flags.push('invalid-judgment');
    vote.rationale = `Invalid judgment: ${error instanceof Error ? error.message : String(error)}`;
  }
}
export async function collectJudges(options: CollectOptions) {
  validateOptions(options);
  options = await prepareJudgeProject(options);
  const maxAttempts = options.maxAttempts ?? 2;
  const bundles = validateStudy(options.study, options.records).filter(b => b.split === (options.tranche === 'heldout' ? 'held-out' : 'dev'));
  const configDigest = digest({ commitment: options.study.commitment, seed: options.seed, tranche: options.tranche,
    evaluators: options.evaluators, maxAttempts, judgeProject: options.judgeProject ?? null,
    resolver: options.resolver ?? null, httpEndpoint: options.httpEndpoint ?? null });
  const plan = { tranche: options.tranche, packets: bundles.length, criteria: options.study.criteria.length,
    configurations: options.evaluators, estimated_calls: bundles.length * options.study.criteria.length * options.evaluators.length,
    maximum_attempt_calls: bundles.length * options.study.criteria.length * options.evaluators.length * maxAttempts,
    max_calls: options.maxCalls, max_usd: options.maxUsd ?? 'not-applicable', human_labels_needed: options.study.criteria.map(c => c.id) };
  if (options.dryRun) return { plan, study: options.study };
  const { dataset } = await loadPilot(fileURLToPath(new URL('../datasets/composition-pilot.json', import.meta.url)),
    fileURLToPath(new URL('../../../test/fixtures/eval-pilot', import.meta.url)));
  if (dataset.commitment !== options.study.dataset_commitment) throw new Error('Frozen pilot commitment mismatch');
  const runDir = path.resolve(options.runDir);
  await mkdir(runDir, { recursive: true });
  const lockPath = path.join(runDir, 'collector.lock');
  const lock = await open(lockPath, 'wx');
  let releaseProject = async () => {};
  try {
    releaseProject = await lockJudgeProject(options.judgeProject);
    let study: CalibrationStudy;
    try { study = JSON.parse(await readFile(path.join(runDir, 'study.json'), 'utf8')); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      if (options.study.votes.length || options.study.evaluators.length) throw new Error('Start collection from the frozen empty study; resume from the run directory');
      study = structuredClone(options.study);
      study.evaluators = options.evaluators.map(c => evaluator(c, study, options));
      study.collection = { config_digest: configDigest, seed: options.seed, tranche: options.tranche, max_attempts: maxAttempts,
        evaluators: options.evaluators, stop_reason: 'complete', executable_references: references(bundles, options, dataset), human_labels_needed: plan.human_labels_needed };
    }
    if (study.collection?.config_digest !== configDigest) throw new Error('Resume configuration mismatch');
    // An interrupted dispatch is never silently repeated: recover its committed receipt or stop.
    for (let i = 0; i < study.votes.length; i++) {
      if (!study.votes[i].critical_flags.includes('in-flight')) continue;
      try { study.votes[i] = JSON.parse(await readFile(path.join(runDir, study.votes[i].execution_id, 'vote.json'), 'utf8')); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    validateStudy(study, options.records);
    for (const vote of study.votes) {
      const bundle = bundles.find(b => b.id === vote.episode_id)!;
      const criterion = study.criteria.find(c => c.id === vote.criterion_id)!;
      if (digest(renderJudgePrompt(study, bundle, criterion, vote.option_order)) !== vote.prompt_digest) throw new Error('Resume prompt drift; use a fresh run directory');
    }
    if (!options.retryBlocked && options.evaluators.some(config => study.votes
      .filter(v => v.evaluator_id === config.id).at(-1)?.critical_flags.includes('resolver-blocked'))) {
      study.collection.stop_reason = 'resolver-blocked'; await checkpoint(runDir, study); return { plan, study };
    }
    if (study.votes.some(v => v.critical_flags.includes('in-flight'))) {
      study.collection.stop_reason = 'in-flight'; await checkpoint(runDir, study); return { plan, study };
    }
    study.collection.stop_reason = 'complete';
    const httpSpend = () => study.votes.reduce((sum, vote) => {
      const declaration = options.evaluators.find(e => e.id === vote.evaluator_id)!;
      return sum + (declaration.transport === 'openrouter' ? typeof vote.cost_usd === 'number' ? vote.cost_usd : declaration.max_call_usd! : 0);
    }, 0);
    for (const bundle of bundles) for (const criterion of study.criteria) for (const config of options.evaluators) {
      const attempts = study.votes.filter(v => v.episode_id === bundle.id && v.criterion_id === criterion.id && v.evaluator_id === config.id);
      if (attempts.some(v => v.status === 'completed')) continue;
      while (attempts.length < maxAttempts) {
        if (study.votes.length >= options.maxCalls) { study.collection.stop_reason = 'max-calls'; await checkpoint(runDir, study); return { plan, study }; }
        const spent = httpSpend();
        if (options.maxUsd !== undefined && spent > 0 && spent >= options.maxUsd - 1e-12) {
          study.collection.stop_reason = 'max-usd'; await checkpoint(runDir, study); return { plan, study };
        }
        if (config.transport === 'openrouter' && spent + config.max_call_usd! > options.maxUsd! + 1e-12) {
          study.collection.stop_reason = 'max-usd'; await checkpoint(runDir, study); return { plan, study };
        }
        const orderSeed = Number.parseInt(digest({ seed: options.seed, episode: bundle.id, criterion: criterion.id }).slice(7, 15), 16);
        const order = shuffle(Object.keys(criterion.anchors), random(orderSeed));
        const prompt = renderJudgePrompt(study, bundle, criterion, order);
        const execution = `${opaque('judge', { bundle: bundle.id, criterion: criterion.id, evaluator: config.id })}-attempt-${attempts.length + 1}`;
        const attemptDir = path.join(runDir, execution); await mkdir(attemptDir, { recursive: true });
        const vote: Vote = { episode_id: bundle.id, bundle_digest: bundle.digest, criterion_id: criterion.id, criterion_version: criterion.version,
          evaluator_id: config.id, config_digest: study.evaluators.find(e => e.id === config.id)!.config_digest,
          execution_id: execution, retry_of: attempts.at(-1)?.execution_id ?? null, status: 'missing', label: null, evidence: [],
          rationale: 'Dispatch interrupted before receipt', critical_flags: ['in-flight'], secondary_flags: [], raw_response: '', raw_digest: digest(''),
          cost_usd: 'unknown', tokens: 'unknown', latency_ms: 'unknown', option_order: order, confidence: null, prompt, prompt_digest: digest(prompt),
          settings: config.transport === 'openrouter' ? httpPayload(config, prompt) : { declaration: config },
          observed_model: 'unknown', observed_vendor: 'unknown', observed_family: 'unknown', revision: 'unknown' };
        vote.settings_digest = digest(vote.settings);
        study.votes.push(vote); await checkpoint(runDir, study);
        const started = performance.now();
        let observation: Observation;
        try { observation = await invokeJudge(config, prompt, attemptDir, options); }
        catch (error) {
          if (error instanceof JudgeProjectIsolationError) throw error;
          observation = { raw: '', content: '', status: 'provider-error', flags: ['launch-error'], cost: 'unknown', tokens: 'unknown',
            settings: vote.settings!, observed_model: 'unknown', observed_vendor: 'unknown', observed_family: 'unknown', revision: 'unknown' };
        }
        vote.latency_ms = performance.now() - started;
        await parseJudgment(observation, vote, study, options.records, attemptDir);
        await writeFile(path.join(attemptDir, 'vote.json'), JSON.stringify(vote, null, 2) + '\n');
        await checkpoint(runDir, study); attempts.push(vote);
        if (vote.critical_flags.includes('resolver-blocked')) {
          study.collection.stop_reason = 'resolver-blocked'; await checkpoint(runDir, study); return { plan, study };
        }
        if (vote.status === 'completed') break;
      }
    }
    await checkpoint(runDir, study); return { plan, study };
  } finally { await releaseProject(); await lock.close(); await unlink(lockPath); }
}
