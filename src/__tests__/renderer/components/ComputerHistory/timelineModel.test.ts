import { describe, expect, it } from 'vitest';
import {
	KIND_FILTERS,
	VISIT_GAP_MS,
	buildHistogram,
	chooseBarStepMs,
	eventKey,
	groupIntoVisits,
	kindsForFilters,
	rangeStartMs,
	urlHostLabel,
	type KindFilterId,
} from '../../../../renderer/components/ComputerHistory/timelineModel';
import type { StoredEvent } from '../../../../shared/computer-history/types';

const T0 = Date.parse('2026-10-03T14:15:00.000Z');
const slack = { id: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 1 };
const chrome = { id: 'com.google.chrome', name: 'Chrome', pid: 2 };

function ev(seq: number, offsetMs: number, partial: Partial<StoredEvent> = {}): StoredEvent {
	return {
		v: 1,
		seq,
		ts: new Date(T0 + offsetMs).toISOString(),
		kind: 'text.committed',
		app: slack,
		window: { title: 'general' },
		text: `t${seq}`,
		...partial,
	};
}

describe('groupIntoVisits', () => {
	it('groups by app and window, newest first, folding activations into the header', () => {
		const visits = groupIntoVisits([
			ev(0, 0, { kind: 'app.activated', text: undefined }),
			ev(1, 1000),
			ev(2, 2000, { kind: 'window.changed', text: undefined }),
			ev(3, 3000, {
				app: chrome,
				kind: 'app.activated',
				window: { title: 'Docs', url: 'https://docs.example.com/a' },
			}),
			ev(4, 4000, { app: chrome, kind: 'selection.changed', window: { title: 'Docs' } }),
			ev(5, 5000, {
				app: chrome,
				kind: 'window.changed',
				window: { title: 'Mail' },
				text: undefined,
			}),
		]);
		expect(visits.map((v) => `${v.appName}:${v.title}`)).toEqual([
			'Chrome:Mail',
			'Chrome:Docs',
			'Slack:general',
		]);
		const [, docs, general] = visits;
		expect(general.rows.map((r) => r.seq)).toEqual([1]);
		expect(general.eventCount).toBe(3);
		expect(docs.url).toBe('https://docs.example.com/a');
		expect(docs.rows.map((r) => r.kind)).toEqual(['selection.changed']);
	});

	it('splits a long pause in the same window and accepts unsorted input', () => {
		const visits = groupIntoVisits([ev(1, VISIT_GAP_MS + 5000), ev(0, 0)]);
		expect(visits).toHaveLength(2);
		expect(visits[0].startMs).toBe(T0 + VISIT_GAP_MS + 5000);
	});

	it('event keys are unique per event', () => {
		expect(eventKey(ev(0, 0))).not.toBe(eventKey(ev(1, 0)));
	});
});

describe('filters and ranges', () => {
	it('all kind filters on means no kind filter', () => {
		const all = new Set(KIND_FILTERS.map((f) => f.id));
		expect(kindsForFilters(all)).toBeUndefined();
		expect(kindsForFilters(new Set<KindFilterId>(['typed', 'navigation']))).toEqual([
			'text.committed',
			'app.activated',
			'window.changed',
		]);
	});

	it('presets end now; today starts at local midnight', () => {
		const now = T0;
		expect(rangeStartMs('1h', now)).toBe(now - 3_600_000);
		const midnight = new Date(now);
		midnight.setHours(0, 0, 0, 0);
		expect(rangeStartMs('today', now)).toBe(midnight.getTime());
		expect(rangeStartMs('30d', now)).toBe(now - 30 * 86_400_000);
	});

	it('urlHostLabel never throws', () => {
		expect(urlHostLabel('https://a.example.com/x?y')).toBe('a.example.com');
		expect(urlHostLabel('not a url')).toBeUndefined();
		expect(urlHostLabel(undefined)).toBeUndefined();
	});
});

describe('histogram', () => {
	it('picks the narrowest step that keeps bars wide enough', () => {
		expect(chooseBarStepMs(3_600_000, 800)).toBe(15 * 60_000);
		expect(chooseBarStepMs(30 * 86_400_000, 400)).toBe(12 * 3_600_000);
		expect(chooseBarStepMs(365 * 86_400_000, 100)).toBe(86_400_000);
	});

	it('folds buckets into bars weighted by time, falling back to counts', () => {
		const step = 3_600_000;
		const since = T0;
		const bars = buildHistogram(
			[
				{ startMs: T0, events: 3, apps: { a: 2, b: 1 }, activeMs: { a: 60_000, b: 30_000 } },
				// An old index line: no foreground time recorded.
				{ startMs: T0 + 15 * 60_000, events: 2, apps: { a: 2 }, activeMs: { a: 0 } },
			],
			step,
			since,
			since + 2 * step
		);
		// Bars align to LOCAL hours, so the two buckets may share a bar or not
		// depending on the time zone; totals are the same either way.
		const sum = (pick: (b: (typeof bars)[number]) => number) =>
			bars.reduce((n, b) => n + pick(b), 0);
		expect(sum((b) => b.events)).toBe(5);
		expect(sum((b) => b.byApp.a ?? 0)).toBe(60_000 + 2000);
		expect(sum((b) => b.byApp.b ?? 0)).toBe(30_000);
		expect(bars.find((b) => b.byApp.b)!.timed).toBe(true);
		expect(bars.length).toBeGreaterThanOrEqual(2);
	});
});
