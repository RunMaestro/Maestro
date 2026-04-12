/**
 * Tests for the Feedback IPC handlers
 *
 * These tests verify:
 * - GitHub CLI auth checking (installed/authenticated states)
 * - Caching behavior for gh auth status
 * - Feedback submission via process manager write()
 * - Error cases: process manager unavailable, write() failure
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';
import { registerFeedbackHandlers } from '../../../../main/ipc/handlers/feedback';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock cliDetection utilities
const mockIsGhInstalled = vi.fn();
const mockGetExpandedEnv = vi.fn().mockReturnValue({});
const mockGetCachedGhStatus = vi.fn().mockReturnValue(null);
const mockSetCachedGhStatus = vi.fn();

vi.mock('../../../../main/utils/cliDetection', () => ({
	isGhInstalled: (...args: any[]) => mockIsGhInstalled(...args),
	getExpandedEnv: (...args: any[]) => mockGetExpandedEnv(...args),
	getCachedGhStatus: (...args: any[]) => mockGetCachedGhStatus(...args),
	setCachedGhStatus: (...args: any[]) => mockSetCachedGhStatus(...args),
}));

// Mock execFileNoThrow
const mockExecFileNoThrow = vi.fn();

vi.mock('../../../../main/utils/execFile', () => ({
	execFileNoThrow: (...args: any[]) => mockExecFileNoThrow(...args),
}));

// Mock logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock prompts
vi.mock('../../../../prompts', () => ({
	feedbackPrompt: 'Please file this feedback on GitHub: {{FEEDBACK}}',
}));

describe('feedback IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockProcessManager: any;

	beforeEach(() => {
		vi.clearAllMocks();

		mockGetCachedGhStatus.mockReturnValue(null);
		mockGetExpandedEnv.mockReturnValue({});

		mockProcessManager = {
			write: vi.fn().mockReturnValue(true),
		};

		// Capture registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as Function);
		});

		registerFeedbackHandlers({
			getProcessManager: () => mockProcessManager,
		});
	});

	describe('registration', () => {
		it('should register all feedback handlers', () => {
			expect(handlers.has('feedback:check-gh-auth')).toBe(true);
			expect(handlers.has('feedback:submit')).toBe(true);
		});
	});

	describe('feedback:check-gh-auth', () => {
		const callCheckAuth = () => handlers.get('feedback:check-gh-auth')!(null);

		it('returns authenticated: true when gh is installed and authenticated', async () => {
			mockIsGhInstalled.mockResolvedValue(true);
			mockExecFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

			const result = await callCheckAuth();

			expect(result).toEqual({ authenticated: true });
			expect(mockSetCachedGhStatus).toHaveBeenCalledWith(true, true);
		});

		it('returns authenticated: false with message when gh is not installed', async () => {
			mockIsGhInstalled.mockResolvedValue(false);

			const result = await callCheckAuth();

			expect(result.authenticated).toBe(false);
			expect(result.message).toContain('not installed');
			expect(mockSetCachedGhStatus).toHaveBeenCalledWith(false, false);
		});

		it('returns authenticated: false with message when gh auth check fails', async () => {
			mockIsGhInstalled.mockResolvedValue(true);
			mockExecFileNoThrow.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'not logged in' });

			const result = await callCheckAuth();

			expect(result.authenticated).toBe(false);
			expect(result.message).toContain('not authenticated');
			expect(mockSetCachedGhStatus).toHaveBeenCalledWith(true, false);
		});

		it('returns cached result when cache is available (installed + authenticated)', async () => {
			mockGetCachedGhStatus.mockReturnValue({ installed: true, authenticated: true });

			const result = await callCheckAuth();

			expect(result).toEqual({ authenticated: true });
			expect(mockIsGhInstalled).not.toHaveBeenCalled();
		});

		it('returns cached not-installed result without calling isGhInstalled', async () => {
			mockGetCachedGhStatus.mockReturnValue({ installed: false, authenticated: false });

			const result = await callCheckAuth();

			expect(result.authenticated).toBe(false);
			expect(result.message).toContain('not installed');
			expect(mockIsGhInstalled).not.toHaveBeenCalled();
		});

		it('returns cached not-authenticated result without calling isGhInstalled', async () => {
			mockGetCachedGhStatus.mockReturnValue({ installed: true, authenticated: false });

			const result = await callCheckAuth();

			expect(result.authenticated).toBe(false);
			expect(result.message).toContain('not authenticated');
			expect(mockIsGhInstalled).not.toHaveBeenCalled();
		});
	});

	describe('feedback:submit', () => {
		const callSubmit = (params: { sessionId: string; feedbackText: string }) =>
			handlers.get('feedback:submit')!(null, params);

		it('writes constructed prompt to session and returns success', async () => {
			const result = await callSubmit({ sessionId: 'session-1', feedbackText: 'Great app!' });

			expect(result).toEqual({ success: true });
			expect(mockProcessManager.write).toHaveBeenCalledWith(
				'session-1',
				expect.stringContaining('Great app!')
			);
		});

		it('includes feedback text in the constructed prompt', async () => {
			await callSubmit({ sessionId: 'session-1', feedbackText: 'Fix the bug please' });

			const writtenPrompt: string = mockProcessManager.write.mock.calls[0][1];
			expect(writtenPrompt).toContain('Fix the bug please');
		});

		it('returns failure when process manager is unavailable', async () => {
			const newHandlers = new Map<string, Function>();
			vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
				newHandlers.set(channel, handler as Function);
			});
			handlers = newHandlers;
			registerFeedbackHandlers({ getProcessManager: () => null });

			const result = await handlers.get('feedback:submit')!(null, {
				sessionId: 'session-1',
				feedbackText: 'test',
			});

			expect(result).toEqual({ success: false, error: expect.any(String) });
		});

		it('returns failure when write() returns false (agent exited)', async () => {
			mockProcessManager.write.mockReturnValue(false);

			const result = await callSubmit({ sessionId: 'dead-session', feedbackText: 'test' });

			expect(result).toEqual({ success: false, error: expect.any(String) });
		});
	});
});
