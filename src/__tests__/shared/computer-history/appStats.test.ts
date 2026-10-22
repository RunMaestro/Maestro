import { describe, expect, it } from 'vitest';
import {
	APP_TIME_IDLE_CAP_MS,
	addEventToAppStats,
	appStatsIndexFields,
	createAppStats,
} from '../../../shared/computer-history/appStats';

const T0 = Date.parse('2026-10-03T14:15:00.000Z');
const at = (ms: number, id?: string, name?: string) => ({
	ts: new Date(T0 + ms).toISOString(),
	...(id ? { app: { id, name } } : {}),
});

describe('appStats', () => {
	it('credits each gap to the previous event app, capped, and keeps the latest name', () => {
		const stats = createAppStats();
		addEventToAppStats(stats, at(0, 'slack', 'Slack'));
		addEventToAppStats(stats, at(30_000, 'chrome', 'Chrome'));
		addEventToAppStats(stats, at(30_000 + 20 * 60_000, 'slack', 'Slack 2'));
		const fields = appStatsIndexFields(stats);
		expect(fields.apps).toEqual({ slack: 2, chrome: 1 });
		expect(fields.names).toEqual({ slack: 'Slack 2', chrome: 'Chrome' });
		expect(fields.activeMs).toEqual({ slack: 30_000, chrome: APP_TIME_IDLE_CAP_MS });
	});

	it('an event with no app ends the previous credit and owns nothing after it', () => {
		const stats = createAppStats();
		addEventToAppStats(stats, at(0, 'slack'));
		addEventToAppStats(stats, at(10_000));
		addEventToAppStats(stats, at(50_000, 'slack'));
		expect(stats.activeMs).toEqual({ slack: 10_000 });
		expect(stats.apps).toEqual({ slack: 2 });
	});

	it('ignores an unparseable timestamp and never credits a negative gap', () => {
		const stats = createAppStats();
		addEventToAppStats(stats, at(5_000, 'a'));
		addEventToAppStats(stats, { ts: 'garbage', app: { id: 'b' } });
		addEventToAppStats(stats, at(1_000, 'a'));
		expect(stats.activeMs).toEqual({ a: 0 });
		expect(stats.apps).toEqual({ a: 2 });
	});

	it('index fields are copies', () => {
		const stats = createAppStats();
		addEventToAppStats(stats, at(0, 'a'));
		const fields = appStatsIndexFields(stats);
		addEventToAppStats(stats, at(1_000, 'a'));
		expect(fields.apps).toEqual({ a: 1 });
	});
});
