#!/usr/bin/env node
/** Synthetic Claude Code grammar; never invokes a model or reads credentials. */
import { readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('2.1.319 (Claude Code)'); process.exit(0); }
const config = JSON.parse(readFileSync(process.env.AIWG_FAKE_WORKER_CONFIG, 'utf8'));
const value = flag => argv[argv.indexOf(flag) + 1];
const scenario = config.scenario ?? 'success';
const required = ['--print', '--verbose', '--restricted', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence'];
if (required.some(flag => !argv.includes(flag)) || value('--permission-mode') !== 'dontAsk'
  || value('--permission-prompts') !== 'none' || value('--input-format') !== 'text'
  || value('--output-format') !== 'stream-json' || !value('--model') || !value('--effort')
  || !argv.includes('--tools') || !argv.includes('--allowedTools') || !argv.includes('--disallowedTools')
  || argv.some(arg => /dangerously|bypassPermissions|fallback-model/.test(arg))) {
  console.error('synthetic invalid invocation'); process.exit(2);
}
let brief = '';
for await (const chunk of process.stdin) brief += chunk;
writeFileSync(config.recordPath, JSON.stringify({ argv, cwd: process.cwd(), brief, stdinEof: true,
  envNames: Object.keys(process.env).sort() }));
const session_id = 'claude-fixture-session';
const emit = event => console.log(JSON.stringify({ session_id, ...event }));
emit({ type: 'system', subtype: 'init', model: value('--model') });
emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'synthetic' } } });
emit({ type: 'assistant', message: { id: 'message-1', role: 'assistant', content: [] } });
emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'synthetic read' }] } });
const claims = { version: 1, status: 'completed', summary: 'synthetic only', claims: [], artifacts: [], checks: [], limitations: [] };
const terminal = { type: 'result', subtype: 'success', is_error: false, uuid: 'result-1', result: JSON.stringify(claims) };
if (scenario === 'missing') process.exit(0);
if (scenario === 'truncated') { process.stdout.write('{"type":"result"'); process.exit(0); }
if (scenario === 'crash') process.exit(7);
if (scenario === 'standalone-error') emit({ type: 'error', message: 'synthetic failure' });
if (scenario === 'exit-zero-error') { emit({ ...terminal, subtype: 'error_during_execution', is_error: true, errors: ['synthetic failure'] }); process.exit(0); }
if (scenario === 'structured') { delete terminal.result; terminal.structured_output = claims; }
if (scenario === 'wrong-session') terminal.session_id = 'unrelated-session';
emit(terminal);
if (scenario === 'double') emit(terminal);
