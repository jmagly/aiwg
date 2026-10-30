// Find operational artifacts in the source corpus when indexes lack a match.

/**
 * Scan bundle `gate-packs/` directories for a pack matching `needle` (#2830).
 *
 * Accepts the full namespaced id, the rest-path or the short pack name and
 * probes `<bundle>/gate-packs/<pack>.gatepack.{yaml,yml,json}`. Never looks
 * under `gates/`, which agent-persistence HITL owns.
 */
export async function findGatePackInCorpus(
  groups: Array<{ kind: 'framework' | 'addon' | 'extension' | 'plugin'; dir: string }>,
  needle: string,
): Promise<{ path: string; bundleKind: 'framework' | 'addon' | 'extension' | 'plugin' | null; bundleId: string | null } | null> {
  const path = await import('node:path');
  const fsp = (await import('node:fs')).promises;
  const trimmed = needle.trim();
  const rest = trimmed.includes(':') ? trimmed.slice(trimmed.indexOf(':') + 1) : trimmed;
  const slash = rest.indexOf('/');
  const wantedBundle = slash >= 0 ? rest.slice(0, slash) : null;
  const wantedPack = slash >= 0 ? rest.slice(slash + 1) : rest;
  if (!wantedPack || /\s/.test(wantedPack) || wantedPack.includes(':') || wantedPack.includes('/')) return null;
  const extensions = ['.gatepack.yaml', '.gatepack.yml', '.gatepack.json'];
  const ordered = wantedBundle
    ? groups.flatMap(group => [{ group, bundle: wantedBundle }])
    : null;
  const probe = async (
    group: { kind: 'framework' | 'addon' | 'extension' | 'plugin'; dir: string },
    bundle: string,
  ): Promise<{ path: string; bundleKind: 'framework' | 'addon' | 'extension' | 'plugin' | null; bundleId: string | null } | null> => {
    for (const extension of extensions) {
      const candidate = path.join(group.dir, bundle, 'gate-packs', `${wantedPack}${extension}`);
      try {
        const stat = await fsp.stat(candidate);
        if (stat.isFile()) return { path: candidate, bundleKind: group.kind, bundleId: bundle };
      } catch {
        // not present — continue
      }
    }
    return null;
  };
  if (ordered) {
    for (const { group, bundle } of ordered) {
      const found = await probe(group, bundle);
      if (found) return found;
    }
    return null;
  }
  for (const group of groups) {
    let bundles: string[];
    try {
      bundles = (await fsp.readdir(group.dir, { withFileTypes: true }))
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
    } catch {
      continue;
    }
    for (const bundle of bundles) {
      const found = await probe(group, bundle);
      if (found) return found;
    }
  }
  return null;
}


/**
 * Scan the AIWG_ROOT corpus for an artifact matching `name` (#1221).
 *
 * Walks the well-known artifact layouts under
 * `agentic/code/{frameworks,addons,extensions,plugins}/<bundle>/{skills,agents,commands,rules,templates,behaviors,flows}/`
 * and returns the first match. Used as a fallback in `aiwg show` when an
 * artifact isn't in any built index — either because the workspace hasn't
 * been deployed to yet, or because the bundle hasn't been installed.
 *
 * Returns the resolved absolute path plus enough metadata for the caller
 * to surface a useful install hint. Returns null if nothing matches.
 */
export async function findCorpusArtifact(
  aiwgRoot: string,
  name: string,
  typeFilter: string[],
): Promise<{
  path: string;
  type: string;
  bundleKind: 'framework' | 'addon' | 'extension' | 'plugin' | null;
  bundleId: string | null;
} | null> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const fsp = fs.promises;

  const groups: Array<{ kind: 'framework' | 'addon' | 'extension' | 'plugin'; dir: string }> = [
    { kind: 'framework', dir: path.join(aiwgRoot, 'agentic/code/frameworks') },
    { kind: 'addon', dir: path.join(aiwgRoot, 'agentic/code/addons') },
    { kind: 'extension', dir: path.join(aiwgRoot, 'agentic/code/extensions') },
    { kind: 'plugin', dir: path.join(aiwgRoot, 'agentic/code/plugins') },
  ];

  // (subdir, type, layout) — 'flat' = `<name>.md`, 'slug' = `<name>/SKILL.md`
  const tries: Array<{ sub: string; type: string; layout: 'flat' | 'slug'; extension?: '.md' | '.json' | '.yaml' }> = [
    { sub: 'skills', type: 'skill', layout: 'slug' },
    { sub: 'skills', type: 'skill', layout: 'flat' },
    { sub: 'agents', type: 'agent', layout: 'flat' },
    { sub: 'commands', type: 'command', layout: 'flat' },
    { sub: 'rules', type: 'rule', layout: 'flat' },
    { sub: 'templates', type: 'template', layout: 'flat' },
    { sub: 'behaviors', type: 'behavior', layout: 'flat' },
    { sub: 'flows', type: 'flow', layout: 'flat' },
    { sub: 'runbooks', type: 'runbook', layout: 'flat' },
    { sub: 'decisions', type: 'decision-definition', layout: 'flat', extension: '.json' },
    { sub: 'rulesets', type: 'decision-ruleset', layout: 'flat', extension: '.json' },
    { sub: 'bindings', type: 'decision-binding', layout: 'flat', extension: '.json' },
  ];

  for (const group of groups) {
    let bundles: string[];
    try {
      bundles = (await fsp.readdir(group.dir, { withFileTypes: true }))
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      continue;
    }
    for (const bundle of bundles) {
      for (const t of tries) {
        if (typeFilter.length > 0 && !typeFilter.includes(t.type)) continue;
        const candidate = t.layout === 'slug'
          ? path.join(group.dir, bundle, t.sub, name, 'SKILL.md')
          : path.join(group.dir, bundle, t.sub, `${name}${t.extension ?? '.md'}`);
        try {
          const stat = await fsp.stat(candidate);
          if (stat.isFile()) {
            return { path: candidate, type: t.type, bundleKind: group.kind, bundleId: bundle };
          }
        } catch {
          // not present — continue
        }
      }
    }
  }

  // Gate packs live in `<bundle>/gate-packs/*.gatepack.yaml|json` (never
  // `gates/`, which agent-persistence HITL uses). The needle may be the full
  // namespaced id (`aiwg:decision-engine/integrity-ceiling`), the rest-path
  // (`decision-engine/integrity-ceiling`) or the short pack name
  // (`integrity-ceiling`). (#2830)
  if (typeFilter.length === 0 || typeFilter.includes('gate-pack')) {
    const gateMatch = await findGatePackInCorpus(groups, name);
    if (gateMatch) return { ...gateMatch, type: 'gate-pack' };
  }

  // Top-level agents live at `agentic/code/agents/<category>/<name>.md`
  // (e.g. `personas/aiwg-writer.md`) — a flat-under-category layout the
  // bundle groups above do not cover. Scan it directly so persona/agent
  // `show` survives un-indexed (or stale-framework-index) workspaces, where
  // the corpus fallback is the only resolution path. (#1623 U5)
  if (typeFilter.length === 0 || typeFilter.includes('agent')) {
    const agentMatch = await findAgentInCorpus(
      path.join(aiwgRoot, 'agentic/code/agents'),
      name,
    );
    if (agentMatch) {
      return { path: agentMatch, type: 'agent', bundleKind: null, bundleId: null };
    }
  }

  // Behaviors commonly use a slug layout: `behaviors/<name>/BEHAVIOR.md`.
  if (typeFilter.length === 0 || typeFilter.includes('behavior')) {
    for (const group of groups) {
      let bundles: string[];
      try {
        bundles = (await fsp.readdir(group.dir, { withFileTypes: true }))
          .filter(d => d.isDirectory())
          .map(d => d.name);
      } catch {
        continue;
      }
      for (const bundle of bundles) {
        const candidate = path.join(group.dir, bundle, 'behaviors', name, 'BEHAVIOR.md');
        try {
          const stat = await fsp.stat(candidate);
          if (stat.isFile()) {
            return { path: candidate, type: 'behavior', bundleKind: group.kind, bundleId: bundle };
          }
        } catch {
          // not present — continue
        }
      }
    }
  }

  return null;
}


/**
 * Recursively scan `agentic/code/agents` for a flat `<name>.md` agent file.
 *
 * Agents use an `agents/<category>/<name>.md` layout (e.g. `personas/`) that
 * differs from the bundle `<dir>/<bundle>/<sub>/<name>.md` layout the generic
 * corpus scan walks, so persona agents are otherwise missed. Bounded depth —
 * the agents tree is shallow. Returns the first matching absolute path, or
 * null. Direct files at each level take priority over subdirectories. (#1623)
 */
export async function findAgentInCorpus(
  agentsRoot: string,
  name: string,
  depth = 0,
): Promise<string | null> {
  if (depth > 3) return null;
  const fs = await import('node:fs');
  const path = await import('node:path');
  const fsp = fs.promises;

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(agentsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  // Prefer a direct `<name>.md` at this level before descending.
  for (const entry of entries) {
    if (entry.isFile() && entry.name === `${name}.md`) {
      return path.join(agentsRoot, entry.name);
    }
  }
  // Descend into category subdirectories (e.g. personas/).
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findAgentInCorpus(path.join(agentsRoot, entry.name), name, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
