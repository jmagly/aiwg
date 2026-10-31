// Resolve Flue bundle manifests and the invocation-wide app selection.
import fs from 'node:fs';
import path from 'node:path';
import { resolveAiwgRoot } from './base-inventory.mjs';
import { getFrameworksForMode } from './base-framework-discovery.mjs';
import { importImpl } from '../../_resolve-impl.mjs';
const { frameworkRegistryId } = await importImpl(import.meta.url, 'config/framework-aliases.js');

export const camel = value => value.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase()).replace(/^[0-9]/, digit => `_${digit}`);
export function flueBundleInventory(opts) {
  const root = resolveAiwgRoot(opts.srcRoot);
  const bundles = [];
  const add = dir => {
    const file = path.join(dir, 'manifest.json');
    if (!fs.existsSync(file)) return;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const id = path.basename(dir);
    bundles.push({ id, root: dir, manifest });
  };
  if (root) for (const group of ['frameworks', 'addons', 'extensions']) {
    const dir = path.join(root, 'agentic/code', group);
    if (fs.existsSync(dir)) for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) add(path.join(dir, entry.name));
  }
  for (const entry of Object.values(opts.config?.installed || {})) {
    if (!entry.deployedTo?.flue || !entry.localPath || !opts.target) continue;
    const logical = path.resolve(opts.logicalOutputPath?.(opts.target) || opts.target, entry.localPath);
    const dir = opts.mapInputPath?.(logical) || logical;
    if (!bundles.some(bundle => bundle.root === dir)) add(dir);
  }
  if (!bundles.some(bundle => path.resolve(bundle.root) === path.resolve(opts.srcRoot))) add(opts.srcRoot);
  return bundles;
}
export function selectedFlueBundles(opts) {
  const inventory = flueBundleInventory(opts);
  const names = Object.entries(opts.config?.installed || {}).filter(([, entry]) => entry.deployedTo?.flue).map(([id]) => frameworkRegistryId(id));
  const invoked = inventory.find(bundle => path.resolve(bundle.root) === path.resolve(opts.srcRoot));
  if (invoked) names.push(invoked.id);
  else names.push(...getFrameworksForMode(opts.srcRoot, opts.mode || 'sdlc').map(bundle => bundle.id));
  // `all` preserves the existing kernel skill surface, including addon kernels.
  if ((opts.mode === 'all' && !invoked) || names.includes('all')) names.push(...inventory.map(bundle => bundle.id));
  return inventory.filter(bundle => names.includes(bundle.id)).sort((a, b) => a.id.localeCompare(b.id));
}
