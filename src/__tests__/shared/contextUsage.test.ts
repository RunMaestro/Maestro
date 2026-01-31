/**
 * Tests for the Context Usage Estimation Utilities.
 *
 * These tests verify:
 * - DEFAULT_CONTEXT_WINDOWS constant values
 * - COMBINED_CONTEXT_AGENTS membership
 * - calculateContextTokens() with various agent types and token fields
 * - estimateContextUsage() percentage calculation, fallback logic, and capping
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_CONTEXT_WINDOWS,
	COMBINED_CONTEXT_AGENTS,
	calculateContextTokens,
	estimateContextUsage,
	type ContextUsageStats,
} from '../../shared/contextUsage';

describe('DEFAULT_CONTEXT_WINDOWS', () => {
	it('should have the correct context window for claude-code', () => {
		expect(DEFAULT_CONTEXT_WINDOWS['claude-code']).toBe(200000);
	});

	it('should have the correct context window for codex', () => {
		expect(DEFAULT_CONTEXT_WINDOWS['codex']).toBe(200000);
	});

	it('should have the correct context window for opencode', () => {
		expect(DEFAULT_CONTEXT_WINDOWS['opencode']).toBe(128000);
	});

	it('should have the correct context window for factory-droid', () => {
		expect(DEFAULT_CONTEXT_WINDOWS['factory-droid']).toBe(200000);
	});

	it('should have zero context window for terminal', () => {
		expect(DEFAULT_CONTEXT_WINDOWS['terminal']).toBe(0);
	});

	it('should have entries for all expected agent types', () => {
		const expectedKeys = ['claude-code', 'codex', 'opencode', 'factory-droid', 'terminal'];
		expect(Object.keys(DEFAULT_CONTEXT_WINDOWS).sort()).toEqual(expectedKeys.sort());
	});
});

describe('COMBINED_CONTEXT_AGENTS', () => {
	it('should contain codex', () => {
		expect(COMBINED_CONTEXT_AGENTS.has('codex')).toBe(true);
	});

	it('should not contain claude-code', () => {
		expect(COMBINED_CONTEXT_AGENTS.has('claude-code')).toBe(false);
	});

	it('should not contain opencode', () => {
		expect(COMBINED_CONTEXT_AGENTS.has('opencode')).toBe(false);
	});

	it('should not contain factory-droid', () => {
		expect(COMBINED_CONTEXT_AGENTS.has('factory-droid')).toBe(false);
	});

	it('should not contain terminal', () => {
		expect(COMBINED_CONTEXT_AGENTS.has('terminal')).toBe(false);
	});

	it('should have exactly one member', () => {
		expect(COMBINED_CONTEXT_AGENTS.size).toBe(1);
	});
});

describe('calculateContextTokens', () => {
	it('should calculate Claude-style tokens: input + cacheRead + cacheCreation (no output)', () => {
		const stats: ContextUsageStats = {
			inputTokens: 1000,
			cacheReadInputTokens: 5000,
			cacheCreationInputTokens: 2000,
			outputTokens: 3000,
		};
		const result = calculateContextTokens(stats, 'claude-code');
		expect(result).toBe(8000); // 1000 + 5000 + 2000, output excluded
	});

	it('should calculate Codex tokens: input + cacheRead + cacheCreation + output (combined)', () => {
		const stats: ContextUsageStats = {
			inputTokens: 1000,
			cacheReadInputTokens: 5000,
			cacheCreationInputTokens: 2000,
			outputTokens: 3000,
		};
		const result = calculateContextTokens(stats, 'codex');
		expect(result).toBe(11000); // 1000 + 5000 + 2000 + 3000
	});

	it('should default missing token fields to 0', () => {
		const stats: ContextUsageStats = {
			inputTokens: 500,
		};
		const result = calculateContextTokens(stats, 'claude-code');
		expect(result).toBe(500); // 500 + 0 + 0
	});

	it('should handle all undefined token fields', () => {
		const stats: ContextUsageStats = {};
		const result = calculateContextTokens(stats, 'claude-code');
		expect(result).toBe(0);
	});

	it('should use base formula for terminal agent', () => {
		const stats: ContextUsageStats = {
			inputTokens: 100,
			cacheReadInputTokens: 200,
			cacheCreationInputTokens: 300,
			outputTokens: 400,
		};
		const result = calculateContextTokens(stats, 'terminal');
		expect(result).toBe(600); // 100 + 200 + 300, no output
	});

	it('should use base formula when no agentId is provided', () => {
		const stats: ContextUsageStats = {
			inputTokens: 100,
			cacheReadInputTokens: 200,
			cacheCreationInputTokens: 300,
			outputTokens: 400,
		};
		const result = calculateContextTokens(stats);
		expect(result).toBe(600); // 100 + 200 + 300, no output
	});

	it('should return 0 when all tokens are zero', () => {
		const stats: ContextUsageStats = {
			inputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
		};
		const result = calculateContextTokens(stats, 'claude-code');
		expect(result).toBe(0);
	});

	it('should use base formula for opencode agent', () => {
		const stats: ContextUsageStats = {
			inputTokens: 1000,
			cacheReadInputTokens: 2000,
			cacheCreationInputTokens: 500,
			outputTokens: 1500,
		};
		const result = calculateContextTokens(stats, 'opencode');
		expect(result).toBe(3500); // 1000 + 2000 + 500, output excluded
	});

	it('should use base formula for factory-droid agent', () => {
		const stats: ContextUsageStats = {
			inputTokens: 1000,
			outputTokens: 2000,
		};
		const result = calculateContextTokens(stats, 'factory-droid');
		expect(result).toBe(1000); // only input, no cacheRead or cacheCreation
	});

	it('should default outputTokens to 0 for codex when undefined', () => {
		const stats: ContextUsageStats = {
			inputTokens: 1000,
		};
		const result = calculateContextTokens(stats, 'codex');
		expect(result).toBe(1000); // 1000 + 0 + 0 + 0
	});
});

describe('estimateContextUsage', () => {
	it('should use contextWindow from stats when provided', () => {
		const stats: ContextUsageStats = {
			inputTokens: 5000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			contextWindow: 10000,
		};
		const result = estimateContextUsage(stats, 'claude-code');
		expect(result).toBe(50); // 5000 / 10000 * 100 = 50%
	});

	it('should fall back to DEFAULT_CONTEXT_WINDOWS when no contextWindow in stats', () => {
		const stats: ContextUsageStats = {
			inputTokens: 100000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		};
		const result = estimateContextUsage(stats, 'claude-code');
		// 100000 / 200000 * 100 = 50%
		expect(result).toBe(50);
	});

	it('should return null for terminal agent', () => {
		const stats: ContextUsageStats = {
			inputTokens: 100,
		};
		const result = estimateContextUsage(stats, 'terminal');
		expect(result).toBeNull();
	});

	it('should return null when no agentId and no contextWindow', () => {
		const stats: ContextUsageStats = {
			inputTokens: 100,
		};
		const result = estimateContextUsage(stats);
		expect(result).toBeNull();
	});

	it('should return 0 when all tokens are 0', () => {
		const stats: ContextUsageStats = {
			inputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
		};
		const result = estimateContextUsage(stats, 'claude-code');
		expect(result).toBe(0);
	});

	it('should cap at 100% when tokens exceed context window', () => {
		const stats: ContextUsageStats = {
			inputTokens: 300000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		};
		const result = estimateContextUsage(stats, 'claude-code');
		// 300000 / 200000 * 100 = 150%, capped at 100
		expect(result).toBe(100);
	});

	it('should cap at 100% when using stats contextWindow', () => {
		const stats: ContextUsageStats = {
			inputTokens: 15000,
			contextWindow: 10000,
		};
		const result = estimateContextUsage(stats, 'claude-code');
		expect(result).toBe(100);
	});

	it('should calculate ~50% usage for claude-code agent', () => {
		const stats: ContextUsageStats = {
			inputTokens: 50000,
			cacheReadInputTokens: 30000,
			cacheCreationInputTokens: 20000,
		};
		const result = estimateContextUsage(stats, 'claude-code');
		// (50000 + 30000 + 20000) / 200000 * 100 = 50%
		expect(result).toBe(50);
	});

	it('should include output tokens in calculation for codex agent', () => {
		const stats: ContextUsageStats = {
			inputTokens: 50000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 50000,
		};
		const result = estimateContextUsage(stats, 'codex');
		// (50000 + 0 + 0 + 50000) / 200000 * 100 = 50%
		expect(result).toBe(50);
	});

	it('should use contextWindow from stats even without agentId', () => {
		const stats: ContextUsageStats = {
			inputTokens: 5000,
			contextWindow: 10000,
		};
		const result = estimateContextUsage(stats);
		// 5000 / 10000 * 100 = 50%
		expect(result).toBe(50);
	});

	it('should round the percentage to nearest integer', () => {
		const stats: ContextUsageStats = {
			inputTokens: 33333,
			contextWindow: 100000,
		};
		const result = estimateContextUsage(stats, 'claude-code');
		// 33333 / 100000 * 100 = 33.333 => rounded to 33
		expect(result).toBe(33);
	});

	it('should use opencode default context window of 128000', () => {
		const stats: ContextUsageStats = {
			inputTokens: 64000,
		};
		const result = estimateContextUsage(stats, 'opencode');
		// 64000 / 128000 * 100 = 50%
		expect(result).toBe(50);
	});

	it('should return null for unknown agent without contextWindow', () => {
		const stats: ContextUsageStats = {
			inputTokens: 100,
		};
		// Cast to bypass type checking for an unknown agent
		const result = estimateContextUsage(stats, 'unknown-agent' as any);
		expect(result).toBeNull();
	});

	it('should handle contextWindow of 0 by falling back to defaults', () => {
		const stats: ContextUsageStats = {
			inputTokens: 100000,
			contextWindow: 0,
		};
		const result = estimateContextUsage(stats, 'claude-code');
		// contextWindow is 0 (falsy), falls back to default 200000
		// 100000 / 200000 * 100 = 50%
		expect(result).toBe(50);
	});
});
