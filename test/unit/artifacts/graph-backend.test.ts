/**
 * Graph Backend Abstraction Tests
 *
 * @source @src/artifacts/graph-backend.ts
 * @source @src/artifacts/backends/json-backend.ts
 * @implements #727
 */

import { describe, it, expect, vi } from 'vitest';
import * as featureRuntime from '../../../src/features/runtime.js';
import { SqliteGraphBackend } from '../../../src/artifacts/backends/sqlite-backend.js';
import { JsonGraphBackend } from '../../../src/artifacts/backends/json-backend.js';
import { createGraphBackend } from '../../../src/artifacts/graph-backend.js';
import type { DependencyGraph } from '../../../src/artifacts/types.js';

describe('JsonGraphBackend', () => {
  describe('addNode / hasNode', () => {
    it('adds and detects nodes', () => {
      const g = new JsonGraphBackend();
      expect(g.hasNode('A')).toBe(false);
      g.addNode('A');
      expect(g.hasNode('A')).toBe(true);
      expect(g.nodeCount()).toBe(1);
    });

    it('stores node attributes', () => {
      const g = new JsonGraphBackend();
      g.addNode('A', { type: 'paper', year: 2024 });
      expect(g.getNodeAttrs('A')).toEqual({ type: 'paper', year: 2024 });
    });

    it('merges attributes on duplicate addNode', () => {
      const g = new JsonGraphBackend();
      g.addNode('A', { type: 'paper' });
      g.addNode('A', { year: 2024 });
      expect(g.getNodeAttrs('A')).toEqual({ type: 'paper', year: 2024 });
    });

    it('returns undefined attrs for missing node', () => {
      const g = new JsonGraphBackend();
      expect(g.getNodeAttrs('missing')).toBeUndefined();
    });
  });

  describe('addEdge / hasEdge', () => {
    it('creates directed edges and auto-creates nodes', () => {
      const g = new JsonGraphBackend();
      g.addEdge('A', 'B', 'cites');
      expect(g.hasNode('A')).toBe(true);
      expect(g.hasNode('B')).toBe(true);
      expect(g.hasEdge('A', 'B')).toBe(true);
      expect(g.hasEdge('A', 'B', 'cites')).toBe(true);
      expect(g.hasEdge('B', 'A')).toBe(false);
      expect(g.edgeCount()).toBe(1);
    });

    it('filters hasEdge by type', () => {
      const g = new JsonGraphBackend();
      g.addEdge('A', 'B', 'cites');
      expect(g.hasEdge('A', 'B', 'depends-on')).toBe(false);
      expect(g.hasEdge('A', 'B', 'cites')).toBe(true);
    });

    it('defaults edge type to depends-on', () => {
      const g = new JsonGraphBackend();
      g.addEdge('A', 'B');
      expect(g.hasEdge('A', 'B', 'depends-on')).toBe(true);
    });
  });

  describe('neighbors', () => {
    it('returns outbound neighbors', () => {
      const g = new JsonGraphBackend();
      g.addEdge('A', 'B', 'cites');
      g.addEdge('A', 'C', 'cites');
      g.addEdge('D', 'A', 'cites');

      expect(g.neighbors('A', 'out')).toEqual(expect.arrayContaining(['B', 'C']));
      expect(g.neighbors('A', 'out')).toHaveLength(2);
    });

    it('returns inbound neighbors', () => {
      const g = new JsonGraphBackend();
      g.addEdge('A', 'B', 'cites');
      g.addEdge('C', 'B', 'depends-on');

      expect(g.neighbors('B', 'in')).toEqual(expect.arrayContaining(['A', 'C']));
      expect(g.neighbors('B', 'in')).toHaveLength(2);
    });

    it('returns both directions', () => {
      const g = new JsonGraphBackend();
      g.addEdge('A', 'B', 'cites');
      g.addEdge('C', 'A', 'depends-on');

      const both = g.neighbors('A', 'both');
      expect(both).toEqual(expect.arrayContaining(['B', 'C']));
      expect(both).toHaveLength(2);
    });

    it('filters by edge type', () => {
      const g = new JsonGraphBackend();
      g.addEdge('A', 'B', 'cites');
      g.addEdge('A', 'C', 'depends-on');

      expect(g.neighbors('A', 'out', 'cites')).toEqual(['B']);
      expect(g.neighbors('A', 'out', 'depends-on')).toEqual(['C']);
    });

    it('returns empty for missing node', () => {
      const g = new JsonGraphBackend();
      expect(g.neighbors('missing', 'both')).toEqual([]);
    });
  });

  describe('set operations', () => {
    const g = new JsonGraphBackend();

    it('computes intersection', () => {
      expect(g.intersection(['A', 'B', 'C'], ['B', 'C', 'D'])).toEqual(['B', 'C']);
    });

    it('computes difference', () => {
      expect(g.difference(['A', 'B', 'C'], ['B', 'C', 'D'])).toEqual(['A']);
    });

    it('computes union', () => {
      const result = g.union(['A', 'B'], ['B', 'C']);
      expect(result).toEqual(expect.arrayContaining(['A', 'B', 'C']));
      expect(result).toHaveLength(3);
    });

    it('handles empty sets', () => {
      expect(g.intersection([], ['A'])).toEqual([]);
      expect(g.difference(['A'], [])).toEqual(['A']);
      expect(g.union([], [])).toEqual([]);
    });
  });

  describe('serialize / deserialize', () => {
    it('round-trips through DependencyGraph format', () => {
      const g = new JsonGraphBackend();
      g.addEdge('A', 'B', 'cites');
      g.addEdge('A', 'C', 'depends-on');
      g.addEdge('D', 'A', 'cited-by');

      const serialized = g.serialize();

      const g2 = new JsonGraphBackend();
      g2.deserialize(serialized);

      expect(g2.hasNode('A')).toBe(true);
      expect(g2.hasNode('B')).toBe(true);
      expect(g2.hasNode('C')).toBe(true);
      expect(g2.hasNode('D')).toBe(true);
      expect(g2.neighbors('A', 'out')).toEqual(expect.arrayContaining(['B', 'C']));
      expect(g2.neighbors('A', 'in')).toEqual(expect.arrayContaining(['D']));
      expect(g2.nodeCount()).toBe(g.nodeCount());
      expect(g2.edgeCount()).toBe(g.edgeCount());
    });

    it('deserializes legacy string edges as depends-on', () => {
      const legacy: DependencyGraph = {
        'A': {
          upstream: [{ path: 'B', type: 'depends-on' }],
          downstream: [{ path: 'C', type: 'depends-on' }],
        },
        'B': { upstream: [], downstream: [{ path: 'A', type: 'depends-on' }] },
        'C': { upstream: [{ path: 'A', type: 'depends-on' }], downstream: [] },
      };

      const g = new JsonGraphBackend();
      g.deserialize(legacy);

      expect(g.hasNode('A')).toBe(true);
      expect(g.neighbors('A', 'in')).toContain('B');
      expect(g.neighbors('A', 'out')).toContain('C');
    });

    it('creates nodes for edges referencing missing nodes', () => {
      const partial: DependencyGraph = {
        'A': {
          upstream: [{ path: 'B', type: 'cites' }],
          downstream: [],
        },
      };

      const g = new JsonGraphBackend();
      g.deserialize(partial);

      expect(g.hasNode('A')).toBe(true);
      expect(g.hasNode('B')).toBe(true);
    });
  });

  describe('nodes()', () => {
    it('lists all node IDs', () => {
      const g = new JsonGraphBackend();
      g.addNode('X');
      g.addEdge('A', 'B');

      const nodeList = g.nodes();
      expect(nodeList).toEqual(expect.arrayContaining(['X', 'A', 'B']));
      expect(nodeList).toHaveLength(3);
    });
  });
});

describe('createGraphBackend', () => {
  it('creates json backend by default', async () => {
    const backend = await createGraphBackend();
    expect(backend.nodeCount()).toBe(0);
    backend.addNode('test');
    expect(backend.hasNode('test')).toBe(true);
  });

  it('creates json backend explicitly', async () => {
    const backend = await createGraphBackend('json');
    expect(backend.nodeCount()).toBe(0);
  });

  it('creates or throws for graphology backend', async () => {
    let available = true;
    try {
      await import('graphology');
    } catch {
      available = false;
    }
    if (available) {
      const backend = await createGraphBackend('graphology');
      expect(backend.nodeCount()).toBe(0);
    } else {
      await expect(createGraphBackend('graphology')).rejects.toThrow(/aiwg features install graph/);
    }
  });

  it('creates a real sqlite backend through the supported package resolver', async () => {
    const backend = await createGraphBackend('sqlite');
    try {
      expect(backend).toBeInstanceOf(SqliteGraphBackend);
      expect(backend.nodeCount()).toBe(0);
      backend.addNode('fixture');
      expect(backend.hasNode('fixture')).toBe(true);
      expect(backend.nodeCount()).toBe(1);
    } finally { await backend.close?.(); }
  });

  it('reports remediation when the sqlite package resolver fails', async () => {
    const resolver = vi.spyOn(featureRuntime, 'requireFeaturePackage').mockImplementation(() => {
      throw new Error('synthetic unavailable native dependency');
    });
    try {
      await expect(createGraphBackend('sqlite')).rejects.toThrow(/aiwg features install sqlite/);
      expect(resolver).toHaveBeenCalledExactlyOnceWith('better-sqlite3');
    } finally { resolver.mockRestore(); }
  });

  it('throws for unknown backend', async () => {
    // @ts-expect-error testing invalid input
    await expect(createGraphBackend('unknown')).rejects.toThrow(/Unknown graph backend/);
  });
});
