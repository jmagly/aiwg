import { assertStartupRuleDelivery } from '../helpers/rule-delivery-context.js';
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const repo=resolve('.');
const sandbox=mkdtempSync(join(tmpdir(),'aiwg-omp-public-cli-'));
const workspace=join(sandbox,'project');
const config=join(sandbox,'aiwg-config');
mkdirSync(workspace,{recursive:true});mkdirSync(config,{recursive:true});
writeFileSync(join(config,'channel.json'),JSON.stringify({channel:'edge',edgePath:repo,devMode:true}));
const baseEnv={...process.env,AIWG_CONFIG:config,AIWG_USER_REGISTRY_PATH:join(config,'installed.json'),PI_CODING_AGENT_DIR:join(sandbox,'omp-agent'),PI_CONFIG_DIR:relative(homedir(),join(sandbox,'omp-config')),OMP_PROFILE:'',PI_PROFILE:'',NO_UPDATE_NOTIFIER:'1'};
afterAll(()=>rmSync(sandbox,{recursive:true,force:true}));
function cli(args:string[],env:Record<string,string>={}){
  const entry=pathToFileURL(join(repo,'src/cli/router.ts')).href;
  const program=`import { run } from ${JSON.stringify(entry)}; await run(process.argv.slice(1)); process.exit(process.exitCode ?? 0);`;
  const result=spawnSync(process.execPath,['--import',pathToFileURL(require.resolve('tsx')).href,'--eval',program,...args],{cwd:workspace,env:{...baseEnv,...env},encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  expect(result.status,[result.error?.message,result.signal,result.stderr,result.stdout].filter(Boolean).join('\n')).toBe(0);
  return result.stdout;
}
function put(name:string,body:string){const file=join(workspace,name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,body);}
function files(directory:string):string[]{if(!existsSync(directory))return[];return readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(directory,e.name)):[join(directory,e.name)]).sort();}
let preservedSupport: string | undefined;
const common=['use','aiwg-utils','--provider','omp','--no-project-local','--json'];
describe('OMP public use command integration',()=>{
  it('supports canonical and alias dry-run without creating native artifacts',()=>{
    cli([...common,'--dry-run']);
    cli(['use','aiwg-utils','--provider','oh-my-pi','--no-project-local','--dry-run','--json']);
    expect(existsSync(join(workspace,'.omp'))).toBe(false);
    expect(existsSync(join(workspace,'.agents/skills'))).toBe(false);
  },180000);
  it('deploys/repeats full skills then reconciles kernel-only through the public command',()=>{
    const foreign={'.pi/AGENTS.md':'Pi operator context','.claude/CLAUDE.md':'Claude operator context','.codex/config.toml':'# Codex operator configuration','.agents/skills/operator/SKILL.md':'---\nname: operator\ndescription: operator owned\n---\nKeep this.'};
    for(const [name,body] of Object.entries(foreign))put(name,body);
    cli([...common,'--copy-all']);
    assertStartupRuleDelivery(workspace, 'omp', readFileSync(join(workspace,'.omp/AGENTS.md'),'utf8'));
    expect(existsSync(join(workspace,'.omp/extensions/aiwg-bridge.ts'))).toBe(true);
    const full=files(join(workspace,'.agents/skills')).filter(f=>f.endsWith('/SKILL.md'));
    expect(full.some(f=>f.includes('/aiwg-doctor/'))).toBe(true);
    expect(full.some(f=>f.includes('/workspace-reset/'))).toBe(true);
    preservedSupport=join(workspace,'.agents/skills/aiwg-refresh/run.sh');
    expect(existsSync(preservedSupport)).toBe(true);
    if(preservedSupport)writeFileSync(preservedSupport,'Operator-owned support update');
    cli([...common,'--copy-all']);
    if(preservedSupport)expect(readFileSync(preservedSupport,'utf8')).toBe('Operator-owned support update');
    expect(files(join(workspace,'.agents/skills')).filter(f=>f.endsWith('/SKILL.md'))).toEqual(full);
    cli(['use','sdlc','--provider','omp','--no-project-local','--json']);
    expect(existsSync(join(workspace,'.agents/skills/workspace-reset/SKILL.md'))).toBe(true);
    cli(common); // Explicitly return aiwg-utils to index mode before reconciling it.
    cli(['use','sdlc','--provider','omp','--no-project-local','--json']);
    const startup=readFileSync(join(workspace,'.omp/AGENTS.md'),'utf8');
    expect(startup).toContain('## Core rules');
    const index = assertStartupRuleDelivery(workspace, 'omp', startup);
    expect(index).toContain('Review tunnel access policies and credentials');
    expect(index).toContain('aiwg show rule net-tunnel-safety --body');
    expect(readFileSync(join(workspace, '.omp/rules/sys-interactive-gate.md'), 'utf8')).toContain('Interactive Command Gate');
    const kernel=files(join(workspace,'.agents/skills')).filter(f=>f.endsWith('/SKILL.md'));
    expect(kernel.length).toBeLessThan(full.length);
    expect(kernel.some(f=>f.includes('/aiwg-doctor/'))).toBe(true);
    expect(kernel.some(f=>f.includes('/workspace-reset/'))).toBe(false);
    for(const [name,body] of Object.entries(foreign))expect(readFileSync(join(workspace,name),'utf8')).toBe(body);
    if(preservedSupport)expect(readFileSync(preservedSupport,'utf8')).toBe('Operator-owned support update');
  },300000);
  it('routes default user resources and named profile resources to isolated native roots',()=>{
    cli([...common,'--scope','user']);
    expect(existsSync(join(sandbox,'omp-agent/skills/aiwg-doctor/SKILL.md'))).toBe(true);
    expect(files(join(sandbox,'omp-config/agent/agents')).some(file=>file.endsWith('.md'))).toBe(true);
    cli(['use','aiwg-utils','--provider','oh-my-pi','--no-project-local','--json','--scope','user'],{OMP_PROFILE:'conformance',PI_PROFILE:'ignored'});
    expect(existsSync(join(sandbox,'omp-config/profiles/conformance/agent/skills/aiwg-doctor/SKILL.md'))).toBe(true);
    expect(existsSync(join(sandbox,'omp-config/profiles/ignored'))).toBe(false);
  },300000);
  it('removes only receipt-owned files from the selected project/profile',()=>{
    put('.omp/operator.txt','Keep operator file');
    cli(['remove','omp','--provider','omp','--dry-run']);
    expect(existsSync(join(workspace,'.omp/extensions/aiwg-bridge.ts'))).toBe(true);
    cli(['remove','omp','--provider','omp','--scope','user'],{OMP_PROFILE:'conformance'});
    expect(existsSync(join(sandbox,'omp-config/profiles/conformance/agent/skills/aiwg-doctor/SKILL.md'))).toBe(false);
    expect(existsSync(join(sandbox,'omp-agent/skills/aiwg-doctor/SKILL.md'))).toBe(true);
    cli(['remove','omp','--provider','omp']);
    expect(existsSync(join(workspace,'.omp/extensions/aiwg-bridge.ts'))).toBe(false);
    expect(readFileSync(join(workspace,'.omp/operator.txt'),'utf8')).toBe('Keep operator file');
    if(preservedSupport)expect(readFileSync(preservedSupport,'utf8')).toBe('Operator-owned support update');
  },180000);
});
