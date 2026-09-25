#!/usr/bin/env node
// Offline decision pattern playground. Lists the installed pattern packs and runs
// their recorded fixtures through the production decision evaluator. It never
// resolves a credential, contacts a network endpoint, or executes an action.
import { pathToFileURL } from 'node:url';
import { resolveDecisionRuntime } from './runtime-root.mjs';

const USAGE = `Usage: decision-playground <command> [options]

Commands:
  list                          List installed pattern packs and their fixtures
  show <pack>                   Print a pack manifest and its candidate policy
  run <pack> [--fixture <id>]   Run one offline fixture (default: the pack's first)
  run-all                       Run every offline fixture of every available pack
  live-plan <pack>              Show the non-executing live readiness plan and limits

Options:
  --summary                     Print a compact receipt instead of the full receipt
`;

const args = process.argv.slice(2);
const [command, ...rest] = args;
const option = name => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
const summaryOnly = rest.includes('--summary');
if (!command || command === '--help' || command === '-h') {
  process.stdout.write(USAGE);
  process.exit(command ? 0 : 2);
}

let runtimePath;
try { runtimePath = resolveDecisionRuntime(import.meta.url); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }
const runtime = await import(pathToFileURL(runtimePath).href);
const write = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const packFor = id => {
  if (!id || !runtime.decisionPatternPacks.some(pack => pack.id === id)) {
    process.stderr.write(`Unknown decision pattern: ${id ?? '<missing>'}\n`);
    process.exit(2);
  }
  return runtime.getDecisionPatternPack(id);
};
const summarize = receipt => ({
  pattern: receipt.pattern, fixtureId: receipt.fixtureId, executionMode: receipt.executionMode, evidenceOrigin: receipt.evidenceOrigin,
  route: receipt.route, reason: receipt.reason, rulesetOutcome: receipt.rulesetOutcome, gates: receipt.gates,
  evaluations: receipt.evaluations.map(({ alias, primitive, status, reason, value, acceptance }) => ({ alias, primitive, status, reason, value, disposition: acceptance?.disposition ?? null })),
  runtime: receipt.runtime, usage: receipt.usage, action: receipt.action,
});

switch (command) {
  case 'list':
    write(runtime.listDecisionPatterns().map(entry => {
      const pack = runtime.getDecisionPatternPack(entry.id);
      return { ...entry, primitive: pack.primitive, fixtures: pack.fixtures.map(fixture => fixture.id), liveLimits: pack.live?.limits ?? null };
    }));
    break;
  case 'show': {
    const pack = packFor(rest[0]);
    write({ pack, candidatePolicy: runtime.resolveDecisionPatternArtifact(pack.artifacts.candidatePolicy).content, validation: runtime.validateDecisionPattern(pack) });
    break;
  }
  case 'run': {
    const pack = packFor(rest[0]);
    if (pack.status === 'unavailable') {
      process.stderr.write(`Decision pattern unavailable: ${pack.id}\n`);
      process.exit(3);
    }
    const receipt = await runtime.runOfflineDecisionPattern(pack.id, option('--fixture'));
    write(summaryOnly ? summarize(receipt) : receipt);
    break;
  }
  case 'run-all': {
    const results = [];
    for (const pack of runtime.decisionPatternPacks) {
      if (pack.status === 'unavailable') { results.push({ pattern: pack.id, status: 'unavailable' }); continue; }
      for (const fixture of pack.fixtures) {
        const receipt = await runtime.runOfflineDecisionPattern(pack.id, fixture.id);
        const matches = receipt.route === fixture.expected.route && receipt.reason === fixture.expected.reason;
        results.push({ pattern: pack.id, fixture: fixture.id, status: matches ? 'pass' : 'fail', route: receipt.route, reason: receipt.reason,
          evaluator: receipt.result ? receipt.runtime.evaluator : 'rejected-before-dispatch', transportCalls: receipt.runtime.transportCalls });
      }
    }
    const failed = results.filter(result => result.status === 'fail').length;
    write({ executionMode: 'offline-recorded', fixtures: results.filter(result => result.fixture).length, failed, results });
    process.exit(failed ? 1 : 0);
    break;
  }
  case 'live-plan': {
    const pack = packFor(rest[0]);
    // The command-line playground never executes live. Live probes need the programmatic
    // runLiveDecisionPattern API with explicit opt-in, approved egress and a transport.
    write(runtime.planLiveDecisionPattern(pack.id, { explicitOptIn: false, credentialResolved: false, egressApproved: false }));
    break;
  }
  default:
    process.stderr.write(USAGE);
    process.exit(2);
}
