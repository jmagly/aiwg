// Run one real Flue lifetime with scripted, keyless model responses.
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { init, setProvider, useModel, useTool } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createAiwgTools } from './src/aiwg/tools.ts';
import db from './src/db.ts';
import { useAiwgSpecialists } from './src/aiwg/specialists.ts';

globalThis.fetch = () => { throw new Error('Network forbidden'); };
const mode = process.argv[2];
const fake = fauxProvider();
setProvider(fake.provider);
const options = JSON.parse(await readFile('durability-options.json', 'utf8'));
const tools = createAiwgTools(options);
function DurableAgent() {
  useModel(`${fake.provider.id}/${fake.getModel().id}`);
  useTool(tools.aiwg_artifact_write);
  if (['code-reviewer', 'test-engineer'].includes(mode)) useAiwgSpecialists();
  return 'Offline durability fixture.';
}
const runtime = await start({ agents: [DurableAgent], db, providers: [] });
const handle = init(DurableAgent, { id: 'durable-conversation' });
const boundedRead = receipt => handle.read(receipt, { signal: AbortSignal.timeout(10_000) });
try {
  if (['code-reviewer', 'test-engineer'].includes(mode)) {
    fake.setResponses([
      fauxAssistantMessage(fauxToolCall('task', { agent: mode, prompt: 'Assess a synthetic change.' }), { stopReason: 'toolUse' }),
      (context, _options, _state, model) => {
        assert.equal(model.id, fake.getModel().id, 'delegate inherits app model');
        const names = context.messages.flatMap(message => message.toolsAdded ?? []).map(tool => tool.name);
        assert.deepEqual(names.filter(name => name.startsWith('aiwg_')).sort(),
          ['aiwg_artifact_write', 'aiwg_discover', 'aiwg_show']);
        for (const name of ['bash', 'read', 'write', 'edit']) assert.ok(!names.includes(name));
        return fauxAssistantMessage('specialist-result');
      },
      context => {
        assert.match(JSON.stringify(context), /specialist-result/);
        return fauxAssistantMessage('delegation-complete');
      },
    ]);
    assert.equal((await boundedRead(await handle.dispatch('Delegate this assessment.'))).text, 'delegation-complete');
    assert.equal(fake.state.callCount, 3);
  } else if (mode === 'first') {
    fake.setResponses([fauxAssistantMessage('persisted-first')]);
    const receipt = await handle.dispatch('first-prompt');
    const reply = await boundedRead(receipt);
    assert.equal(reply.text, 'persisted-first');
    await writeFile('first-receipt.json', JSON.stringify(receipt));
    await writeFile('first-reply.json', JSON.stringify(reply));
  } else if (mode === 'restart') {
    const receipt = JSON.parse(await readFile('first-receipt.json', 'utf8'));
    const original = JSON.parse(await readFile('first-reply.json', 'utf8'));
    assert.deepEqual(await boundedRead(receipt), original);
    assert.equal(fake.state.callCount, 0, 'reading a persisted reply must not invoke the provider');
    fake.setResponses([context => {
      assert.match(JSON.stringify(context), /first-prompt/);
      assert.match(JSON.stringify(context), /persisted-first/);
      return fauxAssistantMessage('resumed-same-conversation');
    }]);
    const resumed = await boundedRead(await handle.dispatch('follow-up'));
    assert.equal(resumed.text, 'resumed-same-conversation');
    assert.equal(resumed.uid, original.uid);
  } else if (['owner', 'fencing-owner'].includes(mode)) {
    fake.setResponses([fauxAssistantMessage(fauxToolCall('aiwg_artifact_write', {
      path: 'effect.md', content: 'effect-before-ack',
    }), { stopReason: 'toolUse' })]);
    const receipt = await handle.dispatch('write the synthetic effect');
    await writeFile('abort-receipt.json', JSON.stringify(receipt));
    const deadline = Date.now() + 10_000;
    while (true) {
      try { await access('entered-tool'); break; }
      catch { if (Date.now() > deadline) throw new Error('Tool did not enter'); await delay(20); }
    }
    process.send({ ready: true });
    await new Promise(resolve => process.once('message', resolve));
    if (mode === 'owner') {
      await handle.abort();
      await assert.rejects(boundedRead(receipt), error => error.outcome === 'aborted');
    }
  } else if (['rival', 'lease-rival'].includes(mode)) {
    const receipt = JSON.parse(await readFile('abort-receipt.json', 'utf8'));
    // The second live runtime uses the same SQLite store and coordinator claim API.
    const { submissionStore } = await db.connect();
    const original = await submissionStore.getSubmission(receipt.submissionId);
    assert.equal(original.status, 'running');
    assert.ok(original.ownerId && original.leaseExpiresAt > Date.now());
    const liveClaim = await submissionStore.claimSubmission({ submissionId: receipt.submissionId,
      attemptId: 'rival-attempt', ownerId: 'rival-owner', leaseExpiresAt: Date.now() + 30_000 });
    assert.equal(liveClaim, null, 'a live submission cannot be claimed by a second owner');
    if (mode === 'rival') {
      // Flue 2.3.0 builtin-providers-C5FpT9g1.mjs:1288-1323 admits and wakes;
      // sql-agent-execution-store-LqbFqydc.mjs:455-473 fences later work in the same session.
      const rivalReceipt = await handle.dispatch('rival dispatch on durable-conversation');
      assert.notEqual(rivalReceipt.submissionId, receipt.submissionId);
      assert.equal(rivalReceipt.uid, receipt.uid);
      await assert.rejects(handle.read(rivalReceipt, { signal: AbortSignal.timeout(200) }),
        error => error.name === 'TimeoutError');
      const queued = await submissionStore.getSubmission(rivalReceipt.submissionId);
      assert.equal(queued.sessionKey, original.sessionKey);
      assert.ok(queued.sequence > original.sequence);
      assert.equal(queued.status, 'queued');
      assert.equal(queued.ownerId, undefined);
      assert.equal(queued.attemptId, undefined);
      assert.equal(queued.leaseExpiresAt, 0);
      const claim = await submissionStore.claimSubmission({ submissionId: rivalReceipt.submissionId,
        attemptId: 'rival-attempt', ownerId: 'rival-owner', leaseExpiresAt: Date.now() + 30_000 });
      assert.equal(claim, null, 'a later dispatch cannot run ahead of the live owner');
    } else {
      await assert.rejects(handle.read(receipt, { signal: AbortSignal.timeout(200) }),
        error => error.name === 'TimeoutError');
    }
    const after = await submissionStore.getSubmission(receipt.submissionId);
    assert.equal(after.status, 'running');
    assert.equal(after.ownerId, original.ownerId);
    assert.equal(after.attemptId, original.attemptId);
    assert.ok(after.leaseExpiresAt > Date.now());
    assert.equal(fake.state.callCount, 0, 'rival must never execute the model or tool');
  } else if (mode === 'reconcile') {
    const receipt = JSON.parse(await readFile('abort-receipt.json', 'utf8'));
    await assert.rejects(boundedRead(receipt), error => error.outcome === 'aborted');
    assert.equal(fake.state.callCount, 0);
    // An aborted acknowledgement cannot prove an external effect did not happen.
    assert.equal(await readFile('effect.md', 'utf8'), 'effect-before-ack');
    assert.equal(await readFile('effect-count.txt', 'utf8'), 'effect\n');
    fake.setResponses([fauxAssistantMessage('reconciled-effect')]);
    assert.equal((await boundedRead(await handle.dispatch('effect read reconciled'))).text, 'reconciled-effect');
  } else throw new Error(`Unknown mode ${mode}`);
  console.log(`PASS durability ${mode}`);
} finally {
  await runtime.stop();
}
