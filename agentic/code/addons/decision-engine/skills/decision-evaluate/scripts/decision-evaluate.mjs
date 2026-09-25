#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDecisionEvaluate } from './decision-evaluate-core.mjs';

const args = process.argv.slice(2);
// Usage and opt-in checks run before the packaged runtime is imported.
const early = args.indexOf('--request') < 0 || !args[args.indexOf('--request') + 1]
  || process.env.AIWG_DECISION_ENABLED !== '1';
const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../../../../');
const runtime = early ? {} : await import(pathToFileURL(path.join(packageRoot, 'dist/src/decision/index.js')).href);
process.exit(await runDecisionEvaluate({
  argv: args, env: process.env, runtime, stdout: process.stdout, stderr: process.stderr,
}));
