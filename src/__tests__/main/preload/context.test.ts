/**
 * Tests for context preload API
 *
 * Coverage:
 * - createContextApi: getStoredSession, groomContext, cancelGrooming,
 *   createGroomingSession (deprecated), sendGroomingPrompt (deprecated), cleanupGroomingSession
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createContextApi } from '../../../main/preload/context';

describe('Context Preload API', () => {
	let api: ReturnType<typeof createContextApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createContextApi();
	});

	describe('getStoredSession', () => {
		it('should invoke context:getStoredSession with correct parameters', async () => {
			const mockResponse = {
				messages: [{ type: 'user', content: 'Hello', timestamp: '2024-01-01', uuid: '123' }],
				total: 1,
				hasMore: false,
			};
			mockInvoke.mockResolvedValue(mockResponse);

			const result = await api.getStoredSession('claude-code', '/project', 'session-123');

			expect(mockInvoke).toHaveBeenCalledWith(
				'context:getStoredSession',
				'claude-code',
				'/project',
				'session-123'
			);
			expect(result).toEqual(mockResponse);
		});

		it('should return null for non-existent session', async () => {
			mockInvoke.mockResolvedValue(null);

			const result = await api.getStoredSession('claude-code', '/project', 'non-existent');

			expect(result).toBeNull();
		});
	});

	describe('groomContext', () => {
		it('should invoke context:groomContext with correct parameters', async () => {
			mockInvoke.mockResolvedValue('groomed context response');

			const result = await api.groomContext('/project', 'claude-code', 'summarize this');

			expect(mockInvoke).toHaveBeenCalledWith(
				'context:groomContext',
				'/project',
				'claude-code',
				'summarize this'
			);
			expect(result).toBe('groomed context response');
		});

		it('should propagate errors from IPC', async () => {
			mockInvoke.mockRejectedValue(new Error('Grooming failed'));

			await expect(api.groomContext('/project', 'claude-code', 'prompt')).rejects.toThrow(
				'Grooming failed'
			);
		});
	});

	describe('cancelGrooming', () => {
		it('should invoke context:cancelGrooming', async () => {
			mockInvoke.mockResolvedValue(undefined);

			await api.cancelGrooming();

			expect(mockInvoke).toHaveBeenCalledWith('context:cancelGrooming');
		});
	});

	describe('createGroomingSession (deprecated)', () => {
		it('should invoke context:createGroomingSession', async () => {
			mockInvoke.mockResolvedValue('grooming-session-id');

			const result = await api.createGroomingSession('/project', 'claude-code');

			expect(mockInvoke).toHaveBeenCalledWith(
				'context:createGroomingSession',
				'/project',
				'claude-code'
			);
			expect(result).toBe('grooming-session-id');
		});
	});

	describe('sendGroomingPrompt (deprecated)', () => {
		it('should invoke context:sendGroomingPrompt', async () => {
			mockInvoke.mockResolvedValue('response text');

			const result = await api.sendGroomingPrompt('session-123', 'prompt text');

			expect(mockInvoke).toHaveBeenCalledWith(
				'context:sendGroomingPrompt',
				'session-123',
				'prompt text'
			);
			expect(result).toBe('response text');
		});
	});

	describe('cleanupGroomingSession', () => {
		it('should invoke context:cleanupGroomingSession', async () => {
			mockInvoke.mockResolvedValue(undefined);

			await api.cleanupGroomingSession('session-123');

			expect(mockInvoke).toHaveBeenCalledWith('context:cleanupGroomingSession', 'session-123');
		});
	});
});
