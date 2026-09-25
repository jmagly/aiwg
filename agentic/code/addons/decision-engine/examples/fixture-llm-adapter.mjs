import { readFile } from 'node:fs/promises';
import { LlmSubagentDecisionAdapter } from 'aiwg/decision';

const worker = JSON.parse(await readFile(new URL('./worker-fixture.json', import.meta.url), 'utf8'));

export default new LlmSubagentDecisionAdapter({
  resolveWorker: async () => worker,
  runWorker: async request => {
    const prompt = JSON.parse(request.prompt);
    let output;
    if (prompt.answer.kind === 'choice') {
      output = { status: 'success', value: 'documentation', confidence: null, distribution: null };
    } else if (prompt.answer.kind === 'ordinal-score') {
      output = { status: 'success', confidence: null, distribution: { 0: 0.75, 1: 0.25, 2: 0 } };
    } else {
      output = { status: 'success', value: 0.05, confidence: null, distribution: null };
    }
    return {
      started: true,
      terminal: true,
      output,
      actualModel: 'fixture-structured-worker',
      inputTokens: 1,
      outputTokens: 1
    };
  }
});
