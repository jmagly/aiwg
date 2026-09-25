// Offline fake Jev transport for dispatcher tests. Loaded through the dispatcher's
// adapterModules seam; the real JevDecisionAdapter code runs against a fake fetch.
import { JevDecisionAdapter } from '../../../src/decision/index.js';

export const observed = { calls: 0, bodies: [], authorization: [] };
const canary = process.env.AIWG_TEST_RESPONSE_CANARY ?? 'synthetic-dispatcher-response-canary';

function answers(body) {
  return Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id,
    question.type === 'choice'
      ? { type: 'choice', choice: 'documentation', probabilities: { documentation: 1, runtime: 0, other: 0 }, confidence: 1 }
      : question.type === 'score'
        ? { type: 'score', score: 0.25, probabilities: { 0: 0.75, 1: 0.25, 2: 0 },
            legend: { 0: 'Cosmetic or documentation issue; core functions work.', 1: 'A feature fails but has a workaround.',
              2: 'Core functions unavailable.' }, confidence: 0.8 }
        : { type: 'noul', noul: 0.05 }]));
}

export default new JevDecisionAdapter({
  region: 'operator-declared-region',
  fetch: async (_url, init) => {
    observed.calls += 1;
    const body = JSON.parse(String(init.body));
    observed.bodies.push(body);
    observed.authorization.push(String(new Headers(init.headers).get('authorization')));
    // Canaries in a response header and an unmodelled response field must never surface.
    return new Response(JSON.stringify({ answers: answers(body), model: 'jev-fixture', debug: canary,
      usage: { input_tokens: 9, output_tokens: 3 } }), { status: 200, headers: { 'x-debug-echo': canary } });
  },
});
