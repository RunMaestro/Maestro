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
		let captured: { sessionId?: string; background?: boolean; switchToAgent?: boolean } = {};
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
		// Unflagged: today's behaviour is preserved exactly. `--background` is
		// additive, so an unflagged call must still switch and still focus.
		expect(captured.background).toBe(false);
		expect(captured.switchToAgent).toBe(true);
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Opened file.ts in Maestro'));
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	describe('--background vs --no-switch (they are different asks)', () => {
		function captureMessage() {
			vi.mocked(existsSync).mockReturnValue(true);
			const captured: Record<string, unknown> = {};
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((msg) => {
						Object.assign(captured, msg);
						return Promise.resolve({ type: 'open_file_tab_result', success: true });
					}),
				};
				return action(mockClient as never);
			});
			return captured;
		}

		it('--background asks for the strong version and leaves --no-switch alone', async () => {
			const msg = captureMessage();
			await openFile('/home/user/project/file.ts', { agent: 'session-123', background: true });
			expect(msg.background).toBe(true);
			expect(msg.switchToAgent).toBe(true);
		});

		it('--no-switch keeps its own weaker meaning and does NOT imply background', async () => {
			// The trap this guards: folding `--no-switch` into `--background` would
			// silently change behaviour for everyone already passing it. It means
			// "stay on this agent" and still activates the tab in the target.
			const msg = captureMessage();
			await openFile('/home/user/project/file.ts', { agent: 'session-123', switch: false });
			expect(msg.switchToAgent).toBe(false);
			expect(msg.background).toBe(false);
		});

		it('accepts both, since --background is strictly stronger', async () => {
			const msg = captureMessage();
			await openFile('/home/user/project/file.ts', {
				agent: 'session-123',
				background: true,
				switch: false,
			});
			expect(msg.background).toBe(true);
			expect(msg.switchToAgent).toBe(false);
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('--focus is the explicit spelling of the current default', async () => {
			const msg = captureMessage();
			await openFile('/home/user/project/file.ts', { agent: 'session-123', focus: true });
			expect(msg.background).toBe(false);
			expect(msg.switchToAgent).toBe(true);
		});
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
