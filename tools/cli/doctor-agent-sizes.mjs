// Compare oversized Codex definitions with fresh, fully bound package output.
import fs from 'node:fs/promises';
import path from 'node:path';
import { importImpl } from '../_resolve-impl.mjs';
const { normalizeAgentArtifactName } = await importImpl(import.meta.url, 'agents/packaged-agent-inventory.js');

export function createAgentSourceSizeCheck(root, target, provider, inventory) {
  let renderer;
  return async (filename, content) => {
    if (provider !== 'codex' || !filename.endsWith('.toml')) return [];
    const candidates = inventory.get(normalizeAgentArtifactName(filename)) || [];
    if (!candidates.length) return [];
    renderer ??= (async () => {
      let ruleSources;
      try {
        const receipt = JSON.parse(await fs.readFile(path.join(target, '.codex/rules/.aiwg-manifest.json'), 'utf8'));
        ruleSources = receipt.ruleSources;
      } catch { /* Older deployments have no selected-rule receipt. */ }
      const { createPackagedCodexRenderer } = await import('../agents/providers/packaged-codex-agents.mjs');
      return createPackagedCodexRenderer(root, { target, ruleSources });
    })();
    try {
      const render = await renderer;
      return candidates.filter(source => {
        try { return render(path.resolve(root, source.path)) === content; }
        catch { return false; }
      }).map(source => source.path);
    } catch {
      // Retain existing attribution if a fresh package render is unavailable.
      return [];
    }
  };
}
