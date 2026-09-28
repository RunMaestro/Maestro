/**
 * @file scheduled-tasks-describe.test.ts
 * @description Tests for the display formatters behind the Scheduled Tasks
 * table and `maestro-cli cue schedule --list`: day-set collapsing, interval
 * humanizing, and the one-shot fire time.
 */

import { describe, it, expect } from 'vitest';
import {
	describeFireAt,
	describeIntervalMinutes,
	describeSchedule,
	describeScheduleDays,
	type ScheduledTask,
} from '../../../shared/cue/scheduled-tasks';

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
	return {
		name: 'sub',
		kind: 'daily',
		event: 'time.scheduled',
		enabled: true,
		agentId: 'a',
		agentName: 'Alpha',
		projectRoot: '/p',
		action: 'prompt',
		label: '',
		prompt: '',
		pipelineName: 'Tasks',
		scheduleTimes: ['09:00'],
		nextFireAtMs: null,
		...overrides,
	};
}

describe('describeScheduleDays', () => {
	it('treats an absent, empty, or complete day list as every day', () => {
		expect(describeScheduleDays(undefined)).toBe('Every day');
		expect(describeScheduleDays([])).toBe('Every day');
		expect(describeScheduleDays(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).toBe(
			'Every day'
		);
	});

	it('names the two sets people actually mean', () => {
		expect(describeScheduleDays(['mon', 'tue', 'wed', 'thu', 'fri'])).toBe('Weekdays');
		expect(describeScheduleDays(['sat', 'sun'])).toBe('Weekends');
	});

	it('collapses a run of three or more into a range', () => {
		expect(describeScheduleDays(['mon', 'tue', 'wed'])).toBe('M-W');
		expect(describeScheduleDays(['tue', 'wed', 'thu', 'fri'])).toBe('T-F');
	});

	it('lists isolated days and short runs individually', () => {
		expect(describeScheduleDays(['mon', 'wed', 'fri'])).toBe('M, W, F');
		expect(describeScheduleDays(['mon', 'tue'])).toBe('M, T');
		expect(describeScheduleDays(['thu'])).toBe('Th');
	});

	it('mixes runs and singles in week order regardless of input order', () => {
		expect(describeScheduleDays(['sat', 'mon', 'wed', 'tue'])).toBe('M-W, Sa');
	});

	it('keeps T and Th distinguishable', () => {
		// The whole point of the two-letter Th: a single-letter scheme would
		// render Tuesday and Thursday identically.
		expect(describeScheduleDays(['tue'])).toBe('T');
		expect(describeScheduleDays(['thu'])).toBe('Th');
	});
});

describe('describeIntervalMinutes', () => {
	it('renders sub-hour intervals in minutes', () => {
		expect(describeIntervalMinutes(30)).toBe('30m');
		expect(describeIntervalMinutes(59)).toBe('59m');
	});

	it('renders whole hours and days in their own unit', () => {
		expect(describeIntervalMinutes(60)).toBe('1h');
		expect(describeIntervalMinutes(120)).toBe('2h');
		expect(describeIntervalMinutes(1440)).toBe('1d');
	});

	it('falls back to hours plus minutes for a ragged interval', () => {
		expect(describeIntervalMinutes(90)).toBe('1h 30m');
	});
});

describe('describeFireAt', () => {
	it('renders a local wall-clock time rather than the stored UTC ISO string', () => {
		const iso = new Date(2026, 7, 22, 16, 5).toISOString();
		const rendered = describeFireAt(iso);

		expect(rendered).not.toContain('T');
		expect(rendered).not.toMatch(/Z$/);
		// The hour the user typed, not the UTC hour it was stored as.
		expect(rendered).toContain('22');
	});

	it('passes an unparseable value straight through rather than showing NaN', () => {
		expect(describeFireAt('not-a-date')).toBe('not-a-date');
	});
});

describe('describeSchedule', () => {
	it('renders a daily task as times, then the day set', () => {
		expect(describeSchedule(task({ scheduleTimes: ['09:00', '17:30'] }))).toBe(
			'09:00, 17:30 · Every day'
		);
		expect(
			describeSchedule(
				task({ scheduleTimes: ['15:30'], scheduleDays: ['mon', 'tue', 'wed', 'thu', 'fri'] })
			)
		).toBe('15:30 · Weekdays');
	});

	it('renders an interval task', () => {
		expect(
			describeSchedule(
				task({
					kind: 'interval',
					event: 'time.heartbeat',
					intervalMinutes: 120,
					scheduleTimes: undefined,
				})
			)
		).toBe('Every 2h');
	});

	it('reports an unscheduled one-shot rather than rendering an empty date', () => {
		expect(
			describeSchedule(task({ kind: 'once', event: 'time.once', scheduleTimes: undefined }))
		).toBe('unscheduled');
	});
});
