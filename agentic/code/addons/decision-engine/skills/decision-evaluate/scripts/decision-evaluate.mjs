#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { runDecisionEvaluate } from './decision-evaluate-core.mjs';
import { resolveDecisionRuntime } from './runtime-root.mjs';

const args = process.argv.slice(2);
// Usage and opt-in checks run before the packaged runtime is imported.
const early = args.indexOf('--request') < 0 || !args[args.indexOf('--request') + 1]
  || process.env.AIWG_DECISION_ENABLED !== '1';
let runtime = {};
if (!early) {
  let runtimePath;
  try { runtimePath = resolveDecisionRuntime(import.meta.url); }
  catch (error) { console.error(error.message); process.exit(2); }
  runtime = await import(pathToFileURL(runtimePath).href);
}
process.exit(await runDecisionEvaluate({
  argv: args, env: process.env, runtime, stdout: process.stdout, stderr: process.stderr,
}));
