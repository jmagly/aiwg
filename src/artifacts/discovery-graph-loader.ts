// Load optional offline fixture observations through the existing graph metadata reader.
import type { ArtifactIndex, GraphType, MetadataEntry } from './types.js';
import { loadGraphIndexFile } from './index-reader.js';
import { buildDiscoveryGraph, type DiscoveryGraph } from './discovery-graph.js';
import { summarizeCommunities } from './discovery-graph-communities.js';

export function loadOfflineDiscoveryGraph(cwd: string, entries: MetadataEntry[], graph?: GraphType): DiscoveryGraph {
  const graphs = graph ? [graph] : [...new Set(entries.map(entry =>
    (entry as MetadataEntry & { indexGraph?: GraphType }).indexGraph).filter((name): name is GraphType => Boolean(name)))];
  if (!graphs.length) return buildDiscoveryGraph(entries);
  const parts = graphs.map(name => {
    const index = loadGraphIndexFile<ArtifactIndex>(cwd, 'metadata.json', name);
    const local = entries.filter(entry => !('indexGraph' in entry) || entry.indexGraph === name);
    return buildDiscoveryGraph(local, index?.experimentalGraph);
  });
  const result: DiscoveryGraph = {
    nodes: [...new Map(parts.flatMap(part => part.nodes).map(node => [node.path, node])).values()],
    edges: parts.flatMap(part => part.edges), communities: [], uses: {}, nowSeconds: 0,
  };
  // Normalize independent fixture clocks to ages before merging graph partitions.
  for (const part of parts) for (const [node, times] of Object.entries(part.uses)) {
    result.uses[node] = times.map(time => time - part.nowSeconds);
  }
  result.communities = summarizeCommunities(result);
  return result;
}
