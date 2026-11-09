// Finalize user hook registrations after promotion, using the real provider home.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importImpl } from '../../_resolve-impl.mjs';
import { deployMuseHooks } from './muse-hooks.mjs';

export async function installUserHooks(provider, cfg) {
  const frameworkRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const enabled = cfg.hooks !== false && !cfg.commandsOnly && !cfg.rulesOnly && (!cfg.skillsOnly || cfg.kernelOnly === true);
  const home = os.homedir();
  if (provider === 'claude' && (enabled || cfg.attribution !== false)) {
    const { installAiwgHooks } = await importImpl(import.meta.url, 'extensions/claude-hooks-installer.js');
    const result = await installAiwgHooks({ projectPath: home, frameworkRoot, scope: 'user', hooks: enabled,
      attribution: cfg.attribution !== false });
    // Same surface as project post-deploy: operator-facing settings warnings are never swallowed.
    for (const warning of result?.warnings || []) console.warn(`Claude settings: ${warning}`);
    return result;
  }
  if (provider === 'codex' && enabled) {
    const { installCodexPromptDiscovery } = await importImpl(import.meta.url, 'smiths/hook-bridge/codex-translator.js');
    return installCodexPromptDiscovery({ projectPath: home, frameworkRoot, scope: 'user',
      hookDirectory: process.env.CODEX_HOME || path.join(home, '.codex') });
  }
  if (provider === 'muse' && enabled) return deployMuseHooks(home, { quiet: cfg.quiet, scope: 'user' });
}
