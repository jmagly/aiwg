// Resolve indexed file and declarative Flow references without per-edge scans.
import path from 'node:path';
import type { MetadataEntry } from './types.js';
import { isTemplateReference, sourceBundleRoot, templateReferenceCandidates } from './template-references.js';

export function extractFlowDependencies(spec: unknown): string[] {
  const result = new Set<string>();
  const pending: unknown[] = [spec];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (['body', 'content', 'script', 'source', 'template'].includes(key)) continue;
      const kind = key === 'agent' ? 'agent'
        : /^(?:capability|rollback[_-]?capability|playbook|flow)$/.test(key) ? 'flow' : undefined;
      if (kind && typeof child === 'string' && /^[\w.-]+$/.test(child)) result.add(`${kind}:${child}`);
      else if (child && typeof child === 'object') pending.push(child);
    }
  }
  return [...result];
}

function register(map: Map<string, string | null>, key: string, value: string): void {
  if (!map.has(key)) map.set(key, value);
  else if (map.get(key) !== value) map.set(key, null);
}

export function createDependencyResolver(entries: Record<string, MetadataEntry>): (source: string, dep: string) => string | undefined {
  const suffixes = new Map<string, string | null>();
  const names = new Map<string, string | null>();
  for (const entry of Object.values(entries)) {
    const file = entry.path;
    for (let offset = file.indexOf('/'); offset >= 0; offset = file.indexOf('/', offset + 1)) {
      register(suffixes, file.slice(offset + 1), file);
    }
    if (['agent', 'flow', 'runbook'].includes(entry.type)) {
      // Flow agent fields use file slugs even when frontmatter names are titles
      // (for example, project-manager.md declares name: Project Manager).
      const basename = path.posix.basename(file);
      const slug = /^(AGENT|FLOW)\.md$/i.test(basename)
        ? path.posix.basename(path.posix.dirname(file)) : basename.replace(/\.[^.]+$/, '');
      for (const alias of new Set([entry.name, slug].filter(Boolean))) {
        const name = `${entry.type === 'agent' ? 'agent' : 'flow'}:${alias}`;
        register(names, name, file);
        register(names, `${sourceBundleRoot(file) ?? ''}|${name}`, file);
      }
    }
  }
  return (source, dep) => {
    if (isTemplateReference(dep)) {
      return templateReferenceCandidates(source, dep).find(candidate => entries[candidate]);
    }
    if (/^(agent|flow):/.test(dep)) {
      const local = `${sourceBundleRoot(source) ?? ''}|${dep}`;
      return (names.has(local) ? names.get(local) : names.get(dep)) ?? undefined;
    }
    return entries[dep] ? dep : suffixes.get(dep) ?? undefined;
  };
}
