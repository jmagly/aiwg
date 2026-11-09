/** Portable corpus identity; stat receipts are isolated by the #3310 root key. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BUILTIN_GRAPH_CONFIGS, INDEX_EXTRACTOR_VERSION, getGraphIndexDir } from './types.js';

export const FRAMEWORK_RELATIONS_REVISION = 5;
const REVISION = FRAMEWORK_RELATIONS_REVISION;
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
interface SourceReceipt {
  version: number;
  files: Record<string, { stat: string; checksum: string }>;
}

/** No absolute paths, git revision or mtimes enter the portable digest. */
export function frameworkSourceDigest(root: string, cache = true): string {
  const receiptPath = path.join(getGraphIndexDir(root, 'framework'), 'relationship-sources.json');
  let previous: SourceReceipt | undefined;
  if (cache) {
    try {
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as SourceReceipt;
      if (receipt.version === REVISION && receipt.files && typeof receipt.files === 'object') previous = receipt;
    } catch { /* cold/corrupt root receipt */ }
  }
  const files: SourceReceipt['files'] = {};
  const config = BUILTIN_GRAPH_CONFIGS.framework;
  const walk = (dir: string, extensions: readonly string[] = config.extensions): void => {
    let children: fs.Dirent[];
    try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      if (child.name.startsWith('.') || child.isSymbolicLink()) continue;
      const file = path.join(dir, child.name);
      if (child.isDirectory()) walk(file, extensions);
      else if (child.isFile() && extensions.some(ext => child.name.endsWith(ext))
        // These development-only corpus files are excluded by package.files.
        && !/^(package(?:-lock)?|tsconfig)\.json$/.test(child.name)) add(file);
    }
  };
  const add = (file: string, logicalPath?: string): void => {
    const relative = logicalPath ?? path.relative(root, file).split(path.sep).join('/');
    const stat = fs.statSync(file);
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const old = previous?.version === REVISION ? previous.files[relative] : undefined;
    files[relative] = { stat: signature, checksum: old?.stat === signature && /^[a-f0-9]{64}$/.test(old.checksum) ? old.checksum : sha256(fs.readFileSync(file)) };
  };
  for (const dir of config.scanDirs) walk(path.join(root, dir));
  // Provider configuration and projection logic are inputs to the resolved table.
  walk(path.join(root, 'schemas/providers'));
  walk(path.join(root, 'tools/agents/providers'), ['.mjs']);
  // The source .mjs is copied verbatim into dist/; use one logical input key
  // so a packed install and its checkout have exactly the same digest.
  const activationKey = 'src/rules/activation.mjs';
  const activation = [path.join(root, activationKey), path.join(root, 'dist', activationKey)]
    .find(file => fs.existsSync(file));
  if (activation) add(activation, activationKey);
  const sources = Object.keys(files).sort().map(file => [file, files[file].checksum]);
  const digest = `sha256:${sha256(JSON.stringify({ revision: REVISION, extractor: INDEX_EXTRACTOR_VERSION, config, sources }))}`;
  if (cache) {
    const text = JSON.stringify({ version: REVISION, files });
    if (text !== JSON.stringify(previous)) {
      fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
      const temp = `${receiptPath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, text);
      fs.renameSync(temp, receiptPath);
    }
  }
  return digest;
}
