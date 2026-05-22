/**
 * @file refresh-files.test.ts
 * @description Tests for the refresh-files CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	resolveSessionId: vi.fn(),
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((message: string) => `Error: ${message}`),
}));

import { refreshFiles } from '../../../cli/commands/refresh-files';
import { resolveSessionId, withMaestroClient } from '../../../cli/services/maestro-client';

describe('refresh-files command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(resolveSessionId).mockReturnValue('target-session');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const client = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'refresh_file_tree_result',
					success: true,
				}),
			};
			return action(client as never);
		});
	});

	it('refreshes the file tree with an explicit session', async () => {
		await refreshFiles({ session: 'target-session' });

		expect(resolveSessionId).toHaveBeenCalledWith({ session: 'target-session' });
		expect(withMaestroClient).toHaveBeenCalledTimes(1);
		const action = vi.mocked(withMaestroClient).mock.calls[0][0];
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'refresh_file_tree_result',
			success: true,
		});
		await action({ sendCommand } as never);
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'refresh_file_tree', sessionId: 'target-session' },
			'refresh_file_tree_result'
		);
		expect(consoleSpy).toHaveBeenCalledWith('File tree refreshed');
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('refreshes the file tree with the resolved default session', async () => {
		vi.mocked(resolveSessionId).mockReturnValue('resolved-session');

		await refreshFiles({});

		const action = vi.mocked(withMaestroClient).mock.calls[0][0];
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'refresh_file_tree_result',
			success: true,
		});
		await action({ sendCommand } as never);
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'refresh_file_tree', sessionId: 'resolved-session' },
			'refresh_file_tree_result'
		);
	});

	it('exits with an error when Maestro is not reachable', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro desktop app is not running'));

		await refreshFiles({ session: 'target-session' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			'Error: Failed to refresh file tree: Maestro desktop app is not running'
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('exits with an error when Maestro rejects the refresh', async () => {
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const client = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'refresh_file_tree_result',
					success: false,
					error: 'Session not found',
				}),
			};
			return action(client as never);
		});

		await refreshFiles({ session: 'target-session' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			'Error: Failed to refresh file tree: Session not found'
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
