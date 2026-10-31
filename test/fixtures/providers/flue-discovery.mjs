// Offline Flue 2.3.0 discovery contract: @flue/runtime/dist/config.mjs:162-195.
import fs from 'node:fs';
import path from 'node:path';

export function resolveSourceRoot(root) {
  for (const dir of ['.flue', 'src']) {
    const candidate = path.join(root, dir);
    try { if (fs.statSync(candidate).isDirectory()) return candidate; } catch {}
  }
  return root;
}

export function discoverProjectEntry(sourceRoot, basename) {
  for (const ext of ['ts', 'mts', 'js', 'mjs']) {
    const candidate = path.join(sourceRoot, `${basename}.${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
}
