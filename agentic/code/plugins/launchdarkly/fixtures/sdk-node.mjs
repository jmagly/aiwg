// TestData fixture; API grounding: https://launchdarkly.com/docs/sdk/features/test-data-sources.md
// Requires an already installed @launchdarkly/node-server-sdk v8+; never installs or uses real credentials.
import assert from 'node:assert/strict';
import { init } from '@launchdarkly/node-server-sdk';
import { TestData } from '@launchdarkly/node-server-sdk/integrations';

const td = new TestData();
td.update(td.flag('checkout').booleanFlag().variationForAll(false));
const client = init('offline-test-only', { updateProcessor: td.getFactory(), sendEvents: false });
try {
  await client.waitForInitialization({ timeout: 5 });
  const context = { kind: 'user', key: 'fixture-user' };
  for (const state of [false, true]) {
    td.update(td.flag('checkout').booleanFlag().variationForAll(state));
    assert.equal(await client.variation('checkout', context, false), state);
  }
  assert.equal(await client.variation('missing', context, false), false);
  console.log(JSON.stringify({ language: 'node', off_exit_code: 0, on_exit_code: 0 }));
} finally {
  try { await client.flush(); } finally { client.close(); }
}
