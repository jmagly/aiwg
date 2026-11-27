// Install package-owned prompt discovery for full Antigravity project deployments.
import { fileURLToPath } from 'node:url';
import { importImpl } from '../../_resolve-impl.mjs';

export async function deployAntigravityPromptDiscovery(targetDir, opts) {
  const fullDeploy = !opts.commandsOnly && !opts.rulesOnly && (!opts.skillsOnly || opts.kernelOnly === true);
  if (!fullDeploy || opts.hooks === false || opts.scope === 'user') return;
  const { installAntigravityPromptDiscovery } = await importImpl(import.meta.url, 'smiths/hook-bridge/antigravity-translator.js');
  const result = await installAntigravityPromptDiscovery({ projectPath: targetDir,
    commandRoot: opts.logicalOutputPath?.(targetDir), frameworkRoot: fileURLToPath(new URL('../../../', import.meta.url)),
    dryRun: opts.dryRun });
  for (const warning of result.warnings) console.warn(warning);
}
