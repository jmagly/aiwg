// Deploy the shared prompt discovery hook for Muse's additionalContext contract.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importImpl } from '../../_resolve-impl.mjs';

export const { promptDiscoveryHook } = await importImpl(import.meta.url, 'extensions/muse-managed-hooks.js');

export function deployPromptDiscovery(targetDir) {
  const directory = path.join(targetDir, '.muse', 'hooks');
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error('Refusing to deploy prompt discovery through a symlinked .muse/hooks directory.');
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('../../../agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs', import.meta.url)),
    path.join(directory, 'aiwg-prompt-discovery.cjs'));
}
