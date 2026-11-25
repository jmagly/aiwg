// Exercise manual ACP dispatch tooling using only a local JSON-RPC executable.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const script = resolve('tools/providers/grok-build-acp-live.mjs');
const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ['--import', 'tsx', script], {
  env: { PATH: process.env.PATH, HOME: tmpdir(), AIWG_RESOLVE_IMPL_FROM: 'src',
    NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE, ...env },
  encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aiwg-grok-acp-script-'));
  const binary = join(root, 'grok');
  const marker = join(root, 'executed');
  const body = `#!/usr/bin/env node
const fs=require('fs');fs.writeFileSync(${JSON.stringify(marker)},'executed');
if(process.argv.includes('--version')) { console.log('grok 1.0.77 synthetic');process.exit(process.env.FAIL_VERSION?'1':0); }
if(!process.argv.join(' ').includes('--no-subagents --disallowed-tools workflow,scheduler_create,scheduler_list,scheduler_delete'))process.exit(2);
const respond=(id,result)=>console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize'){
  if(process.env.FAIL_INIT)console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{message:'synthetic init failure'}}));
  else respond(m.id,{authMethods:[{id:'xai.api_key'}]});
 }
 if(m.method==='authenticate')respond(m.id,{});
 if(m.method==='session/new'){fs.writeFileSync(${JSON.stringify(join(root, 'project'))},m.params.cwd);respond(m.id,{sessionId:'synthetic'});}
 if(m.method==='session/prompt'){
  if(process.env.FAIL_RELEASE)fs.unlinkSync(require('path').join(process.cwd(),'.git','aiwg-grok-dispatch-slots','0.json'));
  if(m.params.prompt[0].text!=='Reply with exactly: acp-dispatch-ok')process.exit(3);
  console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{text:process.env.WRONG_REPLY?'wrong':'acp-dispatch-ok'}}}}));
  respond(m.id,{stopReason:'end_turn'});
 }
});`;
  writeFileSync(binary, body, { mode: 0o700 });
  return { root, binary, marker, env: { HOME: root, AIWG_GROK_BUILD_LIVE_SMOKE: '1', AIWG_GROK_BUILD_BIN: binary,
    XAI_API_KEY: 'synthetic-only', AIWG_GROK_BUILD_EXPECTED_SHA256: createHash('sha256').update(body).digest('hex') } };
}

describe('manual-only Grok Build ACP dispatch script', () => {
  it('skips without opt-in', () => {
    const result = run({});
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'skipped', reason: 'AIWG_GROK_BUILD_LIVE_SMOKE is not enabled' });
  });

  it('skips when the binary is unavailable', () => {
    const result = run({ AIWG_GROK_BUILD_LIVE_SMOKE: '1', AIWG_GROK_BUILD_BIN: '/nonexistent/grok' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'skipped', reason: 'Grok Build binary unavailable' });
  });

  it.each(['CI', 'GITHUB_ACTIONS', 'GITEA_ACTIONS'])('skips in %s even with opt-in and credentials', flag => {
    const f = fixture();
    try {
      const result = run({ ...f.env, [flag]: 'true' });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'skipped', reason: 'Live ACP dispatch is manual-only; CI is disabled' });
      expect(existsSync(f.marker)).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('resolves the pinned default grok executable through PATH', () => {
    const f = fixture();
    try {
      const result = run({ ...f.env, AIWG_GROK_BUILD_BIN: '', PATH: `${f.root}${delimiter}${process.env.PATH}` });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'passed', slotAcquired: true, slotReleased: true });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('skips missing credentials before pin validation or binary execution', () => {
    const f = fixture();
    try {
      const result = run({ ...f.env, XAI_API_KEY: '', AIWG_GROK_BUILD_EXPECTED_SHA256: '' });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'skipped', reason: 'No Grok credential: set XAI_API_KEY or AIWG_GROK_BUILD_AUTH=login' });
      expect(existsSync(f.marker)).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('accepts a declared cached login instead of an API key and continues to pin validation', () => {
    const f = fixture();
    try {
      const result = run({ ...f.env, XAI_API_KEY: '', AIWG_GROK_BUILD_AUTH: 'login', AIWG_GROK_BUILD_EXPECTED_SHA256: '' });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/requires AIWG_GROK_BUILD_EXPECTED_SHA256/);
      expect(existsSync(f.marker)).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('does not treat other AIWG_GROK_BUILD_AUTH values as a credential', () => {
    const f = fixture();
    try {
      const result = run({ ...f.env, XAI_API_KEY: '', AIWG_GROK_BUILD_AUTH: 'yes', AIWG_GROK_BUILD_EXPECTED_SHA256: '' });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'skipped' });
      expect(existsSync(f.marker)).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it.each(['', '0'.repeat(64)])('rejects missing or mismatched binary pins before execution (%s)', hash => {
    const f = fixture();
    try {
      const result = run({ ...f.env, AIWG_GROK_BUILD_EXPECTED_SHA256: hash });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/requires AIWG_GROK_BUILD_EXPECTED_SHA256|SHA-256 mismatch/);
      expect(existsSync(f.marker)).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('reports a failed version check', () => {
    const f = fixture();
    try {
      const result = run({ ...f.env, FAIL_VERSION: '1' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('version check failed');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it.each([false, true])('holds/releases a cap slot and cleans its temp project even on a wrong reply (%s)', wrong => {
    const f = fixture();
    try {
      const result = run({ ...f.env, WRONG_REPLY: wrong ? '1' : '' });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(wrong ? 1 : 0);
      expect(JSON.parse(result.stdout)).toMatchObject({ provider: 'grok-build', transport: 'acp',
        status: wrong ? 'failed' : 'passed', stopReason: 'end_turn', finalText: wrong ? 'wrong' : 'acp-dispatch-ok',
        cap: 1, slotAcquired: true, slotReleased: true, cleanup: true });
      expect(existsSync(readFileSync(join(f.root, 'project'), 'utf8'))).toBe(false);
      expect(result.stdout + result.stderr).not.toContain('synthetic-only');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it.each(['FAIL_INIT', 'FAIL_RELEASE'])('cleans the disposable project after %s', failure => {
    const f = fixture();
    try {
      const result = run({ ...f.env, [failure]: '1' });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({ status: 'failed', cleanup: true,
        slotAcquired: failure !== 'FAIL_INIT', slotReleased: failure === 'FAIL_INIT' });
      expect(result.stderr).toContain(failure === 'FAIL_INIT' ? 'dispatch failed' : 'slot cleanup failed');
      if (existsSync(join(f.root, 'project'))) expect(existsSync(readFileSync(join(f.root, 'project'), 'utf8'))).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('keeps live ACP dispatch out of both CI workflow trees', () => {
    for (const tree of ['.github', '.gitea']) {
      const result = spawnSync('rg', ['-l', 'grok-build-acp-live\\.mjs', `${tree}/workflows`], {
        encoding: 'utf8', timeout: 5_000,
      });
      expect(result.status).toBe(1);
    }
  });
});
