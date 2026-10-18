#!/usr/bin/env node
/**
 * Opt-in, cost-bounded model-routing smoke recorder.
 * Normal CI exercises only --check; live commands require explicit operator gates.
 * @implements #1807
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const args = {};
for (let index = 0; index < argv.length; index++) {
  if (!argv[index].startsWith('--')) continue;
  const next = argv[index + 1];
  args[argv[index].slice(2)] = !next || next.startsWith('--') ? true : next;
}
const budget = Number(args['budget-usd'] ?? 0);
const check = args.check === true;
const provider = String(args.provider ?? '');
const command = String(args.command ?? '');
const output = String(args.output ?? '');

if (check) {
  console.log(JSON.stringify({
    live: false,
    normalCiCostUsd: 0,
    requiredGate: 'AIWG_MODEL_LIVE_SMOKE=1',
    maximumBudgetUsd: 0.25,
  }, null, 2));
  process.exit(0);
}
if (process.env.AIWG_MODEL_LIVE_SMOKE !== '1') {
  throw new Error('Live model smoke is disabled; set AIWG_MODEL_LIVE_SMOKE=1 explicitly');
}
if (!provider || !command || !output) {
  throw new Error('--provider, --command, and --output are required for live smoke');
}
if (!Number.isFinite(budget) || budget <= 0 || budget > 0.25) {
  throw new Error('--budget-usd must be greater than 0 and no more than 0.25');
}

const startedAt = new Date().toISOString();
const result = spawnSync('/bin/sh', ['-c', command], {
  encoding: 'utf8',
  timeout: 120_000,
  env: { ...process.env, AIWG_MODEL_SMOKE_BUDGET_USD: String(budget) },
  killSignal: 'SIGKILL',
});
const evidence = {
  version: '1.0.0',
  provider,
  startedAt,
  completedAt: new Date().toISOString(),
  budgetUsd: budget,
  exitCode: result.status,
  resolved: {
    model: process.env.AIWG_MODEL_SMOKE_RESOLVED_MODEL ?? null,
    effort: process.env.AIWG_MODEL_SMOKE_RESOLVED_EFFORT ?? null,
    fallback: process.env.AIWG_MODEL_SMOKE_FALLBACK ?? null,
    accountConstraints: process.env.AIWG_MODEL_SMOKE_ACCOUNT_CONSTRAINTS ?? null
  },
  stdout: result.stdout.trim(),
  stderr: result.stderr.trim(),
};
fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
if (result.status !== 0) process.exitCode = result.status ?? 1;
