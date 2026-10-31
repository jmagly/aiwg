// Preserve copy-mode deletions and edited receipt-owned payloads across provider passes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { frameworkRegistryId } from '../config/framework-aliases.js';
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const parse = bytes => { try { return JSON.parse(bytes?.toString() || '{}'); } catch { return {}; } };
const sidecar = '.aiwg-manifest.json';
const context = new Set(['AGENTS.md', 'AIWG.md', 'WORKSPACE.md', 'CLAUDE.md', 'WARP.md', '.hermes.md', 'copilot-instructions.md']);
export function providerCopyMode(project, provider, owner, config, indexOwner) {
  const history = parse(fs.existsSync(path.join(project, '.aiwg', sidecar)) ? fs.readFileSync(path.join(project, '.aiwg', sidecar)) : null).bundleDeployments?.[provider] || {};
  if (!config) {
    try { config = JSON.parse(fs.readFileSync(path.join(project, '.aiwg/aiwg.config'), 'utf8')); } catch { config = {}; }
  }
  const modes = new Map(Object.entries(history).map(([id, mode]) => [frameworkRegistryId(id), mode.copy === true || mode.package === true]));
  for (const [id, entry] of Object.entries(config.installed || {})) {
    if (entry.deployedTo?.[provider]) modes.set(frameworkRegistryId(id), entry.deployedTo[provider].copy === true || entry.deployedTo[provider].package === true);
  }
  if (indexOwner) modes.set(frameworkRegistryId(indexOwner), false);
  const inherited = new Set();
  for (const [id, mode] of Object.entries(history)) if (modes.get(frameworkRegistryId(id))) {
    for (const produced of mode.produces || []) inherited.add(frameworkRegistryId(produced));
  }
  return owner ? modes.get(frameworkRegistryId(owner)) === true || inherited.has(frameworkRegistryId(owner)) || inherited.has('*')
    : [...modes.values()].some(Boolean) || inherited.size > 0;
}
export function automaticRemovalAllowed(project, provider, file, config) {
  const receipt = parse(fs.existsSync(path.join(path.dirname(file), sidecar)) ? fs.readFileSync(path.join(path.dirname(file), sidecar)) : null);
  const record = receipt.managed?.[path.basename(file)];
  const owners = record?.owners || (record?.frameworkSlug ? [record.frameworkSlug] : []);
  const copy = owners.length ? owners.some(owner => providerCopyMode(project, provider, owner, config)) : providerCopyMode(project, provider, undefined, config);
  const modified = !record?.hash || record.hash !== hash(fs.readFileSync(file));
  if (!copy && !modified) return true;
  console.warn(`${file}: kept (${copy ? 'copy mode' : record?.hash ? 'operator-edited' : 'unverifiable ownership'});${copy ? ' use aiwg remove <bundle> to delete' : ' managed hash differs'}`);
  return false;
}

/** Called against a staging snapshot before ownership is refreshed or output is promoted. */
export function preserveDeploymentOutputs(before, roots, opts = {}) {
  const writeReceipt = (file, bytes) => file === path.join(opts.target, '.aiwg', sidecar) && opts.writeReceipt
    ? opts.writeReceipt(file, bytes) : fs.writeFileSync(file, bytes);
  const claims = new Map();
  const receipts = new Map();
  for (const [file, bytes] of before) {
    if (path.basename(file) !== sidecar) continue;
    const receipt = parse(bytes);
    receipts.set(file, receipt);
    const base = receipt.scope === 'project' && file === path.join(opts.target, '.aiwg', sidecar) ? opts.target : path.dirname(file);
    for (const [name, record] of Object.entries(receipt.managed || {})) {
      const target = path.resolve(base, name);
      if (target.startsWith(`${base}${path.sep}`)) claims.set(target, { record, file, name });
    }
  }
  const restored = [];
  for (const [file, bytes] of before) {
    if (path.basename(file) === sidecar) continue;
    const exists = fs.existsSync(file);
    const claim = claims.get(file);
    const edited = claim?.record.hash && claim.record.hash !== hash(bytes) && !context.has(path.basename(file)) && claim.record.kind !== 'settings';
    const owners = claim?.record.owners || (claim?.record.frameworkSlug ? [claim.record.frameworkSlug] : []);
    const currentOwner = (opts.srcRoot || '').replaceAll('\\', '/').match(/(?:agentic\/code|\.aiwg)\/(?:frameworks|addons|extensions)\/([^/]+)/)?.[1] || frameworkRegistryId(opts.mode || '');
    const copy = (opts.copyMode ?? opts.copyStandardSkills) || owners.some(owner => providerCopyMode(opts.target, opts.provider, owner, opts.config, currentOwner));
    if (!(edited || !exists && copy) || exists && fs.readFileSync(file).equals(bytes)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    if (edited) console.warn(`${opts.logicalOutputPath?.(file) || file}: kept (operator-edited)`);
    restored.push(claim);
  }
  // Keep the old digest for protected payloads: a later run must still detect edits.
  for (const claim of restored.filter(Boolean)) {
    const { managed: _managed, ...metadata } = receipts.get(claim.file) || {};
    const receipt = { ...metadata, ...parse(fs.existsSync(claim.file) ? fs.readFileSync(claim.file) : null) };
    receipt.managed ??= {};
    receipt.managed[claim.name] = claim.record;
    writeReceipt(claim.file, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  // Provider writers must not discard declaration history when rewriting a receipt.
  for (const [file, previous] of receipts) {
    if (!previous.bundleDeployments) continue;
    const current = parse(fs.existsSync(file) ? fs.readFileSync(file) : null);
    current.bundleDeployments = previous.bundleDeployments;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (JSON.stringify(current.bundleDeployments) !== JSON.stringify(parse(fs.existsSync(file) ? fs.readFileSync(file) : null).bundleDeployments)) writeReceipt(file, `${JSON.stringify(current, null, 2)}\n`);
  }
}

/** Successful captured passes still report edits whose old receipt digests were retained. */
export function deploymentEditWarnings(project, provider) {
  const warnings = new Set();
  const visit = dir => {
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (entry.name !== sidecar || !entry.isFile()) continue;
      const receipt = parse(fs.readFileSync(file));
      for (const [name, record] of Object.entries(receipt.managed || {})) {
        const target = path.resolve(dir, name);
        if (!target.startsWith(`${dir}${path.sep}`) || context.has(path.basename(target)) || record.kind === 'settings') continue;
        const state = fs.lstatSync(target, { throwIfNoEntry: false });
        if (state?.isFile() && record.hash && record.hash !== hash(fs.readFileSync(target))) warnings.add(`${target}: kept (operator-edited)`);
      }
    }
  };
  visit(path.join(project, `.${provider}`));
  visit(path.join(project, '.agents'));
  return [...warnings];
}
