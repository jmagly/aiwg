// Replay captured ACP exchanges, validating requests and remapping only ids/cwd.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { deepStrictEqual } from 'node:assert';

const { frames } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const input = createInterface({ input: process.stdin });
const ids = new Map();
let cursor = 0;
input.on('line', line => {
  try {
    const request = JSON.parse(line);
    const expected = frames[cursor++];
    deepStrictEqual(expected.dir, 'out');
    const message = structuredClone(expected.msg);
    if (message.id !== undefined) {
      ids.set(message.id, request.id);
      message.id = request.id;
    }
    if (message.method === 'session/new') message.params.cwd = process.cwd();
    deepStrictEqual(request, message);
    // Gate each incoming burst on the preceding captured request, including
    // session/cancel. Original millisecond offsets remain in the JSON fixture.
    while (cursor < frames.length && frames[cursor].dir === 'in') {
      const response = structuredClone(frames[cursor++].msg);
      if (response.id !== undefined) response.id = ids.get(response.id);
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
    if (cursor === frames.length) {
      process.stderr.write(`REPLAY_COMPLETE ${cursor}\n`);
      input.close();
      process.stdin.pause();
    }
  } catch (error) {
    process.stderr.write(`Replay mismatch: ${error.message}\n`);
    process.exitCode = 1;
    input.close();
    process.stdin.pause();
  }
});
