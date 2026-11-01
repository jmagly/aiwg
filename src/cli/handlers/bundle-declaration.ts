// Edit bundle intent without touching provider payloads.
import fs from 'node:fs';
import path from 'node:path';
import { emptyConfig, getProjectDir, readAiwgConfig, writeAiwgConfig, ensureProviderListed } from '../../config/aiwg-config.js';
import { getFrameworkRoot } from '../../channel/manager.mjs';
import { REGISTRY_ID_TO_USE_NAME } from '../../config/framework-aliases.js';
import { getProviderArtifactPathStrings } from '../../providers/provider-definitions.js';
import { firstRemovePositional, parseRemoveProvider } from './remove-options.js';
import type { HandlerContext, HandlerResult } from './types.js';
import { validateInstalled } from '../../config/installed-validation.js';

export async function declareBundle(ctx: HandlerContext, remove = false): Promise<HandlerResult> {
  try {
    const id = firstRemovePositional(ctx.args);
    const { provider, error } = parseRemoveProvider(ctx.args);
    if (!id || !provider || error) return { exitCode: 2, message: error || '--declare requires a bundle and explicit --provider.' };
    if (ctx.args.includes('--user') || ctx.args.includes('--global') || ctx.args[ctx.args.indexOf('--scope') + 1] === 'user') {
      return { exitCode: 2, message: '--declare supports project scope only.' };
    }
    if (!getProviderArtifactPathStrings(provider)) return { exitCode: 2, message: `Unknown provider '${provider}'.` };
    const project = getProjectDir(ctx, ctx.args);
    const config = await readAiwgConfig(project) ?? emptyConfig([provider]);
    const name = REGISTRY_ID_TO_USE_NAME[id] ?? id;
    if (!remove && name !== 'all') {
      const root = ctx.frameworkRoot || await getFrameworkRoot();
      const exists = ['frameworks', 'addons', 'extensions'].some(group =>
        fs.existsSync(path.join(root, 'agentic/code', group, id, 'manifest.json')) ||
        Object.entries(REGISTRY_ID_TO_USE_NAME).some(([dir, alias]) => alias === name && fs.existsSync(path.join(root, 'agentic/code', group, dir, 'manifest.json'))) ||
        fs.existsSync(path.join(project, '.aiwg', group, id, 'manifest.json')));
      if (!exists) return { exitCode: 2, message: `Unknown bundle '${id}'.` };
    }
    const key = Object.keys(config.installed).find(key => (REGISTRY_ID_TO_USE_NAME[key] ?? key) === name) ?? name;
    if (remove) {
      delete config.installed[key]?.deployedTo[provider];
      if (config.installed[key] && !Object.keys(config.installed[key].deployedTo).length) delete config.installed[key];
    } else {
      config.installed[key] ??= { deployedTo: {} };
      config.installed[key].deployedTo[provider] = ctx.args.includes('--copy-all') || ctx.args.includes('--copy-standard-skills') ? { copy: true } : {};
      if (provider === 'flue' && ctx.args.includes('--package')) config.installed[key].deployedTo[provider].package = true;
      validateInstalled({ [key]: { deployedTo: { [provider]: config.installed[key].deployedTo[provider] } } });
      ensureProviderListed(config, provider);
    }
    const dryRun = ctx.args.includes('--dry-run');
    if (!dryRun) await writeAiwgConfig(project, config);
    return { exitCode: 0, message: `${dryRun ? 'Would ' : ''}${remove ? 'Undeclared' : 'Declared'} ${name} for ${provider}.` };
  } catch (error) { return { exitCode: 1, message: String(error) }; }
}
