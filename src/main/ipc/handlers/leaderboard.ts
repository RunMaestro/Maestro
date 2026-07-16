/**
 * Leaderboard IPC Handlers
 *
 * Handles all leaderboard-related IPC operations:
 * - Getting installation ID
 * - Submitting leaderboard entries
 * - Polling auth status after email confirmation
 * - Resending confirmation emails
 * - Fetching leaderboard data
 * - Syncing stats from server
 */

import { ipcMain, App } from 'electron';
import Store from 'electron-store';
import { logger } from '../../utils/logger';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout';
import type { MaestroSettings } from './persistence';

// ==========================================================================
// Constants
// ==========================================================================

const LEADERBOARD_API_BASE = 'https://runmaestro.ai/api';
const M4ESTR0_API_BASE = 'https://runmaestro.ai/api/m4estr0';

/**
 * Default timeout for fetch requests in milliseconds.
 * 30 seconds is reasonable for API calls that may have some latency.
 */
const FETCH_TIMEOUT_MS = 30000;

// ==========================================================================
// Types
// ==========================================================================

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
	// Delta mode for multi-device aggregation
	deltaMs?: number;
	deltaRuns?: number;
	// Installation tracking for multi-device differentiation
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
 * Dependencies required for leaderboard handler registration
 */
export interface LeaderboardHandlerDependencies {
	app: App;
	settingsStore: Store<MaestroSettings>;
}

// ==========================================================================
// Helper Functions
// ==========================================================================

// ==========================================================================
// Handler Registration
// ==========================================================================

/**
 * Register all leaderboard-related IPC handlers
 */
export function registerLeaderboardHandlers(deps: LeaderboardHandlerDependencies): void {
	const { app, settingsStore } = deps;

	// Get the unique installation ID for this Maestro installation
	ipcMain.handle('leaderboard:getInstallationId', async () => {
		return settingsStore.get('installationId') || null;
	});

	// Submit leaderboard entry to runmaestro.ai
	ipcMain.handle(
		'leaderboard:submit',
		async (_event, data: LeaderboardSubmitData): Promise<LeaderboardSubmitResponse> => {
			try {
				// Auto-inject installation ID if not provided
				const installationId =
					data.installationId || settingsStore.get('installationId') || undefined;

				logger.info('Submitting leaderboard entry', 'Leaderboard', {
					displayName: data.displayName,
					email: data.email.substring(0, 3) + '***',
					badgeLevel: data.badgeLevel,
					hasClientToken: !!data.clientToken,
					hasAuthToken: !!data.authToken,
					hasInstallationId: !!installationId,
					hasClientTotalTime: !!data.clientTotalTimeMs,
				});

				// Prepare submission data with server-expected field names
				// Server expects 'installId' not 'installationId'
				const submissionData = {
					...data,
					installId: installationId,
				};

				const response = await fetchWithTimeout(
					`${M4ESTR0_API_BASE}/submit`,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'User-Agent': `Maestro/${app.getVersion()}`,
						},
						body: JSON.stringify(submissionData),
					},
					FETCH_TIMEOUT_MS
				);

				const result = (await response.json()) as {
					success?: boolean;
					message?: string;
					pendingEmailConfirmation?: boolean;
					error?: string;
					ranking?: LeaderboardSubmitResponse['ranking'];
					serverTotals?: LeaderboardSubmitResponse['serverTotals'];
				};

				if (response.ok) {
					logger.info('Leaderboard submission successful', 'Leaderboard', {
						pendingEmailConfirmation: result.pendingEmailConfirmation,
						ranking: result.ranking,
						serverTotals: result.serverTotals,
					});
					return {
						success: true,
						message: result.message || 'Submission received',
						pendingEmailConfirmation: result.pendingEmailConfirmation,
						ranking: result.ranking,
						serverTotals: result.serverTotals,
					};
				} else if (response.status === 401) {
					// Auth token required or invalid
					logger.warn('Leaderboard submission requires auth token', 'Leaderboard', {
						error: result.error || result.message,
					});
					return {
						success: false,
						message: result.message || 'Authentication required',
						error: result.error || 'Auth token required for confirmed email addresses',
						authTokenRequired: true,
					};
				} else {
					logger.warn('Leaderboard submission failed', 'Leaderboard', {
						status: response.status,
						error: result.error || result.message,
					});
					return {
						success: false,
						message: result.message || 'Submission failed',
						error: result.error || `Server error: ${response.status}`,
					};
				}
			} catch (error) {
				// Handle timeout specifically
				if (error instanceof Error && error.name === 'AbortError') {
					logger.error('Leaderboard submission timed out', 'Leaderboard');
					return {
						success: false,
						message: 'Request timed out',
						error: 'Request timed out. Please check your network connection and try again.',
					};
				}
				logger.error('Error submitting to leaderboard', 'Leaderboard', error);
				return {
					success: false,
					message: 'Failed to connect to leaderboard server',
					error: error instanceof Error ? error.message : 'Unknown error',
				};
			}
		}
	);

	// Poll for auth token after email confirmation
	ipcMain.handle(
		'leaderboard:pollAuthStatus',
		async (_event, clientToken: string): Promise<AuthStatusResponse> => {
			try {
				logger.debug('Polling leaderboard auth status', 'Leaderboard');

				const response = await fetchWithTimeout(
					`${M4ESTR0_API_BASE}/auth-status?clientToken=${encodeURIComponent(clientToken)}`,
					{
						headers: {
							'User-Agent': `Maestro/${app.getVersion()}`,
						},
					},
					FETCH_TIMEOUT_MS
				);

				const result = (await response.json()) as {
					status: 'pending' | 'confirmed' | 'expired';
					authToken?: string;
					message?: string;
				};

				if (response.ok) {
					if (result.status === 'confirmed' && result.authToken) {
						logger.info('Leaderboard auth token received', 'Leaderboard');
					}
					return {
						status: result.status,
						authToken: result.authToken,
						message: result.message,
					};
				} else {
					return {
						status: 'error',
						error: result.message || `Server error: ${response.status}`,
					};
				}
			} catch (error) {
				// Handle timeout specifically
				if (error instanceof Error && error.name === 'AbortError') {
					logger.error('Leaderboard auth poll timed out', 'Leaderboard');
					return {
						status: 'error',
						error: 'Request timed out',
					};
				}
				logger.error('Error polling leaderboard auth status', 'Leaderboard', error);
				return {
					status: 'error',
					error: error instanceof Error ? error.message : 'Unknown error',
				};
			}
		}
	);

	// Resend confirmation email (self-service auth token recovery)
	ipcMain.handle(
		'leaderboard:resendConfirmation',
		async (
			_event,
			data: { email: string; clientToken: string }
		): Promise<ResendConfirmationResponse> => {
			try {
				logger.info('Requesting leaderboard confirmation resend', 'Leaderboard', {
					email: data.email.substring(0, 3) + '***',
				});

				const response = await fetchWithTimeout(
					`${M4ESTR0_API_BASE}/resend-confirmation`,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'User-Agent': `Maestro/${app.getVersion()}`,
						},
						body: JSON.stringify({
							email: data.email,
							clientToken: data.clientToken,
						}),
					},
					FETCH_TIMEOUT_MS
				);

				const result = (await response.json()) as {
					success?: boolean;
					message?: string;
					error?: string;
				};

				if (response.ok && result.success) {
					logger.info('Leaderboard confirmation email resent', 'Leaderboard');
					return {
						success: true,
						message: result.message || 'Confirmation email sent. Please check your inbox.',
					};
				} else {
					return {
						success: false,
						error: result.error || result.message || `Server error: ${response.status}`,
					};
				}
			} catch (error) {
				// Handle timeout specifically
				if (error instanceof Error && error.name === 'AbortError') {
					logger.error('Leaderboard resend confirmation timed out', 'Leaderboard');
					return {
						success: false,
						error: 'Request timed out',
					};
				}
				logger.error('Error resending leaderboard confirmation', 'Leaderboard', error);
				return {
					success: false,
					error: error instanceof Error ? error.message : 'Unknown error',
				};
			}
		}
	);

	// Get leaderboard entries
	ipcMain.handle(
		'leaderboard:get',
		async (_event, options?: { limit?: number }): Promise<LeaderboardGetResponse> => {
			try {
				const limit = options?.limit || 50;
				const response = await fetchWithTimeout(
					`${LEADERBOARD_API_BASE}/leaderboard?limit=${limit}`,
					{
						headers: {
							'User-Agent': `Maestro/${app.getVersion()}`,
						},
					},
					FETCH_TIMEOUT_MS
				);

				if (response.ok) {
					const data = (await response.json()) as { entries?: LeaderboardEntry[] };
					return {
						success: true,
						entries: data.entries,
					};
				} else {
					return {
						success: false,
						error: `Server error: ${response.status}`,
					};
				}
			} catch (error) {
				// Handle timeout specifically
				if (error instanceof Error && error.name === 'AbortError') {
					logger.error('Leaderboard fetch timed out', 'Leaderboard');
					return {
						success: false,
						error: 'Request timed out',
					};
				}
				logger.error('Error fetching leaderboard', 'Leaderboard', error);
				return {
					success: false,
					error: error instanceof Error ? error.message : 'Unknown error',
				};
			}
		}
	);

	// Get longest runs leaderboard
	ipcMain.handle(
		'leaderboard:getLongestRuns',
		async (_event, options?: { limit?: number }): Promise<LongestRunsGetResponse> => {
			try {
				const limit = options?.limit || 50;
				const response = await fetchWithTimeout(
					`${LEADERBOARD_API_BASE}/longest-runs?limit=${limit}`,
					{
						headers: {
							'User-Agent': `Maestro/${app.getVersion()}`,
						},
					},
					FETCH_TIMEOUT_MS
				);

				if (response.ok) {
					const data = (await response.json()) as { entries?: LongestRunEntry[] };
					return {
						success: true,
						entries: data.entries,
					};
				} else {
					return {
						success: false,
						error: `Server error: ${response.status}`,
					};
				}
			} catch (error) {
				// Handle timeout specifically
				if (error instanceof Error && error.name === 'AbortError') {
					logger.error('Longest runs fetch timed out', 'Leaderboard');
					return {
						success: false,
						error: 'Request timed out',
					};
				}
				logger.error('Error fetching longest runs leaderboard', 'Leaderboard', error);
				return {
					success: false,
					error: error instanceof Error ? error.message : 'Unknown error',
				};
			}
		}
	);

	// Sync user stats from server (for new device installations)
	ipcMain.handle(
		'leaderboard:sync',
		async (
			_event,
			data: { email: string; authToken: string }
		): Promise<LeaderboardSyncResponse> => {
			try {
				logger.info('Syncing leaderboard stats from server', 'Leaderboard', {
					email: data.email.substring(0, 3) + '***',
				});

				const response = await fetchWithTimeout(
					`${M4ESTR0_API_BASE}/sync`,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'User-Agent': `Maestro/${app.getVersion()}`,
						},
						body: JSON.stringify({
							email: data.email,
							authToken: data.authToken,
						}),
					},
					FETCH_TIMEOUT_MS
				);

				const result = (await response.json()) as {
					success: boolean;
					found?: boolean;
					message?: string;
					error?: string;
					errorCode?: string;
					data?: LeaderboardSyncResponse['data'];
				};

				if (response.ok && result.success) {
					if (result.found && result.data) {
						logger.info('Leaderboard sync successful', 'Leaderboard', {
							badgeLevel: result.data.badgeLevel,
							cumulativeTimeMs: result.data.cumulativeTimeMs,
						});
						return {
							success: true,
							found: true,
							data: result.data,
						};
					} else {
						logger.info('Leaderboard sync: user not found', 'Leaderboard');
						return {
							success: true,
							found: false,
							message: result.message || 'No existing registration found',
						};
					}
				} else if (response.status === 401) {
					logger.warn('Leaderboard sync: invalid token', 'Leaderboard');
					return {
						success: false,
						found: false,
						error: result.error || 'Invalid authentication token',
						errorCode: 'INVALID_TOKEN',
					};
				} else if (response.status === 403) {
					logger.warn('Leaderboard sync: email not confirmed', 'Leaderboard');
					return {
						success: false,
						found: false,
						error: result.error || 'Email not yet confirmed',
						errorCode: 'EMAIL_NOT_CONFIRMED',
					};
				} else if (response.status === 400) {
					return {
						success: false,
						found: false,
						error: result.error || 'Missing required fields',
						errorCode: 'MISSING_FIELDS',
					};
				} else {
					return {
						success: false,
						found: false,
						error: result.error || `Server error: ${response.status}`,
					};
				}
			} catch (error) {
				// Handle timeout specifically
				if (error instanceof Error && error.name === 'AbortError') {
					logger.error('Leaderboard sync timed out', 'Leaderboard');
					return {
						success: false,
						found: false,
						error: 'Request timed out',
					};
				}
				logger.error('Error syncing from leaderboard server', 'Leaderboard', error);
				return {
					success: false,
					found: false,
					error: error instanceof Error ? error.message : 'Unknown error',
				};
			}
		}
	);
}

// ==========================================================================
// Exports for Testing
// ==========================================================================

/**
 * Get the default fetch timeout in milliseconds (for testing)
 */
export function getFetchTimeoutMs(): number {
	return FETCH_TIMEOUT_MS;
}
