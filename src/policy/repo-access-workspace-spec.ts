// Adapt itops workspace declarations without creating a competing authorization source.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import type { RepoAccessEntry } from './repo-access.js';

export const WORKSPACE_SPEC_PATH = 'config/workspace.yaml';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function workspaceSpecPath(root: string): string | null {
  const candidate = join(root, WORKSPACE_SPEC_PATH);
  return existsSync(candidate) ? candidate : null;
}

export function readWorkspaceSpec(path: string): { repos: unknown[]; workspaceName?: string } {
  const raw = loadYaml(readFileSync(path, 'utf8'));
  if (!object(raw) || raw.apiVersion !== 'workspace.aiwg.io/v1' || raw.kind !== 'WorkspaceSpec') {
    throw new Error(`${path}: expected workspace.aiwg.io/v1 WorkspaceSpec`);
  }
  if (!Array.isArray(raw.repos)) throw new Error(`${path}: requires repos: []`);
  const entries = [...raw.repos];
  const routingPath = join(dirname(path), 'repository-routing.yaml');
  if (existsSync(routingPath)) {
    const routing = loadYaml(readFileSync(routingPath, 'utf8'));
    if (!object(routing) || !Array.isArray(routing.repositories)) {
      throw new Error(`${routingPath}: requires repositories: []`);
    }
    entries.push(...routing.repositories);
  }
  return {
    workspaceName: object(raw.metadata) && typeof raw.metadata.name === 'string' ? raw.metadata.name : undefined,
    repos: entries.map(entry => object(entry) ? {
      ...entry,
      // Membership authorizes local reads/edits, never implicit push or destructive work.
      allowed: entry.allowed ?? entry.actions ?? entry.permissions ?? ['read', 'write'],
    } : entry),
  };
}

export function mergeSpecRepos(entries: RepoAccessEntry[]): RepoAccessEntry[] {
  const result: RepoAccessEntry[] = [];
  for (const entry of entries) {
    const previous = result.find(repo => repo.path === entry.path || repo.name === entry.name);
    if (!previous) {
      result.push(entry);
    } else {
      if (previous.path !== entry.path || previous.name !== entry.name) {
        throw new Error(`Conflicting workspace spec repository: ${entry.name} (${entry.path})`);
      }
      previous.actions = previous.actions.filter(action => entry.actions.includes(action));
    }
  }
  return result;
}

export function workspaceSpecEdit(path: string, name: string, repoPath?: string, allowed?: string[]): string {
  const root = resolve(dirname(path), '..');
  const routing = join(dirname(path), 'repository-routing.yaml');
  const edit = repoPath === undefined ? `Remove the entry named ${JSON.stringify(name)}.`
    : `Add or update this entry (paths relative to ${root}):\n  - name: ${JSON.stringify(name)}\n    path: ${JSON.stringify(relative(root, repoPath) || '.')}`;
  const requested = allowed ? `Requested actions: ${allowed.join(', ')}. ` : '';
  return `${requested}Workspace spec is managed externally. Edit ${path} repos[] and ${routing} repositories[].\n${edit}\n`
    + 'Membership defaults to read,write; preserve any explicit allowed restrictions. No files were changed.';
}
