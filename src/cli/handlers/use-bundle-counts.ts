// Count bundle artifacts from native files and activation-selected rule receipts.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { receiptIncludesOwner } from './use-owned-counts.js';
import { parseRuleFrontmatter } from '../../rules/activation.mjs';

export async function countDeployedBundleRules(bundlePath: string, target: string, deployPath: string, provider?: string): Promise<number> {
  if (!deployPath && !provider) return 0;
  // The shared rule projector uses this conventional directory even when a
  // provider has no native rule loader (for example Pi).
  const destination = path.resolve(target, deployPath || `.${provider}/rules`);
  let selected: string[] = [];
  let managed: Record<string, { hash?: string }> = {};
  try {
    const receipt = JSON.parse(await fs.readFile(path.join(destination, '.aiwg-manifest.json'), 'utf8'));
    selected = Array.isArray(receipt.ruleSources) ? receipt.ruleSources : [];
    managed = receipt.managed ?? {};
  } catch { /* Legacy deployments have only native files. */ }
  const indexed = new Set<string>();
  for (const extension of ['.md', '.mdc']) {
    const name = `RULES-INDEX${extension}`;
    try {
      const content = await fs.readFile(path.join(destination, name), 'utf8');
      const hash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
      if (managed[name]?.hash !== hash) continue;
      // Rule names may contain spaces (for example "Diversity Awareness").
      for (const match of content.matchAll(/`aiwg show rule ([^`]+?) --body`/g)) indexed.add(match[1]);
    } catch { /* An index receipt alone does not deliver a rule. */ }
  }
  let sources: string[];
  try { sources = (await fs.readdir(path.join(bundlePath, 'rules'))).filter(name => name.endsWith('.md')); }
  catch { return 0; }
  let count = 0;
  for (const name of sources) {
    const source = path.resolve(bundlePath, 'rules', name);
    if (selected.includes(source)) {
      const { data } = parseRuleFrontmatter(await fs.readFile(source, 'utf8'));
      const metadata = data as { name?: string; activation?: string };
      // Other activations can be delivered inside context or bound artifacts.
      if (metadata.activation !== 'summary' || indexed.has(metadata.name || path.basename(name, '.md'))) { count++; continue; }
    }
    for (const extension of ['.md', '.mdc']) {
      try { await fs.access(path.join(destination, path.basename(name, '.md') + extension)); count++; break; }
      catch { /* A catalog-only, unselected rule is not deployed. */ }
    }
  }
  return count;
}

export async function countDeployedBundleFiles(
  bundlePath: string, subdir: string, target: string, deployPath: string, extensions: string[],
): Promise<number> {
  if (!deployPath) return 0;
  let names: string[];
  try { names = (await fs.readdir(path.join(bundlePath, subdir))).filter(name => name.endsWith('.md')); }
  catch { return 0; }
  let count = 0;
  for (const name of names) {
    for (const extension of extensions) {
      try {
        const file = path.join(path.resolve(target, deployPath), path.basename(name, '.md') + extension);
        await fs.access(file);
        if (!await receiptIncludesOwner(file, new Set([path.basename(bundlePath)]))) continue;
        count++;
        break;
      } catch { /* Only count artifacts actually written by this bundle. */ }
    }
  }
  return count;
}
