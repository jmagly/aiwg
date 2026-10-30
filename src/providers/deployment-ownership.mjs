// Extend deploy sidecars with current-write ownership and settings preimages.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseTOML, getStaticTOMLValue } from 'toml-eslint-parser';
import { parse as parseYaml } from 'yaml';
import { parseJson } from '../mcp/json-document.mjs';
import { extractFrameworkSlug, mergeArtifactOwnership } from './skill-ownership.mjs';

const SIDECAR = '.aiwg-manifest.json';
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const portable = value => value.split(path.sep).join('/');
const stable = value => JSON.stringify(value, (_key, child) => child && typeof child === 'object' && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
const parse = bytes => { try { return JSON.parse(bytes?.toString() || '{}'); } catch { return {}; } };
const bundleOwner = source => extractFrameworkSlug(source) || source.replaceAll('\\', '/').match(/(?:agentic\/code|\.aiwg)\/(?:frameworks|addons|extensions|plugins)\/([^/]+)\//)?.[1];
const ownersFor = opts => {
  const names = { sdlc: 'sdlc-complete', marketing: 'media-marketing-kit', mmk: 'media-marketing-kit',
    research: 'research-complete', forensics: 'forensics-complete', dfir: 'forensics-complete', validation: 'validation-complete', ops: 'ops-complete', general: 'writing-quality' };
  return opts.frameworkSlug || bundleOwner(`${opts.logicalInputPath?.(opts.srcRoot) || opts.srcRoot}/manifest.json`) || names[opts.mode] || opts.mode;
};

/** Only provider output surfaces, never arbitrary project source directories. */
export function deploymentOutputRoots(provider, target) {
  const roots = Object.values(provider.paths || {}).filter(Boolean).map(dir => path.isAbsolute(dir)
    ? dir : path.join(target, dir.split(/[\\/]/)[0]));
  if (provider.kernelSkillsPath) roots.push(path.resolve(target, provider.kernelSkillsPath));
  return [...new Set([...roots, path.join(target, `.${provider.name}`), path.join(target, '.agents'),
    ...['AGENTS.md', 'AIWG.md', 'WORKSPACE.md', 'CLAUDE.md', 'WARP.md', '.hermes.md', 'opencode.json',
      '.windsurfrules', 'models.json', '.aiwg/frameworks', '.aiwg/.aiwg-manifest.json'].map(name => path.join(target, name))])];
}

/** Capture regular output files before this invocation; never follow symlinks. */
export function captureDeploymentOutputs(roots) {
  const files = new Map();
  const visit = file => {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name));
    else if (stat.isFile()) files.set(path.resolve(file), fs.readFileSync(file));
  };
  for (const root of roots) visit(root);
  // A root-level file's sidecar is itself outside that file's snapshot root.
  for (const file of [...files.keys()]) {
    const receipt = path.join(path.dirname(file), SIDECAR);
    if (!files.has(receipt) && fs.existsSync(receipt) && fs.lstatSync(receipt).isFile()) files.set(receipt, fs.readFileSync(receipt));
  }
  return files;
}

function settingsDocument(file, bytes) {
  if (!bytes) return {};
  try {
    if (file.endsWith('.toml')) return getStaticTOMLValue(parseTOML(bytes.toString()));
    if (/\.ya?ml$/.test(file)) return parseYaml(bytes.toString()) ?? {};
    return parseJson(bytes.toString());
  } catch { return null; }
}

/** Recompute value digests after staged logical-path normalization. */
export function refreshSettingsDigests(record) {
  for (const entry of Object.values(record.settings || {})) {
    entry.hash = hash(stable(entry.value));
    for (const contribution of entry.contributions || []) contribution.hash = hash(stable(contribution.value));
  }
}

function leaves(value, pointer = '', out = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
    for (const [key, child] of Object.entries(value)) leaves(child, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, out);
  } else out[pointer] = value;
  return out;
}

/** Settings arrays retain individual contributions so operator entries aren't claimed. */
function settingsRecords(previous, current, prior, owner) {
  const records = { ...prior };
  if (current === null) return records;
  const before = previous === null ? {} : leaves(previous), after = leaves(current);
  for (const [pointer, value] of Object.entries(after)) {
    if (stable(before[pointer]) === stable(value)) continue;
    const old = records[pointer];
    const digest = hash(stable(value));
    const verified = Object.hasOwn(before, pointer) && old?.hash === hash(stable(before[pointer]));
    const preimage = verified ? old.previous
      : previous === null ? { unverifiable: true } : { present: Object.hasOwn(before, pointer), ...(Object.hasOwn(before, pointer) ? { value: before[pointer] } : {}) };
    const record = { hash: digest, value, previous: preimage, owners: [...new Set([...(verified ? old.owners || [] : []), owner])].sort() };
    if (!Array.isArray(value) && verified) {
      const contributions = old.contributions || [{ hash: old.hash, value: old.value, owners: old.owners }];
      record.contributions = [...contributions.filter(entry => !entry.owners.includes(owner)), { hash: digest, value, owners: [owner] }];
    }
    if (Array.isArray(value)) {
      const previousValues = Array.isArray(before[pointer]) ? before[pointer] : [];
      record.contributions = value.flatMap(item => {
        const itemHash = hash(stable(item));
        const existing = old?.contributions?.find(entry => entry.hash === itemHash);
        if (existing) return [existing];
        return previousValues.some(entry => stable(entry) === stable(item)) ? [] : [{ hash: itemHash, value: item, owners: [owner] }];
      });
    }
    records[pointer] = record;
  }
  return records;
}

function artifactKind(file) {
  if (/(?:^|[/\\])hooks?[/\\]/.test(file)) return 'hook';
  if (/(?:^|[/\\])(?:skills|skill)[/\\]/.test(file)) return 'skill';
  if (/(?:^|[/\\])(?:agents|droids)[/\\]/.test(file)) return 'agent';
  if (/(?:^|[/\\])(?:commands|prompts|workflows)[/\\]/.test(file)) return 'command';
  if (/(?:^|[/\\])(?:rules|rule|copilot-rules)[/\\]/.test(file)) return 'rule';
  return 'generated';
}

/** Record only writes evidenced by this invocation or newly emitted file receipts. */
export function recordDeploymentOutputs(before, roots, opts = {}) {
  if (opts.dryRun) return;
  const after = captureDeploymentOutputs(roots);
  const owner = ownersFor(opts);
  const manifests = new Map();
  const manifest = dir => {
    const file = path.join(dir, SIDECAR);
    if (!manifests.has(file)) manifests.set(file, parse(after.get(file)));
    return manifests.get(file);
  };
  const projectRoot = opts.target && path.resolve(opts.target);
  const receiptRoot = (file, receipt) => projectRoot && file === path.join(projectRoot, '.aiwg', SIDECAR) && receipt.scope === 'project'
    ? projectRoot : path.dirname(file);
  const declared = new Map();
  for (const [file, bytes] of after) {
    if (path.basename(file) !== SIDECAR) continue;
    const receipt = parse(bytes), previous = parse(before.get(file));
    // Legacy writers replace their managed map. Retain already recorded,
    // untouched metadata files/resources they omit; this never adopts a file.
    for (const [name, entry] of Object.entries(previous.managed || {})) {
      const base = receiptRoot(file, receipt);
      const target = path.resolve(base, name);
      if (!target.startsWith(`${base}${path.sep}`) || receipt.managed?.[name]) continue;
      if (!before.has(target) || !after.get(target)?.equals(before.get(target))) continue;
      receipt.managed ||= {};
      receipt.managed[name] = entry;
      manifests.set(file, receipt);
    }
    for (const [name, entry] of Object.entries(receipt.managed || {})) {
      const base = receiptRoot(file, receipt);
      const target = path.resolve(base, name);
      if (!target.startsWith(`${base}${path.sep}`) || !after.has(target)) continue;
      if (stable(previous.managed?.[name]) !== stable(entry)) declared.set(target, { file, name, entry, receipt });
    }
  }
  for (const [file, bytes] of after) {
    if (path.basename(file) === SIDECAR || /(?:^|[/\\])aiwg\.config$/.test(file)
      || /(?:\.bak\.|\.aiwg-backup-)/.test(path.basename(file))) continue;
    const changed = !before.get(file)?.equals(bytes);
    const declaration = declared.get(file);
    if (opts.onlyDeclared && !declaration) continue;
    if (!changed && !declaration && !opts.writtenFiles?.includes(file)) continue;
    // Existing integrity receipts that disagree with bytes never bless operator edits.
    if (declaration?.entry.hash && declaration.entry.hash !== hash(bytes)) continue;
    let skillRoot = path.dirname(file);
    while (skillRoot !== path.dirname(skillRoot)) {
      const parentReceipt = parse(after.get(path.join(skillRoot, SIDECAR)));
      if (parentReceipt.managed?.['SKILL.md']) break;
      skillRoot = path.dirname(skillRoot);
    }
    const skillReceipt = parse(after.get(path.join(skillRoot, SIDECAR)));
    const projectScoped = projectRoot && path.dirname(file) === projectRoot;
    const dir = projectScoped ? path.join(projectRoot, '.aiwg') : declaration ? path.dirname(declaration.file) : skillReceipt.managed?.['SKILL.md'] ? skillRoot : path.dirname(file);
    const name = declaration?.name || portable(path.relative(projectScoped ? projectRoot : dir, file));
    const existing = manifests.get(path.join(dir, SIDECAR)) || parse(after.get(path.join(dir, SIDECAR)));
    const previous = parse(before.get(path.join(dir, SIDECAR))).managed?.[name];
    const current = existing.managed?.[name] || {};
    const identity = current.sourcePath || `${declaration?.receipt.skillSource}/SKILL.md`;
    const logicalSource = opts.logicalInputPath?.(identity) || identity;
    const sourceOwner = (declaration || current.hash === hash(bytes)) && (current.frameworkSlug || bundleOwner(logicalSource))
      || skillReceipt.managed?.['SKILL.md']?.frameworkSlug;
    const generatedIndex = /^RULES-(?:INDEX|ONDEMAND)\.(?:md|mdc)$/.test(path.basename(file));
    const kind = generatedIndex ? 'rule-index' : current.kind || artifactKind(file);
    const selectedOwner = sourceOwner || (opts.onlyDeclared ? current.owners?.[0] : owner);
    if (!selectedOwner) {
      console.warn(`Ownership not recorded for ${file}: no framework owner resolved.`);
      continue;
    }
    const receipt = manifest(dir);
    if (projectScoped) receipt.scope = 'project';
    const record = mergeArtifactOwnership(previous, { ...current, hash: hash(bytes), owners: current.hash === hash(bytes) ? current.owners : [], kind }, selectedOwner);
    // Structural rule indexes are generated outputs; their assembly scratch
    // directory is not a durable source identity.
    if (generatedIndex) {
      delete record.sourcePath;
      record.kind = 'rule-index';
    }
    // Settings have key/value receipts in the same entry, never a separate store.
    if (/^(?:settings(?:\.local)?|hooks|opencode|config|aiwg\.cordis\.patch)\.(?:json|toml|ya?ml)$/.test(path.basename(file))) {
      record.kind = 'settings';
      record.settings = settingsRecords(settingsDocument(file, before.get(file)), settingsDocument(file, bytes), previous?.settings, selectedOwner);
    }
    receipt.managed ||= {};
    receipt.managed[name] = record;
  }
  for (const [file, receipt] of manifests) {
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    if (after.get(file)?.toString() === text) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (receipt.scope === 'project' && opts.writeReceipt) opts.writeReceipt(file, text);
    else fs.writeFileSync(file, text);
  }
}
