import { describe, it, expect } from 'vitest';
import {
	selectMode,
	LIMIT_THRESHOLD_PERCENT,
	type SelectModeInput,
	type UsageSnapshot,
} from '../../../main/agents/claude-mode-selector';

const NOW = new Date('2026-05-15T12:00:00Z');
const ONE_HOUR_MS = 60 * 60 * 1000;
const FIVE_HOURS_MS = 5 * ONE_HOUR_MS;
const ONE_WEEK_MS = 7 * 24 * ONE_HOUR_MS;

function snapshot(
	overrides: {
		sessionPercent?: number;
		weekPercent?: number;
		weekSonnetPercent?: number;
		sessionResetsAt?: string;
		weekResetsAt?: string;
		weekSonnetResetsAt?: string;
	} = {}
): UsageSnapshot {
	return {
		sampledAt: NOW.toISOString(),
		configDirKey: '/Users/test/.claude',
		session: {
			percent: overrides.sessionPercent ?? 50,
			resetsAt: overrides.sessionResetsAt ?? new Date(NOW.getTime() + FIVE_HOURS_MS).toISOString(),
		},
		weekAllModels: {
			percent: overrides.weekPercent ?? 20,
			resetsAt: overrides.weekResetsAt ?? new Date(NOW.getTime() + ONE_WEEK_MS).toISOString(),
		},
		weekSonnetOnly: {
			percent: overrides.weekSonnetPercent ?? 10,
			resetsAt: overrides.weekSonnetResetsAt ?? new Date(NOW.getTime() + ONE_WEEK_MS).toISOString(),
		},
	};
}

function input(overrides: Partial<SelectModeInput> = {}): SelectModeInput {
	return {
		perTabReason: 'auto',
		usageSnapshot: snapshot(),
		now: NOW,
		...overrides,
	};
}

describe('claude-mode-selector', () => {
	describe('LIMIT_THRESHOLD_PERCENT', () => {
		it('is exported as 99', () => {
			expect(LIMIT_THRESHOLD_PERCENT).toBe(99);
		});
	});

	describe('null snapshot', () => {
		it('falls back to interactive/auto', () => {
			expect(selectMode(input({ usageSnapshot: null }))).toEqual({
				mode: 'interactive',
				reason: 'auto',
			});
		});

		it('null snapshot ignores sticky-limit (cannot prove window still open)', () => {
			expect(selectMode(input({ usageSnapshot: null, perTabReason: 'limit' }))).toEqual({
				mode: 'interactive',
				reason: 'auto',
			});
		});
	});

	describe('under threshold', () => {
		it('both windows under 99% → interactive/auto', () => {
			expect(selectMode(input({ usageSnapshot: snapshot({ sessionPercent: 50 }) }))).toEqual({
				mode: 'interactive',
				reason: 'auto',
			});
		});

		it('0% does not trigger', () => {
			expect(
				selectMode(input({ usageSnapshot: snapshot({ sessionPercent: 0, weekPercent: 0 }) }))
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});
	});

	describe('limit triggers', () => {
		it('session >= 99% with window open → api/limit', () => {
			expect(selectMode(input({ usageSnapshot: snapshot({ sessionPercent: 99 }) }))).toEqual({
				mode: 'api',
				reason: 'limit',
			});
		});

		it('week >= 99% with window open → api/limit', () => {
			expect(selectMode(input({ usageSnapshot: snapshot({ weekPercent: 99 }) }))).toEqual({
				mode: 'api',
				reason: 'limit',
			});
		});

		it('both over threshold → still a single api/limit result', () => {
			expect(
				selectMode(input({ usageSnapshot: snapshot({ sessionPercent: 99, weekPercent: 100 }) }))
			).toEqual({ mode: 'api', reason: 'limit' });
		});

		it('weekSonnetOnly alone does NOT trigger (selector ignores it)', () => {
			expect(selectMode(input({ usageSnapshot: snapshot({ weekSonnetPercent: 99 }) }))).toEqual({
				mode: 'interactive',
				reason: 'auto',
			});
		});

		it('session at threshold but window already reset → no trigger', () => {
			const closedSession = new Date(NOW.getTime() - ONE_HOUR_MS).toISOString();
			expect(
				selectMode(
					input({
						usageSnapshot: snapshot({ sessionPercent: 99, sessionResetsAt: closedSession }),
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});
	});

	describe('threshold boundary', () => {
		it('exactly 99% triggers (>=)', () => {
			expect(selectMode(input({ usageSnapshot: snapshot({ sessionPercent: 99 }) }))).toEqual({
				mode: 'api',
				reason: 'limit',
			});
		});

		it('98.9% does NOT trigger', () => {
			expect(selectMode(input({ usageSnapshot: snapshot({ sessionPercent: 98.9 }) }))).toEqual({
				mode: 'interactive',
				reason: 'auto',
			});
		});
	});

	describe('sticky-limit', () => {
		it('perTabReason "limit" with session window still open → stays api/limit', () => {
			expect(
				selectMode(
					input({
						perTabReason: 'limit',
						usageSnapshot: snapshot({ sessionPercent: 50, weekPercent: 10 }),
					})
				)
			).toEqual({ mode: 'api', reason: 'limit' });
		});

		it('perTabReason "limit" with only week window open → stays api/limit', () => {
			const closedSession = new Date(NOW.getTime() - ONE_HOUR_MS).toISOString();
			expect(
				selectMode(
					input({
						perTabReason: 'limit',
						usageSnapshot: snapshot({ sessionResetsAt: closedSession }),
					})
				)
			).toEqual({ mode: 'api', reason: 'limit' });
		});

		it('perTabReason "limit" with both windows closed → flips back to interactive/auto', () => {
			const closed = new Date(NOW.getTime() - ONE_HOUR_MS).toISOString();
			expect(
				selectMode(
					input({
						perTabReason: 'limit',
						usageSnapshot: snapshot({
							sessionResetsAt: closed,
							weekResetsAt: closed,
						}),
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});

		it('percent dropping below threshold mid-window does NOT break sticky-limit', () => {
			expect(
				selectMode(
					input({
						perTabReason: 'limit',
						usageSnapshot: snapshot({ sessionPercent: 10, weekPercent: 5 }),
					})
				)
			).toEqual({ mode: 'api', reason: 'limit' });
		});

		it('perTabReason "auto" with windows open but percents under threshold → interactive/auto (not sticky)', () => {
			expect(
				selectMode(
					input({
						perTabReason: 'auto',
						usageSnapshot: snapshot({ sessionPercent: 50 }),
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});
	});

	describe('purity', () => {
		it('does not mutate input', () => {
			const snap = Object.freeze(snapshot({ sessionPercent: 99 }));
			expect(() => selectMode(input({ usageSnapshot: snap }))).not.toThrow();
		});

		it('returns the same result for the same input (determinism)', () => {
			const inp = input({ usageSnapshot: snapshot({ sessionPercent: 99 }) });
			expect(selectMode(inp)).toEqual(selectMode(inp));
		});
	});
});
