import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrokBuildDispatcher, acquireGrokProjectSlot, prepareGrokWorktree } from '../../../src/providers/grok-build-dispatch.js';

function cleanRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'aiwg-grok-source-'));
  execFileSync('git', ['init', '-q', root], { timeout: 5_000 });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'], { timeout: 5_000 });
  execFileSync('git', ['-C', root, 'config', 'user.name', 'AIWG Test'], { timeout: 5_000 });
  writeFileSync(join(root, 'README.md'), 'source\n');
  execFileSync('git', ['-C', root, 'add', 'README.md'], { timeout: 5_000 });
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture'], { timeout: 5_000 });
  return root;
}

describe('Grok Build governed dispatch', () => {
  it('creates an isolated detached worktree and records recoverable ownership', async () => {
    const root = cleanRepo();
    let worktree = '';
    try {
      const record = await prepareGrokWorktree(root, 'test-owner');
      worktree = record.path;
      expect(record).toMatchObject({ schema: 'aiwg.grok-build.worktree.v1', owner: 'test-owner', source: root });
      expect(worktree).not.toBe(root);
      expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('source\n');
      expect(await GrokBuildDispatcher.forProject(worktree)).toBe(await GrokBuildDispatcher.forProject(root));
      const gitDir = execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8', timeout: 5_000 }).trim();
      expect(JSON.parse(readFileSync(join(gitDir, 'aiwg-grok-owner.json'), 'utf8'))).toMatchObject({ owner: 'test-owner', path: worktree });
      expect(record.recovery).toContain('worktree list');
    } finally {
      if (worktree && existsSync(worktree)) execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', worktree], { timeout: 5_000 });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an isolation snapshot when the source has uncommitted changes', async () => {
    const root = cleanRepo();
    try {
      writeFileSync(join(root, 'README.md'), 'uncommitted\n');
      await expect(prepareGrokWorktree(root)).rejects.toThrow(/clean source checkout/);
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('uncommitted\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('checks authorization, budget, resolved cap, and disables unbounded internal fan-out', async () => {
    const root = cleanRepo();
    try {
      const dispatcher = await GrokBuildDispatcher.forProject(root);
      expect(dispatcher.maxParallel).toBe(4);
      expect(await GrokBuildDispatcher.forProject(root)).toBe(dispatcher);
      const fake = { command: process.execPath, prefixArgs: ['-e', 'setTimeout(()=>console.log(JSON.stringify({type:"result",text:process.env.GROK_SUBAGENTS})),250)', '--'] };
      await expect(dispatcher.dispatch({ ...fake, projectRoot: root, prompt: 'x', authorize: () => false, budgetRemaining: () => true })).rejects.toThrow(/authorization gate/);
      await expect(dispatcher.dispatch({ ...fake, projectRoot: root, prompt: 'x', authorize: () => true, budgetRemaining: () => false })).rejects.toThrow(/budget exhausted/);
      const running = Array.from({ length: dispatcher.maxParallel }, () => dispatcher.dispatch({
        ...fake, projectRoot: root, prompt: 'x', authorize: () => true, budgetRemaining: () => true,
      }));
      // Resolving the Git common directory adds bounded async work before admission.
      const deadline = Date.now() + 2_000;
      while (dispatcher.activeDispatches < 4 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(dispatcher.activeDispatches).toBe(4);
      await expect(dispatcher.dispatch({ ...fake, projectRoot: root, prompt: 'x', authorize: () => true, budgetRemaining: () => true })).rejects.toThrow(/parallelism cap/);
      const results = await Promise.all(running);
      expect(results.every(item => item.result.text.includes('"text":"0"'))).toBe(true);
      expect(results.every(item => item.result.text.includes('"type":"result"'))).toBe(true);
      expect(dispatcher.activeDispatches).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('shares the project cap with an independent process and releases after failure', async () => {
    const root = cleanRepo();
    const key = join(root, '.git');
    mkdirSync(join(root, '.aiwg'));
    writeFileSync(join(root, '.aiwg', 'aiwg.config'), JSON.stringify({ parallelism: { max_parallel_subagents: 1 } }));
    const fake = { command: process.execPath, prefixArgs: ['-e', 'console.log(JSON.stringify({type:"result"}))', '--'] };
    try {
      const dispatcher = await GrokBuildDispatcher.forProject(root);
      expect(dispatcher.maxParallel).toBe(1);
      const release = await acquireGrokProjectSlot(key, 1);
      try {
        await expect(dispatcher.dispatch({ ...fake, projectRoot: root, prompt: 'x', authorize: () => true, budgetRemaining: () => true }))
          .rejects.toThrow(/parallelism cap/);
        const childCode = `import { acquireGrokProjectSlot } from './src/providers/grok-build-dispatch.ts'; try { await acquireGrokProjectSlot(${JSON.stringify(key)}, 1); process.exit(2); } catch (error) { if (!String(error).includes('parallelism cap')) process.exit(3); }`;
        execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childCode], {
          cwd: process.cwd(), timeout: 5_000,
        });
      } finally { await release(); }
      await expect(dispatcher.dispatch({ ...fake, projectRoot: root, prompt: 'x', authorize: () => true, budgetRemaining: () => true }))
        .resolves.toMatchObject({ result: { exitCode: 0 } });
      writeFileSync(join(key, 'aiwg-grok-dispatch-slots', '0.json'), JSON.stringify({ pid: 2147483647, token: 'stale', limit: 1 }), { mode: 0o600 });
      await expect(dispatcher.dispatch({ ...fake, projectRoot: root, prompt: 'x', authorize: () => true, budgetRemaining: () => true }))
        .rejects.toThrow(/Stale Grok Build dispatch slot/);
      rmSync(join(key, 'aiwg-grok-dispatch-slots', '0.json'));
      writeFileSync(join(root, 'README.md'), 'dirty\n');
      await expect(dispatcher.dispatch({ ...fake, projectRoot: root, prompt: 'x', isolate: true, authorize: () => true, budgetRemaining: () => true }))
        .rejects.toThrow(/clean source checkout/);
      await expect(dispatcher.dispatch({ ...fake, projectRoot: root, prompt: 'x', authorize: () => true, budgetRemaining: () => true }))
        .resolves.toMatchObject({ result: { exitCode: 0 } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('holds the same cross-process slot for an ACP session until its process exits', async () => {
    const root = cleanRepo();
    const key = join(root, '.git');
    mkdirSync(join(root, '.aiwg'));
    writeFileSync(join(root, '.aiwg', 'aiwg.config'), JSON.stringify({ parallelism: { max_parallel_subagents: 1 } }));
    const script = `require('readline').createInterface({input:process.stdin}).on('line',line=>{
      const message=JSON.parse(line);
      if(message.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{authMethods:[{id:'xai.api_key'}]}}));
      if(message.method==='authenticate') console.log(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{}}));
      if(message.method==='session/new') console.log(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{sessionId:process.argv.includes('--no-subagents')?'acp-fixture':'missing-cap-flag'}}));
      if(message.method==='session/prompt') console.log(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{stopReason:'end_turn'}}));
    })`;
    try {
      const dispatcher = await GrokBuildDispatcher.forProject(root);
      const options = { projectRoot: root, command: process.execPath, prefixArgs: ['-e', script, '--'],
        env: { ...process.env, XAI_API_KEY: 'fixture-secret' },
        authorize: () => true, budgetRemaining: () => true };
      const externalRelease = await acquireGrokProjectSlot(key, 1);
      try { await expect(dispatcher.openAcp(options)).rejects.toThrow(/parallelism cap/); }
      finally { await externalRelease(); }
      const session = await dispatcher.openAcp(options);
      expect(session.sessionId).toBe('acp-fixture');
      expect(session.authMethod).toBe('xai.api_key');
      expect(dispatcher.activeDispatches).toBe(1);
      await expect(acquireGrokProjectSlot(key, 1)).rejects.toThrow(/parallelism cap/);
      await session.close();
      expect(dispatcher.activeDispatches).toBe(0);
      const released = await acquireGrokProjectSlot(key, 1);
      await released();
      const noCredential = { ...process.env };
      delete noCredential.XAI_API_KEY;
      await expect(dispatcher.openAcp({ ...options, env: noCredential })).rejects.toThrow(/authentication unavailable/);
      expect(dispatcher.activeDispatches).toBe(0);
      const afterFailure = await acquireGrokProjectSlot(key, 1);
      await afterFailure();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps an ACP lease until a SIGTERM-resistant process is forcibly stopped', async () => {
    const root = cleanRepo();
    mkdirSync(join(root, '.aiwg'));
    writeFileSync(join(root, '.aiwg', 'aiwg.config'), JSON.stringify({ parallelism: { max_parallel_subagents: 1 } }));
    const script = `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);require('readline').createInterface({input:process.stdin}).on('line',line=>{
      const message=JSON.parse(line);
      const result=message.method==='initialize'?{authMethods:[{id:'xai.api_key'}]}:
        message.method==='session/new'?{sessionId:'resistant'}:{};
      console.log(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
    })`;
    try {
      const dispatcher = await GrokBuildDispatcher.forProject(root);
      const session = await dispatcher.openAcp({ projectRoot: root, command: process.execPath,
        prefixArgs: ['-e', script, '--'], env: { ...process.env, XAI_API_KEY: 'fixture-secret' },
        authorize: () => true, budgetRemaining: () => true });
      const started = Date.now();
      await session.close();
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(dispatcher.activeDispatches).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
