import { describe, expect, it } from 'vitest';
import type { AITabRecord, AgentRecord } from '../../../shared/maestro-lib';
import {
	CONTEXT_DANGER_PERCENT,
	STATUS_SEPARATOR,
	buildStatusSegments,
	contextSegment,
	fitStatusSegments,
	readUsageStats,
	statusLineWidth,
} from '../statusSegments';

const agent = (extra: Record<string, unknown> = {}): AgentRecord => ({
	id: 'a1',
	name: 'Agent',
	toolType: 'claude-code',
	...extra,
});

const tab = (extra: Record<string, unknown> = {}): AITabRecord => ({ id: 't1', ...extra });

const usage = (extra: Record<string, unknown> = {}) => ({
	inputTokens: 1_000,
	outputTokens: 500,
	cacheReadInputTokens: 80_000,
	cacheCreationInputTokens: 3_000,
	totalCostUsd: 1.5,
	contextWindow: 200_000,
	...extra,
});

const text = (segments: ReturnType<typeof buildStatusSegments>) =>
	segments.map((s) => s.text).join(STATUS_SEPARATOR);

describe('readUsageStats', () => {
	it('keeps numeric counts and zeroes anything else', () => {
		expect(readUsageStats({ inputTokens: 5, outputTokens: 'x', totalCostUsd: NaN })).toMatchObject({
			inputTokens: 5,
			outputTokens: 0,
			totalCostUsd: 0,
		});
	});

	it('answers undefined for a value that is not an object', () => {
		expect(readUsageStats(undefined)).toBeUndefined();
		expect(readUsageStats(null)).toBeUndefined();
		expect(readUsageStats('1')).toBeUndefined();
	});
});

describe('buildStatusSegments', () => {
	it('formats fixed usage data: provider, model, effort, context, cost', () => {
		const segments = buildStatusSegments(
			agent({ customModel: 'opus', customEffort: 'high' }),
			tab({ usageStats: usage() })
		);
		expect(text(segments)).toBe('Claude Code · opus · high · ctx 42% (84.0K/200.0K) · $1.50');
	});

	it('prefers the tab model and effort over the agent defaults', () => {
		const segments = buildStatusSegments(
			agent({ customModel: 'opus', customEffort: 'high' }),
			tab({ customModel: 'sonnet', customEffort: 'low', usageStats: usage() })
		);
		expect(segments.map((s) => s.text).slice(1, 3)).toEqual(['sonnet', 'low']);
	});

	it('names the defaults when nothing is set', () => {
		const segments = buildStatusSegments(agent(), tab({ usageStats: usage() }));
		expect(segments.map((s) => s.text).slice(1, 3)).toEqual(['default model', 'default effort']);
	});

	it('shows a dash for context and cost before any turn has reported usage', () => {
		const segments = buildStatusSegments(agent(), tab());
		expect(segments.slice(3).map((s) => s.text)).toEqual(['ctx -', '-']);
	});

	it('formats small and zero costs the way the desktop does', () => {
		expect(
			buildStatusSegments(agent(), tab({ usageStats: usage({ totalCostUsd: 0 }) }))[4]?.text
		).toBe('$0.00');
		expect(
			buildStatusSegments(agent(), tab({ usageStats: usage({ totalCostUsd: 0.004 }) }))[4]?.text
		).toBe('<$0.01');
	});
});

describe('contextSegment', () => {
	it('turns yellow at 70% and red at 90%', () => {
		const at = (percent: number) =>
			contextSegment(
				agent(),
				readUsageStats(usage({ inputTokens: percent * 2_000, cacheReadInputTokens: 0 }))
			);
		expect(at(42).tone).toBe('normal');
		expect(at(70).tone).toBe('warn');
		expect(at(CONTEXT_DANGER_PERCENT).tone).toBe('danger');
	});

	it('uses the window the provider reported, else the library table', () => {
		const reported = contextSegment(
			agent(),
			readUsageStats(usage({ contextWindow: 1_000_000, cacheReadInputTokens: 0 }))
		);
		expect(reported.text).toContain('/1.0M)');
		const table = contextSegment(agent(), readUsageStats(usage({ contextWindow: 0 })));
		expect(table.text).toContain('/200.0K)');
	});

	it('does not count cached input twice for a combined-window provider', () => {
		const stats = readUsageStats(
			usage({ inputTokens: 40_000, outputTokens: 10_000, cacheReadInputTokens: 30_000 })
		);
		const segment = contextSegment(agent({ toolType: 'codex' }), {
			...stats!,
			contextWindow: 100_000,
			cacheCreationInputTokens: 0,
		});
		expect(segment.text).toBe('ctx 50% (50.0K/100.0K)');
	});

	it('falls back to the stored percentage when a tool chain overflows the window', () => {
		const stats = readUsageStats(usage({ cacheReadInputTokens: 900_000 }));
		expect(contextSegment(agent({ contextUsage: 61 }), stats).text).toBe('ctx ~61% of 200.0K');
		expect(contextSegment(agent(), stats).text).toBe('ctx ? of 200.0K');
	});
});

describe('fitStatusSegments', () => {
	const segments = buildStatusSegments(
		agent({ customModel: 'opus', customEffort: 'high' }),
		tab({ usageStats: usage() })
	);
	const full = statusLineWidth(segments);

	it('keeps everything when it fits', () => {
		expect(fitStatusSegments(segments, full)).toEqual(segments);
	});

	it('drops effort first, then provider, then model', () => {
		const keys = (width: number) => fitStatusSegments(segments, width).map((s) => s.key);
		expect(keys(full - 1)).toEqual(['provider', 'model', 'context', 'cost']);
		expect(keys(full - 12)).toEqual(['model', 'context', 'cost']);
		expect(keys(0)).toEqual(['context', 'cost']);
	});
});
