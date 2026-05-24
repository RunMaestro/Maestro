/**
 * Tests for Feedback IPC Handlers
 *
 * Tests the IPC handlers for the in-app Send Feedback feature:
 * - feedback:check-gh-auth
 * - feedback:submit
 */

import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { ipcMain } from 'electron';
import {
	registerFeedbackHandlers,
	clearFeedbackGhAuthCache,
} from '../../../../main/ipc/handlers/feedback';
import type { ProcessManager } from '../../../../main/process-manager';

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
	},
}));

// Mock the prompt
vi.mock('../../../../prompts', () => ({
	feedbackPrompt: '# Feedback Template\n\nUser raw feedback: {{FEEDBACK}}\n\nEnd.',
}));

// Mock cliDetection utilities — controlled per-test below
const isGhInstalledMock = vi.fn();
const resolveGhPathMock = vi.fn();
const getExpandedEnvMock = vi.fn(() => ({ PATH: '/usr/local/bin:/usr/bin' }));
vi.mock('../../../../main/utils/cliDetection', () => ({
	isGhInstalled: (...args: unknown[]) => isGhInstalledMock(...args),
	resolveGhPath: (...args: unknown[]) => resolveGhPathMock(...args),
	getExpandedEnv: (...args: unknown[]) => getExpandedEnvMock(...args),
}));

// Mock execFileNoThrow
const execFileNoThrowMock = vi.fn();
vi.mock('../../../../main/utils/execFile', () => ({
	execFileNoThrow: (...args: unknown[]) => execFileNoThrowMock(...args),
}));

// Capture registered handlers
const registeredHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> = new Map();

describe('Feedback IPC Handlers', () => {
	let mockProcessManager: {
		write: Mock;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();
		clearFeedbackGhAuthCache();

		// Default cliDetection responses
		isGhInstalledMock.mockResolvedValue(true);
		resolveGhPathMock.mockResolvedValue('/usr/local/bin/gh');
		execFileNoThrowMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

		// Capture handler registrations
		(ipcMain.handle as Mock).mockImplementation(
			(channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
				registeredHandlers.set(channel, handler);
			}
		);

		// Create mock process manager
		mockProcessManager = {
			write: vi.fn().mockReturnValue(true),
		};

		// Register handlers
		registerFeedbackHandlers({
			getProcessManager: () => mockProcessManager as unknown as ProcessManager,
		});
	});

	// Helper to invoke a registered handler — withIpcErrorLogging strips the event arg
	async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
		const handler = registeredHandlers.get(channel);
		if (!handler) {
			throw new Error(`No handler registered for channel: ${channel}`);
		}
		return handler({}, ...args);
	}

	describe('handler registration', () => {
		it('registers feedback:check-gh-auth', () => {
			expect(ipcMain.handle).toHaveBeenCalledWith('feedback:check-gh-auth', expect.any(Function));
		});

		it('registers feedback:submit', () => {
			expect(ipcMain.handle).toHaveBeenCalledWith('feedback:submit', expect.any(Function));
		});
	});

	describe('feedback:check-gh-auth', () => {
		it('returns authenticated=true when gh is installed and "gh auth status" exits 0', async () => {
			isGhInstalledMock.mockResolvedValue(true);
			execFileNoThrowMock.mockResolvedValue({ stdout: 'Logged in', stderr: '', exitCode: 0 });

			const result = await invokeHandler('feedback:check-gh-auth');

			expect(result).toEqual({ authenticated: true });
			expect(execFileNoThrowMock).toHaveBeenCalledWith(
				'/usr/local/bin/gh',
				['auth', 'status'],
				undefined,
				expect.objectContaining({ PATH: expect.any(String) })
			);
		});

		it('returns not-installed message when gh CLI is missing', async () => {
			isGhInstalledMock.mockResolvedValue(false);

			const result = await invokeHandler('feedback:check-gh-auth');

			expect(result).toEqual({
				authenticated: false,
				message: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com',
			});
			expect(execFileNoThrowMock).not.toHaveBeenCalled();
		});

		it('returns not-authenticated message when "gh auth status" fails', async () => {
			isGhInstalledMock.mockResolvedValue(true);
			execFileNoThrowMock.mockResolvedValue({
				stdout: '',
				stderr: 'You are not logged into any GitHub hosts.',
				exitCode: 1,
			});

			const result = await invokeHandler('feedback:check-gh-auth');

			expect(result).toEqual({
				authenticated: false,
				message: 'GitHub CLI is not authenticated. Run "gh auth login" in your terminal.',
			});
		});

		it('caches the auth status across calls within the TTL', async () => {
			isGhInstalledMock.mockResolvedValue(true);
			execFileNoThrowMock.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

			await invokeHandler('feedback:check-gh-auth');
			await invokeHandler('feedback:check-gh-auth');
			await invokeHandler('feedback:check-gh-auth');

			// Should only have shelled out once thanks to the TTL cache
			expect(execFileNoThrowMock).toHaveBeenCalledTimes(1);
		});

		it('re-checks after clearFeedbackGhAuthCache()', async () => {
			isGhInstalledMock.mockResolvedValue(true);
			execFileNoThrowMock.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

			await invokeHandler('feedback:check-gh-auth');
			clearFeedbackGhAuthCache();
			await invokeHandler('feedback:check-gh-auth');

			expect(execFileNoThrowMock).toHaveBeenCalledTimes(2);
		});
	});

	describe('feedback:submit', () => {
		it('substitutes {{FEEDBACK}} and writes the constructed prompt to the agent', async () => {
			const result = await invokeHandler('feedback:submit', {
				sessionId: 'session-123',
				feedbackText: 'The settings modal does not close on Escape.',
			});

			expect(result).toEqual({ success: true });
			expect(mockProcessManager.write).toHaveBeenCalledTimes(1);
			const [sessionId, data] = mockProcessManager.write.mock.calls[0];
			expect(sessionId).toBe('session-123');
			expect(data).toContain('User raw feedback: The settings modal does not close on Escape.');
			expect(data).not.toContain('{{FEEDBACK}}');
			expect(data.endsWith('\n')).toBe(true);
		});

		it('returns error when the process manager write returns false', async () => {
			mockProcessManager.write.mockReturnValue(false);

			const result = await invokeHandler('feedback:submit', {
				sessionId: 'session-missing',
				feedbackText: 'Hello',
			});

			expect(result).toEqual({ success: false, error: 'Agent process not available' });
		});

		it('returns error when the process manager write throws', async () => {
			mockProcessManager.write.mockImplementation(() => {
				throw new Error('stream closed');
			});

			const result = await invokeHandler('feedback:submit', {
				sessionId: 'session-x',
				feedbackText: 'Hello',
			});

			expect(result).toEqual({ success: false, error: 'Agent process not available' });
		});

		it('rejects empty feedback text', async () => {
			const result = await invokeHandler('feedback:submit', {
				sessionId: 'session-123',
				feedbackText: '   ',
			});

			expect(result).toEqual({ success: false, error: 'Feedback text is empty' });
			expect(mockProcessManager.write).not.toHaveBeenCalled();
		});

		it('rejects missing sessionId', async () => {
			const result = await invokeHandler('feedback:submit', {
				sessionId: '',
				feedbackText: 'real feedback',
			});

			expect(result).toEqual({ success: false, error: 'Invalid sessionId' });
			expect(mockProcessManager.write).not.toHaveBeenCalled();
		});
	});
});
