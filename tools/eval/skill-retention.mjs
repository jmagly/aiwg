// Offline metadata-only intervention using the shipped discover implementation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { arms, digest, original, refineIncoming, summarize, validateSnapshot } from './skill-retention-controls.mjs';
export { refineIncoming, validateSnapshot } from './skill-retention-controls.mjs';

async function modules(skills) {
  return new Map(await Promise.all(skills.map(async skill => [skill.id,
    await import(`data:text/javascript;base64,${Buffer.from(skill.body).toString('base64')}`)])));
}

function execute(task, selected, loaded, input) {
  let value = structuredClone(input);
  for (const step of task.steps) {
    const implementation = selected.map(id => loaded.get(id)).find(item => item?.operation === step);
    if (!implementation) throw new Error(`Selected tools cannot execute ${step}`);
    value = implementation.default(value);
  }
  return value;
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function validateAlternatives(tasks, loaded) {
  const results = {};
  for (const task of tasks) {
    results[task.id] = {};
    for (const [required, candidates] of Object.entries(task.alternatives)) {
      results[task.id][required] = candidates.filter(candidate => {
        const selection = task.required.map(id => id === required ? candidate : id);
        try { return task.validationCases.every(test => equal(execute(task, selection, loaded, test.input), test.expected)); }
        catch { return false; }
      });
    }
  }
  return results;
}

async function currentDiscover(project, skills, task, controls) {
  const { getGraphIndexDir } = await import('../../dist/src/artifacts/types.js');
  const { discoverCapability } = await import('../../dist/src/artifacts/query-engine-discover.js');
  const directory = getGraphIndexDir(project, 'project');
  fs.mkdirSync(directory, { recursive: true });
  const entries = Object.fromEntries(skills.map(skill => [skill.id, {
    name: skill.name, title: skill.name, path: `skills/${skill.id}/SKILL.md`, type: 'skill',
    capability: skill.description, summary: '', tags: [], phase: '', created: '', updated: '',
    checksum: skill.bodyHash, dependencies: [], dependents: [],
  }]));
  fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify({ entries }));
  const output = [], log = console.log;
  console.log = (...args) => output.push(args.map(String).join(' '));
  try {
    await discoverCapability(project, { phrase: task.query, typeFilter: ['skill'], graph: 'project',
      backend: 'local', limit: controls.limit, noBuild: true, offline: true, resourceSource: 'local', json: true });
  } finally { console.log = log; }
  return JSON.parse(output.join('')).results.map(item => item.name);
}

export async function runStudy(data, root, { route = currentDiscover } = {}) {
  validateSnapshot(data);
  const snapshotHash = digest(JSON.stringify(data));
  const loaded = await modules(data.skills);
  const alternatives = validateAlternatives(data.tasks, loaded);
  const controls = { router: 'current-discover:local', graph: 'project', type: 'skill', offline: true,
    noBuild: true, limit: data.protocol.limit, contextCharacters: data.protocol.contextCharacters,
    executionSteps: data.protocol.executionSteps, modelBudget: 0 };
  const runs = [];
  for (const [stream, sequence] of Object.entries(data.protocol.streams)) {
    for (const arm of arms) {
      const available = data.skills.filter(s => s.cohort === 'old').map(s => ({ ...s }));
      const refinements = [];
      for (let step = 0; step <= sequence.length; step++) {
        let refinementMs = 0;
        let refinementContextCharacters = 0;
        let refinementOutputCharacters = 0;
        if (step) {
          const incoming = data.skills.find(s => s.id === sequence[step - 1]);
          if (arm === 'body-only' || arm === 'neighbour-aware') {
            const refinementStart = performance.now();
            const neighbours = data.skills.filter(s => available.some(a => a.id === s.id));
            const refinement = refineIncoming(incoming, arm === 'body-only' ? [] : neighbours, arm);
            refinementMs = performance.now() - refinementStart;
            refinementContextCharacters = incoming.body.length + JSON.stringify(refinement.basis).length;
            refinementOutputCharacters = refinement.description.length;
            refinements.push({ id: incoming.id, ...refinement, calls: 0, retries: 0, embeddings: 0 });
            available.push({ ...incoming, description: refinement.description });
          } else available.push({ ...incoming });
        }
        const eligible = data.tasks.filter(task => task.required.every(id => available.some(s => s.id === id)));
        const queries = [], cost = { refinementCalls: 0, retries: 0, embeddings: 0, modelTokens: 0,
          usd: 0, refinementMs, routingCharacters: 0, routingMs: 0, executionMs: 0, executionAttempts: 0,
          refinementContextCharacters, refinementOutputCharacters };
        const project = path.join(root, stream, arm, String(step));
        fs.mkdirSync(project, { recursive: true });
        const metadataCharacters = JSON.stringify(available.map(s => ({ id: s.id, description: s.description }))).length;
        for (const task of eligible) {
          const cohorts = new Set(task.required.map(id => data.skills.find(s => s.id === id).cohort));
          const stratum = cohorts.size === 2 ? 'mixed' : cohorts.has('new') ? 'new-only' : 'old-only';
          const row = { id: task.id, stratum, selected: [], strict: false, functional: false,
            execution: { status: 'not-run' } };
          const start = performance.now();
          cost.routingCharacters += metadataCharacters + task.query.length;
          try {
            if (metadataCharacters + task.query.length > controls.contextCharacters) throw new Error('routing context budget exceeded');
            row.selected = await route(project, available, task, controls);
            if (row.selected.length > controls.limit || row.selected.some(id => !available.some(s => s.id === id))) {
              throw new Error('router returned invalid selection');
            }
            row.strict = task.required.every(id => row.selected.includes(id));
            row.functional = task.required.every(id => row.selected.includes(id)
              || (alternatives[task.id][id] ?? []).some(other => row.selected.includes(other)));
          } catch (error) { row.error = error.message; }
          cost.routingMs += performance.now() - start;
          if (!row.error) {
            const executionStart = performance.now();
            cost.executionAttempts++;
            try {
              const actual = execute(task, row.selected, loaded, task.input);
              row.execution = { status: equal(actual, task.expected) ? 'passed' : 'failed', actual, expected: task.expected };
            } catch (error) { row.execution = { status: 'failed', error: error.message }; }
            cost.executionMs += performance.now() - executionStart;
          }
          queries.push(row);
        }
        runs.push({ stream, arm, step, status: queries.some(q => q.error) ? 'partial' : 'completed',
          controls, originals: available.map(s => original(data.skills.find(o => o.id === s.id))),
          refinements: structuredClone(refinements), queries, strata: summarize(queries), cost });
      }
    }
  }
  const pairs = [];
  for (const candidate of runs.filter(run => run.arm !== 'unchanged')) {
    const baseline = runs.find(run => run.arm === 'unchanged' && run.stream === candidate.stream && run.step === candidate.step);
    for (const query of candidate.queries) {
      const before = baseline.queries.find(q => q.id === query.id);
      pairs.push({ stream: candidate.stream, step: candidate.step, arm: candidate.arm, task: query.id, stratum: query.stratum,
        comparable: !query.error && !before.error,
        strictDelta: Number(query.strict) - Number(before.strict),
        functionalDelta: Number(query.functional) - Number(before.functional),
        executionDelta: Number(query.execution.status === 'passed') - Number(before.execution.status === 'passed') });
    }
  }
  if (snapshotHash !== digest(JSON.stringify(data))) throw new Error('snapshot changed during evaluation');
  return { snapshotHash, protocol: data.protocol, controls, originals: data.skills.map(original), alternatives, runs, pairs,
    recommendation: { decision: 'no-change', reason: 'A small synthetic offline pilot cannot prove general routing or model task-performance benefit.',
      reversal: 'Keep production metadata and router unchanged; remove this optional pilot to revert.',
      limitations: ['Literal body-clause support only; no general semantic fidelity guarantee.',
        'Zero model calls; timing and characters are local costs, not measured model tokens.',
        'Execution uses deterministic local tools, not an agent; task performance is reported separately.',
        'Wilson intervals are descriptive; arrival streams and repeated tasks are dependent.',
        'Snapshot is representative of confusable operation families, not the production catalog.'] } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const fixture = process.argv[2] ?? 'test/fixtures/artifacts/skill-retention.json';
  const output = process.argv[3];
  if (!output) throw new Error('Usage: node tools/eval/skill-retention.mjs [snapshot.json] <report.json>');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-retention-'));
  // A synthetic corpus must not consult the installed catalog for output enrichment.
  process.env.AIWG_ROOT = path.join(root, 'runtime');
  try {
    const report = await runStudy(JSON.parse(fs.readFileSync(fixture, 'utf8')), root);
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ runs: report.runs.length, partial: report.runs.filter(r => r.status === 'partial').length,
      pairs: report.pairs.length, decision: report.recommendation.decision, output }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
