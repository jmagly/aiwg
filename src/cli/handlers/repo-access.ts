import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import {
  checkRepoAccess,
  findRepoEntry,
  findRepoAccessManifest,
  formatRepoAccessEntry,
  loadRepoAccessManifest,
  type RepoAccessAction,
} from '../../policy/repo-access.js';
import { workspaceSpecEdit, WORKSPACE_SPEC_PATH } from '../../policy/repo-access-workspace-spec.js';
import { resolveWorkspace } from '../../config/workspace.js';
import {
  getProjectDir,
  readAiwgConfig,
  writeAiwgConfig,
  WORKSPACE_REPO_ACTIONS,
  type WorkspaceRepoAction,
  type WorkspaceRepoConfig,
} from '../../config/aiwg-config.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

function valueAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

function usage(): string {
  return `
  aiwg repo-access — repo authorization manifest preflight

  Usage:
    aiwg repo-access list
    aiwg repo-access status
    aiwg repo-access explain --path <repo-or-file>
    aiwg repo-access check --path <repo-or-file> --action <read|write|commit|push|issue-comment|service-action|destructive>
    aiwg repo-access add --path <p> --name <n> --allow <a,b,c> [--provider <gitea|github|gitlab>] [--notes "..."]
    aiwg repo-access remove --name <n>
    aiwg repo-access audit

  Manifest:
    .aiwg/aiwg.config workspace + repos blocks (preferred)
    config/workspace.yaml + config/repository-routing.yaml (itops)
    .aiwg/ops/security/repo-access.manifest.yaml
    .aiwg/security/repo-access.manifest.yaml (fallback)
`;
}

function printHelp(): void {
  console.log(usage());
}

/**
 * The manifest is mandatory and default-deny, but until now it had no write path:
 * registering a repo meant hand-editing JSON, and the rule's own recovery text
 * ("ask for a manifest update") had no supported way to be carried out (#2531).
 */
async function addRepo(ctx: HandlerContext, args: string[]): Promise<HandlerResult> {
  const repoPath = valueAfter(args, '--path');
  const name = valueAfter(args, '--name');
  const allowRaw = valueAfter(args, '--allow');
  if (!repoPath) return { exitCode: 2, message: 'repo-access add requires --path <repo-or-file>' };
  if (!name) return { exitCode: 2, message: 'repo-access add requires --name <name>' };
  if (!allowRaw) {
    return { exitCode: 2, message: `repo-access add requires --allow <${WORKSPACE_REPO_ACTIONS.join('|')}>` };
  }

  const allowed = allowRaw.split(',').map((item) => item.trim()).filter(Boolean);
  const invalid = allowed.filter((item) => !WORKSPACE_REPO_ACTIONS.includes(item as WorkspaceRepoAction));
  if (invalid.length > 0) {
    return {
      exitCode: 2,
      message: `Unknown action(s): ${invalid.join(', ')}. Valid: ${WORKSPACE_REPO_ACTIONS.join(', ')}`,
    };
  }

  const provider = valueAfter(args, '--provider') ?? undefined;
  if (provider && !['gitea', 'github', 'gitlab'].includes(provider)) {
    return { exitCode: 2, message: `Unknown provider: ${provider}. Valid: gitea, github, gitlab` };
  }

  const projectDir = getProjectDir(ctx, args);
  const manifestPath = findRepoAccessManifest(projectDir);
  if (manifestPath?.replace(/\\/g, '/').endsWith(`/${WORKSPACE_SPEC_PATH}`)) {
    return { exitCode: 2, message: workspaceSpecEdit(manifestPath, name, nodePath.resolve(projectDir, repoPath), allowed) };
  }
  const config = await readAiwgConfig(projectDir);
  if (!config) return { exitCode: 2, message: `No .aiwg/aiwg.config found in ${projectDir}` };

  const repos: WorkspaceRepoConfig[] = config.repos ? [...config.repos] : [];
  const entry: WorkspaceRepoConfig = {
    name,
    path: repoPath,
    allowed: allowed as WorkspaceRepoAction[],
    ...(provider ? { provider: provider as WorkspaceRepoConfig['provider'] } : {}),
    ...(valueAfter(args, '--notes') ? { notes: valueAfter(args, '--notes') as string } : {}),
  };

  const existingIndex = repos.findIndex((repo) => repo.name === name);
  if (existingIndex >= 0) {
    repos[existingIndex] = { ...repos[existingIndex], ...entry };
  } else {
    repos.push(entry);
  }

  await writeAiwgConfig(projectDir, { ...config, repos });
  console.log(`${existingIndex >= 0 ? 'Updated' : 'Registered'} ${name}: ${repoPath} [${allowed.join(', ')}]`);
  return { exitCode: 0 };
}

async function removeRepo(ctx: HandlerContext, args: string[]): Promise<HandlerResult> {
  const name = valueAfter(args, '--name');
  if (!name) return { exitCode: 2, message: 'repo-access remove requires --name <name>' };

  const projectDir = getProjectDir(ctx, args);
  const manifestPath = findRepoAccessManifest(projectDir);
  if (manifestPath?.replace(/\\/g, '/').endsWith(`/${WORKSPACE_SPEC_PATH}`)) {
    return { exitCode: 2, message: workspaceSpecEdit(manifestPath, name) };
  }
  const config = await readAiwgConfig(projectDir);
  if (!config) return { exitCode: 2, message: `No .aiwg/aiwg.config found in ${projectDir}` };

  const repos = config.repos ?? [];
  const remaining = repos.filter((repo) => repo.name !== name);
  if (remaining.length === repos.length) {
    return { exitCode: 1, message: `No repo named '${name}' in the manifest.` };
  }

  // An empty `repos` array fails config validation, so drop the key entirely
  // when the last entry goes rather than writing a config that cannot be read back.
  const next = { ...config };
  if (remaining.length > 0) next.repos = remaining;
  else delete next.repos;

  await writeAiwgConfig(projectDir, next);
  console.log(`Removed ${name}. It now falls under the default-deny policy.`);
  return { exitCode: 0 };
}

/**
 * Report workspace subdirectories that are git repos but carry no manifest entry.
 * Manifests drift out of sync with reality; on the reporting workspace two
 * actively-used repos were both unlisted and therefore formally denied (#2531).
 */
async function auditRepos(ctx: HandlerContext, args: string[]): Promise<HandlerResult> {
  // A missing manifest is the most important case to audit, not a reason to fail:
  // every repo is then unlisted and formally denied.
  let manifest: ReturnType<typeof loadRepoAccessManifest> | null = null;
  try {
    manifest = loadRepoAccessManifest(ctx.cwd);
  } catch {
    manifest = null;
  }
  const root = manifest?.workspaceProjectRoot ?? getProjectDir(ctx, args);
  let children: string[] = [];
  try {
    children = readdirSync(root);
    if (manifest?.source === 'workspace-spec' && existsSync(nodePath.join(root, 'repos'))) {
      children.push(...readdirSync(nodePath.join(root, 'repos')).map(child => nodePath.join('repos', child)));
    }
  } catch {
    return { exitCode: 2, message: `Cannot read workspace root: ${root}` };
  }

  const unlisted: string[] = [];
  for (const child of children.sort()) {
    if (child.startsWith('.')) continue;
    const full = nodePath.join(root, child);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(nodePath.join(full, '.git'))) continue;
    if (manifest && findRepoEntry(manifest, full, ctx.cwd)) continue;
    unlisted.push(child);
  }

  console.log(`Repo access manifest: ${manifest?.path ?? '(none — every repo is denied)'}`);
  console.log(`Workspace root: ${root}`);
  console.log(`Default policy: ${manifest?.defaultPolicy ?? 'deny'}`);
  if (unlisted.length === 0) {
    console.log('All git repositories under the workspace root are registered.');
    return { exitCode: 0 };
  }

  console.log('');
  console.log(`Unlisted git repositories (${unlisted.length}) — denied by default:`);
  for (const name of unlisted) {
    console.log(`  - ${name}`);
    console.log(`      aiwg repo-access add --path ./${name} --name ${name} --allow read`);
  }
  return { exitCode: 1 };
}

async function handleRepoAccess(ctx: HandlerContext): Promise<HandlerResult> {
  const [subcommand = 'help', ...args] = ctx.args;
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printHelp();
    return { exitCode: 0 };
  }

  // Canonical add/remove must work before any manifest
  // exists — registering the first repo is exactly the bootstrap case (#2531).
  if (subcommand === 'add') return await addRepo(ctx, args);
  if (subcommand === 'remove') return await removeRepo(ctx, args);
  if (subcommand === 'audit') return await auditRepos(ctx, args);

  try {
    const manifest = loadRepoAccessManifest(ctx.cwd);

    if (subcommand === 'list' || subcommand === 'status') {
      console.log(`Repo access manifest: ${manifest.path}`);
      console.log(`Source: ${manifest.source}`);
      if (manifest.workspaceName) console.log(`Workspace: ${manifest.workspaceName}`);
      console.log(`Default policy: ${manifest.defaultPolicy}`);
      if (manifest.source === 'workspace-config') {
        const workspace = await resolveWorkspace(
          manifest.workspaceProjectRoot,
          manifest.workspaceProjectRoot,
        );
        for (const member of workspace.members) {
          const route = `${member.primary.provider}@${member.primary.domain ?? 'unknown-domain'}`;
          const tracker = `${member.issueTracker.provider}@${member.issueTracker.domain ?? 'unknown-domain'}`;
          const drift = member.drift.length > 0 ? ` DRIFT: ${member.drift.join('; ')}` : ' OK';
          console.log(`- ${member.name}: ${member.path} [${member.allowed.join(', ')}]`);
          console.log(`  config: ${member.configPath}${member.config ? '' : ' (missing)'}`);
          console.log(`  delivery: ${member.delivery.mode} -> ${member.remotes.primary} (${route})`);
          console.log(`  tracker: ${member.remotes.issue_tracker} (${tracker})`);
          console.log(`  status:${drift}`);
        }
      } else {
        for (const repo of manifest.repos) {
          console.log(`- ${formatRepoAccessEntry(repo)}`);
        }
      }
      return { exitCode: 0 };
    }

    if (subcommand === 'explain') {
      const requestedPath = valueAfter(args, '--path');
      if (!requestedPath) return { exitCode: 2, message: 'repo-access explain requires --path <repo-or-file>' };
      const entry = findRepoEntry(manifest, requestedPath, ctx.cwd);
      if (!entry) {
        console.log(`Path: ${requestedPath}`);
        console.log('Matched repo: none');
        console.log('Decision: unlisted repo/path defaults to denied');
        return { exitCode: 0 };
      }
      console.log(`Path: ${requestedPath}`);
      console.log(`Matched repo: ${formatRepoAccessEntry(entry)}`);
      return { exitCode: 0 };
    }

    if (subcommand === 'check') {
      const requestedPath = valueAfter(args, '--path');
      const action = valueAfter(args, '--action') as RepoAccessAction | null;
      if (!requestedPath) return { exitCode: 2, message: 'repo-access check requires --path <repo-or-file>' };
      if (!action) return { exitCode: 2, message: 'repo-access check requires --action <action>' };
      const decision = checkRepoAccess(manifest, requestedPath, action, ctx.cwd);
      const status = decision.allowed ? 'ALLOW' : 'DENY';
      console.log(`${status} ${decision.action} ${decision.requestedPath}`);
      console.log(decision.reason);
      if (decision.matchedRepo) {
        console.log(`matched: ${formatRepoAccessEntry(decision.matchedRepo)}`);
      }
      return { exitCode: decision.allowed ? 0 : 1 };
    }

    return { exitCode: 2, message: `Unknown repo-access subcommand: ${subcommand}\n${usage()}` };
  } catch (error) {
    return {
      exitCode: 2,
      message: error instanceof Error ? error.message : String(error),
      error: error instanceof Error ? error : undefined,
    };
  }
}

export const repoAccessHandler: CommandHandler = {
  id: 'repo-access',
  name: 'Repo Access',
  description: 'Validate and query repo access manifest permissions',
  category: 'utility',
  aliases: [],
  async help(): Promise<HandlerResult> {
    return { exitCode: 0, message: usage(), rawOutput: true };
  },

  execute: handleRepoAccess,
};

export const repoAccessHandlers: CommandHandler[] = [repoAccessHandler];
