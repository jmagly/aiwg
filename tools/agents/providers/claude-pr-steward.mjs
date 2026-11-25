// Generate and retire the single opt-in PR Steward policy file without adopting operator guidance.
import fs from 'node:fs';
import path from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';
import { addManagedMarker, contentHash, readSidecarManifest, updateSidecarManifest } from './base-files.mjs';

const KIND = 'pr-steward-guidance';
const STAMP = 'aiwg-pr-steward-guidance-v1\n';
const regular = file => { try { const stat = fs.lstatSync(file); return stat.isFile() && stat.nlink === 1; } catch { return false; } };
const present = file => { try { fs.lstatSync(file); return true; } catch { return false; } };

// Check ancestors too: a regular leaf beneath a symlink is not a repository-local output.
function safeDirectory(root, dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    if (present(current) && !fs.lstatSync(current).isDirectory()) return false;
    if (current === path.resolve(root)) return true;
    if (current === path.dirname(current)) return false;
  }
}

/** Narrow exception to #4380: legacy marker-only steward copies must still migrate. */
export function isPrStewardGuidance(dir) {
  return regular(path.join(dir, '.aiwg-managed'))
    && fs.readFileSync(path.join(dir, '.aiwg-managed'), 'utf8') === STAMP
    && regular(path.join(dir, '.aiwg-manifest.json'))
    && readSidecarManifest(dir)?.managed?.['SKILL.md']?.kind === KIND;
}

// Only explicit bullet lists under these exact WORKSPACE headings are declarations.
function declaredList(workspace, title) {
  const lines = workspace.split(/\r?\n/), items = [];
  let active = false, depth = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (active && heading[1].length <= depth) break;
      if (!active && heading[2] === title) { active = true; depth = heading[1].length; }
    } else if (active) {
      const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
      if (bullet) items.push(bullet[1].replace(/^`(.*)`$/, '$1'));
    }
  }
  return items;
}
const text = value => String(value).replace(/[\r\n]/g, ' ');

export function renderPrStewardGuidance(config, workspace, resolveDelivery) {
  const declared = config.delivery || {}, delivery = resolveDelivery(declared);
  const lines = ['# PR Steward repository guidance', '',
    'Input for Claude Code PR Steward. Only a user-typed /steward starts it. Never merge.', '',
    '## Delivery (delivery.mode, delivery.default_branch)',
    `Mode: ${delivery.mode}; default branch: ${text(delivery.default_branch)}.`,
    delivery.mode === 'direct' ? 'Follow the declared direct commit/push flow.'
      : delivery.mode === 'feature-branch' ? 'Push changes on a feature branch; this policy does not require a PR.'
        : 'Keep changes on the PR branch; use the required pull request flow.', '',
    '## Force pushes (delivery.force_push_policy)',
    delivery.force_push_policy === 'never' ? 'Policy never: never force-push; resolve conflicts by merging.'
      : delivery.force_push_policy === 'own-branch-only' ? 'Policy own-branch-only: force-push only your own feature branch, never the default branch.'
        : 'Policy allowed: force pushes are permitted by repository policy; obey PR Steward limits.', '',
    `CI policy (delivery.require_ci_green): ${delivery.require_ci_green ? 'require green CI before declaring done.' : 'green CI is not a delivery completion requirement.'}`];
  if (declared.committer?.name && declared.committer?.email) {
    lines.push('', '## Commit identity (delivery.committer)',
      `Use author and committer ${text(declared.committer.name)} <${text(declared.committer.email)}>.`);
  } else lines.push('', 'Note: No complete commit identity declared; consult repository policy.');
  const signing = declared.signing;
  const commitSigning = signing && signing.enforce !== 'tags' && (signing.key || signing.key_file);
  if (commitSigning) {
    lines.push('', '## Signing (delivery.signing)',
      `sign every commit with ${signing.key ? `key ${text(signing.key)}` : `key file ${text(signing.key_file)}`}${signing.format ? ` (${text(signing.format)})` : ''}.`,
      `Signing enforcement: ${signing.enforce || 'commits'}.${signing.program ? ` Program: ${text(signing.program)}.` : ''}`);
  } else lines.push('', 'Note: No commit signing configuration declared; consult repository policy.');
  if (delivery.require_signed_commits) lines.push('delivery.require_signed_commits: every commit must be signed; missing key metadata does not waive this requirement.');
  for (const [title, section] of [['PR Steward verification commands', 'Verification'], ['PR Steward off-limits paths', 'Off-limits']]) {
    const items = declaredList(workspace, title);
    if (items.length) {
      lines.push('', `## ${section} (WORKSPACE.md: ${title})`);
      if (section === 'Verification') lines.push('After a conflict merge or CI fix, run these declared checks:');
      else lines.push('Do not edit these paths without human authorization:');
      lines.push(...items.map(item => `- ${item}`));
    } else lines.push('', section === 'Verification' ? 'Note: No verification commands declared; no checks inferred.' : 'Note: No off-limits paths declared; consult repository policy.');
  }
  const forge = config.remotes?.issue_provider;
  lines.push('', '## Forge (remotes.issue_provider)', forge === 'gitea'
    ? 'Gitea: only git-state watching applies. PR checks, review threads and mergeability features are GitHub-oriented; do not use GitHub PR tooling here.'
    : forge === 'github' ? 'GitHub: PR Steward supports GitHub PR checks, review threads and mergeability.'
      : `${forge === 'local' ? 'Local tracker' : 'Forge undeclared'}: do not assume GitHub PR tooling is available; consult repository policy.`,
  '', '## Attribution (kernel no-attribution rule)', 'No AI attribution in commits or replies.', '');
  return lines.join('\n');
}

export async function deployPrStewardGuidance(targetDir, opts = {}) {
  // This feature is per repository, never a user HOME deployment.
  if (opts.scope === 'user' || opts.userScope) return;
  const root = path.resolve(targetDir), dir = path.join(root, '.claude/skills/steward');
  const file = path.join(dir, 'SKILL.md'), stamp = path.join(dir, '.aiwg-managed'), manifest = path.join(dir, '.aiwg-manifest.json');
  const notice = reason => console.warn(`PR Steward guidance ${opts.logicalOutputPath?.(file) || file}: ${reason}; skipped, existing guidance left untouched.`);
  if (!safeDirectory(root, dir) || [file, stamp, manifest].some(name => present(name) && !regular(name))) {
    notice('unsafe file or directory'); return;
  }
  const { readAiwgConfig, resolveDelivery } = await importImpl(import.meta.url, 'config/aiwg-config.js');
  const config = await readAiwgConfig(root);
  const enabled = config?.delivery?.pr_steward_guidance === true;
  const managed = isPrStewardGuidance(dir);
  const previous = readSidecarManifest(dir);
  if (present(file) && (!managed || previous.managed['SKILL.md'].hash !== `sha256:${contentHash(fs.readFileSync(file))}`)) {
    notice(managed ? 'operator-edited' : 'unmanaged'); return;
  }
  if (!enabled) {
    if (!managed || opts.dryRun) return;
    for (const name of [file, stamp]) if (present(name)) {
      fs.unlinkSync(name);
      opts.replacedSkillCopies ||= new Set();
      opts.replacedSkillCopies.add(path.resolve(name));
      opts.replacedSkillCopies.add(path.resolve(opts.logicalOutputPath?.(name) || name));
    }
    delete previous.managed['SKILL.md']; delete previous.managed['.aiwg-managed'];
    if (Object.keys(previous.managed).length) fs.writeFileSync(manifest, JSON.stringify(previous, null, 2) + '\n');
    else {
      fs.unlinkSync(manifest);
      opts.replacedSkillCopies.add(manifest);
      opts.replacedSkillCopies.add(path.resolve(opts.logicalOutputPath?.(manifest) || manifest));
    }
    if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    return;
  }
  if (opts.dryRun) return;
  const workspaceFile = path.join(root, 'WORKSPACE.md');
  const workspace = regular(workspaceFile) ? fs.readFileSync(workspaceFile, 'utf8') : '';
  const version = opts.deployVersion || opts.version || 'unknown';
  const content = addManagedMarker(renderPrStewardGuidance(config, workspace, resolveDelivery), version, '.aiwg/aiwg.config#delivery.pr_steward_guidance');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content); fs.writeFileSync(stamp, STAMP);
  const { deploymentOwner } = await importImpl(import.meta.url, 'providers/deployment-ownership.mjs');
  updateSidecarManifest(dir, [{ filename: 'SKILL.md', hash: contentHash(content), kind: KIND, frameworkSlug: deploymentOwner(opts) },
    { filename: '.aiwg-managed', hash: contentHash(STAMP), kind: KIND, frameworkSlug: deploymentOwner(opts) }], { ...opts, version, source: opts.deploySource || 'bundled' });
  opts.writtenFiles?.push(file, stamp);
}
