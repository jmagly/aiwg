// Install package-owned prompt discovery for full Cursor project deployments.
import { fileURLToPath } from 'node:url';
import { importImpl } from '../../_resolve-impl.mjs';

export async function deployCursorPromptDiscovery(targetDir, opts) {
  const fullDeploy = !opts.commandsOnly && !opts.rulesOnly && (!opts.skillsOnly || opts.kernelOnly === true);
  if (!fullDeploy || opts.hooks === false || opts.scope === 'user') return;
  const { installCursorPromptDiscovery } = await importImpl(import.meta.url, 'smiths/hook-bridge/cursor-translator.js');
  const result = await installCursorPromptDiscovery({ projectPath: targetDir,
    commandRoot: opts.logicalOutputPath?.(targetDir), frameworkRoot: fileURLToPath(new URL('../../../', import.meta.url)),
    dryRun: opts.dryRun });
  for (const warning of result.warnings) console.warn(warning);
}
