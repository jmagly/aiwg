// Drive the example's actual Assistant with keyless Pi responses across processes.
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { init, setProvider } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { Assistant } from './src/agents/assistant.ts';
import db from './src/db.ts';

globalThis.fetch = () => { throw new Error('Network forbidden'); };
const fake = fauxProvider(); // Pi's createProvider with local stream functions only.
setProvider(fake.provider);
process.env.FLUE_MODEL = `${fake.provider.id}/${fake.getModel().id}`;
const runtime = await start({ agents: [Assistant], db, providers: [] });
const handle = init(Assistant, { id: 'node-slice' });
const read = receipt => handle.read(receipt, { signal: AbortSignal.timeout(120_000) });
const call = (name, data) => fauxAssistantMessage(fauxToolCall(name, data), { stopReason: 'toolUse' });
function result(context, name) {
  const message = context.messages.filter(item => item.role === 'toolResult' && item.toolName === name).at(-1);
  assert.ok(message, `Expected result of ${name}`);
  assert.ok(!message.isError, JSON.stringify(message));
  return JSON.stringify(message);
}

try {
  const mode = process.argv[2];
  if (mode === 'first') {
    fake.setResponses([
      call('aiwg_discover', { query: 'sdlc-quickref', type: 'skill' }),
      context => {
        assert.match(result(context, 'aiwg_discover'), /sdlc-quickref/);
        return call('aiwg_show', { type: 'skill', name: 'sdlc-quickref' });
      },
      context => {
        const shown = result(context, 'aiwg_show');
        assert.match(shown, /sdlc-quickref/);
        assert.match(shown, /skill-discovery/);
        assert.match(shown, /SDLC Orchestration Rules/); // Full bound rule body, not only its name.
        assert.match(shown, /Canonical Workflow Surface/);
        assert.match(shown, /Governing|governing|boundRules/);
        return call('activate_skill', { name: 'sdlc-quickref' });
      },
      context => {
        assert.match(result(context, 'activate_skill'), /SDLC Framework/);
        return call('task', { agent: 'code-reviewer', prompt: 'Review: export const add = (a, b) => a - b;' });
      },
      (context, _options, _state, model) => {
        assert.equal(model.id, fake.getModel().id);
        const names = context.messages.flatMap(message => message.toolsAdded ?? []).map(tool => tool.name);
        assert.deepEqual(names.filter(name => name.startsWith('aiwg_')).sort(),
          ['aiwg_artifact_write', 'aiwg_discover', 'aiwg_show']);
        for (const name of ['bash', 'write', 'read', 'edit']) assert.ok(!names.includes(name));
        return fauxAssistantMessage('Code Reviewer: add subtracts; use a + b.');
      },
      context => {
        assert.match(result(context, 'task'), /add subtracts/);
        return call('aiwg_artifact_write', { path: 'reviews/example.md', content: 'Code Reviewer: use a + b.\n' });
      },
      context => {
        assert.match(result(context, 'aiwg_artifact_write'), /success/);
        return fauxAssistantMessage('Review saved at reviews/example.md.');
      },
    ]);
    const receipt = await handle.dispatch('Review this change: export const add = (a, b) => a - b;');
    const reply = await read(receipt);
    assert.equal(reply.text, 'Review saved at reviews/example.md.');
    assert.equal(fake.state.callCount, 7);
    await writeFile('slice-receipt.json', JSON.stringify(receipt));
    await writeFile('slice-reply.json', JSON.stringify(reply));
  } else if (mode === 'restart') {
    const receipt = JSON.parse(await readFile('slice-receipt.json', 'utf8'));
    const original = JSON.parse(await readFile('slice-reply.json', 'utf8'));
    assert.deepEqual(await read(receipt), original);
    assert.equal(fake.state.callCount, 0);
    fake.setResponses([context => {
      assert.match(JSON.stringify(context), /Review this change/);
      assert.match(JSON.stringify(context), /Review saved at reviews\/example.md/);
      return fauxAssistantMessage('Resumed review.');
    }]);
    const resumed = await read(await handle.dispatch('Continue the same review.'));
    assert.equal(resumed.uid, original.uid);
    assert.equal(resumed.text, 'Resumed review.');
  } else if (mode === 'abort') {
    fake.setResponses([call('aiwg_artifact_write', { path: 'effect.md', content: 'effect-before-ack' })]);
    const receipt = await handle.dispatch('Write a synthetic effect.');
    await writeFile('slice-abort-receipt.json', JSON.stringify(receipt));
    const deadline = Date.now() + 15_000;
    while (true) {
      try { await access('entered-tool'); break; }
      catch { if (Date.now() > deadline) throw new Error('Tool did not enter'); await delay(20); }
    }
    await handle.abort();
    await assert.rejects(read(receipt), error => error.outcome === 'aborted');
    assert.equal(await readFile('effect.md', 'utf8'), 'effect-before-ack');
  } else if (mode === 'reconcile') {
    const receipt = JSON.parse(await readFile('slice-abort-receipt.json', 'utf8'));
    await assert.rejects(read(receipt), error => error.outcome === 'aborted');
    assert.equal(fake.state.callCount, 0);
    assert.equal(await readFile('effect.md', 'utf8'), 'effect-before-ack');
    assert.equal(await readFile('effect-count.txt', 'utf8'), 'effect\n');
  } else throw new Error(`Unknown mode ${mode}`);
  console.log(`PASS Node slice ${mode}`);
} finally {
  await runtime.stop();
}
