import { describe, it, expect } from 'vitest';
import {
	buildSystemLogKeys,
	buildSystemLogTimeline,
	MAX_TIMELINE_SEGMENTS,
	type SystemLogViewEntry,
} from '../../../renderer/utils/systemLogView';

const entry = (overrides: Partial<SystemLogViewEntry> = {}): SystemLogViewEntry => ({
	timestamp: 1000,
	level: 'info',
	message: 'hello',
	...overrides,
});

describe('buildSystemLogKeys', () => {
	it('gives every entry a distinct key, duplicates included', () => {
		const keys = buildSystemLogKeys([entry(), entry(), entry({ message: 'other' })]);
		expect(new Set(keys).size).toBe(3);
	});

	it('keeps the keys of older entries when a new one arrives at the top', () => {
		const older = [entry({ timestamp: 2 }), entry({ timestamp: 1 }), entry({ timestamp: 1 })];
		const before = buildSystemLogKeys(older);
		const after = buildSystemLogKeys([entry({ timestamp: 3 }), ...older]);
		expect(after.slice(1)).toEqual(before);
	});

	it('separates the same line from two sources', () => {
		const [a, b] = buildSystemLogKeys([entry(), entry({ source: 'model-server' })]);
		expect(a).not.toBe(b);
	});
});

describe('buildSystemLogTimeline', () => {
	it('draws one stripe per entry while the list is short', () => {
		const entries = [entry({ level: 'info' }), entry({ level: 'error', message: 'x' })];
		const segments = buildSystemLogTimeline(entries, buildSystemLogKeys(entries));
		expect(segments.map((s) => [s.startIndex, s.count, s.level])).toEqual([
			[0, 1, 'info'],
			[1, 1, 'error'],
		]);
	});

	it('groups a long list into at most the cap, covering every entry once', () => {
		const entries = Array.from({ length: 1000 }, (_, i) => entry({ timestamp: i }));
		const segments = buildSystemLogTimeline(entries, buildSystemLogKeys(entries));
		expect(segments).toHaveLength(MAX_TIMELINE_SEGMENTS);
		expect(segments.reduce((sum, s) => sum + s.count, 0)).toBe(1000);
		segments.forEach((s, i) => {
			if (i > 0) expect(s.startIndex).toBe(segments[i - 1].startIndex + segments[i - 1].count);
		});
	});

	it('draws a shared stripe in its most severe level and counts the problems', () => {
		const entries = [
			entry({ level: 'info' }),
			entry({ level: 'error', message: 'a' }),
			entry({ level: 'warn', message: 'b' }),
			entry({ level: 'debug', message: 'c' }),
		];
		const [segment] = buildSystemLogTimeline(entries, buildSystemLogKeys(entries), 1);
		expect(segment.level).toBe('error');
		expect(segment.count).toBe(4);
		expect(segment.title).toContain('4 entries (1 error, 1 warning)');
	});

	it('is empty for no entries', () => {
		expect(buildSystemLogTimeline([], [])).toEqual([]);
	});
});
