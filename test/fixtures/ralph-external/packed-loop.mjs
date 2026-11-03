// Run the staged package in plain Node with a fake Codex executable and local analysis.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [packed, workspace] = process.argv.slice(2);
const { Orchestrator } = await import(pathToFileURL(join(packed, 'tools/ralph-external/orchestrator.mjs')).href);
const { CodexAdapter } = await import(pathToFileURL(join(packed, 'tools/ralph-external/lib/codex-adapter.mjs')).href);
const buildSessionArgs = CodexAdapter.prototype.buildSessionArgs;
CodexAdapter.prototype.getBinary = () => process.execPath;
CodexAdapter.prototype.buildSessionArgs = function (options) {
  return [fileURLToPath(new URL('./codex-loop.mjs', import.meta.url)), ...buildSessionArgs.call(this, options)];
};
const owner = new Orchestrator(workspace);
owner.outputAnalyzer.analyzeWithClaude = () => null;
owner.stateAssessor.assess = async () => ({ completionPercentage: 10, phase: 'normal' });
const result = await owner.execute({
  objective: 'Complete the synthetic task', completionCriteria: 'Synthetic completion marker',
  provider: 'codex', model: 'synthetic-model', maxIterations: 3,
  enableSnapshots: false, enableCheckpoints: false, enableOverseer: false,
  enableSemanticMemory: false, enableClaudeIntelligence: false, enableEarlyStopping: false,
});
console.log('PACKED_RESULT ' + JSON.stringify({ result, metrics: owner.metricsCollector.history,
  decisions: owner.pidController.getDecisionHistory().length,
  launches: readFileSync(join(workspace, '.fake-codex-launches.jsonl'), 'utf8').trim().split('\n').length }));
