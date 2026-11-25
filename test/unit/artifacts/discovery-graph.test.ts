// Verify offline edge construction, spreading activation, and seeded negative controls.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildDiscoveryGraph, controlDiscoveryGraph, rankDiscoveryGraph, actrActivation,
  type OfflineGraphInput,
} from '../../../src/artifacts/discovery-graph.js';
import type { MetadataEntry } from '../../../src/artifacts/types.js';
import { summarizeCommunities } from '../../../src/artifacts/discovery-graph-communities.js';

const fixture = JSON.parse(fs.readFileSync(new URL('../../fixtures/artifacts/discovery-graph-synthetic.json', import.meta.url), 'utf8')) as OfflineGraphInput;
const entry = (name: string, type = 'skill'): MetadataEntry => ({
  path: name, name, title: name, type, summary: name, phase: '', tags: [],
  created: '', updated: '', checksum: '', dependencies: [], dependents: [],
});
const entries = [entry('a'), entry('b', 'rule'), entry('c', 'memory'), entry('d'), entry('e', 'agent')];
const degrees = (graph: ReturnType<typeof buildDiscoveryGraph>) => graph.nodes.map(node =>
  graph.edges.filter(edge => edge.source === node.path || edge.target === node.path).length);

describe('experimental offline discovery graph', () => {
  it('uses only active skills, rules and memories and never derives observations from text', () => {
    const inactive = { ...entry('retired', 'memory'), memoryRecord: { lifecycle: 'retired' } } as MetadataEntry;
    const graph = buildDiscoveryGraph([...entries, inactive]);
    expect(graph.nodes.map(node => node.path)).toEqual(['a', 'b', 'c', 'd']);
    expect(graph.edges).toEqual([]);
    expect(graph.communities).toHaveLength(4);
  });

  it('keeps positive PMI and prunes supplied similarities by shared nearest neighbours', () => {
    const graph = buildDiscoveryGraph(entries, fixture);
    expect(graph.edges.find(edge => edge.source === 'a' && edge.target === 'b')?.weight)
      .toBeCloseTo(Math.log(2.5) + 0.9);
    // a/c co-use PMI is negative; only its shared-neighbour similarity survives.
    expect(graph.edges.find(edge => edge.source === 'a' && edge.target === 'c')?.weight).toBeCloseTo(0.7);
    expect(graph.edges.find(edge => edge.source === 'b' && edge.target === 'c')?.weight).toBeCloseTo(0.8);
    expect(graph.edges.some(edge => edge.source === 'd' || edge.target === 'd')).toBe(false);
  });

  it.each([
    { coUse: { windows: 0, occurrences: {}, pairs: [] } },
    { coUse: { windows: 10, occurrences: { a: 3, b: 3 }, pairs: [{ source: 'a', target: 'b', count: 4 }] } },
    { similarities: [{ source: 'a', target: 'b', similarity: Number.NaN }] },
    { nearestNeighbours: -1 },
    { uses: { a: [1001] }, nowSeconds: 1000 },
  ])('rejects invalid supplied offline data: %j', input => {
    expect(() => buildDiscoveryGraph(entries, input)).toThrow(/offline graph/i);
  });

  it('does not connect unknown identifiers, unsupported types, or self loops', () => {
    const graph = buildDiscoveryGraph(entries, {
      coUse: { windows: 100, occurrences: { a: 10, b: 10, e: 10, unknown: 10 }, pairs: [
        { source: 'a', target: 'a', count: 5 }, { source: 'a', target: 'e', count: 5 },
        { source: 'a', target: 'unknown', count: 5 },
      ] },
    });
    expect(graph.edges).toEqual([]);
  });

  it('spreads lexical activation across types before projecting to eligible results', () => {
    const graph = buildDiscoveryGraph(entries, fixture);
    const ranked = rankDiscoveryGraph(graph, [{ entry: entries[0], score: 1 }], [entries[0], entries[2]], 'a');
    expect(ranked.map(result => result.entry.path)).toEqual(['a', 'c']);
    expect(ranked[1].score).toBeGreaterThan(0);
    expect(ranked.some(result => result.entry.type === 'rule')).toBe(false);
    expect(rankDiscoveryGraph(graph, [], entries, 'unrelated')).toEqual([]);
  });

  it('preserves lexical results exactly for an edgeless graph, including non-node types', () => {
    const lexical = [{ entry: entries[4], score: 0.7 }, { entry: entries[0], score: 0.2 }];
    expect(rankDiscoveryGraph(buildDiscoveryGraph(entries), lexical, entries, 'query')).toEqual(lexical);
  });

  it('deduplicates logical identities introduced by graph expansion', () => {
    const duplicate = { ...entries[2], path: 'copy-c' };
    const graph = buildDiscoveryGraph([...entries, duplicate], { coUse: {
      windows: 100, occurrences: { a: 20, c: 20, 'copy-c': 20 },
      pairs: [{ source: 'a', target: 'c', count: 10 }, { source: 'a', target: 'copy-c', count: 10 }],
    } });
    expect(rankDiscoveryGraph(graph, [{ entry: entries[0], score: 1 }], [entries[2], duplicate], 'a')).toHaveLength(1);
  });

  it('uses supplied ages only for ACT-R recency/frequency decay', () => {
    expect(actrActivation([900, 990], 1000)).toBeCloseTo(Math.log(0.1 + 1 / Math.sqrt(10)));
    expect(actrActivation([990, 995], 1000)).toBeGreaterThan(actrActivation([900], 1000));
    expect(actrActivation([], 1000)).toBe(0);
    expect(rankDiscoveryGraph(buildDiscoveryGraph(entries, fixture), [{ entry: entries[0], score: 1 }], entries, 'a'))
      .toEqual(rankDiscoveryGraph(buildDiscoveryGraph(entries, fixture), [{ entry: entries[0], score: 1 }], entries, 'a'));
  });

  it('constructs connected community summaries without a model service', () => {
    const graph = buildDiscoveryGraph(entries, fixture);
    expect(graph.communities.some(group => group.members.length > 1)).toBe(true);
    expect(graph.communities.flatMap(group => group.members).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(graph.communities.every(group => typeof group.summary === 'string')).toBe(true);
  });

  it('refines and aggregates dense communities separated by a weak bridge', () => {
    const nodes = Array.from({ length: 8 }, (_, i) => entry(String(i)));
    const edges = nodes.flatMap((a, i) => nodes.slice(i + 1).filter(b => Math.floor(i / 4) === Math.floor(Number(b.path) / 4))
      .map(b => ({ source: a.path, target: b.path, weight: 1 })));
    edges.push({ source: '3', target: '4', weight: 0.01 });
    const communities = summarizeCommunities({ nodes, edges });
    expect(communities.map(group => group.members)).toEqual([['0', '1', '2', '3'], ['4', '5', '6', '7']]);
  });

  it('rewires with exact node degrees and shuffles labels reproducibly with fixed seeds', () => {
    const many = Array.from({ length: 12 }, (_, i) => entry(String(i)));
    const input: OfflineGraphInput = { coUse: { windows: 100, occurrences: Object.fromEntries(many.map(node => [node.path, 10])),
      pairs: many.map((node, i) => ({ source: node.path, target: many[(i + 1) % many.length].path, count: 5 })) } };
    const graph = buildDiscoveryGraph(many, input);
    const random = controlDiscoveryGraph(graph, 'degree-matched-random', 3319);
    expect(degrees(random)).toEqual(degrees(graph));
    expect(random.edges).not.toEqual(graph.edges);
    expect(controlDiscoveryGraph(graph, 'degree-matched-random', 3319)).toEqual(random);
    const shuffled = controlDiscoveryGraph(graph, 'shuffled-graph', 3319);
    expect(shuffled.edges).not.toEqual(graph.edges);
    expect(shuffled.edges.map(edge => edge.weight).sort()).toEqual(graph.edges.map(edge => edge.weight).sort());
    expect(controlDiscoveryGraph(graph, 'shuffled-graph', 3319)).toEqual(shuffled);
    expect(controlDiscoveryGraph(graph, 'shuffled-graph', 42).edges).not.toEqual(shuffled.edges);
    expect(graph.edges).toHaveLength(12);
  });
});
