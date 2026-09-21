import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { runGrokHeadless } from '../../../src/providers/grok-build-headless.js';

function fake(script: string) {
  return { command: process.execPath, prefixArgs: ['-e', script, '--'], cwd: tmpdir(), timeoutMs: 3_000 };
}

describe('Grok Build bounded headless transport', () => {
  it('uses fixed safe argv and parses plain termination', async () => {
    const result = await runGrokHeadless({
      ...fake('process.stdout.write(process.argv.join(" "))'), prompt: 'hello', format: 'plain',
    });
    expect(result.text).toContain('--no-auto-update -p hello --output-format plain');
    expect(result.exitCode).toBe(0);
  });

  it('parses JSON result and propagates JSON errors', async () => {
    const result = await runGrokHeadless({ ...fake('console.log(JSON.stringify({type:"result",text:"ok"}))'), prompt: 'hello', format: 'json' });
    expect(result.events[0]).toMatchObject({ type: 'result', text: 'ok' });
    await expect(runGrokHeadless({ ...fake('console.log(JSON.stringify({type:"error",error:"failed"}))'), prompt: 'hello', format: 'json' }))
      .rejects.toThrow(/JSON error/);
  });

  it('redacts nested streaming events and stderr before returning', async () => {
    const result = await runGrokHeadless({
      ...fake('console.log(JSON.stringify({type:"message",nested:{text:"xai-12345678"}}));console.log(JSON.stringify({type:"result"}));console.error("Bearer abcdefghijk")'),
      prompt: 'hello', env: { ...process.env, XAI_API_KEY: 'xai-12345678' },
    });
    expect(JSON.stringify(result)).not.toContain('xai-12345678');
    expect(result.stderr).toContain('Bearer [REDACTED]');
    expect(result.events).toHaveLength(2);
  });

  it('fails malformed streaming events, nonzero exits and missing terminal events', async () => {
    await expect(runGrokHeadless({ ...fake('console.log("not json")'), prompt: 'hello' })).rejects.toThrow(/Invalid/);
    await expect(runGrokHeadless({ ...fake('console.log(JSON.stringify({type:"result"}));process.exit(3)'), prompt: 'hello' })).rejects.toThrow(/exit 3/);
    await expect(runGrokHeadless({ ...fake('console.log(JSON.stringify({type:"message"}))'), prompt: 'hello' })).rejects.toThrow(/without a terminal event/);
  });

  it('terminates after a final event despite an attached background timer', async () => {
    const start = Date.now();
    const result = await runGrokHeadless({
      ...fake('console.log(JSON.stringify({type:"result",text:"done"}));setInterval(()=>{},1000)'),
      prompt: 'hello', timeoutMs: 2_000,
    });
    expect(result.events[0]).toMatchObject({ type: 'result' });
    expect(Date.now() - start).toBeLessThan(1_500);
  });

  it('enforces a timeout for a provider that never completes', async () => {
    await expect(runGrokHeadless({ ...fake('setInterval(()=>{},1000)'), prompt: 'hello', timeoutMs: 100 }))
      .rejects.toThrow(/timed out/);
  });
});
