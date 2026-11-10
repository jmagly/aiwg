import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
