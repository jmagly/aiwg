// Validate and promote staged deployment plans through safe writers.
import fs from 'node:fs';
import path from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';
const { refreshSettingsDigests } = await importImpl(import.meta.url, 'providers/deployment-ownership.mjs');
import {
  contentHash,
  deploySkillsWithKernelRouting,
  getAddonSkillDirs,
  getFrameworksForMode,
  isKernelSkill,
  listSkillDirs,
} from './base.mjs';
import { writeContextFileSync } from './context-write.mjs';
import {
  fileDigest,
  PREPARATION_HOOK,
  promoteDirectories,
  put,
  read,
  walk,
} from './rule-delivery-surface.mjs';
import { prepareRuleDeployment } from './rule-deployment-prepare.mjs';
import {
  captureAnchors,
  capturePreimage,
  detachRuleDeploymentPlan,
  disposeRuleDeploymentPlan,
  planOwner,
  RuleDeploymentStaleError,
  snapshotPreimages,
  verifyInputPool,
  within,
} from './rule-deployment-state.mjs';

/** Validate every captured input before applying a staged provider plan. */
export function commitRuleDeploymentPlan(plan) {
  if (plan.noop) return plan.report;
  try {
    if (plan.version !== 1 || !plan.temp || !plan.stage || !Array.isArray(plan.preimages)) throw new Error('Invalid rule deployment plan');
    const owner = planOwner(plan);
    if (!owner) throw new Error('Unowned or modified rule deployment plan');
    if (owner.pool) { if (plan.poolSeal !== owner.pool.inventorySeal) throw new Error('Shared input pool lease changed'); verifyInputPool(owner.pool); }
    if (JSON.stringify(snapshotPreimages(plan.staged.map(item => item.path))) !== JSON.stringify(plan.staged)) throw new Error('Staged provider output changed');
    if (JSON.stringify(captureAnchors(plan.anchors.map(item => item.path))) !== JSON.stringify(plan.anchors)) {
      throw new RuleDeploymentStaleError('Provider deployment root or ancestor changed', plan.anchors.map(item => item.path));
    }
    const stale = plan.preimages.filter(item => JSON.stringify(capturePreimage(item.path)) !== JSON.stringify(item.state)).map(item => item.path);
    if (stale.length) throw new RuleDeploymentStaleError(`Provider deployment preimage changed: ${stale.join(', ')}`, stale);
    const { target, stage, rootNames } = plan;
    for (const dir of plan.workspaceDirs || []) fs.mkdirSync(path.join(target, dir), { recursive: true });
    const mappings = plan.mappings.map(({ from, to, before }) => ({ from, to, before: new Map(before) }));
    const normalize = content => {
      for (const mapping of [...mappings].sort((a, b) => b.to.length - a.to.length)) content = content.split(mapping.to).join(mapping.from);
      for (const mapping of [...plan.sourceMappings].sort((a, b) => b.to.length - a.to.length)) content = content.split(mapping.to).join(mapping.from);
      return content.split(plan.snapshotRoot).join(plan.corpusRoot).split(stage).join(target);
    };
    const normalizeReceipt = (file, output) => {
      if (path.basename(file) !== '.aiwg-manifest.json') return output;
      const receipt = JSON.parse(output.toString('utf8'));
      for (const [name, record] of Object.entries(receipt.managed || {})) {
        const base = file === path.join(stage, '.aiwg/.aiwg-manifest.json') && receipt.scope === 'project' ? stage : path.dirname(file);
        const recordedFile = path.resolve(base, name);
        if (!within(base, recordedFile) || !fs.existsSync(recordedFile)) continue;
        const recorded = fs.readFileSync(recordedFile);
        if (record.hash !== `sha256:${contentHash(recorded)}`) continue;
        const promoted = recorded.includes(0) ? recorded : Buffer.from(normalize(recorded.toString('utf8')));
        record.hash = `sha256:${contentHash(promoted)}`;
        refreshSettingsDigests(record);
      }
      return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    };
    const delegated = (from, rel) => mappings.some(mapping => mapping.from !== from
      && mapping.from.startsWith(`${from}${path.sep}`)
      && (path.join(from, rel) === mapping.from || path.join(from, rel).startsWith(`${mapping.from}${path.sep}`)));
    for (const { from, to, before } of mappings) {
      if (!fs.existsSync(to)) {
        if (before.size) fs.rmSync(from, { recursive: true, force: true });
        continue;
      }
      promoteDirectories(to, from, rel => delegated(from, rel));
      const after = new Set(walk(to).map(file => path.relative(to, file)).filter(rel => !delegated(from, rel)));
      for (const rel of before.keys()) if (!delegated(from, rel) && !after.has(rel)) {
        fs.rmSync(path.join(from, rel), { force: true });
        // A pruned managed skill must disappear as a directory too. Remove
        // only empty parents absent from the staged result; preserve siblings.
        let parent = path.dirname(rel);
        while (parent !== '.' && !fs.existsSync(path.join(to, parent))) {
          try { fs.rmdirSync(path.join(from, parent)); } catch { break; }
          parent = path.dirname(parent);
        }
      }
      for (const rel of after) {
        const file = path.join(to, rel);
        if (before.get(rel) === fileDigest(file)) continue;
        const buffer = fs.readFileSync(file);
        // Provider output includes binary skill resources; normalize text only.
        let output = buffer.includes(0) ? buffer : Buffer.from(normalize(buffer.toString('utf8')));
        output = normalizeReceipt(file, output);
        fs.mkdirSync(path.dirname(path.join(from, rel)), { recursive: true });
        if (plan.contextWrites.includes(file)) writeContextFileSync(path.join(from, rel), output);
        else fs.writeFileSync(path.join(from, rel), output);
      }
    }
    for (const name of rootNames) if (fs.existsSync(path.join(stage, name))) {
      const output = normalizeReceipt(path.join(stage, name), Buffer.from(normalize(read(path.join(stage, name))))).toString('utf8');
      if (output === read(path.join(target, name))) continue;
      const write = plan.contextWrites.includes(path.join(stage, name)) ? writeContextFileSync : put;
      write(path.join(target, name), output);
    }
    return plan.report;
  } finally {
    disposeRuleDeploymentPlan(plan);
  }
}

/** Stage and commit serially for existing provider callers. */
export async function deployWithRuleDelivery(original, provider, deploy) {
  // Kernel source passes share the same selected rule set. Deploy their
  // skills directly; the final source projects rules and bindings across the
  // complete destination. Full passes retain staging for bound flow skills
  // and provider definitions, but defer rule presentation above.
  if (original.kernelOnly && original.deferRuleProjection && !globalThis[PREPARATION_HOOK]) {
    return deploySelectedSurface(original, provider, deploy);
  }
  if (original.ruleDelivery) return deploy(original);
  const hook = globalThis[PREPARATION_HOOK];
  if (hook) {
    const plan = await prepareRuleDeployment({ ...original, inputPool: hook.inputPool, ruleDeploymentScratch: hook.scratch }, provider, deploy);
    const report = plan.report;
    hook.accept(detachRuleDeploymentPlan(plan));
    return report;
  }
  return commitRuleDeploymentPlan(await prepareRuleDeployment(original, provider, deploy));
}

export async function deploySelectedSurface(opts, provider, deploy) {
  if (!opts.kernelOnly || provider.name !== 'warp') return deploy(opts);
  // Warp's aggregate writer emits bulk definitions even in skills-only mode.
  // Both staged and deferred kernel passes use only its shared skill router.
  const skills = [...listSkillDirs(path.join(opts.srcRoot, 'skills')),
    ...getFrameworksForMode(opts.srcRoot, opts.mode).flatMap(bundle => listSkillDirs(path.join(bundle.path, 'skills'))),
    ...getAddonSkillDirs(opts.srcRoot)].filter(isKernelSkill);
  const standard = path.join(opts.target, provider.paths.skills);
  for (const dir of new Set([opts.kernelSkillsPath || provider.kernelSkillsPath, provider.paths.crossAgentSkills])) {
    if (dir) deploySkillsWithKernelRouting(skills, standard, path.isAbsolute(dir) ? dir : path.join(opts.target, dir), opts);
  }
}
