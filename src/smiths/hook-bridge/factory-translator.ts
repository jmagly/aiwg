// Register Factory hooks and deploy the shared discovery script with ownership receipts.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HookSource, TranslateOptions, TranslateResult } from './types.js';
import { generateShimBash } from './shim.js';
import { loadHookSources } from './loader.js';
import { captureDeploymentOutputs, recordDeploymentOutputs } from '../../providers/deployment-ownership.mjs';
import { managedHookScriptState } from '../../extensions/managed-hook-script-state.js';
import { factoryHookDocuments, removeFactoryManaged, saveFactoryHooks } from './factory-hook-config.js';

// Droid accepts plain stdout context. Decode either shared-script JSON shape
// without changing the shared script's fail-open, read-only, bounded contract.
const launcher = [
  'const write=process.stdout.write.bind(process.stdout);',
  'process.stdout.write=(s,...a)=>{try{const o=JSON.parse(String(s));',
  's=o.hookSpecificOutput?.additionalContext??o.additionalContext??"";}catch{}return write(s,...a);};',
  'const fs=require("node:fs"),p=require("node:path");',
  'for(let d=process.env.FACTORY_PROJECT_DIR||process.cwd();;d=p.dirname(d)){',
  'const s=p.join(d,".factory/hooks/aiwg-prompt-discovery.cjs");',
  'if(fs.existsSync(s)){require(s);break;}if(p.dirname(d)===d)break;}',
].join('');
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

export function managedFactoryHooks() {
  return [
    { event: 'SessionStart', id: 'aiwg-session', command: 'aiwg refresh --dry-run --quiet' },
    { event: 'UserPromptSubmit', id: 'aiwg-prompt-discovery', command: `node -e ${quote(launcher)}` },
  ];
}

export async function translateForFactory(source: HookSource, options: TranslateOptions): Promise<TranslateResult> {
  const result: TranslateResult = { provider: 'factory', emittedPaths: [], warnings: [], skipped: false };
  if (source.degradeOn?.includes('factory')) return { ...result, skipped: true, skipReason: 'degrade-on declared factory' };
  const directory = path.join(options.projectPath, '.factory');
  const prompt = source.id === 'aiwg-prompt-discovery';
  const script = path.join(directory, 'hooks', `${source.id}.${prompt ? 'cjs' : 'sh'}`);
  const config = path.join(directory, 'hooks.json');
  if (options.dryRun) return { ...result, emittedPaths: [script, config].map(file => file + ' (dry-run)') };
  for (const file of [directory, config, path.dirname(script), script,
    path.join(directory, 'settings.json'), path.join(directory, 'hooks/hooks.json')]) {
    try {
      if ((await fs.lstat(file)).isSymbolicLink()) throw new Error(`Refusing symlinked Factory hook target: ${file}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const state = factoryHookDocuments(directory);
  const roots = [directory];
  const before = captureDeploymentOutputs(roots);
  const bytes = prompt
    ? await fs.readFile(source.args?.[0] ?? (() => { throw new Error('Missing shared prompt discovery script'); })())
    : Buffer.from(generateShimBash('factory', source.command, source.args ?? []));
  const status = await managedHookScriptState(options.projectPath, path.relative(options.projectPath, script), bytes);
  if (status === 'operator-edited' || status === 'unreadable') {
    result.warnings.push(`${script}: kept (${status})`);
  } else {
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.writeFile(script, bytes, { mode: 0o755 });
    result.emittedPaths.push(script);
  }
  removeFactoryManaged(state.doc, source.id);
  const hooks = state.doc.hooks ??= {};
  for (const event of source.events) {
    (hooks[event] ??= []).push({ hooks: [{ type: 'command',
      command: prompt ? managedFactoryHooks()[1].command : `bash ${quote(script)}`,
      ...(source.timeout === undefined ? {} : { timeout: source.timeout }),
      _aiwg_managed: true, _aiwg_id: source.id }] });
  }
  saveFactoryHooks(state);
  result.emittedPaths.push(config);
  recordDeploymentOutputs(before, roots, { frameworkSlug: 'aiwg-hooks', claimUnchangedSettings: false, writtenFiles: result.emittedPaths });
  return result;
}

export async function installFactoryPromptDiscovery(options: TranslateOptions & { frameworkRoot: string }): Promise<TranslateResult> {
  const { sources, errors } = await loadHookSources(options.frameworkRoot);
  if (errors.length) throw new Error(errors.join('\n'));
  const source = sources.find(entry => entry.id === 'aiwg-prompt-discovery');
  if (!source) throw new Error('Missing canonical aiwg-prompt-discovery source');
  const result = await translateForFactory(source, options);
  if (!options.dryRun && !result.skipped) {
    const directory = path.join(options.projectPath, '.factory');
    const before = captureDeploymentOutputs([directory]);
    const state = factoryHookDocuments(directory);
    removeFactoryManaged(state.doc, 'aiwg-session');
    const hook = managedFactoryHooks()[0];
    ((state.doc.hooks ??= {})[hook.event] ??= []).push({ matcher: '*', hooks: [{
      type: 'command', command: hook.command, _aiwg_managed: true, _aiwg_id: hook.id,
    }] });
    saveFactoryHooks(state);
    recordDeploymentOutputs(before, [directory], { frameworkSlug: 'aiwg-hooks', claimUnchangedSettings: false, writtenFiles: [state.file] });
  }
  return result;
}
