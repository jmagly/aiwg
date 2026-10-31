// Build file removal decisions exclusively from provider ownership sidecars.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getProviderArtifactPathStrings } from './provider-definitions.js';
import { deployedSkillRoots } from './deployed-skill-roots.js';
import { releaseSkillOwnership, type ArtifactOwnershipRecord } from './skill-ownership.mjs';
import { restoreSettings } from './settings-removal.js';
import type { RemovalWrite } from './removal-transaction.js';

const SIDECAR = '.aiwg-manifest.json';
const CONTEXT_BRIDGES = new Set(['AGENTS.md', 'AIWG.md', 'WORKSPACE.md', 'CLAUDE.md', 'WARP.md', '.hermes.md', '.windsurfrules', 'copilot-instructions.md']);
const hash = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const inside = (root: string, file: string) => file.startsWith(`${root}${path.sep}`);
export interface RemovalDecision {
  path: string; action: 'remove' | 'preserve' | 'release'; reason: string; kind?: string;
  owned?: boolean; legacy?: boolean; pointer?: string;
}
export interface DeploymentRemovalPlan {
  decisions: RemovalDecision[]; writes: RemovalWrite[]; remaining: ArtifactOwnershipRecord[];
  recorded: ArtifactOwnershipRecord[]; legacy: boolean;
}
interface Receipt { scope?: string; managed?: Record<string, ArtifactOwnershipRecord>; [key: string]: unknown }

function symlinkBetween(root: string, file: string): boolean {
  let current = file;
  while (current === root || inside(root, current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (current === root) break;
    current = path.dirname(current);
  }
  return false;
}

export function planDeploymentRemoval(project: string, provider: string, owner: string, includeProject = true): DeploymentRemovalPlan {
  const paths = Object.values(getProviderArtifactPathStrings(provider) || {}).filter(Boolean);
  const roots = [...new Set([...paths.map(dir => path.isAbsolute(dir) ? dir : path.join(project, dir.split(/[\\/]/)[0])),
    ...deployedSkillRoots(project, provider), path.join(project, `.${provider}`), ...(includeProject ? [path.join(project, '.aiwg/frameworks')] : [])])].map(root => path.resolve(root));
  const files = new Set<string>();
  const decisions: RemovalDecision[] = [], writes: RemovalWrite[] = [], remaining: ArtifactOwnershipRecord[] = [], recorded: ArtifactOwnershipRecord[] = [];
  const visit = (file: string) => {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    else files.add(file);
  };
  for (const root of roots) visit(root);
  const projectReceipt = path.join(project, '.aiwg', SIDECAR);
  if (includeProject && fs.existsSync(projectReceipt)) files.add(projectReceipt);
  const accounted = new Set<string>();
  let modern = false;
  const receipts: Array<{ file: string; before: Buffer; receipt: Receipt }> = [];
  for (const file of [...files].filter(file => path.basename(file) === SIDECAR).sort()) {
    if (symlinkBetween(roots.find(root => inside(root, file)) || project, file)) continue;
    try {
      const before = fs.readFileSync(file), receipt = JSON.parse(before.toString()) as Receipt;
      if (receipt.managed && typeof receipt.managed === 'object' && !Array.isArray(receipt.managed)) {
        receipts.push({ file, before, receipt });
        if (Object.values(receipt.managed).some(record => Array.isArray(record?.owners))) modern = true;
      }
    } catch { /* Invalid receipts are reported below, never treated as ownership. */ }
  }
  const claims = new Map<string, ArtifactOwnershipRecord[]>();
  for (const item of receipts) {
    const base = item.file === projectReceipt && item.receipt.scope === 'project' ? project : path.dirname(item.file);
    for (const [name, record] of Object.entries(item.receipt.managed!)) {
      if (!record || typeof record !== 'object') continue;
      const target = path.resolve(base, name);
      claims.set(target, [...(claims.get(target) || []), record]);
    }
  }
  // Legacy skill receipts already contain verifiable hashes and a root owner.
  // Keep their established metadata release semantics; never infer flat artifacts.
  for (const { file, before, receipt } of receipts) {
    const root = path.dirname(file);
    const skillOwner = receipt.managed?.['SKILL.md']?.frameworkSlug;
    if (skillOwner === owner && Object.values(receipt.managed!).every(record => !record?.kind && (!record?.owners || record.owners.length === 1 && record.owners[0] === owner))) {
      const legacyPlan: Array<{ path: string; action: 'remove' | 'preserve'; reason: string }> = [];
      releaseSkillOwnership(root, { frameworkSlug: owner }, { dryRun: true, plan: legacyPlan });
      for (const decision of legacyPlan) {
        accounted.add(decision.path);
        decisions.push({ ...decision, owned: true, legacy: true });
        if (decision.action === 'remove') writes.push({ path: decision.path, before: fs.readFileSync(decision.path), after: null });
      }
      accounted.add(file);
      recorded.push({ ...receipt.managed!['SKILL.md'], kind: 'skill' });
      continue;
    }
    const base = file === projectReceipt && receipt.scope === 'project' ? project : root;
    let changed = false;
    for (const [name, record] of Object.entries(receipt.managed!)) {
      if (!record || typeof record !== 'object') continue;
      const target = path.resolve(base, name);
      const owners = Array.isArray(record.owners) ? record.owners : record.frameworkSlug ? [record.frameworkSlug] : [];
      if (!owners.includes(owner)) continue;
      accounted.add(target);
      recorded.push(record);
      let action: RemovalDecision['action'] = 'preserve', reason = 'modified or unverifiable managed file';
      if (!inside(base, target) || target === file || !roots.some(root => inside(root, target)) && base !== project) reason = 'unsafe receipt path; unverifiable';
      else if (symlinkBetween(roots.find(root => inside(root, target)) || project, target)) reason = 'symlink preserved';
      else if (record.kind === 'settings' && record.settings && (claims.get(target) || []).length === 1) {
        const restored = restoreSettings(target, record, owner);
        decisions.push(...restored.decisions);
        if (restored.write) writes.push(restored.write);
        if (restored.retained) remaining.push(record);
        if (!record.owners?.length) delete receipt.managed![name];
        changed = true;
        continue;
      }
      else if (record.kind === 'settings') reason = 'settings contributions missing or conflicting; unverifiable';
      else if (record.filePreimage && (claims.get(target) || []).length === 1) {
        const snapshot = record.filePreimage;
        const prior = snapshot.present && typeof snapshot.bytes === 'string' ? Buffer.from(snapshot.bytes, 'base64') : null;
        const valid = snapshot.present === false || prior !== null && hash(prior) === snapshot.hash;
        const current = fs.existsSync(target) && fs.lstatSync(target).isFile() ? fs.readFileSync(target) : null;
        if (valid && current && hash(current) === record.hash) {
          const others = owners.filter(candidate => candidate !== owner);
          if (others.length) { record.owners = others; remaining.push(record); }
          else {
            writes.push({ path: target, before: current, after: prior });
            delete receipt.managed![name];
          }
          decisions.push({ path: target, action: others.length || prior ? 'release' : 'remove',
            reason: others.length ? 'shared generated output; release this owner only' : 'verified file preimage restored', kind: record.kind, owned: true });
          changed = true;
          continue;
        }
      }
      else if (CONTEXT_BRIDGES.has(path.basename(target))) reason = 'context bridge preserved; pre-deploy operator content unverifiable';
      else if ((claims.get(target) || []).some(claim => claim.hash !== record.hash)) reason = 'conflicting receipt digests; unverifiable';
      else if ((claims.get(target) || []).some(claim => (claim.owners || (claim.frameworkSlug ? [claim.frameworkSlug] : [])).some(item => item !== owner))) { action = 'release'; reason = 'shared with another framework; release this owner only'; }
      else {
        try {
          if (fs.lstatSync(target).isFile() && /^sha256:[a-f0-9]{64}$/.test(record.hash) && hash(fs.readFileSync(target)) === record.hash) {
            action = 'remove'; reason = 'unchanged managed file';
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') { action = 'release'; reason = 'recorded file already absent'; }
          else reason = 'unreadable path; unverifiable';
        }
      }
      decisions.push({ path: target, action, reason, kind: record.kind, owned: true });
      if (action === 'preserve') { remaining.push(record); continue; }
      changed = true;
      if (action === 'remove') writes.push({ path: target, before: fs.readFileSync(target), after: null });
      const otherOwners = owners.filter(item => item !== owner);
      if (otherOwners.length) {
        record.owners = otherOwners;
        if (record.frameworkSlug === owner) record.frameworkSlug = otherOwners[0];
      } else delete receipt.managed![name];
    }
    if (changed) {
      const empty = Object.keys(receipt.managed!).length === 0;
      writes.push({ path: file, before, after: empty ? null : Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`) });
      if (empty) decisions.push({ path: file, action: 'remove', reason: 'ownership metadata released' });
    }
    accounted.add(file);
  }
  for (const file of [...files].sort()) {
    if (accounted.has(file)) continue;
    // Foreign receipts are ownership evidence, but never this framework's files.
    const skill = receipts.find(item => inside(path.dirname(item.file), file) && item.receipt.managed?.['SKILL.md']);
    const ownSkill = skill?.receipt.managed?.['SKILL.md']?.frameworkSlug === owner;
    const foreign = skill && !ownSkill;
    const foreignFile = (claims.get(file) || []).some(record => (record.owners || (record.frameworkSlug ? [record.frameworkSlug] : [])).length);
    decisions.push({ path: file, action: 'preserve', reason: foreign ? 'foreign or unverifiable ownership receipt'
      : foreignFile ? 'foreign ownership receipt; owned by another bundle' : ownSkill ? 'unrecorded operator file' : modern ? 'unrecorded operator file; unverifiable ownership' : 'unverifiable: no ownership receipt' });
  }
  const unique = new Map<string, RemovalDecision>();
  for (const decision of decisions) {
    const key = `${decision.path}#${decision.pointer ?? ''}`;
    const previous = unique.get(key);
    if (!previous || decision.action === 'preserve' || previous.action === 'remove') unique.set(key, decision);
  }
  return { decisions: [...unique.values()], writes, remaining, recorded, legacy: !modern };
}
