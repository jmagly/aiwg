import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrokAcpClient } from '../../../src/providers/grok-build-acp.js';

const responder = `
const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{authMethods:[{id:'xai.api_key'},{id:'cached_token'}]}}));
 if(m.method==='authenticate') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}}));
 if(m.method==='session/new') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessionId:'s1'}}));
 if(m.method==='session/prompt') {
  process.stderr.write('PROMPT_SEEN\\n');
  console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{text:'Hello '}}}}));
  console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}}));
  setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{text:'world'}}}})),10);
 }
 if(m.method==='session/cancel') process.stderr.write('cancelled xai-12345678');
});`;

function client(script = responder, env: NodeJS.ProcessEnv = { ...process.env, XAI_API_KEY: 'xai-12345678' }, timeoutMs = 2_000) {
  return new GrokAcpClient({ cwd: tmpdir(), command: process.execPath, prefixArgs: ['-e', script, '--'], env, timeoutMs });
}

describe('Grok Build ACP contract', () => {
  const liveRoot = new URL('../../fixtures/providers/grok-build/captured-20261121/', import.meta.url);
  const livePath = fileURLToPath(new URL('acp-live.json', liveRoot));
  const live = JSON.parse(readFileSync(livePath, 'utf8'));

  it('keeps the 72-frame live capture with only generic command updates', () => {
    expect(live.frames).toHaveLength(72);
    expect(live.result).toMatchObject({ exit: { code: 0, sig: null }, stderrBytes: 4276,
      updateKinds: ['available_commands_update', 'agent_thought_chunk', 'agent_message_chunk'] });
    const commandUpdates = live.frames.flatMap(({ msg }: { msg: Record<string, any> }) =>
      msg.params?.update?.sessionUpdate === 'available_commands_update' ? [msg.params.update] : []);
    expect(commandUpdates).toHaveLength(3);
    for (const update of commandUpdates) {
      expect(update.availableCommands.map(({ name }: { name: string }) => name))
        .toEqual(['compact', 'context', 'session-info']);
    }
    expect(live.frames[0].t).toBe(0);
    expect(live.frames.at(-1).t).toBe(4964);
  });

  it.each([{}, { XAI_API_KEY: 'xai-offline-fixture' }])(
    'replays live logged-in auth, chunks, usage and MidTurnAbort (env=%j)', async env => {
      const root = mkdtempSync(join(tmpdir(), 'aiwg-grok-acp-live-replay-'));
      const updates: Record<string, unknown>[] = [];
      const acp = new GrokAcpClient({ cwd: root, command: process.execPath,
        prefixArgs: [fileURLToPath(new URL('replay-acp.mjs', liveRoot)), livePath],
        env, timeoutMs: 2_000, onUpdate: update => updates.push(update) });
      try {
        const requests = live.frames.filter(({ dir }: { dir: string }) => dir === 'out')
          .map(({ msg }: { msg: Record<string, any> }) => msg);
        expect(requests.map(({ method }: { method: string }) => method))
          .toEqual(['initialize', 'session/new', 'session/prompt', 'session/prompt', 'session/cancel']);
        const initResult = live.frames[1].msg.result;
        expect(initResult).toMatchObject({ protocolVersion: 1, _meta: { defaultAuthMethodId: 'cached_token' } });
        expect(initResult.authMethods.map(({ id }: { id: string }) => id)).toEqual(['cached_token', 'grok.com']);
        const sessionId = requests[2].params.sessionId;
        expect(await acp.initialize()).toEqual({ authMethod: 'cached_token', sessionId });
        const completion = await acp.prompt(requests[2].params.prompt[0].text);
        expect(completion).toEqual({ text: 'OK', ...live.result.steps[2].prompt1 });
        expect(completion._meta).toMatchObject({ modelId: 'grok-4.7', usage: {
          numTurns: 1, modelCalls: 1, modelUsage: { 'grok-4.7-build': { outputTokens: 30 } },
        } });
        const pending = acp.prompt(requests[3].params.prompt[0].text);
        acp.cancel();
        const cancelled = await pending;
        expect(cancelled).toEqual({ text: '', ...live.result.steps[3].prompt2AfterCancel });
        expect(cancelled).toMatchObject({ stopReason: 'cancelled', _meta: { cancellationCategory: 'MidTurnAbort' } });
        for (const kind of live.result.updateKinds) {
          const captured = live.frames.flatMap(({ msg }: { msg: Record<string, any> }) =>
            msg.method === 'session/update' && msg.params.update.sessionUpdate === kind ? [msg.params.update] : []);
          expect(captured.length).toBeGreaterThan(0);
          expect(updates.filter(update => update.sessionUpdate === kind)).toEqual(captured);
        }
        expect(acp.stderr).toBe('REPLAY_COMPLETE 72\n');
      } finally { acp.close(); rmSync(root, { recursive: true, force: true }); }
    });

  it.each([NaN, Infinity, 0, -1])('rejects invalid ACP lifetime %s before launch', timeoutMs => {
    let acp: GrokAcpClient | undefined;
    try {
      expect(() => { acp = client('process.stdin.resume()', {}, timeoutMs); }).toThrow(/timeoutMs/);
    } finally { acp?.close(); }
  });

  it.each([NaN, Infinity, 0, -1])('rejects invalid stderr bound %s before launch', maxStderrBytes => {
    let acp: GrokAcpClient | undefined;
    try {
      expect(() => { acp = new GrokAcpClient({ cwd: tmpdir(), command: process.execPath,
        prefixArgs: ['-e', 'process.stdin.resume()', '--'], maxStderrBytes }); }).toThrow(/maxStderrBytes/);
    } finally { acp?.close(); }
  });

  it('preserves UTF-8 in session updates split across pipe reads', async () => {
    const script = responder.replace("process.stderr.write('PROMPT_SEEN\\n');", `
      const frame=Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{text:'🌍'}}}})+'\\n');
      const split=frame.indexOf(Buffer.from('🌍'))+2;
      process.stdout.write(frame.subarray(0,split));
      setTimeout(()=>process.stdout.write(frame.subarray(split)),40);
      return;`);
    // Finish the prompt only after the second byte chunk has been written.
    const acp = client(script.replace('process.stdout.write(frame.subarray(split))',
      "{process.stdout.write(frame.subarray(split));console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}}));}"));
    try {
      await acp.initialize();
      expect((await acp.prompt('unicode')).text).toBe('🌍');
    } finally { acp.close(); }
  });

  it('ignores updates belonging to a different ACP session', async () => {
    const extra = "console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'other',update:{sessionUpdate:'agent_message_chunk',content:{text:'foreign'}}}}));";
    const acp = client(responder.replace("process.stderr.write('PROMPT_SEEN\\n');", extra));
    try {
      await acp.initialize();
      expect((await acp.prompt('hello')).text).toBe('Hello world');
    } finally { acp.close(); }
  });

  it('bounds stderr and rejects outstanding requests without exposing secrets', async () => {
    const acp = new GrokAcpClient({ cwd: tmpdir(), command: process.execPath,
      prefixArgs: ['-e', 'process.stdin.once("data",()=>{process.stderr.write("xai-12345678 "+"x".repeat(8192));});setInterval(()=>{},1000)', '--'],
      env: {}, maxStderrBytes: 1024, timeoutMs: 2_000 });
    try {
      await expect(acp.initialize()).rejects.toThrow(/stderr limit/);
      expect(Buffer.byteLength(acp.stderr)).toBeLessThanOrEqual(1024);
      expect(acp.stderr).not.toContain('xai-12345678');
    } finally { acp.close(); }
  });

  it.each(['null', '[]', '"frame"', '{invalid'])('fails closed on malformed ACP frame %s', async frame => {
    const acp = client(`process.stdin.once('data',()=>console.log(${JSON.stringify(frame)}));setInterval(()=>{},1000)`, {});
    try { await expect(acp.initialize()).rejects.toThrow(/Invalid Grok ACP/); }
    finally { acp.close(); }
  });

  it('propagates a redacted update callback error through the pending prompt', async () => {
    const acp = new GrokAcpClient({ cwd: tmpdir(), command: process.execPath, prefixArgs: ['-e', responder, '--'],
      env: {}, timeoutMs: 2_000, onUpdate: () => { throw new Error('xai-12345678'); } });
    try {
      await acp.initialize();
      await expect(acp.prompt('offline')).rejects.toThrow(/callback failed.*\[REDACTED\]/);
    } finally { acp.close(); }
  });

  it.each([false, true])('pre-allows only discovery in ACP argv (disableSubagents=%s)', async disableSubagents => {
    const script = `process.stderr.write(JSON.stringify(process.argv.slice(1)));` + responder;
    const acp = new GrokAcpClient({ cwd: tmpdir(), command: process.execPath, prefixArgs: ['-e', script, '--'],
      env: {}, timeoutMs: 2_000, disableSubagents });
    try {
      await acp.initialize();
      const args: string[] = JSON.parse(acp.stderr);
      expect(args.flatMap((arg, index) => arg === '--allow' ? [args[index + 1]] : [])).toEqual(['Bash(aiwg discover *)']);
      expect(args.slice(-2)).toEqual(['agent', 'stdio']);
      expect(args).not.toContain('--always-approve');
      expect(args).not.toContain('--permission-mode');
    } finally { acp.close(); }
  });

  it.each(['acp', 'acp-compact'])('replays captured 1.0.77 %s authentication, notifications and completion metadata', async capture => {
    const rows = readFileSync(new URL(`../../fixtures/providers/grok-build/captured-20261110/${capture}-frames.jsonl`, import.meta.url), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    // Replay only captured responses, remapping JSON-RPC ids to this client.
    // An unrecorded authenticate request fails: these captures were already logged in.
    const script = `const rows=${JSON.stringify(rows)};let cursor=0;const ids=new Map();
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line), expected=rows[cursor++];
 if(!expected || expected.dir!=='out' || expected.msg.method!==request.method){
  console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{message:'unexpected request '+request.method}}));return;
 }
 if(expected.msg.id!==undefined)ids.set(expected.msg.id,request.id);
 while(cursor<rows.length && rows[cursor].dir==='in'){
  const message=rows[cursor++].msg;
  if(message.id!==undefined)message.id=ids.get(message.id);
  console.log(JSON.stringify(message));
 }
});`;
    const root = mkdtempSync(join(tmpdir(), 'aiwg-grok-acp-capture-'));
    const updates: Record<string, unknown>[] = [];
    const acp = new GrokAcpClient({ cwd: root, command: process.execPath, prefixArgs: ['-e', script, '--'],
      env: {}, timeoutMs: 2_000, onUpdate: update => updates.push(update) });
    try {
      const init = await acp.initialize();
      expect(init).toMatchObject({ authMethod: 'cached_token' });
      expect(init.sessionId).toMatch(/^[0-9a-f-]{14}7/);
      const completion = await acp.prompt('offline replay');
      expect(completion).toMatchObject({ stopReason: 'end_turn', _meta: { usage: { numTurns: 1, modelCalls: 1 } } });
      if (capture === 'acp') {
        expect(completion.text).toBe('DELTA');
        const pending = acp.prompt('offline cancellation');
        acp.cancel();
        await expect(pending).resolves.toMatchObject({ stopReason: 'cancelled', _meta: { cancellationCategory: 'MidTurnAbort' } });
      } else {
        expect(completion.text).toBe('OK.');
        await expect(acp.prompt('/compact')).resolves.toMatchObject({ stopReason: 'end_turn' });
        expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'auto_compact_completed', tokens_before: 20088, tokens_after: 20088 }));
        expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'session_summary_generated' }));
        await expect(acp.prompt('recall')).resolves.toMatchObject({ text: 'ORCHID', stopReason: 'end_turn', _meta: { usage: { numTurns: 1 } } });
      }
    } finally { acp.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('initializes, selects API-key auth, reads updates after completion and cancels', async () => {
    const acp = client();
    try {
      expect(await acp.initialize()).toEqual({ authMethod: 'xai.api_key', sessionId: 's1' });
      expect(await acp.prompt('hello')).toEqual({ text: 'Hello world', stopReason: 'end_turn' });
      acp.cancel();
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(acp.stderr).toContain('cancelled [REDACTED]');
    } finally { acp.close(); }
  });

  it('chooses cached token when no explicit API key exists', async () => {
    const env = { ...process.env };
    delete env.XAI_API_KEY;
    const acp = client(responder, env);
    try { expect((await acp.initialize()).authMethod).toBe('cached_token'); }
    finally { acp.close(); }
  });

  it('fails closed when no supported authentication method is advertised', async () => {
    const acp = client(responder.replace("{id:'xai.api_key'},{id:'cached_token'}", "{id:'browser'}"));
    try { await expect(acp.initialize()).rejects.toThrow(/authentication unavailable/); }
    finally { acp.close(); }
  });

  it.each(['1.0.38', '1.0.40'])('fails closed on the released %s grok.com-only ACP advertisement', async version => {
    const observation = JSON.parse(readFileSync(new URL(`../../fixtures/providers/grok-build-acp-init-${version}.json`, import.meta.url), 'utf8'));
    expect(observation).toMatchObject({ binaryVersion: version, protocolVersion: 1, authMethods: [{ id: 'grok.com' }] });
    const acp = client(responder.replace("{id:'xai.api_key'},{id:'cached_token'}", "{id:'grok.com'}"));
    try { await expect(acp.initialize()).rejects.toThrow(/grok\.com interactive authentication is not qualified/); }
    finally { acp.close(); }
  });

  it('enforces request timeouts and terminates a silent daemon', async () => {
    const acp = client('process.stdin.resume()', process.env, 100);
    try { await expect(acp.initialize()).rejects.toThrow(/initialize timed out/); }
    finally { acp.close(); }
  });

  it('propagates JSON-RPC errors without exposing credential values', async () => {
    const script = `require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{message:'xai-12345678 denied'}}))})`;
    const acp = client(script);
    try {
      await expect(acp.initialize()).rejects.toThrow(/\[REDACTED\] denied/);
    } finally { acp.close(); }
  });

  it('redacts retained completion metadata without changing usage or cancellation fields', async () => {
    const acp = client(responder.replace("result:{stopReason:'end_turn'}", "result:{stopReason:'end_turn',_meta:{usage:{inputTokens:10},requestId:'xai-12345678',authorization:'Bearer private-value'}}"));
    try {
      await acp.initialize();
      expect(await acp.prompt('offline metadata')).toMatchObject({ _meta: {
        usage: { inputTokens: 10 }, requestId: '[REDACTED]', authorization: '[REDACTED]',
      } });
    } finally { acp.close(); }
  });

  it('rejects a pre-aborted prompt without sending prompt or cancel', async () => {
    const acp = client();
    try {
      await acp.initialize();
      const controller = new AbortController();
      controller.abort();
      await expect(acp.prompt('should not run', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(acp.stderr).not.toContain('PROMPT_SEEN');
      expect(acp.stderr).not.toContain('cancelled');
    } finally { acp.close(); }
  });

  it('cancels an in-flight prompt and rejects after its completion response', async () => {
    const script = `
const rl=require('readline').createInterface({input:process.stdin});let promptId;
rl.on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{authMethods:[{id:'xai.api_key'}]}}));
 if(m.method==='authenticate') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}}));
 if(m.method==='session/new') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessionId:'s1'}}));
 if(m.method==='session/prompt'){promptId=m.id;process.stderr.write('PROMPT_SEEN\\n');}
 if(m.method==='session/cancel'){
  process.stderr.write('CANCEL_SEEN\\n');
  console.log(JSON.stringify({jsonrpc:'2.0',id:promptId,result:{stopReason:'cancelled'}}));
 }
});`;
    const acp = client(script);
    try {
      await acp.initialize();
      const controller = new AbortController();
      const pending = acp.prompt('slow', controller.signal);
      const deadline = Date.now() + 1_000;
      while (!acp.stderr.includes('PROMPT_SEEN') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(acp.stderr).toContain('PROMPT_SEEN');
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(acp.stderr).toMatch(/PROMPT_SEEN[\s\S]*CANCEL_SEEN/);
    } finally { acp.close(); }
  });
});
