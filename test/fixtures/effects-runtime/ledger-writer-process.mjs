// Child process for the effect ledger multi-process race tests. Offline only.
//   node --import tsx ledger-writer-process.mjs <projectDir> <writer> <seedHex> <digestSalt> <count> [first]
// Prints "ready", waits for one stdin line, records <count> intents, then prints one JSON result line.
import { memoryCheckpointSink, openEffectLedger, payloadDigest, recordIntent, staticKeyProvider } from '../../../src/effects/index.ts';

const [projectDir, writer, seedHex, digestSalt, count, first = '0'] = process.argv.slice(2);
const ledger = openEffectLedger({
  projectDir,
  scope: { tenant: 'local', project: 'example/repo', subsystem: 'delivery' },
  writer,
  keyProvider: staticKeyProvider(seedHex),
  sink: memoryCheckpointSink(),
  lockTimeoutMs: 60_000,
});

process.stdout.write('ready\n');
process.stdin.once('data', async () => {
  const results = [];
  for (let index = Number(first); index < Number(first) + Number(count); index += 1) {
    const input = {
      kind: 'tracker.comment',
      target: `gitea:example/repo#${index}`,
      context: { issue: index, action: 'race' },
      payloadDigest: payloadDigest(`race body ${index} ${digestSalt}`),
    };
    try {
      const receipt = await recordIntent(ledger, input);
      results.push({ index, effectId: receipt.effectId, writer: receipt.writer, seq: receipt.seq, idempotent: receipt.idempotent });
    } catch (error) {
      results.push({ index, code: error?.code ?? 'unexpected', exitCode: error?.exitCode ?? 1 });
    }
  }
  process.stdout.write(`${JSON.stringify(results)}\n`);
  process.exit(0);
});
