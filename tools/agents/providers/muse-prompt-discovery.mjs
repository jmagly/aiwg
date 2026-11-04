// Deploy the shared prompt discovery hook for Muse's additionalContext contract.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const promptDiscoveryHook = {
  id: 'aiwg-prompt-discovery',
  event: 'UserPromptSubmit',
  group: { matcher: '*', hooks: [{ type: 'command', command: 'node .muse/hooks/aiwg-prompt-discovery.cjs', timeout: 2 }] },
  reason: 'Discover the top three AIWG capabilities and inject next steps on each substantive prompt; bounded and fail open.',
  removal: 'Set AIWG_PROMPT_DISCOVERY=0, or remove this group from .muse/hooks.json.',
};

export function deployPromptDiscovery(targetDir) {
  const directory = path.join(targetDir, '.muse', 'hooks');
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error('Refusing to deploy prompt discovery through a symlinked .muse/hooks directory.');
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('../../../agentic/code/addons/aiwg-hooks/hooks/aiwg-prompt-discovery.cjs', import.meta.url)),
    path.join(directory, 'aiwg-prompt-discovery.cjs'));
}
