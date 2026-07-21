import { describe, expect, it } from 'vitest';
import { formatDurationDecimal } from '../../../cli/output/duration';
import { formatAgentDetail, type AgentDetailDisplay } from '../../../cli/output/formatter';

describe('CLI decimal duration format', () => {
	it.each([
		[-1, '-1ms'],
		[0, '0ms'],
		[999, '999ms'],
		[1_000, '1.0s'],
		[1_234, '1.2s'],
		[59_999, '60.0s'],
		[60_000, '1.0m'],
		[3_599_999, '60.0m'],
		[3_600_000, '1.0h'],
		[86_400_000, '24.0h'],
		[Infinity, 'Infinityh'],
		[Number.NaN, 'NaNh'],
	])('formats %s milliseconds as %s', (milliseconds, expected) => {
		expect(formatDurationDecimal(milliseconds)).toBe(expected);
	});

	it('preserves the agent detail duration output bytes', () => {
		const agent: AgentDetailDisplay = {
			id: 'agent-1',
			name: 'Agent',
			toolType: 'claude-code',
			cwd: '/workspace',
			stats: {
				historyEntries: 0,
				successCount: 0,
				failureCount: 0,
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalCacheReadTokens: 0,
				totalCacheCreationTokens: 0,
				totalCost: 0,
				totalElapsedMs: 86_400_000,
			},
			recentHistory: [],
		};

		expect(formatAgentDetail(agent)).toContain('  Total Time:    24.0h');
	});
});
