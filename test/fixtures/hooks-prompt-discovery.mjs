// Synthetic discovery library used by the deployed hook's isolated worker.
export async function discoverCapability(cwd, options) {
  if (options.phrase === 'write a test plan for the checkpoint command') return console.log(JSON.stringify({ results: [
    { type: 'skill', name: 'checkpoint', capability: 'Save and restore session checkpoints', score: 0.95 },
    { type: 'skill', name: 'artifact-lookup', capability: 'Search artifacts', score: 0.40 },
    { type: 'skill', name: 'artifact-orchestration', capability: 'Generate artifacts', score: 0.30 },
  ] }));
  if (options.phrase.includes('template hints')) return console.log(JSON.stringify({ results: [
    { type: 'skill', name: 'issue-update', capability: 'Post an issue update', score: options.phrase.includes('weak') ? 0.5 : 0.92,
      templates: [{ name: options.phrase.includes('long') ? 't'.repeat(70) : 'progress-update',
        show_command: options.phrase.includes('unsafe') ? 'aiwg show template form; touch /tmp/unsafe'
          : `aiwg show template ${options.phrase.includes('long') ? 'i'.repeat(150) : 'progress-update'}` },
      { name: 'second-template', show_command: 'aiwg show template second-template' }] },
    ...['agent', 'command'].map(type => ({ type, name: 'n'.repeat(70), capability: 'Long capability '.repeat(10), score: options.phrase.includes('weak') ? 0.4 : 0.8 })),
  ] }));
  if (options.phrase.includes('discovery error')) throw new Error('fixture failure');
  if (options.phrase.includes('synchronous timeout')) while (true) {} // Parent must terminate sync work.
  if (options.phrase.includes('asynchronous timeout')) await new Promise(resolve => setTimeout(resolve, 5000));
  if (options.phrase.includes('empty result')) return console.log(JSON.stringify({ results: [] }));
  if (options.phrase.includes('weak result')) return console.log(JSON.stringify({ results: [
    { type: 'skill', name: 'weak', capability: 'Low relevance', score: 0.19 },
  ] }));
  if (options.phrase.includes('Jira CSV')) return console.log(JSON.stringify({ results: [
    { type: 'template', name: 'rag.prompt', capability: 'Unrelated template', score: 0.60 },
    { type: 'skill', name: 'dataset-trace', capability: 'Unrelated skill', score: 0.40 },
  ] }));
  if (options.phrase.includes('boundary score')) return console.log(JSON.stringify({ results: [
    { type: 'skill', name: 'boundary', capability: 'Threshold candidate', score: Number(options.phrase.split(' ').at(-1)) },
  ] }));
  if (options.limit !== 3 || !options.promptContext || !options.json || options.resourceSource !== 'local' || !options.offline) {
    throw new Error('Expected local, offline, top-three discovery');
  }
  if (options.phrase.includes('long capabilities')) return console.log(JSON.stringify({ results:
    ['skill', 'agent', 'rule'].map((type, i) => ({ type, name: `${'long-name-'.repeat(6)}${i}`,
      capability: '**Detailed** _capability_ ' + 'useful context '.repeat(20), score: 0.9 - i * 0.1 }))
  }));
  console.error('fixture diagnostics must stay out of hook stderr');
  console.log(JSON.stringify({ results: [
    { type: 'skill', name: 'security-review', capability: 'Review code for security issues\nwith actionable fixes', score: 0.92 },
    { type: 'agent', name: 'security-auditor', capability: 'Audit security boundaries', score: 0.85 },
    { type: 'rule', name: 'security-gate', capability: 'Apply **security** _requirements_', score: 0.70 },
    { type: 'skill', name: 'fourth', capability: 'Must not appear', score: 0.65 },
  ] }));
}
