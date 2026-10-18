#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const args=process.argv.slice(2), option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const manifest=JSON.parse(await readFile(join(root,'test/fixtures/providers/omp-conformance/manifest.json'),'utf8'));
const result={schemaVersion:1,recordedAt:new Date().toISOString(),status:'unverified',source:manifest.source,node:process.version,checks:{}};
let temporary;
try {
  const source=option('--source');
  if(!source||!existsSync(join(source,'node_modules/.bin/tsc'))){result.status='skipped';result.reason='PINNED_SOURCE_DEPENDENCIES_UNAVAILABLE';if(args.includes('--require'))throw Error(result.reason);}
  else {
    const checkout=resolve(source);
    const git=spawnSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8',timeout:10000, killSignal: 'SIGKILL' });
    if(git.status!==0||git.stdout.trim()!==manifest.source.commit)throw Error('OMP_SOURCE_REVISION_MISMATCH');
    result.checks.sourceRevision=true;
    const pristine=spawnSync('git',['-C',checkout,'diff','--quiet','HEAD'],{timeout:10000, killSignal: 'SIGKILL' });
    if(pristine.status!==0)throw Error('OMP_SOURCE_TRACKED_FILES_MODIFIED');
    result.checks.trackedSourcePristine=true;
    temporary=await mkdtemp(join(checkout,'.aiwg-api-conformance-'));
    const bridge=join(root,'agentic/code/providers/omp/aiwg-bridge.ts');
    result.bridgeSha256=createHash('sha256').update(await readFile(bridge)).digest('hex');
    await copyFile(bridge,join(temporary,'aiwg-bridge.ts'));
    await writeFile(join(temporary,'tsconfig.json'),JSON.stringify({extends:'../tsconfig.base.json',files:['aiwg-bridge.ts']}));
    const check=spawnSync(join(checkout,'node_modules/.bin/tsc'),['--project',join(temporary,'tsconfig.json'),'--pretty','false'],{cwd:checkout,encoding:'utf8',timeout:120000,maxBuffer:1024*1024, killSignal: 'SIGKILL' });
    result.compiler=JSON.parse(await readFile(join(checkout,'node_modules/typescript/package.json'),'utf8')).version;
    result.checks.nativeExtensionTypes=check.status===0;
    result.diagnostics=(check.stdout+check.stderr).replaceAll(checkout,'<pinned-source>').slice(0,20000);
    if(check.status!==0)throw Error('OMP_NATIVE_API_TYPECHECK_FAILED');
    result.status='passed';
  }
}catch(error){result.status='failed';result.reason=error.message;process.exitCode=1;}
finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
const output=JSON.stringify(result,null,2)+'\n';
if(option('--output')){const path=resolve(option('--output'));await mkdir(dirname(path),{recursive:true});await writeFile(path,output);}
process.stdout.write(output);
