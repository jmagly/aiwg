// Permit only the fixture endpoint while executing the built packed consumer.
import assert from 'node:assert/strict';
const localFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  assert.equal(new URL(url).origin, new URL(process.env.AIWG_REMOTE_URL).origin);
  return localFetch(input, init);
};
const { loadFlueNodeApplication } = await import('./dist/app.mjs');
// Flue sanitizes read() failures but reports the underlying transport error to
// its logger. Check that diagnostic as well as the agent's failed response.
const errorLog = console.error;
const diagnostics = [];
console.error = (...args) => {
  diagnostics.push(args.map(String).join(' '));
  errorLog(...args);
};
const app = await loadFlueNodeApplication({ env: process.env });
try {
  const response = await app.fetch(new Request('http://localhost/probe'));
  const body = await response.text();
  if (process.argv[2] === 'wrong-token') {
    assert.equal(response.status, 500, body);
    assert.match(body, /agent run failed/i);
    assert.match(diagnostics.join('\n'), /401|unauthorized/i);
    console.log('PASS wrong token: ' + diagnostics.join('\n'));
  } else {
    assert.equal(response.status, 200, body);
    assert.equal(body, 'PASS packed remote consumer');
    console.log(body);
  }
} finally { await app.stop(); console.error = errorLog; }
