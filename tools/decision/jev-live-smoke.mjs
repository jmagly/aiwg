#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.AIWG_DECISION_JEV_LIVE_SMOKE !== '1') {
  console.error('Live Jev smoke is opt-in. Set AIWG_DECISION_JEV_LIVE_SMOKE=1.');
  process.exit(2);
}
if (!process.env.AIWG_DECISION_JEV_API_KEY) {
  console.error('AIWG_DECISION_JEV_API_KEY is required and is never logged.');
  process.exit(2);
}
// Region is a declared deployment attribute; the evaluator denies an unknown region.
if (!process.env.AIWG_DECISION_JEV_REGION) {
  console.error('AIWG_DECISION_JEV_REGION must name the recorded deployment region for the projection policy.');
  process.exit(2);
}

const root = process.cwd();
const runtime = await import(pathToFileURL(path.join(root, 'dist/src/decision/index.js')).href);
const load = async name => JSON.parse(await readFile(path.join(root, 'examples/decision', name), 'utf8'));
const definition = await load('decision-category.json');
const input = await load('input.json');
const region = process.env.AIWG_DECISION_JEV_REGION;
const policy = await load('projection-policy-jev.json');
policy.region = region;
for (const field of policy.fields) field.allowedRegions = [region];

// One evaluation through the evaluator, so the live call crosses the same
// projection and endpoint-binding boundary as every other dispatch.
const fullRuleset = await load('ruleset.json');
const ruleset = { ...fullRuleset, spec: { ...fullRuleset.spec,
  evaluations: fullRuleset.spec.evaluations.filter(item => item.alias === 'category'),
  rules: fullRuleset.spec.rules.filter(rule => rule.id === 'docs') } };
const fullBinding = await load('binding-jev.json');
const binding = { ...fullBinding, spec: { ...fullBinding.spec, ruleset: runtime.artifactPin(ruleset),
  evaluations: { category: fullBinding.spec.evaluations.category } } };

const result = await runtime.evaluateDecisionRuleset({
  ruleset, binding, definitions: { [definition.metadata.id]: definition }, input,
  runId: 'jev-live-smoke', invocationId: `live-${Date.now()}`,
  adapters: { jev: new runtime.JevDecisionAdapter({ region }) },
  projection: { resolve: () => structuredClone(policy) },
  resolveCredential: async () => new TextEncoder().encode(process.env.AIWG_DECISION_JEV_API_KEY),
});
const evaluation = result.spec.evaluations.category;
const attempt = evaluation?.spec.attempts.at(-1);
process.stdout.write(`${JSON.stringify({ status: evaluation?.spec.status ?? result.spec.status,
  reason: evaluation?.spec.reason ?? result.spec.reason, actualModel: attempt?.actualModel ?? null,
  usage: attempt?.usage ?? null }, null, 2)}\n`);
process.exit(evaluation?.spec.status === 'success' ? 0 : 1);
