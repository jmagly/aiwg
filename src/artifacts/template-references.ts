// Extract concrete template paths and resolve them within their owning bundle.
import path from 'node:path';

export function isTemplateReference(value: string): boolean {
  return /(?:^|\/)templates\//.test(value) && /\.[\w-]+$/.test(value);
}

export function extractTemplateReferences(content: string): string[] {
  const references = new Set<string>();
  // Scan whole tokens once: do not restart an unanchored path regex at every
  // character of a long non-matching path. Code samples also contain references.
  for (const match of content.matchAll(/[^\s`"'()[\]{},;:<>|\\]+/g)) {
    const token = match[0].replace(/^@/, '').replace(/[.!?]+$/, '').split('#')[0];
    if (!/^(?:\$AIWG_ROOT\/|\.{1,2}\/|[\w-])/.test(token)) continue;
    if (!/^[\w$./-]+$/.test(token) || !isTemplateReference(token)) continue;
    references.add(token);
  }
  return [...references];
}

export function sourceBundleRoot(sourcePath: string): string | undefined {
  return sourcePath.replace(/\\/g, '/').match(
    /^(.*?(?:agentic\/code|\.aiwg)\/(?:addons|frameworks|extensions)\/[^/]+)\//,
  )?.[1];
}

/** Ordered repo-relative candidates, shared by graph resolution and linting. */
export function templateReferenceCandidates(sourcePath: string, reference: string): string[] {
  const target = reference.replace(/^@/, '');
  if (target.startsWith('$AIWG_ROOT/')) return [path.posix.normalize(target.slice(11))];
  if (target.startsWith('agentic/')) return [path.posix.normalize(target)];
  if (target.startsWith('./') || target.startsWith('../')) {
    return [path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), target))];
  }
  const bundle = sourceBundleRoot(sourcePath);
  if (target.startsWith('templates/')) return bundle ? [`${bundle}/${target}`] : [target];
  // Explicit <bundle>/templates/... shorthand may name a sibling bundle.
  if (/^[\w-]+\/(?:[\w-]+\/)*templates\//.test(target)) {
    return ['frameworks', 'addons', 'extensions'].map(group => `agentic/code/${group}/${target}`);
  }
  return [path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), target))];
}
