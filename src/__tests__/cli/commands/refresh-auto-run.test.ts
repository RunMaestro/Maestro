/**
 * @file refresh-auto-run.test.ts
 * @description Tests for the refresh-auto-run CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	resolveTargetSessionId: vi.fn(),
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((message: string) => `Error: ${message}`),
}));

import { refreshAutoRun } from '../../../cli/commands/refresh-auto-run';
import { resolveTargetSessionId, withMaestroClient } from '../../../cli/services/maestro-client';

describe('refresh-auto-run command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(resolveTargetSessionId).mockReturnValue('target-session');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const client = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'refresh_auto_run_docs_result',
					success: true,
				}),
			};
			return action(client as never);
		});
	});

	it('refreshes Auto Run documents with an explicit session', async () => {
		await refreshAutoRun({ agent: 'target-session' });

		expect(resolveTargetSessionId).toHaveBeenCalledWith('target-session');
		expect(withMaestroClient).toHaveBeenCalledTimes(1);
		const action = vi.mocked(withMaestroClient).mock.calls[0][0];
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'refresh_auto_run_docs_result',
			success: true,
		});
		await action({ sendCommand } as never);
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'refresh_auto_run_docs', sessionId: 'target-session' },
			'refresh_auto_run_docs_result'
		);
		expect(consoleSpy).toHaveBeenCalledWith('Auto Run documents refreshed');
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('refreshes Auto Run documents with the resolved default session', async () => {
		vi.mocked(resolveTargetSessionId).mockReturnValue('resolved-session');

		await refreshAutoRun({});

		const action = vi.mocked(withMaestroClient).mock.calls[0][0];
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'refresh_auto_run_docs_result',
			success: true,
		});
		await action({ sendCommand } as never);
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'refresh_auto_run_docs', sessionId: 'resolved-session' },
			'refresh_auto_run_docs_result'
		);
	});

	it('exits with an error when Maestro is not reachable', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro desktop app is not running'));

		await refreshAutoRun({ agent: 'target-session' });

		expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Maestro desktop app is not running');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('exits with an error when Maestro rejects the refresh', async () => {
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const client = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'refresh_auto_run_docs_result',
					success: false,
					error: 'Session not found',
				}),
			};
			return action(client as never);
		});

		await refreshAutoRun({ agent: 'target-session' });

		expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Session not found');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
