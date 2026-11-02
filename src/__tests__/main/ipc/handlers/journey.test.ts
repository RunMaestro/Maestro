/**
 * User Journey IPC.
 *
 * The three channels are thin pass-throughs to `user-journey-manager.ts`, so
 * what these tests defend is the wiring: every channel is registered, the
 * synthetic `_event` argument is stripped (not shifted into the agent id), read
 * options are filtered to well-typed fields, and a missing agent id fails
 * loudly instead of reaching `journey/.jsonl`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const registeredHandlers = new Map<string, (...args: any[]) => any>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
			registeredHandlers.set(channel, handler);
		}),
	},
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

let settings: Record<string, unknown> = {};
vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: (key: string) => settings[key] }),
}));

const manager = {
	appendJourneyEntry: vi.fn(),
	readJourney: vi.fn(),
	getJourneyFilePath: vi.fn(),
	startJourneyRetentionSweep: vi.fn(),
};

vi.mock('../../../../main/user-journey-manager', () => ({
	appendJourneyEntry: (...args: unknown[]) => manager.appendJourneyEntry(...args),
	startJourneyRetentionSweep: () => manager.startJourneyRetentionSweep(),
	readJourney: (...args: unknown[]) => manager.readJourney(...args),
	getJourneyFilePath: (...args: unknown[]) => manager.getJourneyFilePath(...args),
}));

import { registerJourneyHandlers } from '../../../../main/ipc/handlers/journey';

/** Invoke a registered channel with the synthetic event ipcMain would pass. */
function invoke(channel: string, ...args: unknown[]): Promise<any> {
	const handler = registeredHandlers.get(channel);
	if (!handler) throw new Error(`channel not registered: ${channel}`);
	return handler({}, ...args);
}

const ENTRY = { ts: 1_700_000_000_000, agentId: 'agent-1', kind: 'file.open', target: '/p/a.ts' };

describe('journey handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();
		settings = {};
		manager.appendJourneyEntry.mockResolvedValue(true);
		manager.readJourney.mockResolvedValue([ENTRY]);
		manager.getJourneyFilePath.mockReturnValue('/data/journey/agent-1.jsonl');
		registerJourneyHandlers();
	});

	it('starts the retention sweep when the handlers register', () => {
		expect(manager.startJourneyRetentionSweep).toHaveBeenCalledTimes(1);
	});

	it('registers exactly the three journey channels', () => {
		expect([...registeredHandlers.keys()].sort()).toEqual([
			'journey:append',
			'journey:path',
			'journey:read',
		]);
	});

	it('hands the appended entry to the store and returns its answer', async () => {
		await expect(invoke('journey:append', ENTRY)).resolves.toBe(true);
		expect(manager.appendJourneyEntry).toHaveBeenCalledWith(ENTRY);

		manager.appendJourneyEntry.mockResolvedValueOnce(false);
		await expect(invoke('journey:append', ENTRY)).resolves.toBe(false);
	});

	it('records nothing while the user has switched the journey off', async () => {
		settings.userJourneyEnabled = false;
		await expect(invoke('journey:append', ENTRY)).resolves.toBe(false);
		expect(manager.appendJourneyEntry).not.toHaveBeenCalled();

		// Reading what was already recorded still works.
		await expect(invoke('journey:read', 'agent-1')).resolves.toEqual([ENTRY]);

		settings.userJourneyEnabled = true;
		await expect(invoke('journey:append', ENTRY)).resolves.toBe(true);
	});

	it('reads an agent journey with well-typed options only', async () => {
		await expect(
			invoke('journey:read', 'agent-1', {
				since: 100,
				tail: 5.7,
				kinds: ['file.save', 'bogus', 3],
				extra: 'ignored',
			})
		).resolves.toEqual([ENTRY]);
		expect(manager.readJourney).toHaveBeenCalledWith('agent-1', {
			since: 100,
			tail: 5,
			kinds: ['file.save'],
		});
	});

	it('drops malformed read options instead of trusting them', async () => {
		await invoke('journey:read', 'agent-1', { since: 'yesterday', tail: Number.NaN });
		expect(manager.readJourney).toHaveBeenCalledWith('agent-1', {});

		await invoke('journey:read', 'agent-1');
		expect(manager.readJourney).toHaveBeenLastCalledWith('agent-1', {});
	});

	it('returns the journey file path', async () => {
		await expect(invoke('journey:path', 'agent-1')).resolves.toBe('/data/journey/agent-1.jsonl');
		expect(manager.getJourneyFilePath).toHaveBeenCalledWith('agent-1');
	});

	it('rejects a missing or empty agent id', async () => {
		await expect(invoke('journey:read', '')).rejects.toThrow(/agentId/);
		await expect(invoke('journey:path', undefined)).rejects.toThrow(/agentId/);
		expect(manager.readJourney).not.toHaveBeenCalled();
		expect(manager.getJourneyFilePath).not.toHaveBeenCalled();
	});
});
