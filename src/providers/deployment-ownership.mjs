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
export const deploymentOwner = opts => {
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
    ...(provider.deploymentFiles?.(target) || []).map(name => path.join(target, name)),
    ...['AGENTS.md', 'AIWG.md', 'WORKSPACE.md', 'CLAUDE.md', 'WARP.md', '.hermes.md', 'opencode.json',
      '.windsurfrules', 'models.json', '.aiwg/frameworks', '.aiwg/.aiwg-manifest.json'].map(name => path.join(target, name))])];
}

// Settings files and Flue outputs keep preimage bytes in their receipts.
const SETTINGS_FILE = /^(?:settings(?:\.local)?|hooks|opencode|config|aiwg\.cordis\.patch)\.(?:json|toml|ya?ml)$/;
const FLUE_OUTPUT = /[/\\](?:db\.ts|aiwg[/\\](?:(?:tools|specialists|skills)\.ts|remote-specialist\.(?:js|d\.ts)))$/;
// Timestamps are coarse: a same-size write right after a stat can keep its
// ctime. Files changed this recently are hashed instead of trusted by stat.
const RECENT_NS = 2_000_000_000n;

/**
 * A snapshot entry for a file whose bytes the recorder never needs: provider
 * homes such as ~/.hermes or ~/.codex hold gigabytes of runtime data (#3846).
 * `hash` is set when the bytes were read; otherwise only the stat is known.
 */
export class DeploymentOutputState {
  constructor(signature, digest) { this.signature = signature; this.hash = digest; }
}
const signatures = new WeakMap();
const digests = new WeakMap();
const digestOf = entry => {
  if (entry == null) return undefined;
  if (entry instanceof DeploymentOutputState) return entry.hash;
  if (!digests.has(entry)) digests.set(entry, hash(entry));
  return digests.get(entry);
};
/** sha256 digest of a snapshot entry, or undefined when only its stat is known. */
export const outputDigest = entry => digestOf(entry);
/** Content equality; a stat-only entry never equals a different entry. */
export const sameOutput = (a, b) => a != null && b != null && (a === b || (digestOf(a) !== undefined && digestOf(a) === digestOf(b)));
const bytesOf = (file, entry) => {
  if (entry == null || Buffer.isBuffer(entry)) return entry;
  throw new Error(`Deployment snapshot did not retain bytes for ${file}`);
};
const signature = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const receiptBase = (file, receipt) => receipt.scope === 'project' && path.basename(path.dirname(file)) === '.aiwg'
  ? path.dirname(path.dirname(file)) : path.dirname(file);
const claimsOf = (file, bytes, claims) => {
  const receipt = parse(bytes), base = receiptBase(file, receipt);
  for (const name of Object.keys(receipt.managed || {})) {
    const target = path.resolve(base, name);
    if (target.startsWith(`${base}${path.sep}`)) claims.add(target);
  }
};

/**
 * Capture regular output files before this invocation; never follow symlinks.
 * Bytes are kept for receipts, settings, Flue outputs, receipt-claimed files,
 * files beside a receipt and project-root files. Other files are recorded by
 * stat (or digest, when recently changed), so memory does not scale with the
 * size of a provider home. Pass the earlier snapshot as `previous` to reuse
 * entries for files whose stat did not change.
 */
export function captureDeploymentOutputs(roots, { previous } = {}) {
  const files = new Map();
  const stats = new Map();
  signatures.set(files, stats);
  const prior = previous && signatures.get(previous);
  const recentFrom = BigInt(Date.now()) * 1_000_000n - RECENT_NS;
  const claims = new Set();
  // A file this process cannot read is not one it wrote; keep its stat only.
  // Live provider homes also delete files mid-walk; those are simply absent.
  const gone = Symbol('gone');
  const readable = file => {
    try { return fs.readFileSync(file); } catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') return null;
      if (error.code === 'ENOENT') return gone;
      throw error;
    }
  };
  const capture = (file, stat, retain, output) => {
    const sig = signature(stat), recent = stat.ctimeNs >= recentFrom, old = previous?.get(file);
    stats.set(file, sig);
    if (old && !recent && prior?.get(file) === sig && (Buffer.isBuffer(old) || !retain)) { files.set(file, old); return; }
    // The post-deploy pass hashes every file it cannot reuse. The first pass
    // hashes AIWG output kinds (so an identical rewrite is not a change) and
    // recently changed files; provider runtime data keeps only its stat.
    const bytes = retain || previous || recent || output ? readable(file) : null;
    if (bytes === gone) { stats.delete(file); return; }
    files.set(file, retain && bytes ? bytes : new DeploymentOutputState(sig, bytes ? hash(bytes) : undefined));
  };
  // `parent` is 'project' for a project root's direct children and 'managed'
  // for files beside a receipt.
  const visit = (root, file, depth, parent) => {
    let stat;
    try { stat = fs.lstatSync(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isDirectory()) {
      let names;
      try { names = fs.readdirSync(file); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error; }
      const managed = names.includes(SIDECAR);
      // Read a directory's receipt before its files so its claims are known.
      if (managed) visit(root, path.join(file, SIDECAR), depth + 1, 'managed');
      const childParent = depth === 0 && names.includes('.aiwg') ? 'project' : managed ? 'managed' : null;
      for (const name of names) if (name !== SIDECAR) visit(root, path.join(file, name), depth + 1, childParent);
    } else if (stat.isFile()) {
      const key = path.resolve(file), base = path.basename(key);
      capture(key, stat, base === SIDECAR || SETTINGS_FILE.test(base) || FLUE_OUTPUT.test(key)
        || depth === 0 || parent !== null || claims.has(key), artifactKind(path.relative(root, key)) !== 'generated');
      if (base === SIDECAR) claimsOf(key, files.get(key), claims);
    }
  };
  // Project-scoped receipts claim files outside their own directory.
  for (const root of roots) {
    const receipt = path.basename(String(root)) === SIDECAR ? String(root) : path.join(String(root), '.aiwg', SIDECAR);
    try { claimsOf(path.resolve(receipt), fs.readFileSync(receipt), claims); } catch { /* absent */ }
  }
  for (const root of roots) visit(path.resolve(String(root)), String(root), 0, null);
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
function settingsRecords(previous, current, prior, owner, claimUnchanged) {
  const records = { ...prior };
  if (current === null) return records;
  const before = previous === null ? {} : leaves(previous), after = leaves(current);
  for (const [pointer, value] of Object.entries(after)) {
    const old = records[pointer];
    if (stable(before[pointer]) === stable(value)) {
      if (claimUnchanged && old?.hash === hash(stable(value))) {
        records[pointer] = { ...old, owners: [...new Set([...(old.owners || []), owner])].sort(),
          ...(old.contributions ? { contributions: old.contributions.map(entry => ({ ...entry,
            owners: [...new Set([...entry.owners, ...(Array.isArray(value) || entry.hash === old.hash && !old.contributions.some(item => item.owners.includes(owner)) ? [owner] : [])])].sort() })) } : {}) };
      }
      continue;
    }
    const digest = hash(stable(value));
    const verified = Object.hasOwn(before, pointer) && old?.hash === hash(stable(before[pointer]));
    const preimage = verified ? old.previous
      : previous === null ? { unverifiable: true } : { present: Object.hasOwn(before, pointer), ...(Object.hasOwn(before, pointer) ? { value: before[pointer] } : {}) };
    const record = { hash: digest, value, previous: preimage, owners: [...new Set([...(verified ? old.owners || [] : []), owner])].sort() };
    if (!Array.isArray(value) && verified) {
      const contributions = old.contributions || [{ hash: old.hash, value: old.value, owners: old.owners }];
      record.contributions = [...contributions.flatMap(entry => {
        const owners = entry.owners.filter(candidate => candidate !== owner);
        return owners.length ? [{ ...entry, owners }] : [];
      }), { hash: digest, value, owners: [owner] }];
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
  const after = captureDeploymentOutputs(roots, { previous: before });
  const owner = deploymentOwner(opts);
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
  const preserved = new Set();
  for (const [file, bytes] of after) {
    if (path.basename(file) !== SIDECAR) continue;
    const receipt = parse(bytes), previous = parse(before.get(file));
    // Legacy writers replace their managed map. Retain already recorded,
    // untouched metadata files/resources they omit; this never adopts a file.
    for (const [name, entry] of Object.entries(previous.managed || {})) {
      const base = receiptRoot(file, receipt);
      const target = path.resolve(base, name);
      if (!target.startsWith(`${base}${path.sep}`) || receipt.managed?.[name]) continue;
      if (!sameOutput(after.get(target), before.get(target))) continue;
      receipt.managed ||= {};
      receipt.managed[name] = entry;
      manifests.set(file, receipt);
    }
    for (const [name, entry] of Object.entries(receipt.managed || {})) {
      const base = receiptRoot(file, receipt);
      const target = path.resolve(base, name);
      if (!target.startsWith(`${base}${path.sep}`) || !after.has(target)) continue;
      const prior = previous.managed?.[name];
      // A receipt rewrite is not evidence of a payload write. Preservation can
      // also restore bytes after a writer/binder marked the file as written.
      // Never bless those edited bytes, even with an explicit write hint.
      if (sameOutput(before.get(target), after.get(target)) &&
        (prior ? prior.hash !== digestOf(before.get(target)) : entry.hash === digestOf(before.get(target)) && !opts.writtenFiles?.includes(target))) {
        if (prior) receipt.managed[name] = prior;
        else delete receipt.managed[name];
        preserved.add(target);
        manifests.set(file, receipt);
        continue;
      }
      if (stable(previous.managed?.[name]) !== stable(entry)) declared.set(target, { file, name, entry, receipt });
    }
  }
  for (const [file, bytes] of after) {
    if (path.basename(file) === SIDECAR || /(?:^|[/\\])aiwg\.config$/.test(file)
      || /(?:\.bak\.|\.aiwg-backup-)/.test(path.basename(file))) continue;
    if (preserved.has(file)) continue;
    const changed = !sameOutput(before.get(file), bytes);
    const declaration = declared.get(file);
    if (opts.onlyDeclared && !declaration) continue;
    if (!changed && !declaration && !opts.writtenFiles?.includes(file)) continue;
    // Existing integrity receipts that disagree with bytes never bless operator edits.
    if (declaration?.entry.hash && declaration.entry.hash !== digestOf(bytes)) continue;
    let skillRoot = path.dirname(file);
    while (skillRoot !== path.dirname(skillRoot)) {
      const parentReceipt = parse(after.get(path.join(skillRoot, SIDECAR)));
      if (parentReceipt.managed?.['SKILL.md']) break;
      skillRoot = path.dirname(skillRoot);
    }
    const skillReceipt = parse(after.get(path.join(skillRoot, SIDECAR)));
    const projectScoped = projectRoot && (path.dirname(file) === projectRoot || opts.provider === 'flue' && FLUE_OUTPUT.test(file));
    const dir = projectScoped ? path.join(projectRoot, '.aiwg') : declaration ? path.dirname(declaration.file) : skillReceipt.managed?.['SKILL.md'] ? skillRoot : path.dirname(file);
    const name = declaration?.name || portable(path.relative(projectScoped ? projectRoot : dir, file));
    const existing = manifests.get(path.join(dir, SIDECAR)) || parse(after.get(path.join(dir, SIDECAR)));
    const previous = parse(before.get(path.join(dir, SIDECAR))).managed?.[name];
    const current = existing.managed?.[name] || {};
    // A redeploy may preserve operator additions around generated context.
    // Keep the old digest so removal cannot restore a stale preimage over them.
    if (previous?.filePreimage && before.has(file) && previous.hash !== digestOf(before.get(file))) continue;
    const identity = current.sourcePath || `${declaration?.receipt.skillSource}/SKILL.md`;
    const logicalSource = opts.logicalInputPath?.(identity) || identity;
    const sourceOwner = (declaration || current.hash === digestOf(bytes)) && (current.frameworkSlug || bundleOwner(logicalSource))
      || skillReceipt.managed?.['SKILL.md']?.frameworkSlug;
    const generatedIndex = /^RULES-(?:INDEX|ONDEMAND)\.(?:md|mdc)$/.test(path.basename(file));
    const kind = generatedIndex ? 'rule-index' : current.kind || artifactKind(file);
    const selectedOwner = opts.provider === 'flue' ? owner : sourceOwner || (opts.onlyDeclared ? current.owners?.[0] : owner);
    if (!selectedOwner) {
      console.warn(`Ownership not recorded for ${file}: no framework owner resolved.`);
      continue;
    }
    const receipt = manifest(dir);
    if (projectScoped) receipt.scope = 'project';
    const record = mergeArtifactOwnership(previous, { ...current, hash: digestOf(bytes), owners: opts.provider === 'flue' ? [] : current.hash === digestOf(bytes) ? current.owners : [], kind }, selectedOwner);
    // Flue's composed context and generated database/ignore outputs support
    // exact restoration. Never infer a preimage for another provider's files.
    if (opts.provider === 'flue' && (projectScoped || /[/\\]db\.ts$/.test(file))) {
      record.filePreimage = previous?.filePreimage || { present: before.has(file),
        ...(before.has(file) ? { bytes: bytesOf(file, before.get(file)).toString('base64'), hash: digestOf(before.get(file)) } : {}) };
    }
    // Structural rule indexes are generated outputs; their assembly scratch
    // directory is not a durable source identity.
    if (generatedIndex) {
      delete record.sourcePath;
      record.kind = 'rule-index';
    }
    // Settings have key/value receipts in the same entry, never a separate store.
    if (SETTINGS_FILE.test(path.basename(file))) {
      record.kind = 'settings';
      record.settingsPreimage = previous?.settingsPreimage || (!previous?.settings ? {
        present: before.has(file), ...(before.has(file) ? { bytes: bytesOf(file, before.get(file)).toString('base64'), hash: digestOf(before.get(file)) } : {})
      } : undefined);
      const claimUnchanged = opts.claimUnchangedSettings !== false
        && !/(?:agentic\/code|\.aiwg)\/(?:addons|extensions)\//.test((opts.logicalInputPath?.(opts.srcRoot) || opts.srcRoot)?.replaceAll('\\', '/') || '');
      record.settings = settingsRecords(settingsDocument(file, bytesOf(file, before.get(file))), settingsDocument(file, bytesOf(file, bytes)), previous?.settings, selectedOwner, claimUnchanged);
      const settingsOwners = Object.values(record.settings).flatMap(entry => entry.owners);
      record.owners = [...new Set(settingsOwners.length ? settingsOwners
        : [...(previous?.owners || []), ...(changed ? [selectedOwner] : [])])].sort();
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
