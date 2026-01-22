/**
 * Tests for leaderboard preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createLeaderboardApi } from '../../../main/preload/leaderboard';

describe('Leaderboard Preload API', () => {
	let api: ReturnType<typeof createLeaderboardApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createLeaderboardApi();
	});

	describe('getInstallationId', () => {
		it('should invoke leaderboard:getInstallationId', async () => {
			mockInvoke.mockResolvedValue('test-installation-id');

			const result = await api.getInstallationId();

			expect(mockInvoke).toHaveBeenCalledWith('leaderboard:getInstallationId');
			expect(result).toBe('test-installation-id');
		});

		it('should return null when no installation ID', async () => {
			mockInvoke.mockResolvedValue(null);

			const result = await api.getInstallationId();

			expect(result).toBeNull();
		});
	});

	describe('submit', () => {
		it('should invoke leaderboard:submit with data', async () => {
			const submitData = {
				email: 'test@example.com',
				displayName: 'Test User',
				badgeLevel: 1,
				badgeName: 'Bronze',
				cumulativeTimeMs: 10000,
				totalRuns: 5,
			};
			mockInvoke.mockResolvedValue({ success: true, message: 'Submitted' });

			const result = await api.submit(submitData);

			expect(mockInvoke).toHaveBeenCalledWith('leaderboard:submit', submitData);
			expect(result.success).toBe(true);
		});
	});

	describe('pollAuthStatus', () => {
		it('should invoke leaderboard:pollAuthStatus with clientToken', async () => {
			mockInvoke.mockResolvedValue({ status: 'confirmed', authToken: 'new-token' });

			const result = await api.pollAuthStatus('client-token');

			expect(mockInvoke).toHaveBeenCalledWith('leaderboard:pollAuthStatus', 'client-token');
			expect(result.status).toBe('confirmed');
			expect(result.authToken).toBe('new-token');
		});

		it('should handle pending status', async () => {
			mockInvoke.mockResolvedValue({ status: 'pending' });

			const result = await api.pollAuthStatus('client-token');

			expect(result.status).toBe('pending');
		});
	});

	describe('resendConfirmation', () => {
		it('should invoke leaderboard:resendConfirmation with email and clientToken', async () => {
			mockInvoke.mockResolvedValue({ success: true, message: 'Email sent' });

			const result = await api.resendConfirmation({
				email: 'test@example.com',
				clientToken: 'token',
			});

			expect(mockInvoke).toHaveBeenCalledWith('leaderboard:resendConfirmation', {
				email: 'test@example.com',
				clientToken: 'token',
			});
			expect(result.success).toBe(true);
		});
	});

	describe('get', () => {
		it('should invoke leaderboard:get without options', async () => {
			mockInvoke.mockResolvedValue({ success: true, entries: [] });

			const result = await api.get();

			expect(mockInvoke).toHaveBeenCalledWith('leaderboard:get', undefined);
			expect(result.success).toBe(true);
		});

		it('should invoke leaderboard:get with limit option', async () => {
			const mockEntries = [
				{ rank: 1, displayName: 'User', badgeLevel: 5, cumulativeTimeMs: 100000 },
			];
			mockInvoke.mockResolvedValue({ success: true, entries: mockEntries });

			const result = await api.get({ limit: 10 });

			expect(mockInvoke).toHaveBeenCalledWith('leaderboard:get', { limit: 10 });
			expect(result.entries).toEqual(mockEntries);
		});
	});

	describe('getLongestRuns', () => {
		it('should invoke leaderboard:getLongestRuns', async () => {
			const mockEntries = [
				{ rank: 1, displayName: 'User', longestRunMs: 50000, runDate: '2024-01-01' },
			];
			mockInvoke.mockResolvedValue({ success: true, entries: mockEntries });

			const result = await api.getLongestRuns({ limit: 5 });

			expect(mockInvoke).toHaveBeenCalledWith('leaderboard:getLongestRuns', { limit: 5 });
			expect(result.entries).toEqual(mockEntries);
		});
	});

	describe('sync', () => {
		it('should invoke leaderboard:sync with email and authToken', async () => {
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
			mockInvoke.mockResolvedValue({ success: true, found: true, data: mockData });

			const result = await api.sync({ email: 'test@example.com', authToken: 'token' });

			expect(mockInvoke).toHaveBeenCalledWith('leaderboard:sync', {
				email: 'test@example.com',
				authToken: 'token',
			});
			expect(result.success).toBe(true);
			expect(result.found).toBe(true);
			expect(result.data).toEqual(mockData);
		});

		it('should handle user not found', async () => {
			mockInvoke.mockResolvedValue({ success: true, found: false });

			const result = await api.sync({ email: 'test@example.com', authToken: 'token' });

			expect(result.found).toBe(false);
		});
	});
});
