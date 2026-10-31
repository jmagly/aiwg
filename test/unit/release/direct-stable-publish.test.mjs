import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { signBlob } from '../../../tools/release/cosign-sign-blob.mjs';
import { publish, validateInputs, mirror, prepareRecovery, verifyRetention } from '../../../tools/release/direct-stable-publish.mjs';
const roots=[];
afterEach(() => { for (const p of roots.splice(0)) fs.rmSync(p,{recursive:true,force:true}); });
function fixture(version = '2026.10.4'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aiwg-direct-release-'));roots.push(dir);
 const pairs=[['aiwg','aiwg'],['@aiwg/cli','aiwg-cli'],['@aiwg/cockpit','aiwg-cockpit'],['@aiwg/flue','aiwg-flue']];
 const packages=pairs.map(([name,stem])=>{const filename=`${stem}-${version}.tgz`, bytes=Buffer.from(`fixture:${name}`);fs.writeFileSync(path.join(dir,filename),bytes);return {package:name,filename,sha256:createHash('sha256').update(bytes).digest('hex'),installed_version:version,status:'success'};});
 fs.writeFileSync(path.join(dir,'installed-smoke.json'),JSON.stringify({pass:true,packages}));return {dir,packages};
}
function fake(packages,{badIdentity=false,missingProvenance=false,conflict=false,next=false,wrongLatest=false,unavailable=false}={}) {
 const calls=[], published=new Set();
 return {calls, spawn(_cmd,args){calls.push(args);if(args[0]==='publish'){ const pkg=packages.find(p=>args[1].endsWith(p.filename));published.add(pkg.package);return {status:conflict?1:0,stderr:conflict?'EPUBLISHCONFLICT':''}; }
 if(args[0]==='view' && !published.has(args[1].replace(/@2026\.10\.4$/, '')))return {status:1,stderr:'E404 not found'};
 if(args[0]==='dist-tag')return {status:0};
 if(unavailable)return {status:1,stderr:'not visible'};
 if(args[2]==='dist-tags')return {status:0,stdout:JSON.stringify({latest:wrongLatest?'2026.10.3':'2026.10.4',...(next?{next:'2026.10.4'}:{})})};
 const pkg=packages.find(p=>`${p.package}@2026.10.4`===args[1]); const bytes=Buffer.from(`fixture:${pkg.package}`);
 return {status:0,stdout:JSON.stringify({name:pkg.package,version:'2026.10.4',dist:{shasum:badIdentity?'bad':createHash('sha1').update(bytes).digest('hex'),integrity:`sha512-${createHash('sha512').update(bytes).digest('base64')}`,attestations:missingProvenance?{}:{url:'https://example.invalid/attestation',provenance:{predicateType:'https://slsa.dev/provenance/v1'}}}})};
 }};
}
describe('direct stable exact tarball publication',()=>{
 it('publishes four smoke-bound tarballs and recovers verified conflicts',async()=>{const {dir,packages}=fixture(), f=fake(packages,{conflict:true});const result=await publish({directory:dir,version:'2026.10.4',receipt:path.join(dir,'receipt'),spawn:f.spawn,sleep:async()=>{}});expect(result.complete).toBe(true);for(const item of result.packages) expect(item.attestations).toEqual({url:'https://example.invalid/attestation',provenance:{predicateType:'https://slsa.dev/provenance/v1'}});expect(result.packages.map(p=>p.disposition)).toEqual(['already-published','already-published','already-published','already-published']);expect(f.calls.filter(a=>a[0]==='publish')).toHaveLength(4);});
 it('rejects altered tarballs before any publication',()=>{const {dir}=fixture();fs.writeFileSync(path.join(dir,'aiwg-2026.10.4.tgz'),'altered');expect(()=>validateInputs(dir,'2026.10.4')).toThrow(/Tarball changed/);});
 it.each([{badIdentity:true},{unavailable:true}])('rejects unverified registry conflicts %j',async options=>{const {dir,packages}=fixture(),f=fake(packages,{...options,conflict:true});await expect(publish({directory:dir,version:'2026.10.4',receipt:path.join(dir,'receipt'),spawn:f.spawn,sleep:async()=>{}})).rejects.toThrow();expect(f.calls.filter(a=>a[0]==='publish')).toHaveLength(1);},20000);
 it('does not mirror before all four public identities verify',async()=>{const {dir,packages}=fixture(),f=fake(packages,{badIdentity:true});await expect(mirror({directory:dir,version:'2026.10.4',receipt:path.join(dir,'receipt'),spawn:f.spawn,sleep:async()=>{}})).rejects.toThrow();expect(f.calls.some(a=>a[0]==='publish')).toBe(false);});
 it.each([{next:true},{wrongLatest:true},{missingProvenance:true},{unavailable:true}])('keeps registry visibility and policy checks advisory after a successful publish %j',async options=>{const {dir,packages}=fixture(),f=fake(packages,options);const result=await publish({directory:dir,version:'2026.10.4',receipt:path.join(dir,'receipt'),spawn:f.spawn,sleep:async()=>{}});expect(result.complete).toBe(true);expect(f.calls.filter(a=>a[0]==='publish')).toHaveLength(4);if(options.unavailable)expect(result.packages.every(p=>p.registry_identity==='pending')).toBe(true);});
 it('blocks a successful publish when an observed registry identity disagrees',async()=>{const {dir,packages}=fixture(),f=fake(packages,{badIdentity:true});await expect(publish({directory:dir,version:'2026.10.4',receipt:path.join(dir,'receipt'),spawn:f.spawn,sleep:async()=>{}})).rejects.toThrow(/identity mismatch/);expect(f.calls.filter(a=>a[0]==='publish')).toHaveLength(1);});
});

const recoveryCommit = 'a'.repeat(40), repository = 'jmagly/aiwg';
function recoveryFixture({ retained = true, legacy = false, attempt = 2, changed = false, corrupt = false, partial = false, omit, nested = legacy } = {}) {
 const version='2026.10.9', original=fixture(version), directory=fs.mkdtempSync(path.join(os.tmpdir(),'aiwg-recovered-release-'));roots.push(directory);
 const bytes=new Map(original.packages.map(p=>[p.package,fs.readFileSync(path.join(original.dir,p.filename))]));
 const registry=new Map();const calls=[];
 const metadata=(name,b)=>({name,version,dist:{tarball:`https://registry.npmjs.org/${name}/-/fixture.tgz`,shasum:createHash('sha1').update(b).digest('hex'),integrity:`sha512-${createHash('sha512').update(b).digest('base64')}`}});
 const spawn=(cmd,args,_profile,options)=>{
   if(cmd==='python3')return spawnSync(cmd,args,{...options,timeout:120000});
   calls.push(args);
   if(args[0]==='publish'){const p=original.packages.find(p=>args[1].endsWith(p.filename));registry.set(p.package,bytes.get(p.package));return {status:0};}
   const name=args[1].slice(0,-version.length-1),b=registry.get(name);
   return b ? {status:0,stdout:JSON.stringify(metadata(name,b))} : {status:1,stderr:'E404 not found'};
 };
 const run={id:40349216419,path:'.github/workflows/npm-publish.yml',head_sha:recoveryCommit,head_branch:`v${version}`,event:'push',repository:{full_name:repository},head_repository:{full_name:repository}};
 const artifact={id:44,name:`stable-packages-${run.id}-1`,expired:false,workflow_run:{id:run.id,head_sha:recoveryCommit}};
 const required=['Verify workflow identity is tag-bound','Verify signed tag (#1299 / A9 gate)','Checkout release tag','Pack and smoke-test exact npm surfaces','Retain smoke-tested tarballs before publication'];
 const client={
   listWorkflowRuns:async()=>({items:retained?[run]:[],complete:true}),
   listRunArtifacts:async()=>({items:[artifact],complete:true}),
   listJobs:async()=>({items:[{name:'Publish to npmjs.org with provenance',run_id:run.id,head_sha:recoveryCommit,steps:required.map(name=>({name,status:'completed',conclusion:'success'}))}],complete:true}),
   async downloadArtifact({destination}){
     const source=fs.mkdtempSync(path.join(os.tmpdir(),'aiwg-retained-fixture-'));roots.push(source);
     for(const p of original.packages){if((legacy && p.package!=='aiwg') || p.package===omit)continue;fs.copyFileSync(path.join(original.dir,p.filename),path.join(source,p.filename));}
     if(!legacy)fs.copyFileSync(path.join(original.dir,'installed-smoke.json'),path.join(source,'installed-smoke.json'));
     if(changed)fs.writeFileSync(path.join(source,original.packages[2].filename),'different original smoke-tested cockpit');
     const zip=spawnSync('python3',['-I','-S','-c','import os,sys,zipfile\nz=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED)\nfor n in os.listdir(sys.argv[1]): z.write(os.path.join(sys.argv[1],n),sys.argv[3]+n)\nz.close()',source,path.join(destination,'candidate.zip'),nested?'__w/_temp/stable-package/':''],{encoding:'utf8',timeout:30000});
     if(zip.status!==0)throw new Error(zip.stderr);return {archivePath:path.join(destination,'candidate.zip')};
   },
 };
 let smokeCalls=0;
 const smoke=({output})=>{smokeCalls++;const packages=original.packages.map(p=>({...p,sha256:createHash('sha256').update(fs.readFileSync(path.join(output,p.filename))).digest('hex')}));fs.writeFileSync(path.join(output,'installed-smoke.json'),JSON.stringify({pass:true,packages}));};
 return {version,original,directory,registry,calls,client,bytes,spawn,artifact,run,required,
   get smokeCalls(){return smokeCalls;},
   options:{directory,version,repository,commit:recoveryCommit,tag:`v${version}`,runId:attempt===1?99:run.id,attempt,client,spawn,smoke,
     fetchImpl:async url=>{const name=[...bytes.keys()].find(name=>url.pathname===`/${name}/-/fixture.tgz`);const body=registry.get(name);return new Response(corrupt?Buffer.from('corrupt download'):body);}},
   seed(){for(const [name,b]of bytes)if(!partial||name==='aiwg')registry.set(name,b);},
 };
}
describe('post-publication signing recovery',()=>{
 it.each([2,1])('recovers v2026.10.9 after signing fails, with no republish (attempt %s)',async attempt=>{
   const f=recoveryFixture({attempt});
   await publish({directory:f.original.dir,version:f.version,receipt:path.join(f.original.dir,'publication'),spawn:f.spawn});
   expect(f.calls.filter(a=>a[0]==='publish')).toHaveLength(4);
   const signer={file:path.join(f.original.dir,f.original.packages[0].filename),bundle:path.join(f.directory,'bundle'),env:{ACTIONS_ID_TOKEN_REQUEST_URL:'https://oidc.invalid/token',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-request'},sleep:async()=>{}};
   await expect(signBlob({...signer,fetchImpl:async()=>new Response('upstream unavailable',{status:503}),spawn:()=>{throw new Error('must not sign');}})).rejects.toThrow(/after 3 attempts/);
   // A new local build would disagree; recovery must overwrite it with registry bytes.
   fs.writeFileSync(path.join(f.directory,f.original.packages[2].filename),'rebuilt cockpit drift');
   const recovery=await prepareRecovery(f.options);
   expect(recovery).toMatchObject({recovered:true,artifacts:[44]});
   expect(validateInputs(f.directory,f.version)).toHaveLength(4);
   await publish({directory:f.directory,version:f.version,receipt:path.join(f.directory,'publication'),spawn:f.spawn,knownPublished:recovery.published});
   expect(f.calls.filter(a=>a[0]==='publish')).toHaveLength(4);
   const signed=[];
   await signBlob({...signer,file:path.join(f.directory,f.original.packages[0].filename),fetchImpl:async()=>Response.json({value:'synthetic-signing-identity'}),spawn:(_cmd,args)=>{signed.push(args);fs.writeFileSync(signer.bundle,'signed bundle');return {status:0};}});
   expect(signed).toHaveLength(1);expect(fs.readFileSync(signer.bundle,'utf8')).toBe('signed bundle');
 });
 it.each([{retained:false},{legacy:true}])('smokes registry bytes when original retention is incomplete %j',async options=>{
   const f=recoveryFixture(options);f.seed();expect((await prepareRecovery(f.options)).recovered).toBe(true);expect(f.smokeCalls).toBe(1);expect(f.calls.some(a=>a[0]==='publish'||a[0]==='pack')).toBe(false);
 });
 it('refuses even self-consistent registry bytes that disagree with retained smoke proof',async()=>{
   const f=recoveryFixture();f.seed();f.registry.set('@aiwg/cockpit',Buffer.from('different published cockpit'));await expect(prepareRecovery(f.options)).rejects.toThrow(/retained smoke-tested/);expect(f.smokeCalls).toBe(0);expect(f.calls.some(a=>a[0]==='publish')).toBe(false);
 });
 it('refuses a tarball that fails npm dist.integrity',async()=>{const f=recoveryFixture({corrupt:true});f.seed();await expect(prepareRecovery(f.options)).rejects.toThrow(/identity mismatch/);});
 it('refuses retained tarball corruption even when retained smoke hashes match npm',async()=>{const f=recoveryFixture({changed:true});f.seed();await expect(prepareRecovery(f.options)).rejects.toThrow(/retained smoke-tested/);});
 it('reuses retained bytes for the unpublished portion of a partial publication',async()=>{const f=recoveryFixture({partial:true});f.seed();await prepareRecovery(f.options);await publish({directory:f.directory,version:f.version,receipt:path.join(f.directory,'publication'),spawn:f.spawn});expect(f.calls.filter(a=>a[0]==='publish')).toHaveLength(3);});
 it('fails closed on missing partial-publication retention',async()=>{const f=recoveryFixture({partial:true,retained:false});f.seed();await expect(prepareRecovery(f.options)).rejects.toThrow(/lacks retained smoke-tested bytes/);});
 it('uses the original artifact and ignores later attempts containing rebuilt bytes',async()=>{
   const f=recoveryFixture();f.seed();f.options.attempt=3;
   f.client.listRunArtifacts=async()=>({items:[{...f.artifact,id:45,name:`stable-packages-${f.run.id}-2`},f.artifact],complete:true});
   expect(await prepareRecovery(f.options)).toMatchObject({recovered:true,artifacts:[44]});
 });
 it('treats expired original retention as unavailable and smokes the registry bytes',async()=>{
   const f=recoveryFixture();f.seed();f.artifact.expired=true;expect((await prepareRecovery(f.options)).recovered).toBe(true);expect(f.smokeCalls).toBe(1);
 });
 it('can authenticate retention from an earlier recovery when original evidence has expired',async()=>{
   const f=recoveryFixture();f.seed();f.required.splice(f.required.indexOf('Pack and smoke-test exact npm surfaces'),1,'Recover published registry tarballs');
   expect((await prepareRecovery(f.options)).recovered).toBe(true);
 });
 it.each(['aiwg','@aiwg/cli','@aiwg/cockpit','@aiwg/flue'])('rejects an uploaded archive missing %s even with a complete smoke manifest',async omit=>{
   const f=recoveryFixture({omit});await expect(verifyRetention({...f.options,directory:f.original.dir,attempt:1})).rejects.toThrow();
 });
 it('takes the normal pack lane only when all registry versions are absent',async()=>{const f=recoveryFixture();expect(await prepareRecovery(f.options)).toEqual({recovered:false});});
 it('rejects authentication/network errors rather than treating them as absent packages',async()=>{const f=recoveryFixture();await expect(prepareRecovery({...f.options,spawn:()=>({status:1,stderr:'E401 denied'})})).rejects.toThrow(/Registry lookup failed/);});
 it.each(['null','[]','not-json'])('rejects malformed successful registry metadata %s',async stdout=>{const f=recoveryFixture();await expect(prepareRecovery({...f.options,spawn:()=>({status:0,stdout})})).rejects.toThrow(/Malformed registry metadata/);});
 it('never republishes a known-published package if a later registry lookup returns E404',async()=>{
   const f=recoveryFixture();f.seed();const recovery=await prepareRecovery(f.options);f.registry.clear();
   await expect(publish({directory:f.directory,version:f.version,receipt:path.join(f.directory,'publication'),spawn:f.spawn,knownPublished:recovery.published})).rejects.toThrow(/Previously published/);
   expect(f.calls.some(a=>a[0]==='publish')).toBe(false);
 });
 it('rejects unsigned retained evidence',async()=>{const f=recoveryFixture();f.seed();f.required.splice(1,1);await expect(prepareRecovery(f.options)).rejects.toThrow(/smoke-test steps/);});
 it('rejects artifacts from a different source identity',async()=>{const f=recoveryFixture();f.seed();f.run.head_sha='b'.repeat(40);await expect(prepareRecovery(f.options)).rejects.toThrow(/workflow identity/);});
 it.each([false,true])('verifies all four tarballs in the uploaded ZIP (incomplete=%s)',async legacy=>{
   const f=recoveryFixture({legacy});
   const options={...f.options,directory:f.original.dir,attempt:1};
   if(legacy)await expect(verifyRetention(options)).rejects.toThrow();else await expect(verifyRetention(options)).resolves.toBeUndefined();
 });
});
