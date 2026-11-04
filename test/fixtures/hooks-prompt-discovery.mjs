// Synthetic discovery library used by the deployed hook's isolated worker.
export async function discoverCapability(cwd, options) {
  if (options.phrase.includes('discovery error')) throw new Error('fixture failure');
  if (options.phrase.includes('synchronous timeout')) while (true) {} // Parent must terminate sync work.
  if (options.phrase.includes('asynchronous timeout')) await new Promise(resolve => setTimeout(resolve, 5000));
  if (options.phrase.includes('empty result')) return console.log(JSON.stringify({ results: [] }));
  if (options.phrase.includes('weak result')) return console.log(JSON.stringify({ results: [
    { type: 'skill', name: 'weak', capability: 'Low relevance', score: 0.19 },
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
