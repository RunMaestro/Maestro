/**
 * @file status.test.ts
 * @description Tests for the status CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../shared/cli-server-discovery', () => ({
	readCliServerInfo: vi.fn(),
	isCliServerRunning: vi.fn(),
}));

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((message: string) => `Error: ${message}`),
}));

import { status } from '../../../cli/commands/status';
import { readCliServerInfo, isCliServerRunning } from '../../../shared/cli-server-discovery';
import { withMaestroClient } from '../../../cli/services/maestro-client';

describe('status command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(readCliServerInfo).mockReturnValue({
			port: 47321,
			token: 'test-token',
			pid: 1234,
			startedAt: 1710000000000,
		});
		vi.mocked(isCliServerRunning).mockReturnValue(true);
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const client = {
				sendCommand: vi
					.fn()
					.mockResolvedValueOnce({ type: 'pong' })
					.mockResolvedValueOnce({
						type: 'sessions_list',
						sessions: [{ id: 'session-1' }, { id: 'session-2' }],
					}),
			};
			return action(client as never);
		});
	});

	it('prints not running when the discovery file is missing', async () => {
		vi.mocked(readCliServerInfo).mockReturnValue(null);

		await status();

		expect(consoleSpy).toHaveBeenCalledWith('Maestro desktop app is not running');
		expect(isCliServerRunning).not.toHaveBeenCalled();
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(3);
	});

	it('prints stale discovery when the PID is not running', async () => {
		vi.mocked(isCliServerRunning).mockReturnValue(false);

		await status();

		expect(consoleSpy).toHaveBeenCalledWith(
			'Maestro discovery file is stale (app may have crashed)'
		);
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(3);
	});

	it('pings Maestro and prints the port with session count', async () => {
		await status();

		expect(withMaestroClient).toHaveBeenCalledTimes(1);
		const action = vi.mocked(withMaestroClient).mock.calls[0][0];
		const sendCommand = vi
			.fn()
			.mockResolvedValueOnce({ type: 'pong' })
			.mockResolvedValueOnce({
				type: 'sessions_list',
				sessions: [{ id: 'session-1' }, { id: 'session-2' }, { id: 'session-3' }],
			});
		await action({ sendCommand } as never);
		expect(sendCommand).toHaveBeenNthCalledWith(1, { type: 'ping' }, 'pong');
		expect(sendCommand).toHaveBeenNthCalledWith(2, { type: 'get_sessions' }, 'sessions_list');
		expect(consoleSpy).toHaveBeenCalledWith('Maestro is running on port 47321 with 2 agents');
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('treats a missing sessions array as zero sessions', async () => {
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const client = {
				sendCommand: vi
					.fn()
					.mockResolvedValueOnce({ type: 'pong' })
					.mockResolvedValueOnce({ type: 'sessions_list' }),
			};
			return action(client as never);
		});

		await status();

		expect(consoleSpy).toHaveBeenCalledWith('Maestro is running on port 47321 with 0 agents');
	});

	it('exits with an error when Maestro cannot be reached', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Connection refused'));

		await status();

		expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Connection refused');
		expect(processExitSpy).toHaveBeenCalledWith(3);
	});
});
