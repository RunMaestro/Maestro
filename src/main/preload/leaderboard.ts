/**
 * Preload API for leaderboard
 *
 * Provides the window.maestro.leaderboard namespace for:
 * - Getting installation ID
 * - Submitting leaderboard entries
 * - Polling auth status after email confirmation
 * - Resending confirmation emails
 * - Fetching leaderboard data
 * - Syncing stats from server
 */

import { ipcRenderer } from 'electron';

/**
 * Data submitted when creating/updating a leaderboard entry
 */
export interface LeaderboardSubmitData {
	email: string;
	displayName: string;
	githubUsername?: string;
	twitterHandle?: string;
	linkedinHandle?: string;
	discordUsername?: string;
	blueskyHandle?: string;
	badgeLevel: number;
	badgeName: string;
	cumulativeTimeMs: number;
	totalRuns: number;
	longestRunMs?: number;
	longestRunDate?: string;
	currentRunMs?: number;
	theme?: string;
	clientToken?: string;
	authToken?: string;
	deltaMs?: number;
	deltaRuns?: number;
	installationId?: string;
	clientTotalTimeMs?: number;
}

/**
 * Response from leaderboard submission
 */
export interface LeaderboardSubmitResponse {
	success: boolean;
	message: string;
	pendingEmailConfirmation?: boolean;
	error?: string;
	authTokenRequired?: boolean;
	ranking?: {
		cumulative: {
			rank: number;
			total: number;
			previousRank: number | null;
			improved: boolean;
		};
		longestRun: {
			rank: number;
			total: number;
			previousRank: number | null;
			improved: boolean;
		} | null;
	};
	serverTotals?: {
		cumulativeTimeMs: number;
		totalRuns: number;
	};
}

/**
 * Response from polling auth status
 */
export interface AuthStatusResponse {
	status: 'pending' | 'confirmed' | 'expired' | 'error';
	authToken?: string;
	message?: string;
	error?: string;
}

/**
 * Response from resending confirmation
 */
export interface ResendConfirmationResponse {
	success: boolean;
	message?: string;
	error?: string;
}

/**
 * Leaderboard entry for cumulative time rankings
 */
export interface LeaderboardEntry {
	rank: number;
	displayName: string;
	githubUsername?: string;
	avatarUrl?: string;
	badgeLevel: number;
	badgeName: string;
	cumulativeTimeMs: number;
	totalRuns: number;
}

/**
 * Leaderboard entry for longest run rankings
 */
export interface LongestRunEntry {
	rank: number;
	displayName: string;
	githubUsername?: string;
	avatarUrl?: string;
	longestRunMs: number;
	runDate: string;
}

/**
 * Response from fetching leaderboard
 */
export interface LeaderboardGetResponse {
	success: boolean;
	entries?: LeaderboardEntry[];
	error?: string;
}

/**
 * Response from fetching longest runs leaderboard
 */
export interface LongestRunsGetResponse {
	success: boolean;
	entries?: LongestRunEntry[];
	error?: string;
}

/**
 * Response from syncing stats
 */
export interface LeaderboardSyncResponse {
	success: boolean;
	found: boolean;
	message?: string;
	error?: string;
	errorCode?: 'EMAIL_NOT_CONFIRMED' | 'INVALID_TOKEN' | 'MISSING_FIELDS';
	data?: {
		displayName: string;
		badgeLevel: number;
		badgeName: string;
		cumulativeTimeMs: number;
		totalRuns: number;
		longestRunMs: number | null;
		longestRunDate: string | null;
		keyboardLevel: number | null;
		coveragePercent: number | null;
		ranking: {
			cumulative: { rank: number; total: number };
			longestRun: { rank: number; total: number } | null;
		};
	};
}

/**
 * Creates the leaderboard API object for preload exposure
 */
export function createLeaderboardApi() {
	return {
		/**
		 * Get the unique installation ID for this Maestro installation
		 */
		getInstallationId: (): Promise<string | null> =>
			ipcRenderer.invoke('leaderboard:getInstallationId'),

		/**
		 * Submit leaderboard entry to runmaestro.ai
		 * @param data - Leaderboard submission data
		 */
		submit: (data: LeaderboardSubmitData): Promise<LeaderboardSubmitResponse> =>
			ipcRenderer.invoke('leaderboard:submit', data),

		/**
		 * Poll for auth token after email confirmation
		 * @param clientToken - Client token from initial submission
		 */
		pollAuthStatus: (clientToken: string): Promise<AuthStatusResponse> =>
			ipcRenderer.invoke('leaderboard:pollAuthStatus', clientToken),

		/**
		 * Resend confirmation email (self-service auth token recovery)
		 * @param data - Email and client token
		 */
		resendConfirmation: (data: {
			email: string;
			clientToken: string;
		}): Promise<ResendConfirmationResponse> =>
			ipcRenderer.invoke('leaderboard:resendConfirmation', data),

		/**
		 * Get leaderboard entries (cumulative time rankings)
		 * @param options - Optional limit (default: 50)
		 */
		get: (options?: { limit?: number }): Promise<LeaderboardGetResponse> =>
			ipcRenderer.invoke('leaderboard:get', options),

		/**
		 * Get longest runs leaderboard
		 * @param options - Optional limit (default: 50)
		 */
		getLongestRuns: (options?: { limit?: number }): Promise<LongestRunsGetResponse> =>
			ipcRenderer.invoke('leaderboard:getLongestRuns', options),

		/**
		 * Sync user stats from server (for new device installations)
		 * @param data - Email and auth token
		 */
		sync: (data: { email: string; authToken: string }): Promise<LeaderboardSyncResponse> =>
			ipcRenderer.invoke('leaderboard:sync', data),
	};
}

/**
 * TypeScript type for the leaderboard API
 */
export type LeaderboardApi = ReturnType<typeof createLeaderboardApi>;
