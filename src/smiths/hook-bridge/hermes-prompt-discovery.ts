// Deploy prompt discovery through Hermes's documented pre_llm_call shell hook.
import fs from 'node:fs/promises';
import path from 'node:path';
import { isMap, isSeq, parseDocument } from 'yaml';
import { resolveHermesHomePath } from '../../providers/hermes-home.js';
import { captureDeploymentOutputs, recordDeploymentOutputs } from '../../providers/deployment-ownership.mjs';
import { managedHookScriptState } from '../../extensions/managed-hook-script-state.js';
import { verifiedHookCommand } from '../../extensions/verified-hook-command.js';
import { hermesHookAcceptanceNextStep, readHermesHookAcceptance } from './hermes-trust.js';
import type { HookSource, TranslateOptions, TranslateResult } from './types.js';

export async function translateHermesPromptDiscovery(source: HookSource, options: TranslateOptions): Promise<TranslateResult> {
  const home = resolveHermesHomePath();
  const directory = path.join(home, 'agent-hooks');
  const script = path.join(directory, 'aiwg-prompt-discovery.cjs');
  const config = path.join(home, 'config.yaml');
  const result: TranslateResult = { provider: 'hermes', skipped: false, warnings: [], emittedPaths: [] };
  if (options.dryRun) return { ...result, emittedPaths: [script, config].map(file => `${file} (dry-run)`) };
  for (const file of [home, directory, script, config]) {
    try {
      if ((await fs.lstat(file)).isSymbolicLink()) throw new Error(`Refusing symlinked Hermes hook target: ${file}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const original = await fs.readFile(config, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  const doc = parseDocument(original || '{}');
  if (doc.errors.length || !isMap(doc.contents)) throw new Error(`Invalid Hermes config: ${config}`);
  if (!doc.has('hooks')) doc.set('hooks', doc.createNode({}));
  const hooks = doc.get('hooks', true);
  if (!isMap(hooks)) throw new Error('Invalid Hermes hooks mapping');
  if (!hooks.has('pre_llm_call')) hooks.set('pre_llm_call', doc.createNode([]));
  const entries = hooks.get('pre_llm_call', true);
  if (!isSeq(entries) || entries.items.some(entry => !isMap(entry) || typeof entry.get('command') !== 'string')) {
    throw new Error('Invalid Hermes pre_llm_call hooks');
  }
  const sourceScript = source.args?.[0];
  if (!sourceScript) throw new Error('Missing shared prompt discovery script');
  const bytes = await fs.readFile(sourceScript);
  const registration = { command: verifiedHookCommand(home, 'agent-hooks/aiwg-prompt-discovery.cjs', bytes, [], 'user'), timeout: source.timeout ?? 2,
    _aiwg_managed: true, _aiwg_id: source.id };
  const managed = entries.items.filter(entry => isMap(entry) && entry.get('_aiwg_managed') === true && entry.get('_aiwg_id') === source.id);
  const current = managed[0];
  // Leave matching nodes intact to preserve comments and byte-stable redeployment.
  if (managed.length !== 1 || !isMap(current) || JSON.stringify(current.toJSON()) !== JSON.stringify(registration)) {
    entries.items = entries.items.filter(entry => !managed.includes(entry));
    entries.add(doc.createNode(registration));
  }
  const roots = [config, directory, path.join(home, '.aiwg-manifest.json')];
  const before = captureDeploymentOutputs(roots);
  const state = await managedHookScriptState(home, path.relative(home, script), bytes);
  if (state === 'operator-edited' || state === 'unreadable') result.warnings.push(`${script}: kept (${state})`);
  else {
    await fs.mkdir(directory, { recursive: true });
    if (state) await fs.writeFile(script, bytes, { mode: 0o755 });
    result.emittedPaths.push(script);
  }
  const text = doc.toString();
  if (text !== original) await fs.writeFile(config, text);
  result.emittedPaths.push(config);
  recordDeploymentOutputs(before, roots, { frameworkSlug: 'aiwg-hooks', claimUnchangedSettings: false, writtenFiles: result.emittedPaths });
  const nextStep = hermesHookAcceptanceNextStep(await readHermesHookAcceptance());
  if (nextStep) result.warnings.push(nextStep);
  return result;
}

