/**
 * @file open-file.test.ts
 * @description Tests for the open-file CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { SessionInfo } from '../../../shared/types';

vi.mock('fs', () => ({
	existsSync: vi.fn(),
}));

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	getSessionById: vi.fn(),
	readSessions: vi.fn(),
	readSettings: vi.fn(),
}));

vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((message: string) => `Error: ${message}`),
}));

import { openFile } from '../../../cli/commands/open-file';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { getSessionById, readSessions, readSettings } from '../../../cli/services/storage';

describe('open-file command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	const mockSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
		id: 'session-123',
		name: 'Test Agent',
		toolType: 'claude-code',
		cwd: '/path/to/project',
		projectRoot: '/path/to/project',
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(readSettings).mockReturnValue({});
		vi.mocked(readSessions).mockReturnValue([mockSession()]);
		vi.mocked(getSessionById).mockReturnValue(undefined);
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const client = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'open_file_tab_result',
					success: true,
				}),
			};
			return action(client as never);
		});
	});

	it('opens an existing file with an explicit session', async () => {
		const filePath = path.resolve('README.md');

		await openFile('README.md', { session: 'target-session' });

		expect(withMaestroClient).toHaveBeenCalledTimes(1);
		const action = vi.mocked(withMaestroClient).mock.calls[0][0];
		const sendCommand = vi.fn().mockResolvedValue({ type: 'open_file_tab_result', success: true });
		await action({ sendCommand } as never);
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'open_file_tab', sessionId: 'target-session', filePath },
			'open_file_tab_result'
		);
		expect(consoleSpy).toHaveBeenCalledWith('Opened README.md in Maestro');
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('uses active session from settings when no session is provided', async () => {
		vi.mocked(readSettings).mockReturnValue({ activeSessionId: 'active-session' });
		vi.mocked(getSessionById).mockReturnValue(mockSession({ id: 'active-session' }));

		await openFile('/tmp/example.txt', {});

		const action = vi.mocked(withMaestroClient).mock.calls[0][0];
		const sendCommand = vi.fn().mockResolvedValue({ type: 'open_file_tab_result', success: true });
		await action({ sendCommand } as never);
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'open_file_tab', sessionId: 'active-session', filePath: '/tmp/example.txt' },
			'open_file_tab_result'
		);
	});

	it('falls back to the first stored session when there is no active session', async () => {
		vi.mocked(readSessions).mockReturnValue([mockSession({ id: 'first-session' })]);

		await openFile('/tmp/example.txt', {});

		const action = vi.mocked(withMaestroClient).mock.calls[0][0];
		const sendCommand = vi.fn().mockResolvedValue({ type: 'open_file_tab_result', success: true });
		await action({ sendCommand } as never);
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'open_file_tab', sessionId: 'first-session', filePath: '/tmp/example.txt' },
			'open_file_tab_result'
		);
	});

	it('exits with an error for a missing file', async () => {
		vi.mocked(fs.existsSync).mockReturnValue(false);

		await openFile('/tmp/missing.txt', { session: 'target-session' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			'Error: Failed to open file: File not found: /tmp/missing.txt'
		);
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('exits with an error when Maestro is not reachable', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro desktop app is not running'));

		await openFile('/tmp/example.txt', { session: 'target-session' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			'Error: Failed to open file: Maestro desktop app is not running'
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
