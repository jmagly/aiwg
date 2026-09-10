/**
 * Unit tests for Context Budget Manager
 *
 * @source @src/metrics/context-budget.ts
 * @issue #144
 */

import { describe, it, expect } from 'vitest';
import {
  ContextBudgetManager,
  calculatePriority,
} from '../../../src/metrics/context-budget.js';

describe('Context Budget Manager', () => {
  const PROJECT_PATH = '/tmp/test-project';

  describe('constructor', () => {
    it('should use default 70/30 split', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH);
      const config = mgr.getConfig();
      expect(config.contextFraction).toBe(0.70);
      expect(config.generationFraction).toBe(0.30);
    });

    it('should accept custom config', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH, {
        totalTokens: 100000,
        contextFraction: 0.60,
        generationFraction: 0.40,
      });
      expect(mgr.contextBudget).toBe(60000);
      expect(mgr.generationBudget).toBe(40000);
    });

    it('should throw if fractions do not sum to 1', () => {
      expect(() => {
        new ContextBudgetManager(PROJECT_PATH, {
          contextFraction: 0.60,
          generationFraction: 0.60,
        });
      }).toThrow('must sum to 1.0');
    });
  });

  describe('budget calculations', () => {
    it('should calculate context budget as 70% of total', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH, {
        totalTokens: 200000,
      });
      expect(mgr.contextBudget).toBe(140000);
    });

    it('should calculate generation budget as 30% of total', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH, {
        totalTokens: 200000,
      });
      expect(mgr.generationBudget).toBe(60000);
    });
  });

  describe('addItem', () => {
    it('should add an item with estimated tokens', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH);
      const item = mgr.addItem('test-1', 'hello world', 'user');
      expect(item.id).toBe('test-1');
      expect(item.tokens).toBeGreaterThan(0);
      expect(item.source.type).toBe('user');
    });

    it('should calculate priority based on source type', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH);

      const system = mgr.addItem('s', 'content', 'system');
      const mention = mgr.addItem('m', 'content', 'at-mention');
      const user = mgr.addItem('u', 'content', 'user');
      const auto = mgr.addItem('a', 'content', 'auto');

      expect(system.priority).toBeGreaterThan(mention.priority);
      expect(mention.priority).toBeGreaterThan(user.priority);
      expect(user.priority).toBeGreaterThan(auto.priority);
    });
  });

  describe('removeItem', () => {
    it('should remove an existing item', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH);
      mgr.addItem('test-1', 'hello', 'user');
      expect(mgr.removeItem('test-1')).toBe(true);
      expect(mgr.getItems()).toHaveLength(0);
    });

    it('should return false for non-existent item', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH);
      expect(mgr.removeItem('nonexistent')).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('should show ok status when empty', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH);
      const status = mgr.getStatus();
      expect(status.level).toBe('ok');
      expect(status.contextUsed).toBe(0);
      expect(status.itemCount).toBe(0);
    });

    it('should track token usage', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH);
      mgr.addItem('test-1', 'a'.repeat(400), 'user');
      const status = mgr.getStatus();
      expect(status.contextUsed).toBe(100);
    });

    it('should show warning when threshold exceeded', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH, {
        totalTokens: 1000,
        contextFraction: 0.70,
        generationFraction: 0.30,
        warningThreshold: 0.85,
        hardLimitThreshold: 0.95,
      });
      mgr.addItem('big', 'a'.repeat(2400), 'user');
      const status = mgr.getStatus();
      expect(status.level).toBe('warning');
    });

    it('should show critical when hard limit exceeded', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH, {
        totalTokens: 1000,
        contextFraction: 0.70,
        generationFraction: 0.30,
        warningThreshold: 0.85,
        hardLimitThreshold: 0.95,
      });
      mgr.addItem('big', 'a'.repeat(2680), 'user');
      const status = mgr.getStatus();
      expect(status.level).toBe('critical');
    });

    it('should show exceeded when over budget', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH, {
        totalTokens: 100,
        contextFraction: 0.70,
        generationFraction: 0.30,
      });
      mgr.addItem('huge', 'a'.repeat(400), 'user');
      const status = mgr.getStatus();
      expect(status.level).toBe('exceeded');
    });
  });

  describe('wouldExceed', () => {
    it('should return false when under budget', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH);
      expect(mgr.wouldExceed('small text')).toBe(false);
    });

    it('should return true when would exceed', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH, {
        totalTokens: 100,
        contextFraction: 0.70,
        generationFraction: 0.30,
      });
      expect(mgr.wouldExceed('a'.repeat(400))).toBe(true);
    });

    it('should include existing usage at the exact budget and one token beyond', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH, { totalTokens: 100 });
      mgr.addItem('existing', 'a'.repeat(160), 'user');
      expect(mgr.contextBudget).toBe(70);
      expect(mgr.getStatus().contextUsed).toBe(40);
      expect(mgr.wouldExceed('b'.repeat(120))).toBe(false);
      expect(mgr.wouldExceed('b'.repeat(124))).toBe(true);
      expect(mgr.getStatus().contextUsed).toBe(40);
    });
  });

  describe('degrade', () => {
    it('should drop lowest priority items first', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH, {
        totalTokens: 200,
        contextFraction: 0.70,
        generationFraction: 0.30,
        warningThreshold: 0.50,
      });
      mgr.addItem('auto-1', 'a'.repeat(200), 'auto');
      mgr.addItem('user-1', 'b'.repeat(200), 'user');
      mgr.addItem('mention-1', 'c'.repeat(200), 'at-mention');

      const result = mgr.degrade();

      expect(result.dropped.map(item => item.id)).toEqual(['auto-1', 'user-1']);
      expect(result.kept.map(item => item.id)).toEqual(['mention-1']);
      expect(result.tokensFreed).toBe(100);
      expect(mgr.getItems().map(item => item.id)).toEqual(['mention-1']);
      expect(mgr.getStatus()).toMatchObject({ contextUsed: 50, contextRemaining: 90, itemCount: 1 });
    });

    it('should never drop system items', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH, {
        totalTokens: 100,
        contextFraction: 0.70,
        generationFraction: 0.30,
        warningThreshold: 0.10,
      });
      mgr.addItem('sys', 'a'.repeat(200), 'system');
      mgr.addItem('auto', 'b'.repeat(200), 'auto');

      const result = mgr.degrade();

      expect(result.dropped.map(item => item.id)).toEqual(['auto']);
      expect(result.kept.map(item => item.id)).toEqual(['sys']);
      expect(result.tokensFreed).toBe(50);
      expect(mgr.getItems().map(item => item.id)).toEqual(['sys']);
      expect(mgr.getStatus()).toMatchObject({ contextUsed: 50, contextRemaining: 20, itemCount: 1 });
    });
  });

  describe('getItems', () => {
    it('should return items sorted by priority (highest first)', () => {
      const mgr = new ContextBudgetManager(PROJECT_PATH);
      mgr.addItem('auto', 'content', 'auto');
      mgr.addItem('mention', 'content', 'at-mention');
      mgr.addItem('user', 'content', 'user');

      const items = mgr.getItems();
      expect(items[0].id).toBe('mention');
      expect(items[items.length - 1].id).toBe('auto');
    });
  });
});

describe('calculatePriority', () => {
  it('should give system items highest priority', () => {
    expect(calculatePriority('system')).toBe(1.0);
  });

  it('should give at-mention items high priority', () => {
    expect(calculatePriority('at-mention')).toBe(0.9);
  });

  it('should give user items medium priority', () => {
    expect(calculatePriority('user')).toBe(0.7);
  });

  it('should give auto items lower priority', () => {
    expect(calculatePriority('auto')).toBe(0.5);
  });

  it('should add similarity bonus', () => {
    const withSimilarity = calculatePriority('auto', 0.8);
    const withoutSimilarity = calculatePriority('auto');
    expect(withSimilarity).toBeGreaterThan(withoutSimilarity);
  });

  it('should cap priority at 1.0', () => {
    const result = calculatePriority('system', 1.0);
    expect(result).toBeLessThanOrEqual(1.0);
  });
});
