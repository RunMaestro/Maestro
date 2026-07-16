/**
 * @file cue-schedule-list-cancel.test.ts
 * @description Tests for the `--list` and `--cancel` modes of the
 * `maestro-cli cue schedule` command. The create branch is exercised
 * elsewhere - this file focuses on the read/delete paths added in Phase 03
 * task 2 of the time.once feature.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

// Mocks must be defined before importing the module under test.
const mockReadSessions = vi.fn();
const mockLoadCueConfigDetailed = vi.fn();
const mockRemoveSubscriptionFromYaml = vi.fn();

vi.mock('../../../cli/services/storage', () => ({
	readSessions: () => mockReadSessions(),
}));

vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfigDetailed: (root: string) => mockLoadCueConfigDetailed(root),
}));

vi.mock('../../../main/cue/cue-self-destruct', () => ({
	removeSubscriptionFromYaml: (root: string, name: string) =>
		mockRemoveSubscriptionFromYaml(root, name),
}));

import { cueSchedule } from '../../../cli/commands/cue-schedule';

type Session = {
	id: string;
	name: string;
	toolType: string;
	projectRoot: string;
	cwd: string;
};

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 'agent-aaaaaaaa-1111',
		name: 'Alpha',
		toolType: 'claude-code',
		projectRoot: '/projects/alpha',
		cwd: '/projects/alpha',
		...overrides,
	};
}

function detailedOk(subscriptions: Array<Record<string, unknown>>) {
	return {
		ok: true,
		config: { subscriptions, settings: {} },
		warnings: [],
	};
}

const FIXED_NOW = new Date('2026-05-23T12:00:00.000Z').getTime();

describe('cue schedule --list', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;
	let nowSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		nowSpy = vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
	});

	afterEach(() => {
		nowSpy.mockRestore();
	});

	it('prints "No pending one-shot tasks." when no agent has any', async () => {
		mockReadSessions.mockReturnValue([session()]);
		mockLoadCueConfigDetailed.mockReturnValue({ ok: false, reason: 'missing' });

		await cueSchedule({ list: true });

		expect(consoleSpy).toHaveBeenCalledWith('No pending one-shot tasks.');
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('aggregates time.once subscriptions across multiple agents and sorts by fire_at', async () => {
		const alpha = session({ id: 'agent-aaaaaaaa-1111', name: 'Alpha', projectRoot: '/p/alpha' });
		const beta = session({ id: 'agent-bbbbbbbb-2222', name: 'Beta', projectRoot: '/p/beta' });
		mockReadSessions.mockReturnValue([alpha, beta]);

		mockLoadCueConfigDetailed.mockImplementation((root: string) => {
			if (root === '/p/alpha') {
				return detailedOk([
					{
						name: 'later-task',
						event: 'time.once',
						enabled: true,
						prompt: '',
						fire_at: '2026-05-23T14:00:00.000Z',
						action: 'prompt',
						label: 'Later one',
					},
					{
						name: 'unrelated-heartbeat',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'tick',
					},
				]);
			}
			if (root === '/p/beta') {
				return detailedOk([
					{
						name: 'soonest-task',
						event: 'time.once',
						enabled: true,
						prompt: '',
						fire_at: '2026-05-23T12:30:00.000Z',
						action: 'notify',
						label: 'Soonest',
					},
				]);
			}
			return { ok: false, reason: 'missing' };
		});

		await cueSchedule({ list: true });

		expect(consoleSpy).toHaveBeenCalledTimes(1);
		const output = consoleSpy.mock.calls[0][0] as string;
		expect(output).toContain('NAME');
		expect(output).toContain('FIRES_AT');
		// Soonest must appear before later-task (sort ascending by fire_at).
		const soonestIdx = output.indexOf('soonest-task');
		const laterIdx = output.indexOf('later-task');
		expect(soonestIdx).toBeGreaterThan(-1);
		expect(laterIdx).toBeGreaterThan(soonestIdx);
		// Non-time.once subs are filtered out.
		expect(output).not.toContain('unrelated-heartbeat');
		// Relative duration column populated for future fire_at.
		expect(output).toMatch(/30m/);
	});

	it('emits a JSON array sorted by fire_at when --json is set', async () => {
		mockReadSessions.mockReturnValue([session({ projectRoot: '/p/alpha' })]);
		mockLoadCueConfigDetailed.mockReturnValue(
			detailedOk([
				{
					name: 'task-a',
					event: 'time.once',
					enabled: true,
					prompt: 'hello',
					fire_at: '2026-05-23T13:00:00.000Z',
					action: 'prompt',
					label: 'Task A',
				},
			])
		);

		await cueSchedule({ list: true, json: true });

		expect(consoleSpy).toHaveBeenCalledTimes(1);
		const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({
			name: 'task-a',
			fire_at: '2026-05-23T13:00:00.000Z',
			action: 'prompt',
			label: 'Task A',
			agent_id: 'agent-aaaaaaaa-1111',
		});
		expect(parsed[0].in).toBe('1h');
	});

	it('emits an empty JSON array when --json and no tasks pending', async () => {
		mockReadSessions.mockReturnValue([session()]);
		mockLoadCueConfigDetailed.mockReturnValue({ ok: false, reason: 'missing' });

		await cueSchedule({ list: true, json: true });

		expect(consoleSpy).toHaveBeenCalledTimes(1);
		expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toEqual([]);
	});

	it('flags fire_at in the past as expired', async () => {
		mockReadSessions.mockReturnValue([session()]);
		mockLoadCueConfigDetailed.mockReturnValue(
			detailedOk([
				{
					name: 'overdue',
					event: 'time.once',
					enabled: true,
					prompt: '',
					fire_at: '2026-05-23T11:00:00.000Z',
					action: 'notify',
					label: '',
				},
			])
		);

		await cueSchedule({ list: true, json: true });
		const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
		expect(parsed[0].in).toBe('expired');
	});

	it('warns on stderr for parse errors but keeps listing valid agents', async () => {
		const broken = session({ id: 'agent-broken', name: 'Broken', projectRoot: '/p/broken' });
		const good = session({ id: 'agent-good', name: 'Good', projectRoot: '/p/good' });
		mockReadSessions.mockReturnValue([broken, good]);
		mockLoadCueConfigDetailed.mockImplementation((root: string) => {
			if (root === '/p/broken') {
				return { ok: false, reason: 'parse-error', message: 'bad yaml here' };
			}
			return detailedOk([
				{
					name: 'good-task',
					event: 'time.once',
					enabled: true,
					prompt: '',
					fire_at: '2026-05-23T13:00:00.000Z',
					action: 'prompt',
					label: '',
				},
			]);
		});

		await cueSchedule({ list: true });

		expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
		const warning = consoleErrorSpy.mock.calls[0][0] as string;
		expect(warning).toContain('Broken');
		expect(warning).toContain('bad yaml here');
		const output = consoleSpy.mock.calls[0][0] as string;
		expect(output).toContain('good-task');
	});
});

describe('cue schedule --cancel <name>', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('removes the subscription from the only agent holding it', async () => {
		const alpha = session({ id: 'agent-aaa', name: 'Alpha', projectRoot: '/p/alpha' });
		mockReadSessions.mockReturnValue([alpha]);
		mockLoadCueConfigDetailed.mockReturnValue(
			detailedOk([
				{
					name: 'task-x',
					event: 'time.once',
					enabled: true,
					prompt: 'hi',
					fire_at: '2026-05-23T13:00:00.000Z',
					action: 'prompt',
				},
			])
		);
		mockRemoveSubscriptionFromYaml.mockResolvedValue({ removed: true });

		await cueSchedule({ cancel: 'task-x' });

		expect(mockRemoveSubscriptionFromYaml).toHaveBeenCalledWith('/p/alpha', 'task-x');
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining(`Cancelled task 'task-x' on agent Alpha.`)
		);
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('exits 1 with "No pending task" when the name matches nothing', async () => {
		// Switch to throwing exit so errorOut behaves like real process termination
		// - without this the code under test keeps running past the failure point.
		processExitSpy.mockImplementation(() => {
			throw new Error('process.exit');
		});
		mockReadSessions.mockReturnValue([session()]);
		mockLoadCueConfigDetailed.mockReturnValue(detailedOk([]));

		await expect(cueSchedule({ cancel: 'ghost-task' })).rejects.toThrow('process.exit');

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining(`No pending task named 'ghost-task' found.`)
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(mockRemoveSubscriptionFromYaml).not.toHaveBeenCalled();
	});

	it('requires --agent when two agents hold the same task name', async () => {
		processExitSpy.mockImplementation(() => {
			throw new Error('process.exit');
		});
		const alpha = session({ id: 'agent-aaa', name: 'Alpha', projectRoot: '/p/alpha' });
		const beta = session({ id: 'agent-bbb', name: 'Beta', projectRoot: '/p/beta' });
		mockReadSessions.mockReturnValue([alpha, beta]);
		mockLoadCueConfigDetailed.mockReturnValue(
			detailedOk([
				{
					name: 'shared',
					event: 'time.once',
					enabled: true,
					prompt: '',
					fire_at: '2026-05-23T13:00:00.000Z',
					action: 'notify',
				},
			])
		);

		await expect(cueSchedule({ cancel: 'shared' })).rejects.toThrow('process.exit');

		const message = consoleErrorSpy.mock.calls[0][0] as string;
		expect(message).toContain('Multiple agents');
		expect(message).toContain('Alpha');
		expect(message).toContain('Beta');
		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(mockRemoveSubscriptionFromYaml).not.toHaveBeenCalled();
	});

	it('disambiguates with --agent when name is duplicated across agents', async () => {
		const alpha = session({ id: 'agent-aaa', name: 'Alpha', projectRoot: '/p/alpha' });
		const beta = session({ id: 'agent-bbb', name: 'Beta', projectRoot: '/p/beta' });
		mockReadSessions.mockReturnValue([alpha, beta]);
		mockLoadCueConfigDetailed.mockReturnValue(
			detailedOk([
				{
					name: 'shared',
					event: 'time.once',
					enabled: true,
					prompt: '',
					fire_at: '2026-05-23T13:00:00.000Z',
					action: 'notify',
				},
			])
		);
		mockRemoveSubscriptionFromYaml.mockResolvedValue({ removed: true });

		await cueSchedule({ cancel: 'shared', agent: 'Beta' });

		expect(mockRemoveSubscriptionFromYaml).toHaveBeenCalledWith('/p/beta', 'shared');
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining(`Cancelled task 'shared' on agent Beta.`)
		);
	});

	it('honors --agent as a hard scope even when only one agent matches', async () => {
		// Regression: `--cancel <name> --agent <other>` must NOT delete the sole
		// matching agent's task just because the name is unique. --agent is a hard
		// filter for this destructive command.
		processExitSpy.mockImplementation(() => {
			throw new Error('process.exit');
		});
		const alpha = session({ id: 'agent-aaa', name: 'Alpha', projectRoot: '/p/alpha' });
		const beta = session({ id: 'agent-bbb', name: 'Beta', projectRoot: '/p/beta' });
		mockReadSessions.mockReturnValue([alpha, beta]);
		mockLoadCueConfigDetailed.mockImplementation((root: string) =>
			root === '/p/alpha'
				? detailedOk([
						{
							name: 'task-x',
							event: 'time.once',
							enabled: true,
							prompt: '',
							fire_at: '2026-05-23T13:00:00.000Z',
							action: 'prompt',
						},
					])
				: detailedOk([])
		);

		// Only Alpha holds task-x, but we target Beta - must error, not delete Alpha's.
		await expect(cueSchedule({ cancel: 'task-x', agent: 'Beta' })).rejects.toThrow('process.exit');

		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(consoleErrorSpy.mock.calls[0][0] as string).toContain('task-x');
		expect(mockRemoveSubscriptionFromYaml).not.toHaveBeenCalled();
	});

	it('honors --agent on a unique match when it points at the right agent', async () => {
		const alpha = session({ id: 'agent-aaa', name: 'Alpha', projectRoot: '/p/alpha' });
		mockReadSessions.mockReturnValue([alpha]);
		mockLoadCueConfigDetailed.mockReturnValue(
			detailedOk([
				{
					name: 'task-x',
					event: 'time.once',
					enabled: true,
					prompt: '',
					fire_at: '2026-05-23T13:00:00.000Z',
					action: 'prompt',
				},
			])
		);
		mockRemoveSubscriptionFromYaml.mockResolvedValue({ removed: true });

		await cueSchedule({ cancel: 'task-x', agent: 'Alpha' });

		expect(mockRemoveSubscriptionFromYaml).toHaveBeenCalledWith('/p/alpha', 'task-x');
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('emits structured JSON on success when --json is set', async () => {
		mockReadSessions.mockReturnValue([
			session({ id: 'agent-aaa', name: 'Alpha', projectRoot: '/p/alpha' }),
		]);
		mockLoadCueConfigDetailed.mockReturnValue(
			detailedOk([
				{
					name: 'task-x',
					event: 'time.once',
					enabled: true,
					prompt: '',
					fire_at: '2026-05-23T13:00:00.000Z',
					action: 'prompt',
				},
			])
		);
		mockRemoveSubscriptionFromYaml.mockResolvedValue({ removed: true });

		await cueSchedule({ cancel: 'task-x', json: true });

		const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
		expect(parsed).toEqual({ ok: true, removed: 'task-x', agent_id: 'agent-aaa' });
	});

	it('reports the underlying reason when removeSubscriptionFromYaml fails', async () => {
		mockReadSessions.mockReturnValue([
			session({ id: 'agent-aaa', name: 'Alpha', projectRoot: '/p/alpha' }),
		]);
		mockLoadCueConfigDetailed.mockReturnValue(
			detailedOk([
				{
					name: 'task-x',
					event: 'time.once',
					enabled: true,
					prompt: '',
					fire_at: '2026-05-23T13:00:00.000Z',
					action: 'prompt',
				},
			])
		);
		mockRemoveSubscriptionFromYaml.mockResolvedValue({
			removed: false,
			reason: 'yaml dump failed: boom',
		});

		await cueSchedule({ cancel: 'task-x' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining(`Failed to remove 'task-x'`)
		);
		expect(consoleErrorSpy.mock.calls[0][0] as string).toContain('yaml dump failed: boom');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
