/**
 * Tests for usage aggregator utilities
 */

import {
  aggregateModelUsage,
  estimateContextUsage,
  DEFAULT_CONTEXT_WINDOWS,
  type UsageStats,
  type ModelStats,
} from '../../../main/parsers/usage-aggregator';

describe('aggregateModelUsage', () => {
  it('should aggregate model usage from multiple models', () => {
    const modelUsage: Record<string, ModelStats> = {
      'claude-3-5-sonnet': {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 100,
        contextWindow: 200000,
      },
      'claude-3-haiku': {
        inputTokens: 500,
        outputTokens: 250,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 25,
        contextWindow: 200000,
      },
    };

    const result = aggregateModelUsage(modelUsage, {}, 0.05);

    expect(result.inputTokens).toBe(1500);
    expect(result.outputTokens).toBe(750);
    expect(result.cacheReadInputTokens).toBe(250);
    expect(result.cacheCreationInputTokens).toBe(125);
    expect(result.totalCostUsd).toBe(0.05);
    expect(result.contextWindow).toBe(200000);
  });

  it('should fall back to top-level usage when modelUsage is empty', () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
    };

    const result = aggregateModelUsage(undefined, usage, 0.02);

    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(500);
    expect(result.cacheReadInputTokens).toBe(100);
    expect(result.cacheCreationInputTokens).toBe(50);
    expect(result.totalCostUsd).toBe(0.02);
    expect(result.contextWindow).toBe(200000);
  });

  it('should use default context window of 200000', () => {
    const result = aggregateModelUsage(undefined, {}, 0);
    expect(result.contextWindow).toBe(200000);
  });

  it('should use highest context window from models', () => {
    const modelUsage: Record<string, ModelStats> = {
      model1: { inputTokens: 100, contextWindow: 150000 },
      model2: { inputTokens: 100, contextWindow: 300000 },
      model3: { inputTokens: 100, contextWindow: 250000 },
    };

    const result = aggregateModelUsage(modelUsage, {}, 0);
    expect(result.contextWindow).toBe(300000);
  });
});

describe('estimateContextUsage', () => {
  const createStats = (overrides: Partial<UsageStats> = {}): UsageStats => ({
    inputTokens: 10000,
    outputTokens: 5000,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalCostUsd: 0.01,
    contextWindow: 0,
    ...overrides,
  });

  describe('when contextWindow is provided', () => {
    it('should calculate percentage from provided context window', () => {
      const stats = createStats({ contextWindow: 100000 });
      const result = estimateContextUsage(stats, 'claude-code');
      expect(result).toBe(15);
    });

    it('should cap at 100%', () => {
      const stats = createStats({
        inputTokens: 150000,
        outputTokens: 100000,
        contextWindow: 200000,
      });
      const result = estimateContextUsage(stats, 'claude-code');
      expect(result).toBe(100);
    });
  });

  describe('when contextWindow is not provided (fallback)', () => {
    it('should use claude-code default context window (200k)', () => {
      const stats = createStats({ contextWindow: 0 });
      const result = estimateContextUsage(stats, 'claude-code');
      expect(result).toBe(8);
    });

    it('should use codex default context window (200k)', () => {
      const stats = createStats({ contextWindow: 0 });
      const result = estimateContextUsage(stats, 'codex');
      expect(result).toBe(8);
    });

    it('should use opencode default context window (128k)', () => {
      const stats = createStats({ contextWindow: 0 });
      const result = estimateContextUsage(stats, 'opencode');
      expect(result).toBe(12);
    });

    it('should return null for terminal agent', () => {
      const stats = createStats({ contextWindow: 0 });
      const result = estimateContextUsage(stats, 'terminal');
      expect(result).toBeNull();
    });

    it('should return null when no agent specified', () => {
      const stats = createStats({ contextWindow: 0 });
      const result = estimateContextUsage(stats);
      expect(result).toBeNull();
    });

    it('should return 0 when no tokens used', () => {
      const stats = createStats({
        inputTokens: 0,
        outputTokens: 0,
        contextWindow: 0,
      });
      const result = estimateContextUsage(stats, 'claude-code');
      expect(result).toBe(0);
    });
  });
});

describe('DEFAULT_CONTEXT_WINDOWS', () => {
  it('should have context windows defined for all known agent types', () => {
    expect(DEFAULT_CONTEXT_WINDOWS['claude-code']).toBe(200000);
    expect(DEFAULT_CONTEXT_WINDOWS['claude']).toBe(200000);
    expect(DEFAULT_CONTEXT_WINDOWS['codex']).toBe(200000);
    expect(DEFAULT_CONTEXT_WINDOWS['opencode']).toBe(128000);
    expect(DEFAULT_CONTEXT_WINDOWS['aider']).toBe(128000);
    expect(DEFAULT_CONTEXT_WINDOWS['terminal']).toBe(0);
  });
});
