/**
 * @file open-file.test.ts
 * @description Tests for the open-file CLI command
 *
 * Tests the open-file command functionality including:
 * - Opening a valid file with explicit agent
 * - Opening a valid file with default agent resolution
 * - Error handling for non-existent files
 * - Error handling when Maestro app is not running
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import * as path from 'path';

// Mock fs
vi.mock('fs', () => ({
	existsSync: vi.fn(),
}));

// Mock maestro-client
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

// Mock storage (used for resolving the owning agent and target's cwd)
const mockSession = {
	id: 'session-123',
	name: 'Test Agent',
	toolType: 'claude-code',
	cwd: '/home/user/project',
	projectRoot: '/home/user/project',
};
vi.mock('../../../cli/services/storage', () => ({
	getSessionById: vi.fn(() => mockSession),
	readSessions: vi.fn(() => [mockSession]),
	getSessionHistoryMtimeMs: vi.fn(() => 0),
}));

import { openFile } from '../../../cli/commands/open-file';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { existsSync } from 'fs';

describe('open-file command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('should open a valid file with explicit agent', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		let captured: { sessionId?: string; switchToAgent?: boolean } = {};
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					captured = msg;
					return Promise.resolve({ type: 'open_file_tab_result', success: true });
				}),
			};
			return action(mockClient as never);
		});

		await openFile('/home/user/project/file.ts', { agent: 'session-123' });

		expect(captured.sessionId).toBe('session-123');
		expect(captured.switchToAgent).toBe(true);
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Opened file.ts in Maestro'));
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	// --background is a strictly stronger --no-switch. The pair below pins both
	// halves: the flag reaches the wire, and it also forces switchToAgent off so
	// the two promises can't disagree.
	it('should send background and force switchToAgent off with --background', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		let captured: { switchToAgent?: boolean; background?: boolean } = {};
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({
				sendCommand: vi.fn().mockImplementation((msg) => {
					captured = msg;
					return Promise.resolve({ type: 'open_file_tab_result', success: true });
				}),
			} as never)
		);

		await openFile('/home/user/project/file.ts', { agent: 'session-123', background: true });

		expect(captured.background).toBe(true);
		expect(captured.switchToAgent).toBe(false);
	});

	it('should omit background when the flag is absent so the tab still focuses', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		let captured: { switchToAgent?: boolean; background?: boolean } = {};
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({
				sendCommand: vi.fn().mockImplementation((msg) => {
					captured = msg;
					return Promise.resolve({ type: 'open_file_tab_result', success: true });
				}),
			} as never)
		);

		await openFile('/home/user/project/file.ts', { agent: 'session-123' });

		expect(captured.background).toBeUndefined();
		expect(captured.switchToAgent).toBe(true);
	});

	// --no-switch keeps its own meaning: it suppresses the agent switch and does
	// NOT imply background, so a caller already passing it sees no change.
	it('should not imply background from --no-switch', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		let captured: { switchToAgent?: boolean; background?: boolean } = {};
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({
				sendCommand: vi.fn().mockImplementation((msg) => {
					captured = msg;
					return Promise.resolve({ type: 'open_file_tab_result', success: true });
				}),
			} as never)
		);

		await openFile('/home/user/project/file.ts', { agent: 'session-123', switch: false });

		expect(captured.switchToAgent).toBe(false);
		expect(captured.background).toBeUndefined();
	});

	it('should resolve relative file paths to absolute', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		// Relative paths are resolved against process.cwd(); pin it inside the
		// mock session's cwd so the ownership check passes.
		vi.spyOn(process, 'cwd').mockReturnValue('/home/user/project');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					// Verify absolute path was sent
					expect(path.isAbsolute(msg.filePath)).toBe(true);
					return Promise.resolve({ type: 'open_file_tab_result', success: true });
				}),
			};
			return action(mockClient as never);
		});

		await openFile('relative/file.ts', { agent: 'session-123' });

		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Opened file.ts in Maestro'));
	});

	it('should error when file does not exist', async () => {
		vi.mocked(existsSync).mockReturnValue(false);

		await openFile('/home/user/project/nonexistent.ts', { agent: 'session-123' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('File not found'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should error gracefully when Maestro app is not running', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro desktop app is not running'));

		await openFile('/home/user/project/file.ts', { agent: 'session-123' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Maestro desktop app is not running')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should error when server returns failure', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'open_file_tab_result',
					success: false,
					error: 'Session not found',
				}),
			};
			return action(mockClient as never);
		});

		await openFile('/home/user/project/file.ts', { agent: 'session-123' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Session not found'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
