import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GraphBackend } from '../../src/artifacts/graph-backend.js';
import { JsonGraphBackend } from '../../src/artifacts/backends/json-backend.js';
import { GraphologyBackend } from '../../src/artifacts/backends/graphology-backend.js';
import { SqliteGraphBackend } from '../../src/artifacts/backends/sqlite-backend.js';
import { backendUnavailable } from '../helpers/sqlite.js';

interface GoldenDataset {
  schemaVersion: string;
  datasetId: string;
  declared: { nodes: number; edges: number; edgeTypes: Record<string, number>; updates: number; deletes: number };
  nodes: Array<{ id: string; attrs: Record<string, unknown> }>;
  edges: Array<{ source: string; target: string; type: string }>;
  updates: Array<{ id: string; attrs: Record<string, unknown> }>;
  delete: { id: string };
  expected: Record<string, string[]>;
}

const fixture = JSON.parse(readFileSync(fileURLToPath(
  new URL('../fixtures/storage/backend-golden-v1.json', import.meta.url),
), 'utf8')) as GoldenDataset;

describe('versioned storage backend golden dataset (#2191)', () => {
  it('declares internally consistent counts and topology', () => {
    expect(fixture.schemaVersion).toBe('aiwg.storage-backend-golden/v1');
    expect(fixture.nodes).toHaveLength(fixture.declared.nodes);
    expect(fixture.edges).toHaveLength(fixture.declared.edges);
    expect(fixture.updates).toHaveLength(fixture.declared.updates);
    expect(fixture.declared.deletes).toBe(1);
    expect(Object.values(fixture.declared.edgeTypes).reduce((sum, count) => sum + count, 0)).toBe(fixture.declared.edges);
  });

  for (const backend of ['json', 'graphology', 'sqlite'] as const) {
    it.skipIf(backendUnavailable(backend))(`${backend} preserves CRUD, Unicode, null attributes, traversal, and set parity`, async () => {
      const graph = await createBackend(backend);
      try {
        loadFixture(graph);
        expect(graph.nodeCount()).toBe(fixture.declared.nodes);
        expect(graph.edgeCount()).toBe(fixture.declared.edges);
        expect(graph.getNodeAttrs('東京')).toMatchObject({ title: '東京', summary: 'Unicode retained' });
        expect(graph.getNodeAttrs('null-value')).toMatchObject({ phase: null, title: null });
        expect(graph.nodes()).toEqual(fixture.expected.orderedIds);
        expect(graph.queryNodes({ type: 'feature', phase: 'construction' })).toEqual(fixture.expected.constructionFeatures);
        expect(graph.queryNodes({ phase: null })).toEqual(fixture.expected.nullPhase);
        const first = graph.pageNodes(3);
        const second = graph.pageNodes(3, first.nextCursor);
        const third = graph.pageNodes(3, second.nextCursor);
        expect(first).toEqual({ nodes: fixture.expected.orderedIds.slice(0, 3), nextCursor: 'delete-me' });
        expect(second).toEqual({ nodes: fixture.expected.orderedIds.slice(3, 6), nextCursor: 'root' });
        expect(third).toEqual({ nodes: fixture.expected.orderedIds.slice(6) });
        expect(sorted(graph.neighbors('root', 'out', 'depends-on'))).toEqual(fixture.expected.rootOutDependsOn);
        expect(sorted(graph.neighbors('東京', 'in', 'depends-on'))).toEqual(fixture.expected.tokyoInDependsOn);
        expect(sorted(graph.intersection(['alpha', 'beta', '東京'], ['beta', '東京']))).toEqual(fixture.expected.intersection);
        expect(sorted(graph.difference(['alpha', 'beta'], ['beta']))).toEqual(fixture.expected.difference);
        expect(sorted(graph.union(['alpha', '東京'], ['beta', 'emoji-🧪']))).toEqual(fixture.expected.union);
        expect(graph.getNodeAttrs('updated')).toMatchObject({ type: 'feature', phase: 'construction', title: 'After' });

        const serialized = graph.serialize();
        delete serialized[fixture.delete.id];
        for (const node of Object.values(serialized)) {
          node.upstream = node.upstream.filter(edge => (typeof edge === 'string' ? edge : edge.path) !== fixture.delete.id);
          node.downstream = node.downstream.filter(edge => (typeof edge === 'string' ? edge : edge.path) !== fixture.delete.id);
        }
        graph.deserialize(serialized);
        expect(graph.hasNode(fixture.delete.id)).toBe(false);
        expect(graph.nodeCount()).toBe(fixture.declared.nodes - 1);
      } finally {
        await graph.close?.();
      }
    });
  }
});

function loadFixture(graph: GraphBackend): void {
  for (const node of fixture.nodes) graph.addNode(node.id, node.attrs);
  for (const edge of fixture.edges) graph.addEdge(edge.source, edge.target, edge.type);
  for (const update of fixture.updates) graph.addNode(update.id, update.attrs);
}

async function createBackend(backend: 'json' | 'graphology' | 'sqlite'): Promise<GraphBackend> {
  if (backend === 'json') return new JsonGraphBackend();
  if (backend === 'graphology') return GraphologyBackend.create();
  return new SqliteGraphBackend(':memory:');
}

function sorted(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}
