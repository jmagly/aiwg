import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { runGrokHeadless } from '../../../src/providers/grok-build-headless.js';

function fake(script: string) {
  return { command: process.execPath, prefixArgs: ['-e', script, '--'], cwd: tmpdir(), timeoutMs: 3_000 };
}

describe('Grok Build bounded headless transport', () => {
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
    expect(result.text).not.toContain('--no-auto-update');
    expect(result.exitCode).toBe(0);
  });

  it('uses the released CLI switch to disable native subagents for governed workers', async () => {
    const result = await runGrokHeadless({
      ...fake('process.stdout.write(process.argv.join(" "))'), prompt: 'hello', format: 'plain', disableSubagents: true,
    });
    expect(result.text).toContain('--no-subagents -p hello');
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
