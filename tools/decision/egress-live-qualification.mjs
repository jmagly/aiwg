#!/usr/bin/env node
/**
 * #2680 D10 egress live qualification entry point (source checkout only).
 * Default is a dry run: no credential read and no provider call. Live collection needs
 * --collect-approved plus AIWG_DECISION_EGRESS_LIVE=1.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const mode = args[0] ?? '--dry-run';
const USAGE = 'Usage: --dry-run [APPROVAL.json] | --prepare OUTPUT_DIR | --collect-approved APPROVAL.json CORPUS.json ARTIFACT_ROOT RESOLVER_CONFIG.json (requires AIWG_DECISION_EGRESS_LIVE=1)\n';
if (!['--dry-run', '--prepare', '--collect-approved'].includes(mode)) {
  process.stdout.write(`No provider calls. ${USAGE}`);
  process.exit(0);
}
if (mode === '--collect-approved' && process.env.AIWG_DECISION_EGRESS_LIVE !== '1') {
  process.stderr.write('Live egress qualification is opt-in. Set AIWG_DECISION_EGRESS_LIVE=1. No credential was read and no provider call was made.\n');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '../..');
const FROZEN = join(root, 'docs/decision/evidence/egress-live-v1/preregistration.json');
const TEMPLATE = join(root, 'docs/decision/evidence/egress-live-v1/approval-template.json');
let resolver;
/**
 * Dry run and prepare load the TypeScript source directly (no build: shared staging hosts forbid
 * heavy builds). Only live collection compiles, because stale dist must never back live evidence.
 */
async function load(module) {
  if (mode === '--collect-approved') return import(`../../dist/src/decision/${module}.js`);
  const { tsImport } = await import('tsx/esm/api');
  return tsImport(`../../src/decision/${module}.ts`, import.meta.url);
}
try {
  if (mode === '--collect-approved') execFileSync('npm', ['run', 'build:cli'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], timeout: 600_000, killSignal: 'SIGKILL' });
  const runtime = await load('egress-live-qualification');
  const frozen = JSON.parse(await readFile(FROZEN, 'utf8'));
  const corpusFor = () => runtime.generateEgressAttackCorpus(frozen.seed, frozen.itemsPerClass);
  const assertFrozen = corpus => {
    if (runtime.egressLiveDigest(runtime.egressLivePreregistration(corpus)) !== runtime.egressLiveDigest(frozen)) throw new Error('preregistration drift');
  };
  if (mode === '--dry-run') {
    if (args.length > 2) throw new Error('usage');
    const corpus = corpusFor(); assertFrozen(corpus);
    // The attested price comes from the given approval, else from the committed template.
    const { priceBound } = JSON.parse(await readFile(args[1] ?? TEMPLATE, 'utf8'));
    process.stdout.write(`${JSON.stringify(runtime.egressLiveDryRun(corpus, priceBound), null, 2)}\n`);
  } else if (mode === '--prepare') {
    if (args.length !== 2) throw new Error('usage');
    const corpus = corpusFor(); assertFrozen(corpus);
    const { assertContextArtifactRoot } = await load('context-live-qualification');
    await assertContextArtifactRoot(root, resolve(args[1]));
    await writeFile(join(resolve(args[1]), 'corpus.json'), `${JSON.stringify(corpus, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ corpusDigest: runtime.egressLiveDigest(corpus),
      preregistrationDigest: runtime.egressLiveDigest(frozen), items: corpus.items.length, providerCalls: 0 })}\n`);
  } else {
    if (args.length !== 5) throw new Error('usage');
    const approval = JSON.parse(await readFile(args[1], 'utf8'));
    const corpus = JSON.parse(await readFile(args[2], 'utf8'));
    assertFrozen(corpus);
    const configBytes = await readFile(args[4]);
    if (`sha256:${createHash('sha256').update(configBytes).digest('hex')}` !== approval?.credential?.resolverConfigDigest) throw new Error('resolver-config-pin');
    const { createOpenBaoKvResolver } = await import('./openbao-kv-credential-resolver.mjs');
    resolver = createOpenBaoKvResolver(JSON.parse(configBytes.toString('utf8')));
    const summary = await runtime.runEgressLiveQualification({ approval, corpus, sourceRoot: root, artifactRoot: resolve(args[3]),
      host: { resolveCredential: ref => resolver.resolveCredential(ref), audit: () => resolver.audit() } });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!summary.collectionSuccess) process.exitCode = 1;
  }
} catch {
  // Provider, secret-service and filesystem messages may contain private material.
  process.stderr.write('Egress qualification stopped: configuration, provenance, credential, collection or evidence validation failed. No automatic retry.\n');
  process.exitCode = 1;
} finally {
  await resolver?.dispose();
}
