/**
 * @file open-file.test.ts
 * @description Tests for the open-file CLI command
 *
 * Tests the open-file command functionality including:
 * - Opening a valid file with explicit session
 * - Opening a valid file with default session resolution
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
	resolveSessionId: vi.fn(),
}));

// Mock storage (used for resolving relative paths against agent's cwd)
vi.mock('../../../cli/services/storage', () => ({
	getSessionById: vi.fn().mockReturnValue({
		id: 'session-123',
		name: 'Test Agent',
		toolType: 'claude-code',
		cwd: '/home/user/project',
		projectRoot: '/home/user/project',
	}),
}));

import { openFile } from '../../../cli/commands/open-file';
import { withMaestroClient, resolveSessionId } from '../../../cli/services/maestro-client';
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

	it('should open a valid file with explicit session', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveSessionId).mockReturnValue('session-123');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockResolvedValue({ type: 'open_file_tab_result', success: true }),
			};
			return action(mockClient as never);
		});

		await openFile('/path/to/file.ts', { session: 'session-123' });

		expect(resolveSessionId).toHaveBeenCalledWith({ session: 'session-123' });
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Opened file.ts in Maestro'));
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('should resolve relative file paths to absolute', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveSessionId).mockReturnValue('session-123');
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

		await openFile('relative/file.ts', { session: 'session-123' });

		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Opened file.ts in Maestro'));
	});

	it('should error when file does not exist', async () => {
		vi.mocked(existsSync).mockReturnValue(false);

		await openFile('/nonexistent/file.ts', {});

		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('File not found'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should error gracefully when Maestro app is not running', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveSessionId).mockReturnValue('session-123');
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro desktop app is not running'));

		await openFile('/path/to/file.ts', { session: 'session-123' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Maestro desktop app is not running')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should error when server returns failure', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveSessionId).mockReturnValue('session-123');
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

		await openFile('/path/to/file.ts', { session: 'session-123' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Session not found'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
