#!/usr/bin/env node
import { importImpl } from '../_resolve-impl.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformAgent } from '../../src/providers/omp-agent.mjs';
const { signalChild } = await importImpl(import.meta.url, 'process/signal-child.mjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(await readFile(join(root, 'test/fixtures/providers/omp-conformance/manifest.json'), 'utf8'));
const args = process.argv.slice(2);
const option = name => { const i=args.indexOf(name); return i<0 ? undefined : args[i+1]; };
const required = args.includes('--require');
const result = { schemaVersion: 1, recordedAt: new Date().toISOString(), status: 'unverified', source: manifest.source, release: manifest.release.tag,
  platform: `${process.platform}-${process.arch}`, node: process.version, checks: {}, unverified: manifest.unverified, separateGates: manifest.separateGates };
let sandbox;
try {
  const asset=manifest.release.platforms[result.platform];
  if (!asset) { result.status='skipped'; result.reason='UNVERIFIED_PLATFORM'; if(required)throw Error(result.reason); }
  else {
    let binary=option('--binary');
    if (!binary) binary=(process.env.PATH ?? '').split(process.platform==='win32'?';':':').map(p=>join(p,'omp')).find(existsSync);
    if (!binary) { result.status='skipped'; result.reason='OMP_BINARY_UNAVAILABLE'; if(required)throw Error(result.reason); }
    else {
      binary=resolve(binary);
      const digest=createHash('sha256').update(await readFile(binary)).digest('hex');
      result.checks.binaryDigest = digest===asset.sha256;
      if(!result.checks.binaryDigest)throw Error('OMP_BINARY_DIGEST_MISMATCH');
      sandbox=await mkdtemp(join(tmpdir(),'aiwg-omp-conformance-'));
      const workspace=join(sandbox,'workspace'), agentDir=join(sandbox,'agent'), report=join(sandbox,'probe.json');
      const env={PATH:process.env.PATH ?? '/usr/bin:/bin', XDG_CONFIG_HOME:join(sandbox,'config'), XDG_CACHE_HOME:join(sandbox,'cache'), XDG_DATA_HOME:join(sandbox,'data'), XDG_STATE_HOME:join(sandbox,'state'), PI_CODING_AGENT_DIR:agentDir, AIWG_OMP_CONFORMANCE_REPORT:report, NO_COLOR:'1', TERM:'dumb'};
      for(const dir of [workspace,agentDir])await mkdir(dir,{recursive:true});
      const version=spawnSync(binary,['--version'],{env,cwd:workspace,encoding:'utf8',timeout:15000, killSignal: 'SIGKILL' });
      result.binaryVersion=version.stdout?.trim();
      result.checks.version=version.status===0 && result.binaryVersion.includes(manifest.release.version);
      if(!result.checks.version)throw Error('OMP_VERSION_MISMATCH');
      const files={
        'WORKSPACE.md':'AIWG_OMP_ROOT_CONTEXT_CANARY\n',
        'nested/.omp/AGENTS.md':'AIWG_OMP_NESTED_CONTEXT_CANARY\n',
        '.claude/CLAUDE.md':'AIWG_OMP_DISABLED_FOREIGN_CANARY\n',
        '.pi/AGENTS.md':'AIWG_OMP_DISABLED_FOREIGN_CANARY\n',
        '.omp/AGENTS.md':'@../WORKSPACE.md\n',
        '.omp/rules/conformance.md':'---\nalwaysApply: true\n---\nAIWG_OMP_RULE_CANARY\n',
        '.omp/skills/conformance-skill/SKILL.md':'---\nname: conformance-skill\ndescription: AIWG_OMP_SKILL_DESCRIPTION_CANARY\n---\nCredential-free skill fixture.\n',
        '.omp/prompts/conformance-prompt.md':'---\ndescription: Conformance prompt\n---\nRead $1 with $ARGUMENTS.\n',
        '.omp/agents/conformance-agent.md':transformAgent('conformance-agent.md','---\nname: conformance-agent\ndescription: AIWG conformance agent\ntools: [Read]\n---\nInspect the fixture.\n',{quiet:true}),
      };
      for(const [name,body] of Object.entries(files)){const path=join(workspace,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,body);}
      await writeFile(join(agentDir,'config.yml'),'disabledProviders: [claude, claude-md, claude-plugins, codex, gemini, windsurf, agent-plugins, vscode, cursor, ssh-json, opencode, omp-plugins, cline, mcp-json, github, agents, agents-md]\nmarketplace:\n  autoUpdate: false\n');
      const extension=join(sandbox,'probe.ts');await copyFile(join(root,'test/fixtures/providers/omp-conformance/probe.ts'),extension);
      const rpcArgs=['--mode','rpc','--model','openrouter/openai/gpt-4.1-mini','--tools','read,task','--no-lsp','--no-title','--no-session','--no-extensions','--extension',extension];
      const rpc=await runRpc(binary,rpcArgs,{cwd:workspace,env});
      result.checks.rpc=rpc;
      const probe=JSON.parse(await readFile(report,'utf8'));
      result.checks.nativeResources=probe;
      for(const name of ['contextImport','foreignExcluded','ruleLoaded','skillLoaded','agentDiscovered','toolsAvailable'])if(!probe[name])throw Error(`NATIVE_CONFORMANCE_FAILED:${name}`);
      await runRpc(binary,rpcArgs,{cwd:join(workspace,'nested'),env});
      const nested=JSON.parse(await readFile(report,'utf8'));
      result.checks.nativeNestedContext = { nearestContextLoaded: nested.nestedContext, foreignExcluded: nested.foreignExcluded, ancestorContextAutoIncluded: nested.contextImport, ancestorRuleAutoIncluded: nested.ruleLoaded };
      if(!nested.nestedContext || !nested.foreignExcluded || nested.contextImport || nested.ruleLoaded)throw Error('OMP_NEAREST_CONTEXT_CONTRACT_DRIFT');
      result.status='passed';
    }
  }
}catch(error){result.status='failed';result.reason=error.message;process.exitCode=1;}
finally{if(sandbox)await rm(sandbox,{recursive:true,force:true});}
const output=JSON.stringify(result,null,2)+'\n';
if(option('--output')){await mkdir(dirname(resolve(option('--output'))),{recursive:true});await writeFile(resolve(option('--output')),output);}
process.stdout.write(output);
function runRpc(binary,args,options){
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{...options,stdio:['pipe','pipe','pipe']});
    let buffer='',count=0,finished=false;const checks={ready:false,negotiate:false,state:false,abort:false};
    const timer=setTimeout(()=>{signalChild(child, 'SIGKILL');reject(Error('OMP_RPC_TIMEOUT'));},45000);
    const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);if(error){signalChild(child, 'SIGKILL');reject(error);}else resolve(checks);};
    child.stderr.on('data',()=>{});
    child.stdout.on('data',chunk=>{
      buffer+=chunk.toString();if(buffer.length>1024*1024||++count>10000)return finish(Error('OMP_RPC_OUTPUT_LIMIT'));
      let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);let e;try{e=JSON.parse(line);}catch{continue;}
        let next;
        if(e.type==='ready'){checks.ready=true;next={id:'negotiate',type:'negotiate_protocol',protocolVersion:2};}
        else if(e.type==='response'&&Object.hasOwn(checks,e.id)){
          if(!e.success)return finish(Error(`OMP_RPC_REJECTED:${e.id}`));checks[e.id]=true;
          if(e.id==='negotiate')next={id:'state',type:'get_state'};
          if(e.id==='state')next={id:'abort',type:'abort'};
          if(e.id==='abort')child.stdin.end();
        }
        if(next)child.stdin.write(JSON.stringify(next)+'\n');
      }
    });
    child.stdin.on('error',finish);
    child.on('error',finish);
    child.on('exit',code=>finish(code===0&&Object.values(checks).every(Boolean)?undefined:Error('OMP_RPC_INCOMPLETE')));
  });
}
