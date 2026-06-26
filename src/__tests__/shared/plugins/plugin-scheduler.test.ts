import { describe, it, expect } from 'vitest';
import {
	computeDueTriggers,
	schedulerNowFromDate,
	type TriggerState,
} from '../../../shared/plugins/plugin-scheduler';
import type { CueTriggerContribution } from '../../../shared/plugins/contributions';

function interval(id: string, everyMinutes: number): CueTriggerContribution {
	return {
		id,
		localId: id,
		pluginId: 'p',
		title: id,
		schedule: { kind: 'interval', everyMinutes },
		action: 'notify',
		payload: 'hi',
	};
}

function daily(id: string, times: string[]): CueTriggerContribution {
	return {
		id,
		localId: id,
		pluginId: 'p',
		title: id,
		schedule: { kind: 'dailyTimes', times },
		action: 'notify',
		payload: 'hi',
	};
}

const now = (ms: number, hhmm = '00:00', dayKey = '2026-06-25') => ({ ms, hhmm, dayKey });

describe('computeDueTriggers - interval', () => {
	it('seeds on first observation without firing', () => {
		const t = interval('a', 5);
		const step = computeDueTriggers([t], {}, now(1000));
		expect(step.due).toEqual([]);
		expect(step.nextState.a).toEqual({ seeded: true, lastFiredMs: 1000 });
	});

	it('fires once the interval has elapsed, then re-seeds the clock', () => {
		const t = interval('a', 5);
		const seeded: Record<string, TriggerState> = { a: { seeded: true, lastFiredMs: 0 } };
		const step = computeDueTriggers([t], seeded, now(5 * 60_000));
		expect(step.due.map((d) => d.id)).toEqual(['a']);
		expect(step.nextState.a.lastFiredMs).toBe(5 * 60_000);
	});

	it('does not fire before the interval elapses', () => {
		const t = interval('a', 5);
		const seeded: Record<string, TriggerState> = { a: { seeded: true, lastFiredMs: 0 } };
		const step = computeDueTriggers([t], seeded, now(4 * 60_000));
		expect(step.due).toEqual([]);
	});

	it('drops state for triggers no longer present', () => {
		const seeded: Record<string, TriggerState> = { gone: { seeded: true, lastFiredMs: 0 } };
		const step = computeDueTriggers([interval('a', 5)], seeded, now(1000));
		expect(step.nextState.gone).toBeUndefined();
	});
});

describe('computeDueTriggers - dailyTimes', () => {
	it('fires when the clock matches one of the times, once per minute', () => {
		const t = daily('d', ['09:30', '17:00']);
		const first = computeDueTriggers([t], {}, now(1, '09:30', '2026-06-25'));
		expect(first.due.map((x) => x.id)).toEqual(['d']);
		// Same minute again: no double fire.
		const again = computeDueTriggers([t], first.nextState, now(2, '09:30', '2026-06-25'));
		expect(again.due).toEqual([]);
	});

	it('does not fire at a non-matching time', () => {
		const t = daily('d', ['09:30']);
		expect(computeDueTriggers([t], {}, now(1, '09:31')).due).toEqual([]);
	});

	it('fires again the next day at the same time', () => {
		const t = daily('d', ['09:30']);
		const day1 = computeDueTriggers([t], {}, now(1, '09:30', '2026-06-25'));
		const day2 = computeDueTriggers([t], day1.nextState, now(2, '09:30', '2026-06-26'));
		expect(day2.due.map((x) => x.id)).toEqual(['d']);
	});
});

describe('schedulerNowFromDate', () => {
	it('formats hhmm and dayKey with zero-padding', () => {
		const d = new Date(2026, 0, 5, 9, 7, 30); // local
		const n = schedulerNowFromDate(d);
		expect(n.hhmm).toBe('09:07');
		expect(n.dayKey).toBe('2026-01-05');
		expect(n.ms).toBe(d.getTime());
	});
});
