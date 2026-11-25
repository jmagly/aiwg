// Partition the offline graph with modularity local moves, Leiden refinement, and aggregation.
import type { DiscoveryGraph } from './discovery-graph.js';

interface Level {
  links: Map<number, Map<number, number>>;
  atoms: Map<number, string[]>;
}
const sum = (values: Iterable<number>) => [...values].reduce((total, value) => total + value, 0);
function groups(partition: Map<number, number>): Map<number, number[]> {
  const result = new Map<number, number[]>();
  for (const [node, label] of partition) {
    const group = result.get(label) ?? []; group.push(node); result.set(label, group);
  }
  return result;
}

function localMove(level: Level, partition: Map<number, number>, degrees: Map<number, number>, total: number): boolean {
  const volumes = new Map([...groups(partition)].map(([label, nodes]) => [label, sum(nodes.map(node => degrees.get(node)!))]));
  let changed = false; let nextLabel = Math.max(...partition.values(), 0) + 1;
  for (let pass = 0; pass < 100; pass++) {
    let moved = false;
    for (const [node, links] of level.links) {
      const old = partition.get(node)!; const degree = degrees.get(node)!;
      volumes.set(old, volumes.get(old)! - degree);
      const weights = new Map<number, number>([[old, 0]]);
      for (const [neighbour, weight] of links) {
        if (neighbour === node) continue; // Self loops cancel in a move's gain.
        const label = partition.get(neighbour)!;
        weights.set(label, (weights.get(label) ?? 0) + weight);
      }
      let best = old; let gain = (weights.get(old) ?? 0) - degree * volumes.get(old)! / total;
      // A fresh singleton allows a node to leave its aggregate-level seed community.
      if (gain < -1e-12) { best = nextLabel; gain = 0; }
      for (const [label, weight] of [...weights].sort(([a], [b]) => a - b)) {
        const candidate = weight - degree * (volumes.get(label) ?? 0) / total;
        if (candidate > gain + 1e-12) { best = label; gain = candidate; }
      }
      if (best === nextLabel) nextLabel++;
      partition.set(node, best); volumes.set(best, (volumes.get(best) ?? 0) + degree);
      if (best !== old) moved = true;
    }
    changed ||= moved;
    if (!moved) break;
  }
  return changed;
}

/** Refine inside each moved community from singletons, merging only well-connected subsets. */
function refine(level: Level, partition: Map<number, number>, degrees: Map<number, number>, total: number): Map<number, number> {
  const refined = new Map([...partition.keys()].map(node => [node, node]));
  for (const members of groups(partition).values()) {
    const allowed = new Set(members);
    const volume = sum(members.map(node => degrees.get(node)!));
    const sizes = new Map(members.map(node => [node, 1]));
    const volumes = new Map(members.map(node => [node, degrees.get(node)!]));
    const boundary = (subset: number[]) => {
      const set = new Set(subset);
      return sum(subset.flatMap(node => [...level.links.get(node)!]
        .filter(([target]) => allowed.has(target) && !set.has(target)).map(([, weight]) => weight)));
    };
    for (const node of members) {
      const own = refined.get(node)!; const degree = degrees.get(node)!;
      if (sizes.get(own)! !== 1 || boundary([node]) + 1e-12 < degree * (volume - degree) / total) continue;
      const weights = new Map<number, number>();
      for (const [target, weight] of level.links.get(node)!) {
        if (target !== node && allowed.has(target)) {
          const label = refined.get(target)!; weights.set(label, (weights.get(label) ?? 0) + weight);
        }
      }
      let best = own; let gain = 0;
      for (const [label, weight] of [...weights].sort(([a], [b]) => a - b)) {
        if (label === own) continue;
        const targetVolume = volumes.get(label)!;
        const subset = members.filter(member => refined.get(member) === label);
        if (boundary(subset) + 1e-12 < targetVolume * (volume - targetVolume) / total) continue;
        const candidate = weight - degree * targetVolume / total;
        // Deterministic maximum-gain selection is the zero-temperature refinement variant.
        if (candidate > gain + 1e-12) { best = label; gain = candidate; }
      }
      if (best !== own) {
        refined.set(node, best); sizes.set(own, 0); volumes.set(own, 0);
        sizes.set(best, sizes.get(best)! + 1); volumes.set(best, volumes.get(best)! + degree);
      }
    }
  }
  return refined;
}

function aggregate(level: Level, refined: Map<number, number>, partition: Map<number, number>): { level: Level; partition: Map<number, number> } {
  const links = new Map<number, Map<number, number>>(); const atoms = new Map<number, string[]>();
  const next = new Map<number, number>();
  for (const [label, nodes] of groups(refined)) {
    links.set(label, new Map()); atoms.set(label, nodes.flatMap(node => level.atoms.get(node)!));
    next.set(label, partition.get(nodes[0])!);
  }
  for (const [node, neighbours] of level.links) for (const [target, weight] of neighbours) {
    const from = refined.get(node)!; const to = refined.get(target)!; const list = links.get(from)!;
    list.set(to, (list.get(to) ?? 0) + weight);
  }
  return { level: { links, atoms }, partition: next };
}

/** In-house deterministic Leiden prototype, using weighted modularity at resolution 1. */
export function summarizeCommunities(graph: Pick<DiscoveryGraph, 'nodes' | 'edges'>): DiscoveryGraph['communities'] {
  const indices = new Map(graph.nodes.map((node, i) => [node.path, i]));
  let level: Level = { links: new Map(graph.nodes.map((_, i) => [i, new Map()])), atoms: new Map(graph.nodes.map((node, i) => [i, [node.path]])) };
  for (const edge of graph.edges) {
    const a = indices.get(edge.source)!; const b = indices.get(edge.target)!;
    level.links.get(a)!.set(b, (level.links.get(a)!.get(b) ?? 0) + edge.weight);
    level.links.get(b)!.set(a, (level.links.get(b)!.get(a) ?? 0) + edge.weight);
  }
  let partition = new Map([...level.links.keys()].map(node => [node, node]));
  for (let iteration = 0; iteration < 50; iteration++) {
    const degrees = new Map([...level.links].map(([node, links]) => [node, sum(links.values())]));
    const total = sum(degrees.values());
    if (!total || !localMove(level, partition, degrees, total)) break;
    const refined = refine(level, partition, degrees, total);
    if (new Set(refined.values()).size === level.links.size) break;
    ({ level, partition } = aggregate(level, refined, partition));
  }
  const byPath = new Map(graph.nodes.map(node => [node.path, node]));
  const members = [...groups(partition).values()].map(nodes => nodes.flatMap(node => level.atoms.get(node)!).sort());
  return members.sort((a, b) => a[0].localeCompare(b[0])).map(paths => ({ members: paths, summary: paths.map(member => {
    const entry = byPath.get(member)!;
    return `${entry.type}: ${entry.name ?? entry.title}. ${entry.capability ?? entry.summary}`;
  }).join('\n').slice(0, 2048) }));
}
