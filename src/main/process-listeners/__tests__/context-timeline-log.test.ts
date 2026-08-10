/**
 * Tests for the main-process Context Timeline capture log (finding S1).
 *
 * Covers the append/get round trip, seq monotonicity, the per-session cap with
 * its `trimmed` flag, base-session grouping across parallel AI tabs, and removal.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	appendUsageCapture,
	getUsageCaptures,
	removeSessionCaptures,
	MAX_CAPTURES_PER_SESSION,
	__resetUsageCaptureLogForTests,
} from '../context-timeline-log';
import type { UsageStats } from '../types';

const usage = (overrides: Partial<UsageStats> = {}): UsageStats => ({
	inputTokens: 1000,
	outputTokens: 500,
	cacheReadInputTokens: 200,
	cacheCreationInputTokens: 100,
	totalCostUsd: 0.05,
	contextWindow: 200000,
	...overrides,
});

describe('context-timeline-log', () => {
	beforeEach(() => {
		__resetUsageCaptureLogForTests();
	});

	it('round trips appended captures for the base session', () => {
		appendUsageCapture('agent-1', usage({ inputTokens: 1 }));
		appendUsageCapture('agent-1', usage({ inputTokens: 2 }));

		const { captures, trimmed } = getUsageCaptures('agent-1');
		expect(trimmed).toBe(false);
		expect(captures).toHaveLength(2);
		expect(captures.map((c) => c.usageStats.inputTokens)).toEqual([1, 2]);
		expect(captures[0].sessionId).toBe('agent-1');
		expect(captures[0].timestamp).toBeGreaterThan(0);
	});

	it('assigns strictly increasing seq numbers across sessions', () => {
		const a = appendUsageCapture('agent-1', usage());
		const b = appendUsageCapture('agent-2', usage());
		const c = appendUsageCapture('agent-1-ai-tab1', usage());

		expect(b).toBeGreaterThan(a);
		expect(c).toBeGreaterThan(b);
	});

	it('merges parallel AI tabs into one seq-ordered stream for the agent', () => {
		appendUsageCapture('agent-1-ai-tab1', usage({ inputTokens: 1 }));
		appendUsageCapture('agent-1-ai-tab2', usage({ inputTokens: 2 }));
		appendUsageCapture('agent-1-ai-tab1', usage({ inputTokens: 3 }));
		// A different agent whose id merely shares a prefix must NOT leak in as
		// the same session, but the prefix superset does return it - the renderer
		// filters on the exact parsed base id.
		appendUsageCapture('agent-2', usage({ inputTokens: 99 }));

		const { captures } = getUsageCaptures('agent-1');
		expect(captures.map((c) => c.usageStats.inputTokens)).toEqual([1, 2, 3]);
		expect(captures.map((c) => c.seq)).toEqual(
			[...captures.map((c) => c.seq)].sort((x, y) => x - y)
		);
	});

	it('does not return captures from an unrelated session', () => {
		appendUsageCapture('agent-1', usage());
		expect(getUsageCaptures('agent-2').captures).toHaveLength(0);
	});

	it('caps the per-session log and flags it as trimmed', () => {
		for (let i = 0; i < MAX_CAPTURES_PER_SESSION + 5; i++) {
			appendUsageCapture('agent-1', usage({ inputTokens: i }));
		}

		const { captures, trimmed } = getUsageCaptures('agent-1');
		expect(trimmed).toBe(true);
		expect(captures).toHaveLength(MAX_CAPTURES_PER_SESSION);
		// Oldest dropped, newest kept.
		expect(captures[0].usageStats.inputTokens).toBe(5);
		expect(captures[captures.length - 1].usageStats.inputTokens).toBe(MAX_CAPTURES_PER_SESSION + 4);
	});

	it('removes every capture belonging to a deleted agent', () => {
		appendUsageCapture('agent-1', usage());
		appendUsageCapture('agent-1-ai-tab1', usage());
		appendUsageCapture('agent-9', usage());

		removeSessionCaptures('agent-1');

		expect(getUsageCaptures('agent-1').captures).toHaveLength(0);
		expect(getUsageCaptures('agent-9').captures).toHaveLength(1);
	});

	it('ignores an empty session id on append and query', () => {
		expect(() => appendUsageCapture('', usage())).not.toThrow();
		expect(getUsageCaptures('').captures).toHaveLength(0);
	});
});
