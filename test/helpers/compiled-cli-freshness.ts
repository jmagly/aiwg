// Reject missing or stale compiled CLI modules and copied runtime resources.
import fs from 'node:fs';
import path from 'node:path';

export function assertFreshCliBuild(root: string): void {
  const stale: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const source = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(source); continue; }
      const relative = path.relative(root, source);
      // build:cli emits TypeScript and copies these resources; it has no stamp.
      const typescript = /\.tsx?$/.test(source) && !/\.(?:d|test|spec)\.ts$/.test(source);
      if (!typescript && !/\.(?:mjs|json|ya?ml)$/.test(source)) continue;
      const output = path.join(root, 'dist', typescript ? relative.replace(/\.tsx?$/, '.js') : relative);
      const built = fs.statSync(output, { throwIfNoEntry: false });
      if (!built?.isFile() || fs.statSync(source).mtimeMs > built.mtimeMs) stale.push(relative);
    }
  };
  visit(path.join(root, 'src'));
  if (stale.length) throw new Error(`Compiled CLI is missing or stale; run npm run build:cli before these tests.\n${stale.slice(0, 10).join('\n')}`);
}
