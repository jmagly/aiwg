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

// Resolve from this script, not the working directory, so the smoke also runs
// from an installed package where the examples ship inside the addon.
const root = path.resolve(import.meta.dirname, '../..');
const examples = path.join(root, 'agentic/code/addons/decision-engine/examples');
const runtime = await import(pathToFileURL(path.join(root, 'dist/src/decision/index.js')).href);
const definition = JSON.parse(await readFile(path.join(examples, 'decision-category.json'), 'utf8'));
const binding = JSON.parse(await readFile(path.join(examples, 'binding-jev.json'), 'utf8'));
const input = JSON.parse(await readFile(path.join(examples, 'input.json'), 'utf8'));
const observation = await new runtime.JevDecisionAdapter().evaluate({
  alias: 'category', definition, input,
  target: binding.spec.evaluations.category.targets[0],
  invocationId: `live-${Date.now()}`,
  deadlineEpochMs: Date.now() + 15_000,
  signal: new AbortController().signal,
  resolveCredential: async () => new TextEncoder().encode(process.env.AIWG_DECISION_JEV_API_KEY),
});
process.stdout.write(`${JSON.stringify({ status: observation.status, reason: observation.reason, actualModel: observation.actualModel, usage: observation.usage }, null, 2)}\n`);
process.exit(observation.status === 'success' ? 0 : 1);
