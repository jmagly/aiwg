#!/usr/bin/env node
// Offline Muse Code CLI stand-in for the #230 Ralph adapter contract tests.
// No live Meta auth, no network: every path is a recorded-fixture scenario
// selected by AIWG_MUSE_STUB_SCENARIO; AIWG_MUSE_STUB_RECEIPT records what
// the stub observed so tests can assert the exact adapter-built argv.
//
// `muse exec --json` records mirror the envelope captured from an installed
// Muse Code 1.4.0 (2026-09-25): `run.output.delta` carries streamed text and
// `run.terminal.<state>` carries `terminal`, the final `text`, and `reason`.
// Plain mode prints only the final answer text.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const scenario = process.env.AIWG_MUSE_STUB_SCENARIO || '';
const receipt = process.env.AIWG_MUSE_STUB_RECEIPT;
let sequence = 0;
const emit = (payloadType, payload) => process.stdout.write(`${JSON.stringify({
  schema_version: 1, id: `stub-${sequence + 1}`, stream: { kind: 'session', id: 'stub-session' },
  sequence: ++sequence, recorded_at: 1790349213894901 + sequence, record_type: 'event',
  durability: payloadType === 'run.output.delta' ? 'ephemeral' : 'durable', causation_id: null,
  payload_type: payloadType, payload_schema_version: 1, payload,
})}\n`);
const record = patch => {
  if (!receipt) return;
  let current = {};
  try { current = JSON.parse(readFileSync(receipt, 'utf8')); } catch { /* first write */ }
  writeFileSync(receipt, JSON.stringify({ ...current, ...patch }));
};

if (args.includes('--version')) {
  if (scenario === 'version-failure') {
    process.stderr.write('muse-stub: incompatible runtime\n');
    process.exitCode = 3;
  } else {
    process.stdout.write('Muse Code 0.1.0 (fixture)\n');
  }
} else if (args[0] === 'exec') {
  record({ argv: args, env: { CI: process.env.CI, NO_COLOR: process.env.NO_COLOR } });
  const json = args.includes('--json');
  const answer = 'fixture answer';
  if (scenario === 'exec-usage-error') {
    process.stderr.write('unknown option --fixture\nusage: muse exec [OPTIONS] [PROMPT]\n');
    process.exitCode = 2;
  } else if (scenario === 'exec-failure') {
    const reason = 'model `fixture-missing` does not exist or you lack access';
    if (json) emit('run.terminal.failed', { kind: 'run_terminal', terminal: 'failed', reason, text: '' });
    else process.stderr.write(`agent loop failed: model failed: ${reason}\n`);
    process.exitCode = 1;
  } else {
    if (scenario) process.stderr.write('muse-stub diagnostic: stderr channel only\n');
    if (json) {
      emit('run.output.delta', { kind: 'run_output_delta', text: answer });
      emit('run.terminal.completed', { kind: 'run_terminal', terminal: 'completed', reason: null, text: answer });
    } else {
      process.stdout.write(`${answer}\n`);
    }
    process.exitCode = 0;
  }
} else if (args[0] === 'export') {
  record({ argv: args });
  // Minimal documented-shape export document (dev.meta.ai/docs/cookbook/audit-agent-sessions):
  // export_schema_version, sessions, events, diagnostics. Fixture content only.
  const sessionFlag = args.indexOf('--session');
  const sessionId = sessionFlag === -1 ? 'fixture-latest' : args[sessionFlag + 1];
  const outFlag = args.indexOf('--out');
  const outPath = outFlag === -1 ? resolve(process.cwd(), 'trajectory-fixture.json') : resolve(args[outFlag + 1]);
  const document = {
    export_schema_version: 1,
    redaction: args.includes('--redacted') ? 'redacted' : 'raw',
    exporter_version: { display: 'muse-stub 0.1.0' },
    session_build: { display: 'muse-stub 0.1.0' },
    session_terminated_abnormally: false,
    sessions: [{ session_id: sessionId, turn_count: 1, step_count: 2,
      session_end: { exit_reason: 'clean', uptime_ms: 42 } }],
    events: [
      { kind: 'record', envelope: { sequence: 0, recorded_at: '2026-09-24T00:00:00Z',
        record_type: 'record', durability: 'durable', payload_type: 'session.start',
        payload: { event: { kind: 'session.start' } } } },
      { kind: 'record', envelope: { sequence: 1, recorded_at: '2026-09-24T00:00:01Z',
        record_type: 'record', durability: 'durable', payload_type: 'session.end',
        payload: { event: { kind: 'session.end' } } } },
    ],
    diagnostics: { unparseable_lines: 0, unknown_payload_kinds: 0, gaps: 0,
      omitted_live_only: 0, duplicate_records: 0 },
  };
  writeFileSync(outPath, JSON.stringify(document));
  // Muse Code 1.4.0: without --out stdout is one line, the absolute path
  // written; with --out it is `wrote session export to <path as given>`.
  process.stdout.write(outFlag === -1 ? `${outPath}\n` : `wrote session export to ${args[outFlag + 1]}\n`);
  process.exitCode = 0;
} else {
  process.stderr.write(`muse-stub: unhandled invocation: ${args.join(' ')}\n`);
  process.exitCode = 2;
}
