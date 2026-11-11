import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { load as loadYaml } from 'js-yaml';
import {
  WORKSPACE_REPO_ACTIONS,
  type WorkspaceRepoAction,
} from '../config/aiwg-config.js';
import { resolveProjectAiwgDir } from '../config/project-artifacts.js';

export const REPO_ACCESS_MANIFEST_PATHS = [
  '.aiwg/ops/security/repo-access.manifest.yaml',
  '.aiwg/security/repo-access.manifest.yaml',
] as const;

export const REPO_ACCESS_ACTIONS = [
  ...WORKSPACE_REPO_ACTIONS,
] as const satisfies readonly WorkspaceRepoAction[];

export type RepoAccessAction = typeof REPO_ACCESS_ACTIONS[number];

export interface RepoAccessEntry {
  name: string;
  path: string;
  actions: RepoAccessAction[];
  provider?: 'gitea' | 'github' | 'gitlab';
  notes?: string;
}

export interface RepoAccessManifest {
  version: string;
  path: string;
  source: 'workspace-config' | 'legacy-manifest';
  /** Repository containing the workspace config (before workspace.root). */
  workspaceProjectRoot: string;
  projectRoot: string;
  workspaceName?: string;
  defaultPolicy: 'deny';
  repos: RepoAccessEntry[];
}

export interface RepoAccessDecision {
  allowed: boolean;
  action: RepoAccessAction;
  requestedPath: string;
  matchedRepo: RepoAccessEntry | null;
  reason: string;
}

const ACTION_SET = new Set<string>(REPO_ACCESS_ACTIONS);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function findProjectRootFromManifest(manifestPath: string): string {
  const normalized = manifestPath.replace(/\\/g, '/');
  if (normalized.endsWith('/.aiwg/aiwg.config')) {
    return resolve(dirname(manifestPath), '..');
  }
  if (normalized.endsWith('/.aiwg/ops/security/repo-access.manifest.yaml')) {
    return resolve(dirname(manifestPath), '..', '..', '..');
  }
  if (normalized.endsWith('/.aiwg/security/repo-access.manifest.yaml')) {
    return resolve(dirname(manifestPath), '..', '..');
  }
  return resolve(dirname(manifestPath));
}

export function findRepoAccessManifest(startDir = process.cwd()): string | null {
  const explicitWorkspace = process.env.AIWG_WORKSPACE;
  if (explicitWorkspace) {
    const expanded = explicitWorkspace === '~'
      ? homedir()
      : explicitWorkspace.startsWith('~/') || explicitWorkspace.startsWith('~\\')
        ? resolve(homedir(), explicitWorkspace.slice(2))
        : explicitWorkspace;
    const explicitConfig = join(resolveProjectAiwgDir(expanded), 'aiwg.config');
    if (existsSync(explicitConfig)) {
      const parsed = JSON.parse(readFileSync(explicitConfig, 'utf8')) as Record<string, unknown>;
      if (Array.isArray(parsed.repos)) return explicitConfig;
    }
  }

  let current = resolve(startDir);
  while (true) {
    const workspaceConfig = join(resolveProjectAiwgDir(current), 'aiwg.config');
    if (existsSync(workspaceConfig)) {
      try {
        const parsed = JSON.parse(readFileSync(workspaceConfig, 'utf8')) as Record<string, unknown>;
        if (Array.isArray(parsed.repos)) return workspaceConfig;
        if (isObject(parsed.workspace) && typeof parsed.workspace.member_of === 'string') {
          const memberOf = parsed.workspace.member_of;
          const expanded = memberOf === '~'
            ? homedir()
            : memberOf.startsWith('~/') || memberOf.startsWith('~\\')
              ? resolve(homedir(), memberOf.slice(2))
              : memberOf;
          const workspaceRoot = isAbsolute(expanded)
            ? resolve(expanded)
            : resolve(current, expanded);
          const parentConfig = join(resolveProjectAiwgDir(workspaceRoot), 'aiwg.config');
          if (existsSync(parentConfig)) {
            const parent = JSON.parse(readFileSync(parentConfig, 'utf8')) as Record<string, unknown>;
            if (Array.isArray(parent.repos)) return parentConfig;
          }
        }
      } catch {
        // Fail closed: a malformed nearer config must not silently fall through
        // to a broader legacy authorization manifest.
        return workspaceConfig;
      }
    }
    for (const manifestRel of REPO_ACCESS_MANIFEST_PATHS) {
      const candidate = resolve(current, manifestRel);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function normalizeAction(action: unknown): RepoAccessAction {
  if (typeof action !== 'string' || !ACTION_SET.has(action)) {
    throw new Error(`Invalid repo access action: ${String(action)}`);
  }
  return action as RepoAccessAction;
}

function normalizeRepoEntry(entry: unknown, index: number, projectRoot: string): RepoAccessEntry {
  if (!isObject(entry)) throw new Error(`repos[${index}] must be an object`);
  const name = entry.name;
  const repoPath = entry.path;
  const rawActions = entry.allowed ?? entry.actions ?? entry.permissions;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`repos[${index}].name is required`);
  }
  if (typeof repoPath !== 'string' || !repoPath.trim()) {
    throw new Error(`repos[${index}].path is required`);
  }
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    throw new Error(`repos[${index}].actions must be a non-empty array`);
  }
  const resolvedPath = isAbsolute(repoPath)
    ? resolve(repoPath)
    : resolve(projectRoot, repoPath);
  return {
    name: name.trim(),
    path: resolvedPath,
    actions: rawActions.map(normalizeAction),
    provider: ['gitea', 'github', 'gitlab'].includes(String(entry.provider))
      ? entry.provider as RepoAccessEntry['provider']
      : undefined,
    notes: typeof entry.notes === 'string' ? entry.notes : undefined,
  };
}

export function loadRepoAccessManifest(startDir = process.cwd()): RepoAccessManifest {
  const manifestPath = findRepoAccessManifest(startDir);
  if (!manifestPath) {
    throw new Error(
      'Repo access manifest not found. Expected .aiwg/aiwg.config workspace + repos blocks (canonical). '
      + `Legacy compatibility fallbacks: ${REPO_ACCESS_MANIFEST_PATHS.join(' or ')}. `
      + 'Register a repo with aiwg repo-access add --path <repo-or-file> --name <name> --allow read,write.'
    );
  }
  const workspaceProjectRoot = findProjectRootFromManifest(manifestPath);
  const isWorkspaceConfig = manifestPath.endsWith('/.aiwg/aiwg.config')
    || manifestPath.endsWith('\\.aiwg\\aiwg.config');
  const raw = isWorkspaceConfig
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : loadYaml(readFileSync(manifestPath, 'utf8'));
  if (!isObject(raw)) throw new Error('Repo access manifest must be an object');
  const repos = raw.repos;
  if (!Array.isArray(repos)) throw new Error('repo access manifest requires repos: []');
  const defaultPolicy = raw.defaultPolicy ?? raw.default_policy ?? 'deny';
  if (defaultPolicy !== 'deny') {
    throw new Error('repo access manifest default policy must be deny');
  }
  const workspace = isObject(raw.workspace) ? raw.workspace : undefined;
  const configuredRoot = workspace && typeof workspace.root === 'string'
    ? workspace.root
    : undefined;
  const expandedRoot = configuredRoot === '~'
    ? homedir()
    : configuredRoot?.startsWith('~/') || configuredRoot?.startsWith('~\\')
      ? resolve(homedir(), configuredRoot.slice(2))
      : configuredRoot;
  const projectRoot = expandedRoot
    ? isAbsolute(expandedRoot)
      ? resolve(expandedRoot)
      : resolve(workspaceProjectRoot, expandedRoot)
    : workspaceProjectRoot;
  return {
    version: typeof raw.version === 'string' ? raw.version : '1',
    path: manifestPath,
    source: isWorkspaceConfig ? 'workspace-config' : 'legacy-manifest',
    workspaceProjectRoot,
    projectRoot,
    workspaceName: workspace && typeof workspace.name === 'string'
      ? workspace.name
      : undefined,
    defaultPolicy: 'deny',
    repos: repos.map((entry, index) => normalizeRepoEntry(entry, index, projectRoot)),
  };
}

function isSameOrInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function findRepoEntry(manifest: RepoAccessManifest, requestedPath: string, cwd = process.cwd()): RepoAccessEntry | null {
  const resolved = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(cwd, requestedPath);
  const matches = manifest.repos
    .filter((entry) => isSameOrInside(resolved, entry.path))
    .sort((a, b) => b.path.length - a.path.length);
  return matches[0] ?? null;
}

export function checkRepoAccess(
  manifest: RepoAccessManifest,
  requestedPath: string,
  action: RepoAccessAction,
  cwd = process.cwd(),
): RepoAccessDecision {
  const normalizedAction = normalizeAction(action);
  const resolved = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(cwd, requestedPath);
  const matchedRepo = findRepoEntry(manifest, resolved, cwd);
  if (!matchedRepo) {
    return {
      allowed: false,
      action: normalizedAction,
      requestedPath: resolved,
      matchedRepo: null,
      reason: 'unlisted repo/path defaults to denied',
    };
  }
  if (!matchedRepo.actions.includes(normalizedAction)) {
    return {
      allowed: false,
      action: normalizedAction,
      requestedPath: resolved,
      matchedRepo,
      reason: `repo '${matchedRepo.name}' does not allow ${normalizedAction}`,
    };
  }
  return {
    allowed: true,
    action: normalizedAction,
    requestedPath: resolved,
    matchedRepo,
    reason: `repo '${matchedRepo.name}' allows ${normalizedAction}`,
  };
}

export function formatRepoAccessEntry(entry: RepoAccessEntry): string {
  const notes = entry.notes ? ` — ${entry.notes}` : '';
  return `${entry.name}: ${entry.path} [${entry.actions.join(', ')}]${notes}`;
}
