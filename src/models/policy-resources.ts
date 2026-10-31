// Loads bundled policy resources and defines supported provider IDs.
import { createRequire } from 'node:module';
import { z } from 'zod';
const require = createRequire(import.meta.url);
export function requireModelResource(filename: string): unknown {
  const candidates = [
    `./${filename}`,
    `../../agentic/code/providers/${filename}`,
    `../../../agentic/code/providers/${filename}`,
    `../../schemas/models/${filename}`,
    `../../../schemas/models/${filename}`,
  ];
  for (const candidate of candidates) {
    try { return require(candidate); } catch (error: any) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error(`Model policy resource is missing: ${filename}`);
}
export const ProviderSchema = z.enum([
  'antigravity', 'claude', 'codex', 'copilot', 'cursor', 'deepseek-harness', 'factory', 'flue', 'grokbot', 'grok-build', 'hermes',
  'muse', 'opencode', 'openclaw', 'openhuman', 'omp', 'pi', 'warp', 'windsurf',
]);
