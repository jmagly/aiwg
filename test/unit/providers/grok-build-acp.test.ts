import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
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
