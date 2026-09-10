#!/usr/bin/env node
import { writeSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  writeSync(1, `${process.env.FAKE_DSH_VERSION || 'dsh v0.1.3-alpha.1'}\n`);
  process.exit(0);
}

if (args.includes('--profile') && args[args.indexOf('--profile') + 1] === 'headless') {
  if (args.at(-1) === 'hang-headless') {
    process.on('SIGTERM', () => writeSync(1, 'term-ignored\n'));
    writeSync(1, 'headless-ready\n');
    setInterval(() => {}, 1_000);
  } else {
    writeSync(2, 'fake diagnostic\n');
    writeSync(1, 'fake final\n');
    process.exit(0);
  }
}

let seq = 0;
const send = value => writeSync(1, `${JSON.stringify(value)}\r\n`);
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const event = (sessionId, type, data) => notify('session.event', {
  sessionId,
  event: { type, seq: seq++, time: 1788600000000 + seq, data },
});

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf('\n');
    if (newline < 0) break;
    const line = input.slice(0, newline).replace(/\r$/, '');
    input = input.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      send({ jsonrpc: '2.0', id: request.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.1.3-alpha.1' } } });
      continue;
    }
    if (request.method === 'session/prompt') {
      const sessionId = request.params.sessionId;
      if (request.params.contentBlocks?.[0]?.text === 'hang') continue;
      notify('session.status', { sessionId, status: 'running' });
      event(sessionId, 'user/question', { question: 'Continue the fixture?' });
      event(sessionId, 'tool/call', { id: 'tool-1', name: 'read', arguments: { secret: 'redacted' } });
      event(sessionId, 'tool/result', { id: 'tool-1', name: 'read', content: 'redacted' });
      event(sessionId, 'workflow/start', { id: 'workflow-1' });
      event(sessionId, 'job/started', { id: 'job-1' });
      notify('subagent.started', { parentSessionId: sessionId, childSessionId: `${sessionId}-child` });
      event(`${sessionId}-child`, 'assistant/message', { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'child done' }] } });
      notify('subagent.finished', { parentSessionId: sessionId, childSessionId: `${sessionId}-child`, provider: 'spawn', agentId: `${sessionId}-child`, status: 'ok', stopReason: 'completed' });
      event(sessionId, 'job/finished', { id: 'job-1' });
      event(sessionId, 'workflow/end', { id: 'workflow-1' });
      event(sessionId, 'assistant/message', { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'fixture complete' }] } });
      event(sessionId, 'turn/end', { reason: { kind: 'completed' } });
      notify('session.status', { sessionId, status: 'idle' });
      send({ jsonrpc: '2.0', id: request.id, result: { messageId: 'message-1' } });
      continue;
    }
    if (request.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: request.id, result: {} });
      process.stdin.pause();
      setImmediate(() => process.exit(0));
    }
  }
});
