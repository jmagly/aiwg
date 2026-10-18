#!/usr/bin/env node
/**
 * D12 live paired qualification (#2686): flat FlowGraph baseline versus the dependent
 * decision graph on the preregistered synthetic workload. Dry-run by default: without
 * --collect-approved and AIWG_DECISION_DAG_LIVE=1 it never resolves a credential or calls Jev.
 *
 * Offline modes (dry run, freeze, record decision) run the TypeScript source through the tsx dev
 * dependency and never build; only --collect-approved compiles dist, from the exact approved commit.
 *
 *   node tools/decision/dag-live-qualification.mjs [--dry-run [APPROVAL.json [ARTIFACT_ROOT]]]
 *   node tools/decision/dag-live-qualification.mjs --freeze OUTPUT_DIR
 *   AIWG_DECISION_DAG_LIVE=1 node tools/decision/dag-live-qualification.mjs --collect-approved \
 *     APPROVAL.json ARTIFACT_ROOT tools/decision/jev-openbao-credential.mjs RESOLVER_SHA256
 *   node tools/decision/dag-live-qualification.mjs --record-decision RUN_DIR promote|hold REVIEWER RATIONALE
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const frozen = join(root, 'docs/decision/evidence/dag-live-v1');
const args = process.argv.slice(2);
const mode = args[0] ?? '--dry-run';
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

if (!['--dry-run', '--freeze', '--collect-approved', '--record-decision'].includes(mode)) {
  process.stderr.write('Unknown mode. Use --dry-run, --freeze, --collect-approved or --record-decision. No provider calls made.\n');
  process.exit(2);
}
try {
  if (mode === '--collect-approved') {
    if (process.env.AIWG_DECISION_DAG_LIVE !== '1' || args.length !== 5) {
      process.stderr.write('Live collection requires AIWG_DECISION_DAG_LIVE=1 and APPROVAL ARTIFACT_ROOT RESOLVER RESOLVER_SHA256. No provider calls made.\n');
      process.exit(2);
    }
    // Compile the exact committed source; stale dist cannot back live evidence.
    execFileSync('npm', ['run', 'build:cli'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], timeout: 900_000, killSignal: 'SIGKILL' });
  }
  const live = mode === '--collect-approved';
  const module = name => live ? pathToFileURL(join(root, `dist/src/decision/${name}.js`)).href : pathToFileURL(join(root, `src/decision/${name}.ts`)).href;
  if (!live) {
    // No build on shared hosts: transpile the source on import through the tsx dev dependency.
    let register;
    try { ({ register } = await import('tsx/esm/api')); } catch {
      process.stderr.write('Offline modes need the tsx dev dependency (npm ci installs it); no build is run. No provider calls made.\n');
      process.exit(2);
    }
    register();
  }
  const runtime = await import(module('graph-live-qualification'));
  const workloads = await import(module('graph-live-workload'));
  if (mode === '--freeze') {
    if (args.length !== 2) throw new Error('usage');
    const workload = workloads.generateDagLiveWorkload();
    const preregistration = workloads.dagLivePreregistration(workload);
    await mkdir(args[1], { recursive: true });
    await writeFile(join(args[1], 'workload.json'), JSON.stringify(workload, null, 2) + '\n', { flag: 'wx' });
    await writeFile(join(args[1], 'preregistration.json'), JSON.stringify(preregistration, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify({ workloadDigest: runtime.dagLiveDigest(workload), preregistrationDigest: runtime.dagLiveDigest(preregistration), providerCalls: 0 }) + '\n');
    process.exit(0);
  }
  const workload = await readJson(join(frozen, 'workload.json'));
  const preregistration = await readJson(join(frozen, 'preregistration.json'));
  if (mode === '--dry-run') {
    const approval = args[1] ? await readJson(args[1]) : null;
    if (approval) runtime.validateDagLiveApproval(approval, workload, preregistration);
    const limits = structuredClone(approval ?? runtime.DAG_LIVE_DEFAULT_LIMITS);
    // With an artifact root, earlier runs count against the USD 2.00 cap exactly as in collection.
    let prior = null;
    if (args[2]) {
      await runtime.assertDagLiveArtifactRoot(root, resolve(args[2]));
      const scanned = await runtime.dagLivePriorSpend(resolve(args[2]));
      const priorUsd = Math.max(scanned.usd, limits.priorSpendUsd ?? 0);
      prior = { priorSpendUsd: priorUsd, priorRuns: scanned.runs };
      limits.budget.usd = Math.min(limits.budget.usd, Math.max(0, runtime.DAG_LIVE_HARD_CAP_USD - priorUsd));
    }
    const plan = limits.budget.usd > 0 ? runtime.planDagLiveQualification(workload, preregistration, limits) : { withinBudget: false, providerCalls: 0 };
    process.stdout.write(JSON.stringify({ ...plan, ...(prior ?? {}), effectiveRunUsdCap: limits.budget.usd,
      approvalTemplate: approval ? undefined : runtime.dagLiveApprovalTemplate(workload, preregistration) }, null, 2) + '\n');
    if (!plan.withinBudget || !plan.boundCoversLargestEstimate) process.exitCode = 1;
  } else if (mode === '--record-decision') {
    if (args.length !== 5) throw new Error('usage');
    process.stdout.write(JSON.stringify(await runtime.recordDagLiveDecision(resolve(args[1]), args[2], args[3], args[4])) + '\n');
  } else {
    const approval = await readJson(args[1]);
    runtime.validateDagLiveApproval(approval, workload, preregistration);
    // One read: the digested bytes are exactly the bytes imported.
    const resolver = await runtime.loadDagLiveResolver(resolve(args[3]), args[4], approval.credentialResolverDigest);
    if (typeof resolver.createOpenBaoJevResolver !== 'function') throw new Error('resolver-interface');
    // The resolver refuses any vault origin or secret path other than the approved pin.
    const host = { resolveCredential: resolver.createOpenBaoJevResolver({ pin: approval.secretService }) };
    const { resolveDecisionEvaluateSkill } = await import(pathToFileURL(join(root, 'dist/src/decision/graph-skill-bridge.js')).href);
    const skill = await resolveDecisionEvaluateSkill(root);
    const { executeFlowGraph } = createRequire(import.meta.url)('../../agentic/code/addons/composition-engine/lib/runtime.mjs');
    const result = await runtime.runDagLiveQualification({ approval, workload, preregistration, sourceRoot: root, artifactRoot: resolve(args[2]),
      host, executeFlow: executeFlowGraph, skillId: skill.id });
    const { analyses, ...summary } = result;
    process.stdout.write(JSON.stringify({ ...summary, patterns: analyses.map(item => ({ pattern: item.pattern, n: item.n, eligible: item.eligible,
      nonInferiority: item.quality.nonInferiority.decision, difference: item.quality.difference, callRatio: item.economics.callRatio })) }, null, 2) + '\n');
    if (result.stopped) process.exitCode = 1;
  }
} catch {
  // Provider, filesystem and secret-service messages may contain private material.
  process.stderr.write('D12 qualification stopped: configuration, provenance, admission, collection or evidence validation failed. No automatic retry.\n');
  process.exitCode = 1;
}
