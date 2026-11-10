import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { runGrokHeadless } from '../../../src/providers/grok-build-headless.js';
import { getProviderCapabilities } from '../../../src/providers/capability-matrix.js';
import { withWindows } from '../../helpers/windows-simulation.mjs';

function fake(script: string) {
  return { command: process.execPath, prefixArgs: ['-e', script, '--'], cwd: tmpdir(), timeoutMs: 3_000 };
}

describe('Grok Build bounded headless transport', () => {
  it('records captured headless permission failures and the workflow bypass without auto-approving', () => {
    const cases = JSON.parse(readFileSync(new URL('../../fixtures/providers/grok-build/captured-20261110/permissions.json', import.meta.url), 'utf8'));
    for (const index of [0, 1, 2]) {
      expect(cases[index].stderr).toContain('a headless run cannot ask for approval');
      expect(cases[index].records[1]).toMatchObject({ type: 'tool_result', is_error: true });
    }
    expect(cases[1].flags).toEqual(['--allow', 'spawn_subagent']);
    expect(cases[2].records[0].name).toBe('workflow');
    expect(cases[3].flags).toEqual(['--no-subagents', '--permission-mode', 'auto']);
    expect(cases[3].records[1].content).toMatchObject({ type: 'Workflow' });
    const children = JSON.parse(readFileSync(new URL('../../fixtures/providers/grok-build/captured-20261110/workflow-children.json', import.meta.url), 'utf8'));
    expect(children).toHaveLength(2);
    expect(new Set(children.map((child: { parent_session_id: string }) => child.parent_session_id)).size).toBe(1);
    expect(new Set(children.map((child: { child_session_id: string }) => child.child_session_id)).size).toBe(2);
    expect(cases[4].records.filter((record: { type: string }) => record.type === 'tool_result')
      .map((record: { content: { type: string } }) => record.content.type)).toEqual(['SubagentCompleted', 'SubagentCompleted']);
  });

  it.each([true, false])('accepts whole-turn usage without treating it as terminal (end present: %s)', async hasEnd => {
    const frames = [
      { type: 'text', data: 'ok' },
      { type: 'usage', messageId: 'response-1', stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
      { type: 'usage', usage: { input_tokens: 2, output_tokens: 2 } },
      ...(hasEnd ? [{ type: 'end', stopReason: 'end_turn' }] : []),
    ];
    const wire = frames.map(frame => JSON.stringify(frame)).join('\n') + '\n';
    const run = runGrokHeadless({ ...fake(`process.stdout.write(${JSON.stringify(wire)})`), prompt: 'synthetic replay', env: {} });
    if (hasEnd) expect((await run).events).toEqual(frames);
    else await expect(run).rejects.toThrow(/without a terminal event/);
  });

  it('replays every event and callback from the live 1.0.38 capture', async () => {
    const wire = readFileSync(new URL('../../fixtures/providers/grok-build/health/live-1.0.38-stream.ndjson', import.meta.url), 'utf8');
    const captured = wire.trim().split('\n').map(line => JSON.parse(line));
    const callbacks: Record<string, unknown>[] = [];
    const result = await runGrokHeadless({
      ...fake(`process.stdout.write(${JSON.stringify(wire)})`), prompt: 'offline replay',
      onEvent: event => callbacks.push(event),
    });
    expect(result.events).toEqual(captured);
    expect(callbacks).toEqual(captured);
    expect(result.events.map(event => event.type)).toEqual([
      'available_commands', 'available_commands', ...Array(13).fill('text'),
      'available_commands', 'usage', 'tool_call', ...Array(4).fill('tool_call_update'),
      'text', 'available_commands', 'usage', 'end',
    ]);
    expect(result.events.filter(event => event.type === 'tool_call_update').map(event => event.status))
      .toEqual([null, 'in_progress', 'in_progress', 'completed']);
    expect(result.events.at(-1)).toMatchObject({ type: 'end', stopReason: 'end_turn', num_turns: 2 });
    expect(result.exitCode).toBe(0);
  });

  it('parses the live 1.0.38 single JSON result separately from streaming events', async () => {
    const wire = readFileSync(new URL('../../fixtures/providers/grok-build/health/live-1.0.38-result.json', import.meta.url), 'utf8');
    const result = await runGrokHeadless({
      ...fake(`process.stdout.write(${JSON.stringify(wire)})`), prompt: 'offline replay', format: 'json',
    });
    expect(result.events).toEqual([JSON.parse(wire)]);
    expect(result.events[0]).toMatchObject({ text: 'ok', stopReason: 'end_turn', num_turns: 1 });
    expect(result.exitCode).toBe(0);
  });

  it('replays every documented non-error ACP event from the shared health fixture', async () => {
    const wire = readFileSync(new URL('../../fixtures/providers/grok-build/health/stream.ndjson', import.meta.url), 'utf8');
    const result = await runGrokHeadless({ ...fake(`process.stdout.write(${JSON.stringify(wire)})`), prompt: 'hello' });
    expect(result.events).toEqual(wire.trim().split('\n').map(line => JSON.parse(line)));
  });

  it('uses fixed safe argv and parses plain termination', async () => {
    const result = await runGrokHeadless({
      ...fake('process.stdout.write(process.argv.join(" "))'), prompt: 'hello', format: 'plain',
    });
    expect(result.text).toContain('-p hello --output-format plain');
    expect(result.text).toContain('--no-auto-update');
    expect(result.exitCode).toBe(0);
  });

  it('uses the released CLI switch to disable native subagents for governed workers', async () => {
    const result = await runGrokHeadless({
      ...fake('process.stdout.write(process.argv.join(" "))'), prompt: 'hello', format: 'plain', disableSubagents: true,
    });
    expect(result.text).toContain('--no-subagents --disallowed-tools workflow -p hello');
    expect(result.text).not.toContain('--permission-mode auto');
  });

  it('parses JSON result and propagates JSON errors', async () => {
    const result = await runGrokHeadless({ ...fake('console.log(JSON.stringify({text:"ok",stopReason:"end_turn"}))'), prompt: 'hello', format: 'json' });
    expect(result.events[0]).toMatchObject({ text: 'ok', stopReason: 'end_turn' });
    await expect(runGrokHeadless({ ...fake('console.log(JSON.stringify({type:"error",error:"failed"}))'), prompt: 'hello', format: 'json' }))
      .rejects.toThrow(/JSON error/);
  });

  it.each([
    { type: 'result', stopReason: 'end_turn', result: 'legacy' },
    { stopReason: 'end_turn' },
    { text: {}, stopReason: 'end_turn' },
  ])('rejects a non-result JSON object %j', async event => {
    await expect(runGrokHeadless({ ...fake(`console.log(${JSON.stringify(JSON.stringify(event))})`), prompt: 'hello', format: 'json' }))
      .rejects.toThrow(/JSON error/);
  });

  it('redacts nested streaming events and stderr before returning', async () => {
    const result = await runGrokHeadless({
      ...fake('console.log(JSON.stringify({type:"text",nested:{text:"xai-12345678"}}));console.log(JSON.stringify({type:"end",stopReason:"end_turn"}));console.error("Bearer abcdefghijk")'),
      prompt: 'hello', env: { ...process.env, XAI_API_KEY: 'xai-12345678' },
    });
    expect(JSON.stringify(result)).not.toContain('xai-12345678');
    expect(result.stderr).toContain('Bearer [REDACTED]');
    expect(result.events).toHaveLength(2);
  });

  it('fails malformed streaming events, nonzero exits and missing terminal events', async () => {
    await expect(runGrokHeadless({ ...fake('console.log("not json")'), prompt: 'hello' })).rejects.toThrow(/Invalid/);
    await expect(runGrokHeadless({ ...fake('console.log(JSON.stringify({type:"end",stopReason:"end_turn"}));process.exit(3)'), prompt: 'hello' })).rejects.toThrow(/exit 3/);
    await expect(runGrokHeadless({ ...fake('console.log(JSON.stringify({type:"text"}))'), prompt: 'hello' })).rejects.toThrow(/without a terminal event/);
  });

  it('terminates after a final event despite an attached background timer', async () => {
    const start = Date.now();
    const result = await runGrokHeadless({
      ...fake('console.log(JSON.stringify({type:"end",stopReason:"end_turn"}));setInterval(()=>{},1000)'),
      prompt: 'hello', timeoutMs: 2_000,
    });
    expect(result.events[0]).toMatchObject({ type: 'end', stopReason: 'end_turn' });
    expect(Date.now() - start).toBeLessThan(1_500);
  });

  it('enforces a timeout for a provider that never completes', async () => {
    await expect(runGrokHeadless({ ...fake('setInterval(()=>{},1000)'), prompt: 'hello', timeoutMs: 100 }))
      .rejects.toThrow(/timed out/);
  });

  it('parses a trailing ACP end without newline and calls the scrubbed callback', async () => {
    const events: Record<string, unknown>[] = [];
    const result = await runGrokHeadless({
      ...fake('process.stdout.write(JSON.stringify({type:"text",data:"hello"})+"\\n"+JSON.stringify({type:"end",stopReason:"end_turn"}))'),
      prompt: 'hello', onEvent: event => events.push(event),
    });
    expect(events).toEqual(result.events);
    expect(events.map(event => event.type)).toEqual(['text', 'end']);
  });

  it.each(['max_tokens', 'max_turn_requests', 'refusal', 'cancelled', undefined])('rejects unsuccessful end reason %s in streaming and JSON modes', async stopReason => {
    for (const format of ['streaming-json', 'json'] as const) {
      const event = { ...(format === 'streaming-json' ? { type: 'end' } : { text: 'partial' }), stopReason };
      await expect(runGrokHeadless({ ...fake(`console.log(${JSON.stringify(JSON.stringify(event))})`), prompt: 'hello', format })).rejects.toThrow(/failed|JSON error/);
    }
  });

  it.each(['tool_call', 'tool_call_update', 'error'])('latches %s failure before a clean end', async type => {
    const event = { type, status: 'failed', toolCallId: 'call-1', message: 'synthetic failure' };
    await expect(runGrokHeadless({
      ...fake(`console.log(${JSON.stringify(JSON.stringify(event))});console.log(JSON.stringify({type:"end",stopReason:"end_turn"}))`),
      prompt: 'hello',
    })).rejects.toThrow(/failed|after terminal/);
  });

  it.each(['null', '[]', '"text"', '{"type":"result"}', '{"type":"end","stopReason":"end_turn"}\n{"type":"text","data":"late"}'])('rejects malformed or legacy stream %s', async wire => {
    await expect(runGrokHeadless({ ...fake(`console.log(${JSON.stringify(wire)})`), prompt: 'hello' })).rejects.toThrow(/Invalid|terminal/);
  });

  it.each([
    { type: 'message', role: 'assistant', content: 'legacy' },
    { type: 'result', result: 'legacy' },
    { text: 'single JSON result', stopReason: 'end_turn' },
    { type: 'unknown' },
    { type: null },
    { type: { toString: 'text' } },
  ])('a clean end cannot repair a foreign stream frame %j', async event => {
    const wire = [event, { type: 'end', stopReason: 'end_turn' }].map(frame => JSON.stringify(frame)).join('\n');
    await expect(runGrokHeadless({ ...fake(`console.log(${JSON.stringify(wire)})`), prompt: 'hello' }))
      .rejects.toThrow(/Invalid/);
  });

  it('rejects unterminated trailing output even when the provider remains attached', async () => {
    await expect(runGrokHeadless({
      ...fake('process.stdout.write(JSON.stringify({type:"end",stopReason:"end_turn"})+"\\n{" );setInterval(()=>{},1000)'),
      prompt: 'hello',
    })).rejects.toThrow(/Invalid trailing/);
  });
});

describe('Grok Build 1.0.77 captured headless contracts', () => {
  const fixture = (name: string) => readFileSync(new URL(`../../fixtures/providers/grok-build/headless-1.0.77/${name}`, import.meta.url), 'utf8');
  const replay = (wire: string, extra = '') => fake(`process.stdout.write(${JSON.stringify(wire)});${extra}`);

  it('preserves synthetic plain answer text and nonzero exit diagnostics', async () => {
    const wire = fixture('plain.txt');
    expect((await runGrokHeadless({ ...replay(wire), prompt: 'offline', format: 'plain' })).text).toBe(wire);
    await expect(runGrokHeadless({ ...replay(wire, 'console.error("Bearer synthetic-token");process.exitCode=7'), prompt: 'offline', format: 'plain' }))
      .rejects.toMatchObject({ result: { text: wire, exitCode: 7, stderr: 'Bearer [REDACTED]\n' } });
  });

  it('exposes successful stream stop reason, usage and exact cost without changing raw text', async () => {
    const wire = fixture('stream.ndjson');
    const result = await runGrokHeadless({ ...replay(wire), prompt: 'offline' });
    expect(result).toMatchObject({ text: wire, stopReason: 'end_turn', total_cost_usd: 0.0454784,
      total_cost_usd_ticks: 454784000, usage: { total_tokens: 155648 }, num_turns: 5 });
    expect(result.events.map(event => event.type)).toEqual(['available_commands', 'thought', 'text', 'usage', 'tool_call', 'tool_call_update', 'end']);
  });

  it('retains captured JSON cancellation accounting and partial text on failure', async () => {
    const wire = fixture('result.json');
    await expect(runGrokHeadless({ ...replay(wire), prompt: 'offline', format: 'json' }))
      .rejects.toMatchObject({ result: { stopReason: 'cancelled', total_cost_usd: 0.0205768,
        usage: { total_tokens: 55002 }, events: [expect.objectContaining({ text: 'Partial answer.' })] } });
  });

  it('parses the captured message stream cancellation and retains accounting', async () => {
    const wire = fixture('messages.ndjson');
    const callbacks: Record<string, unknown>[] = [];
    await expect(runGrokHeadless({ ...replay(wire), prompt: 'offline', format: 'streaming-messages-json', onEvent: e => callbacks.push(e) }))
      .rejects.toMatchObject({ result: { stopReason: 'cancelled', total_cost_usd: 0.02136356,
        usage: { input_tokens: 18046 }, events: expect.any(Array) } });
    expect(callbacks.map(e => e.type)).toEqual(['system', 'assistant', 'user', 'result']);
  });

  it('retains assistant usage when a message stream is truncated before its result', async () => {
    const wire = fixture('messages.ndjson').split('\n').slice(0, 2).join('\n') + '\n{"type":"res';
    await expect(runGrokHeadless({ ...replay(wire), prompt: 'offline', format: 'streaming-messages-json' }))
      .rejects.toMatchObject({ result: { usage: { input_tokens: 15979, output_tokens: 622 } } });
  });

  it('accepts a synthetic successful message result and ends despite background work', async () => {
    const frames = fixture('messages.ndjson').trim().split('\n').map(line => JSON.parse(line));
    Object.assign(frames.at(-1), { subtype: 'success', is_error: false, errors: [], stop_reason: 'end_turn', result: 'Done.' });
    const wire = frames.map(e => JSON.stringify(e)).join('\n');
    const result = await runGrokHeadless({ ...replay(wire, 'setInterval(()=>{},1000)'), prompt: 'offline', format: 'streaming-messages-json', timeoutMs: 1500 });
    expect(result).toMatchObject({ stopReason: 'end_turn', exitCode: 0 });
  });

  it('terminates a newline-free end and an unterminated JSON result while attached', async () => {
    for (const format of ['streaming-json', 'json'] as const) {
      const wire = JSON.stringify({ ...(format === 'json' ? { text: 'done' } : { type: 'end' }), stopReason: 'end_turn' });
      const result = await runGrokHeadless({ ...replay(wire, 'setInterval(()=>{},1000)'), prompt: 'offline', format, timeoutMs: 1500 });
      expect(result.exitCode).toBe(0);
    }
  });

  it('preserves UTF-8 split between output chunks', async () => {
    const result = await runGrokHeadless({ ...fake('const b=Buffer.from("hello 🌍");process.stdout.write(b.subarray(0,8));setTimeout(()=>process.stdout.write(b.subarray(8)),30)'), prompt: 'offline', format: 'plain' });
    expect(result.text).toBe('hello 🌍');
  });

  it.each([NaN, Infinity, 0, -1])('rejects an invalid lifetime %s before launch', async timeoutMs => {
    await expect(runGrokHeadless({ ...replay('ok'), prompt: 'offline', format: 'plain', timeoutMs })).rejects.toThrow(/timeoutMs/);
  });

  it('preserves redacted partial stream output and usage when the final frame is truncated', async () => {
    const wire = '{"type":"text","data":"xai-12345678"}\n{"type":"usage","usage":{"input_tokens":9}}\n{"type":"end"';
    await expect(runGrokHeadless({ ...replay(wire), prompt: 'offline', env: {} })).rejects.toMatchObject({
      result: { text: expect.stringContaining('[REDACTED]'), usage: { input_tokens: 9 } },
    });
  });

  it('catches callback errors and redacts their diagnostics', async () => {
    await expect(runGrokHeadless({ ...replay(fixture('stream.ndjson')), prompt: 'offline', onEvent: () => { throw new Error('xai-12345678'); } }))
      .rejects.toThrow(/callback.*\[REDACTED\]/);
  });

  it('does not advertise native background tasks from headless tool events', () => {
    const caps = getProviderCapabilities('grok-build');
    expect(caps?.native_features.tasks).toBe(false);
    expect(caps?.emulation.tasks).not.toBe('native');
  });

  it('bounds a simulated Windows child after a terminal event', async () => {
    await withWindows(async () => {
      const wire = '{"type":"end","stopReason":"end_turn"}';
      expect((await runGrokHeadless({ ...replay(wire, 'setInterval(()=>{},1000)'), prompt: 'offline' })).exitCode).toBe(0);
    });
  });

  it.each([true, false])('reaps a child ignoring SIGTERM (terminal: %s)', async terminal => {
    // This exercises the POSIX process-group escalation; Windows needs native PUW.
    if (process.platform === 'win32') return;
    const script = 'process.on("SIGTERM",()=>{});console.log(JSON.stringify({type:"text",data:String(process.pid)}));'
      + (terminal ? 'console.log(JSON.stringify({type:"end",stopReason:"end_turn"}));' : '') + 'setInterval(()=>{},1000)';
    let pid = 0;
    const run = runGrokHeadless({ ...fake(script), prompt: 'offline', timeoutMs: 1000,
      onEvent: event => { if (event.type === 'text') pid = Number(event.data); } });
    if (terminal) await run;
    else await expect(run).rejects.toThrow(/timed out/);
    expect(pid).toBeGreaterThan(0);
    const deadline = Date.now() + 1000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 10)); }
      catch { alive = false; }
    }
    expect(alive).toBe(false);
  });

  it('fails message errors at exit zero and rejects foreign, trailing or truncated frames', async () => {
    for (const wire of [fixture('messages.ndjson'), '{"type":"end","stopReason":"end_turn"}\n',
      '{"type":"assistant","message":null}\n', '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}\n{',
      '{"type":"assistant","message":{"content":[]}}\n']) {
      await expect(runGrokHeadless({ ...replay(wire), prompt: 'offline', format: 'streaming-messages-json' })).rejects.toThrow(/failed|Invalid|terminal/);
    }
  });

  it.each(['max_tokens', 'max_turn_requests', 'refusal', 'cancelled', undefined])('rejects synthetic message result stop reason %s', async stop_reason => {
    const wire = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, errors: [], stop_reason });
    await expect(runGrokHeadless({ ...replay(wire), prompt: 'offline', format: 'streaming-messages-json' })).rejects.toThrow(/failed/);
  });

  it('bounds abort, missing executable, stdout and stderr failures', async () => {
    const controller = new AbortController();
    const run = runGrokHeadless({ ...fake('setInterval(()=>{},1000)'), prompt: 'offline', signal: controller.signal });
    controller.abort();
    await expect(run).rejects.toThrow(/aborted/);
    await expect(runGrokHeadless({ cwd: tmpdir(), command: '/synthetic/missing/grok', prompt: 'offline' })).rejects.toThrow(/launch failed/);
    for (const stream of ['stdout', 'stderr']) {
      await expect(runGrokHeadless({ ...fake(`process.${stream}.write("x".repeat(2048))`), prompt: 'offline', maxOutputBytes: 1024 })).rejects.toThrow(/exceeded/);
    }
  });

  it('redacts credential fields and JSON-escaped environment secrets before callbacks', async () => {
    const secret = 'synthetic"quoted\\secret';
    const frames = [{ type: 'text', nested: { api_key: 'synthetic-private-value', note: secret } }, { type: 'end', stopReason: 'end_turn' }];
    const wire = frames.map(e => JSON.stringify(e)).join('\n');
    const callbacks: unknown[] = [];
    const result = await runGrokHeadless({ ...replay(wire), prompt: 'offline', env: { XAI_API_KEY: secret }, onEvent: e => callbacks.push(e) });
    for (const value of [result, callbacks]) {
      expect(JSON.stringify(value)).not.toContain('synthetic-private-value');
      expect(JSON.stringify(value)).not.toContain('synthetic');
    }
  });
});
