/**
 * Tests for leaderboard IPC handlers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';

// Mock electron
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
	},
}));

// Mock logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

import {
	registerLeaderboardHandlers,
	getFetchTimeoutMs,
	fetchWithTimeout,
} from '../../../../main/ipc/handlers/leaderboard';

describe('Leaderboard IPC Handlers', () => {
	const mockApp = {
		getVersion: vi.fn().mockReturnValue('1.0.0'),
	};

	const mockSettingsStore = {
		get: vi.fn(),
		set: vi.fn(),
	};

	let handlers: Map<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();

		// Capture registered handlers
		vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
			handlers.set(channel, handler);
		});

		registerLeaderboardHandlers({
			app: mockApp as any,
			settingsStore: mockSettingsStore as any,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('handler registration', () => {
		it('should register all leaderboard handlers', () => {
			expect(handlers.has('leaderboard:getInstallationId')).toBe(true);
			expect(handlers.has('leaderboard:submit')).toBe(true);
			expect(handlers.has('leaderboard:pollAuthStatus')).toBe(true);
			expect(handlers.has('leaderboard:resendConfirmation')).toBe(true);
			expect(handlers.has('leaderboard:get')).toBe(true);
			expect(handlers.has('leaderboard:getLongestRuns')).toBe(true);
			expect(handlers.has('leaderboard:sync')).toBe(true);
		});
	});

	describe('leaderboard:getInstallationId', () => {
		it('should return installation ID from store', async () => {
			mockSettingsStore.get.mockReturnValue('test-installation-id');

			const handler = handlers.get('leaderboard:getInstallationId')!;
			const result = await handler({});

			expect(result).toBe('test-installation-id');
			expect(mockSettingsStore.get).toHaveBeenCalledWith('installationId');
		});

		it('should return null if no installation ID exists', async () => {
			mockSettingsStore.get.mockReturnValue(undefined);

			const handler = handlers.get('leaderboard:getInstallationId')!;
			const result = await handler({});

			expect(result).toBeNull();
		});
	});

	describe('leaderboard:submit', () => {
		const mockSubmitData = {
			email: 'test@example.com',
			displayName: 'Test User',
			badgeLevel: 1,
			badgeName: 'Bronze',
			cumulativeTimeMs: 10000,
			totalRuns: 5,
		};

		it('should submit leaderboard entry successfully', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						success: true,
						message: 'Submission received',
						ranking: {
							cumulative: { rank: 10, total: 100, previousRank: 11, improved: true },
							longestRun: null,
						},
					}),
			});

			const handler = handlers.get('leaderboard:submit')!;
			const result = await handler({}, mockSubmitData);

			expect(result.success).toBe(true);
			expect(result.message).toBe('Submission received');
			expect(result.ranking).toBeDefined();
			expect(mockFetch).toHaveBeenCalledWith(
				'https://runmaestro.ai/api/m4estr0/submit',
				expect.objectContaining({
					method: 'POST',
					headers: expect.objectContaining({
						'Content-Type': 'application/json',
					}),
				})
			);
		});

		it('should handle 401 auth required response', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 401,
				json: () =>
					Promise.resolve({
						message: 'Authentication required',
						error: 'Auth token required',
					}),
			});

			const handler = handlers.get('leaderboard:submit')!;
			const result = await handler({}, mockSubmitData);

			expect(result.success).toBe(false);
			expect(result.authTokenRequired).toBe(true);
		});

		it('should handle server errors', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				json: () =>
					Promise.resolve({
						message: 'Server error',
					}),
			});

			const handler = handlers.get('leaderboard:submit')!;
			const result = await handler({}, mockSubmitData);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Server error');
		});

		it('should handle network errors', async () => {
			mockFetch.mockRejectedValue(new Error('Network error'));

			const handler = handlers.get('leaderboard:submit')!;
			const result = await handler({}, mockSubmitData);

			expect(result.success).toBe(false);
			expect(result.message).toBe('Failed to connect to leaderboard server');
			expect(result.error).toBe('Network error');
		});

		it('should auto-inject installation ID if not provided', async () => {
			mockSettingsStore.get.mockReturnValue('auto-injected-id');
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: true, message: 'OK' }),
			});

			const handler = handlers.get('leaderboard:submit')!;
			await handler({}, mockSubmitData);

			const fetchCall = mockFetch.mock.calls[0];
			const body = JSON.parse(fetchCall[1].body);
			expect(body.installId).toBe('auto-injected-id');
		});
	});

	describe('leaderboard:pollAuthStatus', () => {
		it('should return confirmed status with auth token', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						status: 'confirmed',
						authToken: 'new-auth-token',
					}),
			});

			const handler = handlers.get('leaderboard:pollAuthStatus')!;
			const result = await handler({}, 'client-token');

			expect(result.status).toBe('confirmed');
			expect(result.authToken).toBe('new-auth-token');
		});

		it('should return pending status', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						status: 'pending',
					}),
			});

			const handler = handlers.get('leaderboard:pollAuthStatus')!;
			const result = await handler({}, 'client-token');

			expect(result.status).toBe('pending');
		});

		it('should handle server errors', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				json: () =>
					Promise.resolve({
						message: 'Server error',
					}),
			});

			const handler = handlers.get('leaderboard:pollAuthStatus')!;
			const result = await handler({}, 'client-token');

			expect(result.status).toBe('error');
			expect(result.error).toContain('Server error');
		});

		it('should handle network errors', async () => {
			mockFetch.mockRejectedValue(new Error('Network error'));

			const handler = handlers.get('leaderboard:pollAuthStatus')!;
			const result = await handler({}, 'client-token');

			expect(result.status).toBe('error');
			expect(result.error).toBe('Network error');
		});
	});

	describe('leaderboard:resendConfirmation', () => {
		it('should successfully resend confirmation', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						success: true,
						message: 'Email sent',
					}),
			});

			const handler = handlers.get('leaderboard:resendConfirmation')!;
			const result = await handler({}, { email: 'test@example.com', clientToken: 'token' });

			expect(result.success).toBe(true);
			expect(result.message).toBe('Email sent');
		});

		it('should handle failure', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 400,
				json: () =>
					Promise.resolve({
						success: false,
						error: 'Invalid email',
					}),
			});

			const handler = handlers.get('leaderboard:resendConfirmation')!;
			const result = await handler({}, { email: 'test@example.com', clientToken: 'token' });

			expect(result.success).toBe(false);
			expect(result.error).toBe('Invalid email');
		});

		it('should handle network errors', async () => {
			mockFetch.mockRejectedValue(new Error('Network error'));

			const handler = handlers.get('leaderboard:resendConfirmation')!;
			const result = await handler({}, { email: 'test@example.com', clientToken: 'token' });

			expect(result.success).toBe(false);
			expect(result.error).toBe('Network error');
		});
	});

	describe('leaderboard:get', () => {
		it('should fetch leaderboard entries', async () => {
			const mockEntries = [
				{ rank: 1, displayName: 'User 1', badgeLevel: 5, cumulativeTimeMs: 100000 },
				{ rank: 2, displayName: 'User 2', badgeLevel: 4, cumulativeTimeMs: 90000 },
			];

			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries: mockEntries }),
			});

			const handler = handlers.get('leaderboard:get')!;
			const result = await handler({}, { limit: 10 });

			expect(result.success).toBe(true);
			expect(result.entries).toEqual(mockEntries);
			expect(mockFetch).toHaveBeenCalledWith(
				'https://runmaestro.ai/api/leaderboard?limit=10',
				expect.any(Object)
			);
		});

		it('should use default limit of 50', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries: [] }),
			});

			const handler = handlers.get('leaderboard:get')!;
			await handler({});

			expect(mockFetch).toHaveBeenCalledWith(
				'https://runmaestro.ai/api/leaderboard?limit=50',
				expect.any(Object)
			);
		});

		it('should handle server errors', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
			});

			const handler = handlers.get('leaderboard:get')!;
			const result = await handler({});

			expect(result.success).toBe(false);
			expect(result.error).toContain('Server error');
		});

		it('should handle network errors', async () => {
			mockFetch.mockRejectedValue(new Error('Network error'));

			const handler = handlers.get('leaderboard:get')!;
			const result = await handler({});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Network error');
		});
	});

	describe('leaderboard:getLongestRuns', () => {
		it('should fetch longest runs leaderboard', async () => {
			const mockEntries = [
				{ rank: 1, displayName: 'User 1', longestRunMs: 50000, runDate: '2024-01-01' },
			];

			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries: mockEntries }),
			});

			const handler = handlers.get('leaderboard:getLongestRuns')!;
			const result = await handler({}, { limit: 10 });

			expect(result.success).toBe(true);
			expect(result.entries).toEqual(mockEntries);
			expect(mockFetch).toHaveBeenCalledWith(
				'https://runmaestro.ai/api/longest-runs?limit=10',
				expect.any(Object)
			);
		});

		it('should use default limit of 50', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries: [] }),
			});

			const handler = handlers.get('leaderboard:getLongestRuns')!;
			await handler({});

			expect(mockFetch).toHaveBeenCalledWith(
				'https://runmaestro.ai/api/longest-runs?limit=50',
				expect.any(Object)
			);
		});

		it('should handle server errors', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
			});

			const handler = handlers.get('leaderboard:getLongestRuns')!;
			const result = await handler({});

			expect(result.success).toBe(false);
			expect(result.error).toContain('Server error');
		});

		it('should handle network errors', async () => {
			mockFetch.mockRejectedValue(new Error('Network error'));

			const handler = handlers.get('leaderboard:getLongestRuns')!;
			const result = await handler({});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Network error');
		});
	});

	describe('leaderboard:sync', () => {
		it('should sync user stats successfully', async () => {
			const mockData = {
				displayName: 'Test User',
				badgeLevel: 3,
				badgeName: 'Gold',
				cumulativeTimeMs: 50000,
				totalRuns: 25,
				longestRunMs: 5000,
				longestRunDate: '2024-01-01',
				keyboardLevel: 2,
				coveragePercent: 75,
				ranking: {
					cumulative: { rank: 5, total: 100 },
					longestRun: { rank: 10, total: 100 },
				},
			};

			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: true, found: true, data: mockData }),
			});

			const handler = handlers.get('leaderboard:sync')!;
			const result = await handler({}, { email: 'test@example.com', authToken: 'token' });

			expect(result.success).toBe(true);
			expect(result.found).toBe(true);
			expect(result.data).toEqual(mockData);
		});

		it('should handle user not found', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						success: true,
						found: false,
						message: 'No existing registration',
					}),
			});

			const handler = handlers.get('leaderboard:sync')!;
			const result = await handler({}, { email: 'test@example.com', authToken: 'token' });

			expect(result.success).toBe(true);
			expect(result.found).toBe(false);
		});

		it('should handle invalid token (401)', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 401,
				json: () =>
					Promise.resolve({
						error: 'Invalid token',
					}),
			});

			const handler = handlers.get('leaderboard:sync')!;
			const result = await handler({}, { email: 'test@example.com', authToken: 'bad-token' });

			expect(result.success).toBe(false);
			expect(result.errorCode).toBe('INVALID_TOKEN');
		});

		it('should handle email not confirmed (403)', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 403,
				json: () =>
					Promise.resolve({
						error: 'Email not confirmed',
					}),
			});

			const handler = handlers.get('leaderboard:sync')!;
			const result = await handler({}, { email: 'test@example.com', authToken: 'token' });

			expect(result.success).toBe(false);
			expect(result.errorCode).toBe('EMAIL_NOT_CONFIRMED');
		});

		it('should handle missing fields (400)', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 400,
				json: () =>
					Promise.resolve({
						error: 'Missing email',
					}),
			});

			const handler = handlers.get('leaderboard:sync')!;
			const result = await handler({}, { email: '', authToken: 'token' });

			expect(result.success).toBe(false);
			expect(result.errorCode).toBe('MISSING_FIELDS');
		});

		it('should handle network errors', async () => {
			mockFetch.mockRejectedValue(new Error('Network error'));

			const handler = handlers.get('leaderboard:sync')!;
			const result = await handler({}, { email: 'test@example.com', authToken: 'token' });

			expect(result.success).toBe(false);
			expect(result.found).toBe(false);
			expect(result.error).toBe('Network error');
		});

		it('should handle timeout errors', async () => {
			const abortError = new Error('Aborted');
			abortError.name = 'AbortError';
			mockFetch.mockRejectedValue(abortError);

			const handler = handlers.get('leaderboard:sync')!;
			const result = await handler({}, { email: 'test@example.com', authToken: 'token' });

			expect(result.success).toBe(false);
			expect(result.found).toBe(false);
			expect(result.error).toBe('Request timed out');
		});
	});

	describe('fetchWithTimeout helper', () => {
		it('should return default timeout value', () => {
			expect(getFetchTimeoutMs()).toBe(30000);
		});

		it('should complete successfully before timeout', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ data: 'test' }),
			});

			const response = await fetchWithTimeout('https://example.com/api', {});
			expect(response.ok).toBe(true);
		});

		it('should abort on timeout', async () => {
			// Create a fetch that respects the abort signal
			mockFetch.mockImplementation((_url: string, options: RequestInit) => {
				return new Promise((_resolve, reject) => {
					// Check if already aborted
					if (options.signal?.aborted) {
						const error = new Error('Aborted');
						error.name = 'AbortError';
						reject(error);
						return;
					}

					// Listen for abort
					options.signal?.addEventListener('abort', () => {
						const error = new Error('Aborted');
						error.name = 'AbortError';
						reject(error);
					});
				});
			});

			// Use a very short timeout to test the abort behavior
			await expect(fetchWithTimeout('https://example.com/api', {}, 10)).rejects.toThrow();
		});

		it('should pass abort signal to fetch', async () => {
			mockFetch.mockResolvedValue({ ok: true });

			await fetchWithTimeout('https://example.com/api', { method: 'POST' });

			expect(mockFetch).toHaveBeenCalledWith(
				'https://example.com/api',
				expect.objectContaining({
					method: 'POST',
					signal: expect.any(AbortSignal),
				})
			);
		});
	});

	describe('timeout handling in handlers', () => {
		it('should handle timeout in leaderboard:submit', async () => {
			const abortError = new Error('Aborted');
			abortError.name = 'AbortError';
			mockFetch.mockRejectedValue(abortError);

			const handler = handlers.get('leaderboard:submit')!;
			const result = await handler(
				{},
				{
					email: 'test@example.com',
					displayName: 'Test',
					badgeLevel: 1,
					badgeName: 'Bronze',
					cumulativeTimeMs: 1000,
					totalRuns: 1,
				}
			);

			expect(result.success).toBe(false);
			expect(result.message).toBe('Request timed out');
			expect(result.error).toContain('timed out');
		});

		it('should handle timeout in leaderboard:pollAuthStatus', async () => {
			const abortError = new Error('Aborted');
			abortError.name = 'AbortError';
			mockFetch.mockRejectedValue(abortError);

			const handler = handlers.get('leaderboard:pollAuthStatus')!;
			const result = await handler({}, 'client-token');

			expect(result.status).toBe('error');
			expect(result.error).toBe('Request timed out');
		});

		it('should handle timeout in leaderboard:resendConfirmation', async () => {
			const abortError = new Error('Aborted');
			abortError.name = 'AbortError';
			mockFetch.mockRejectedValue(abortError);

			const handler = handlers.get('leaderboard:resendConfirmation')!;
			const result = await handler({}, { email: 'test@example.com', clientToken: 'token' });

			expect(result.success).toBe(false);
			expect(result.error).toBe('Request timed out');
		});

		it('should handle timeout in leaderboard:get', async () => {
			const abortError = new Error('Aborted');
			abortError.name = 'AbortError';
			mockFetch.mockRejectedValue(abortError);

			const handler = handlers.get('leaderboard:get')!;
			const result = await handler({});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Request timed out');
		});

		it('should handle timeout in leaderboard:getLongestRuns', async () => {
			const abortError = new Error('Aborted');
			abortError.name = 'AbortError';
			mockFetch.mockRejectedValue(abortError);

			const handler = handlers.get('leaderboard:getLongestRuns')!;
			const result = await handler({});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Request timed out');
		});
	});
});
