/**
 * Unit tests for Token Counter
 *
 * @source @src/metrics/token-counter.ts
 * @issue #173
 */

import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  countNonBlankLines,
  countTotalLines,
  countTokens,
  evaluateThreshold,
  analyzeTokenEfficiency,
  CHARS_PER_TOKEN,
  BENCHMARK_TOKENS_PER_LINE,
  BASELINE_TOKENS_PER_LINE,
  GREEN_MAX_TOKENS_PER_LINE,
  YELLOW_MAX_TOKENS_PER_LINE,
} from '../../../src/metrics/token-counter.js';

describe('Token Counter', () => {
  describe('estimateTokens', () => {
    it('should return 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('should estimate tokens using 4 chars/token heuristic', () => {
      expect(estimateTokens('hello world!')).toBe(3);
    });

    it('should ceil partial tokens', () => {
      expect(estimateTokens('hello')).toBe(2);
    });

    it('should handle single character', () => {
      expect(estimateTokens('a')).toBe(1);
    });

    it('should handle exactly divisible content', () => {
      expect(estimateTokens('abcdefgh')).toBe(2);
    });
  });

  describe('countNonBlankLines', () => {
    it('should return 0 for empty string', () => {
      expect(countNonBlankLines('')).toBe(0);
    });

    it('should count lines with content', () => {
      expect(countNonBlankLines('line1\nline2\nline3')).toBe(3);
    });

    it('should exclude blank lines', () => {
      expect(countNonBlankLines('line1\n\nline2\n\n\nline3')).toBe(3);
    });

    it('should exclude whitespace-only lines', () => {
      expect(countNonBlankLines('line1\n   \n\t\nline2')).toBe(2);
    });
  });

  describe('countTotalLines', () => {
    it('should return 0 for empty string', () => {
      expect(countTotalLines('')).toBe(0);
    });

    it('should count all lines including blank', () => {
      expect(countTotalLines('a\n\nb\n')).toBe(4);
    });

    it('should count single line', () => {
      expect(countTotalLines('hello')).toBe(1);
    });
  });

  describe('countTokens', () => {
    it('should return zero metrics for empty content', () => {
      const result = countTokens('');
      expect(result.tokens).toBe(0);
      expect(result.characters).toBe(0);
      expect(result.nonBlankLines).toBe(0);
      expect(result.totalLines).toBe(0);
      expect(result.tokensPerLine).toBe(0);
    });

    it('should calculate complete token metrics', () => {
      const content = 'hello world test\n\nfoo bar baz test';
      const result = countTokens(content);

      expect(result).toEqual({
        tokens: 9, characters: 34, nonBlankLines: 2, totalLines: 3, tokensPerLine: 4.5,
      });
    });

    it('should round tokensPerLine to 2 decimal places', () => {
      const result = countTokens('a\nb\nc');
      expect(result).toEqual({
        tokens: 2, characters: 5, nonBlankLines: 3, totalLines: 3, tokensPerLine: 0.67,
      });
    });
  });

  describe('evaluateThreshold', () => {
    it('should return green for values at or below benchmark', () => {
      const result = evaluateThreshold(100);
      expect(result.level).toBe('green');
      expect(result.action).toBe('none');
    });

    it('should return green at exactly 124', () => {
      const result = evaluateThreshold(GREEN_MAX_TOKENS_PER_LINE);
      expect(result.level).toBe('green');
    });

    it('should return yellow for values between 125 and 150', () => {
      const result = evaluateThreshold(135);
      expect(result.level).toBe('yellow');
      expect(result.action).toBe('flag_for_review');
    });

    it('should return yellow at exactly 150', () => {
      const result = evaluateThreshold(YELLOW_MAX_TOKENS_PER_LINE);
      expect(result.level).toBe('yellow');
    });

    it('should return red for values above 150', () => {
      const result = evaluateThreshold(200);
      expect(result.level).toBe('red');
      expect(result.action).toBe('generate_recommendations');
    });

    it('should return green for zero', () => {
      const result = evaluateThreshold(0);
      expect(result.level).toBe('green');
    });
  });

  describe('analyzeTokenEfficiency', () => {
    it('should include threshold status', () => {
      const result = analyzeTokenEfficiency('short line\nanother line');
      expect(result.threshold).toEqual({ level: 'green', action: 'none', message: 'Meeting benchmark' });
    });

    it('should calculate benchmark comparison', () => {
      const result = analyzeTokenEfficiency('test content');
      expect(result.tokensPerLine).toBe(3);
      expect(result.vsBenchmark).toBe(-97.58);
      expect(result.vsBaseline).toBe(-98.5);
    });

    it.each([
      [124, 'green', 'none', 'Meeting benchmark', 0, -38],
      [135, 'yellow', 'flag_for_review', 'Review for optimization', 8.87, -32.5],
      [200, 'red', 'generate_recommendations', 'Requires optimization', 61.29, 0],
    ] as const)('should compose exact efficiency metrics for %i tokens per line',
      (tokens, level, action, message, vsBenchmark, vsBaseline) => {
        expect(analyzeTokenEfficiency('a'.repeat(tokens * 4))).toEqual({
          tokens, characters: tokens * 4, nonBlankLines: 1, totalLines: 1, tokensPerLine: tokens,
          threshold: { level, action, message }, vsBenchmark, vsBaseline,
        });
      });

    it('should return zero comparisons for empty content', () => {
      const result = analyzeTokenEfficiency('');
      expect(result.vsBenchmark).toBe(0);
      expect(result.vsBaseline).toBe(0);
    });

    it('should show negative vsBenchmark for efficient content', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
      const result = analyzeTokenEfficiency(lines);
      expect(result.vsBenchmark).toBeLessThan(0);
    });
  });

  describe('constants', () => {
    it('should have correct CHARS_PER_TOKEN', () => {
      expect(CHARS_PER_TOKEN).toBe(4);
    });

    it('should have correct benchmark', () => {
      expect(BENCHMARK_TOKENS_PER_LINE).toBe(124);
    });

    it('should have correct baseline', () => {
      expect(BASELINE_TOKENS_PER_LINE).toBe(200);
    });
  });
});
