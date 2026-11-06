// Install Factory user preflight and project discovery through the existing hook bridge.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importImpl } from '../../_resolve-impl.mjs';

export async function deployFactoryHooks(dryRun, projectPath) {
  const config = await importImpl(import.meta.url, 'smiths/hook-bridge/factory-hook-config.js');
  const { managedFactoryHooks, installFactoryPromptDiscovery } = await importImpl(import.meta.url, 'smiths/hook-bridge/factory-translator.js');
  const { captureDeploymentOutputs, recordDeploymentOutputs } = await importImpl(import.meta.url, 'providers/deployment-ownership.mjs');
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    const directory = path.join(home, '.factory');
    for (const file of [directory, path.join(directory, 'hooks'), ...['hooks.json', 'settings.json', 'hooks/hooks.json'].map(name => path.join(directory, name))]) {
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`Refusing symlinked Factory hook target: ${file}`);
    }
    const state = config.factoryHookDocuments(directory);
    const roots = [state.file, state.settingsFile, state.legacyFile, path.join(directory, '.aiwg-manifest.json')];
    const before = dryRun ? undefined : captureDeploymentOutputs(roots);
    const removed = config.removeFactoryManaged(state.doc, 'aiwg-session');
    // A project deploy carries the preflight in the project hooks.json; user scope only
    // migrates AIWG's old copy away, so the session hook never runs twice.
    if (!projectPath) {
      const hook = managedFactoryHooks()[0];
      ((state.doc.hooks ??= {})[hook.event] ??= []).push({ matcher: '*', hooks: [{
        type: 'command', command: hook.command, _aiwg_managed: true, _aiwg_id: hook.id,
      }] });
    }
    // Only touch user files when there is something to migrate or install: creating
    // ~/.factory/hooks.json would shadow the user's settings.json hooks fallback.
    const changed = removed || state.migratedSettings || fs.existsSync(state.legacyFile) || !projectPath;
    if (dryRun) { if (changed) console.log(`[dry-run] Would update Factory user hooks in ${state.file}`); }
    else if (changed) {
      config.saveFactoryHooks(state);
      recordDeploymentOutputs(before, roots, { frameworkSlug: 'aiwg-hooks', claimUnchangedSettings: false, writtenFiles: [state.file] });
    }
  }
  if (projectPath) {
    const frameworkRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const result = await installFactoryPromptDiscovery({ projectPath, frameworkRoot, dryRun });
    for (const warning of result.warnings) console.warn(warning);
  }
}
