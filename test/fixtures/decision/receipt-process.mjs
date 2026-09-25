import { FileDecisionReceiptStore } from '../../../src/decision/receipts.ts';
import { readFileSync } from 'node:fs';

const [directory, keyHex, invocationId, mode = 'acquire', targetState, fingerprintArg] = process.argv.slice(2);
const store = new FileDecisionReceiptStore(directory, { integrityKey: Buffer.from(keyHex, 'hex'),
  ...(mode.startsWith('publish-hold-') ? { onPublish: async stage => {
    if (stage === mode.slice('publish-hold-'.length)) {
      process.stdout.write(`publish-${stage}\n`);
      await new Promise(() => undefined);
    }
  } } : {}) });
process.stdout.write('ready\n');
process.stdin.once('data', async () => {
  try {
    const result = await store.acquire(invocationId, 'project', fingerprintArg ?? `sha256:${'a'.repeat(64)}`);
    if (mode === 'transition') {
      if (!targetState) throw new Error('Missing target state');
      if (result.receipt.state !== targetState) {
        const { nextReceipt } = await import('../../../src/decision/receipts.ts');
        let existing = result.receipt;
        const final = JSON.parse(readFileSync('agentic/code/addons/decision-engine/examples/ruleset-result.json', 'utf8'));
        final.spec.invocationId = invocationId;
        const path = targetState === 'failed' || targetState === 'execution-uncertain'
          ? [targetState]
          : ['dispatched', 'remote-handle-known', 'observation-received', 'composed', 'completed'];
        const from = path.indexOf(existing.state);
        const to = path.indexOf(targetState);
        if (to < 0 || (from >= 0 && to <= from)) throw new Error('Invalid transition target');
        for (const state of path.slice(from + 1, to + 1)) {
          const next = nextReceipt(existing, state, {
            ...(state === 'remote-handle-known' ? { remoteHandles: ['handle-1'] } : {}),
            ...(state === 'completed' ? { result: final } : {}),
          });
          await store.compareAndSwap(invocationId, 'project', existing.revision, next);
          existing = next;
        }
      }
      process.stdout.write(`${targetState}\n`);
      setInterval(() => undefined, 1000);
      return;
    }
    if (mode === 'dispatch' && result.owner) {
      const { nextReceipt } = await import('../../../src/decision/receipts.ts');
      await store.compareAndSwap(invocationId, 'project', result.receipt.revision, nextReceipt(result.receipt, 'dispatched'));
      process.stdout.write('dispatched\n');
      setInterval(() => undefined, 1000);
      return;
    }
    process.stdout.write(`${JSON.stringify({ owner: result.owner, revision: result.receipt.revision })}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(String(error));
    process.exit(1);
  }
});
