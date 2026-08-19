/**
 * @file cue-schedule-recurring.test.ts
 * @description End-to-end tests for the repeating and editing modes of
 * `maestro-cli cue schedule`: `--daily-at` / `--every` creation, the `--kind`
 * list filter, `--reschedule`, and `--pause` / `--resume`.
 *
 * Like the create test, only `readSessions` is mocked - every write runs
 * against a real temp project root so the YAML on disk is what is asserted.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

const mockReadSessions = vi.fn();

vi.mock('../../../cli/services/storage', () => ({
	readSessions: () => mockReadSessions(),
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import { cueSchedule } from '../../../cli/commands/cue-schedule';

type Session = {
	id: string;
	name: string;
	toolType: string;
	projectRoot: string;
	cwd: string;
};

function session(projectRoot: string, overrides: Partial<Session> = {}): Session {
	return {
		id: 'agent-alpha',
		name: 'Alpha',
		toolType: 'claude-code',
		projectRoot,
		cwd: projectRoot,
		...overrides,
	};
}

function readSubs(projectRoot: string): Record<string, unknown>[] {
	const filePath = path.join(projectRoot, '.maestro', 'cue.yaml');
	const parsed = yaml.load(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
	return parsed.subscriptions as Record<string, unknown>[];
}

describe('cue schedule (recurring + edit)', () => {
	let projectRoot = '';
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-schedule-recurring-'));
		mockReadSessions.mockReturnValue([session(projectRoot)]);
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('process.exit');
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (projectRoot && fs.existsSync(projectRoot)) {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	it('--daily-at writes a time.scheduled sub with normalized times and canonical day order', async () => {
		await cueSchedule({
			dailyAt: '9:00, 17:30',
			days: 'fri,mon',
			agent: 'Alpha',
			prompt: 'Summarize the PR queue',
		});

		const subs = readSubs(projectRoot);
		expect(subs).toHaveLength(1);
		expect(subs[0].event).toBe('time.scheduled');
		expect(subs[0].schedule_times).toEqual(['09:00', '17:30']);
		// Canonical week order, not the order the user typed.
		expect(subs[0].schedule_days).toEqual(['mon', 'fri']);
		expect(subs[0].prompt).toBe('Summarize the PR queue');
		expect(subs[0].fire_at).toBeUndefined();
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('--every converts a duration into interval_minutes on a time.heartbeat sub', async () => {
		await cueSchedule({ every: '2h', agent: 'Alpha', prompt: 'check CI' });

		const subs = readSubs(projectRoot);
		expect(subs[0].event).toBe('time.heartbeat');
		expect(subs[0].interval_minutes).toBe(120);
		expect(subs[0].name).toMatch(/^task-every-120m-[a-f0-9]{8}$/);
	});

	it('rejects --days without --daily-at', async () => {
		await expect(
			cueSchedule({ every: '30m', days: 'mon', agent: 'Alpha', prompt: 'x' })
		).rejects.toThrow('process.exit');
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('--days requires --daily-at')
		);
	});

	it('rejects two timing flags at once', async () => {
		await expect(
			cueSchedule({ in: '5m', every: '30m', agent: 'Alpha', prompt: 'x' })
		).rejects.toThrow('process.exit');
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('mutually exclusive'));
	});

	it('--grace-minutes is rejected on a repeating task', async () => {
		await expect(
			cueSchedule({ every: '30m', graceMinutes: '10', agent: 'Alpha', prompt: 'x' })
		).rejects.toThrow('process.exit');
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('only applies to one-shot tasks')
		);
	});

	it('--list --kind filters by recurrence and --json carries the schedule fields', async () => {
		await cueSchedule({ in: '10m', agent: 'Alpha', prompt: 'one shot', name: 'once-task' });
		await cueSchedule({
			dailyAt: '09:00',
			agent: 'Alpha',
			prompt: 'daily job',
			name: 'daily-task',
		});
		consoleSpy.mockClear();

		await cueSchedule({ list: true, kind: 'daily', json: true });
		const rows = JSON.parse(consoleSpy.mock.calls[0][0] as string) as Record<string, unknown>[];
		expect(rows).toHaveLength(1);
		expect(rows[0].name).toBe('daily-task');
		expect(rows[0].kind).toBe('daily');
		expect(rows[0].schedule).toBe('09:00 (every day)');
		expect(rows[0].next_fire_at).not.toBe('');
	});

	it('--reschedule moves a one-shot fire time and leaves the rest of the sub alone', async () => {
		await cueSchedule({ in: '10m', agent: 'Alpha', prompt: 'ship it', name: 'shipping' });
		const before = readSubs(projectRoot)[0];

		await cueSchedule({ reschedule: 'shipping', at: '2030-01-02 03:04' });

		const after = readSubs(projectRoot)[0];
		expect(after.fire_at).not.toBe(before.fire_at);
		expect(new Date(after.fire_at as string).getFullYear()).toBe(2030);
		expect(after.prompt).toBe('ship it');
		expect(after.label).toBe(before.label);
	});

	it('--reschedule refuses a timing flag that does not match the task kind', async () => {
		await cueSchedule({ every: '30m', agent: 'Alpha', prompt: 'tick', name: 'ticker' });

		await expect(cueSchedule({ reschedule: 'ticker', in: '5m' })).rejects.toThrow('process.exit');
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('is an interval task'));
		expect(readSubs(projectRoot)[0].interval_minutes).toBe(30);
	});

	it('--pause and --resume flip enabled without removing the subscription', async () => {
		await cueSchedule({ dailyAt: '09:00', agent: 'Alpha', prompt: 'standup', name: 'standup' });

		await cueSchedule({ pause: 'standup' });
		expect(readSubs(projectRoot)[0].enabled).toBe(false);

		await cueSchedule({ resume: 'standup' });
		expect(readSubs(projectRoot)[0].enabled).toBe(true);
		expect(readSubs(projectRoot)).toHaveLength(1);
	});
});
