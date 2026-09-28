import { describe, it, expect } from 'vitest';

import {
	computeTabConversationStats,
	formatConversationDuration,
} from '../../shared/tabConversationStats';
import type { LogEntry } from '../../renderer/types';

const BASE_TIME = 1703116800000; // 2023-12-21T00:00:00.000Z

function log(source: LogEntry['source'], offsetMs: number, text = 'x'): LogEntry {
	return {
		id: `log-${source}-${offsetMs}`,
		timestamp: BASE_TIME + offsetMs,
		source,
		text,
	};
}

describe('computeTabConversationStats', () => {
	it('returns zeroed stats for an empty or missing log array', () => {
		for (const input of [undefined, []]) {
			const stats = computeTabConversationStats(input);
			expect(stats.logs).toEqual([]);
			expect(stats.totalMessages).toBe(0);
			expect(stats.userMessages).toBe(0);
			expect(stats.aiMessages).toBe(0);
			expect(stats.durationMs).toBe(0);
		}
	});

	it('counts every conversation entry, not just prose', () => {
		const stats = computeTabConversationStats([
			log('user', 0),
			log('ai', 1000),
			log('tool', 2000),
			log('thinking', 3000),
			log('stdout', 4000),
		]);

		expect(stats.totalMessages).toBe(5);
		expect(stats.userMessages).toBe(1);
		expect(stats.aiMessages).toBe(2); // ai + stdout
	});

	it('drops sources that are not part of the conversation', () => {
		const stats = computeTabConversationStats([
			log('user', 0),
			log('command' as LogEntry['source'], 1000),
			log('ai', 2000),
		]);

		expect(stats.totalMessages).toBe(2);
		expect(stats.logs.map((l) => l.source)).toEqual(['user', 'ai']);
	});

	it('measures the span between the first and last conversation entry', () => {
		const stats = computeTabConversationStats([
			log('user', 0),
			log('ai', 60_000),
			log('user', 3_600_000),
		]);

		expect(stats.durationMs).toBe(3_600_000);
	});

	it('ignores dropped sources when measuring the span', () => {
		const stats = computeTabConversationStats([
			log('command' as LogEntry['source'], 0),
			log('user', 60_000),
			log('ai', 120_000),
			log('command' as LogEntry['source'], 900_000),
		]);

		expect(stats.durationMs).toBe(60_000);
	});

	it('reports a zero span for a single entry', () => {
		expect(computeTabConversationStats([log('user', 0)]).durationMs).toBe(0);
	});
});

describe('formatConversationDuration', () => {
	it('renders zero as 0m rather than an empty string', () => {
		expect(formatConversationDuration(0)).toBe('0m');
	});

	it('renders a real span compactly', () => {
		expect(formatConversationDuration(3_600_000)).toContain('1h');
	});
});
