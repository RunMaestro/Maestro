/**
 * Leaderboard service — ships achievement time deltas to the RunMaestro
 * leaderboard.
 *
 * The server builds its totals from `deltaMs` submissions (delta mode, so a
 * user running Maestro on several machines aggregates correctly). A
 * `cumulativeTimeMs` sent WITHOUT a delta is ignored for an already-registered
 * user, since the server keeps its own totals. That means any local time which
 * never ships a delta drifts permanently below the leaderboard total.
 *
 * So: every path that grows `autoRunStats.cumulativeTimeMs` must also submit
 * its delta through here, or the local Conductor level and the leaderboard
 * silently diverge.
 */

import * as Sentry from '@sentry/electron/renderer';
import { useSettingsStore, selectIsLeaderboardRegistered } from '../stores/settingsStore';
import { getBadgeForTime } from '../constants/conductorBadges';
import { logger } from '../utils/logger';

export interface SubmitLeaderboardTimeDeltaArgs {
	/** Time to add to the server total. Must already be applied locally. */
	deltaMs: number;
	/**
	 * Runs to add to the server total. Defaults to 0 for time that is not an
	 * Auto Run (e.g. Cue), so `totalRuns` keeps matching the local value.
	 */
	deltaRuns?: number;
	/** What earned this time. Lets the server treat Cue's higher submission
	 * frequency differently (notification suppression) without inferring it
	 * from `deltaRuns === 0`. */
	source?: 'auto-run' | 'cue';
}

/**
 * Submit a time delta for the registered user. No-ops when the user is not
 * registered, has not confirmed their email, or has no auth token.
 *
 * Call this AFTER the delta has been applied locally, so the accompanying
 * `cumulativeTimeMs` / `clientTotalTimeMs` reflect the same total the local
 * badge is showing and the server's discrepancy check stays quiet.
 */
export async function submitLeaderboardTimeDelta(
	args: SubmitLeaderboardTimeDeltaArgs
): Promise<void> {
	const { deltaMs, deltaRuns = 0, source } = args;
	if (deltaMs <= 0) return;

	const state = useSettingsStore.getState();
	if (!selectIsLeaderboardRegistered(state)) return;

	const registration = state.leaderboardRegistration;
	if (!registration) return;
	if (!registration.authToken) {
		logger.warn('Leaderboard delta submission skipped: no auth token');
		return;
	}

	const stats = state.autoRunStats;
	const badge = getBadgeForTime(stats.cumulativeTimeMs);

	try {
		const result = await window.maestro.leaderboard.submit({
			email: registration.email,
			displayName: registration.displayName,
			githubUsername: registration.githubUsername,
			twitterHandle: registration.twitterHandle,
			linkedinHandle: registration.linkedinHandle,
			badgeLevel: badge?.level ?? 0,
			badgeName: badge?.name ?? 'No Badge Yet',
			cumulativeTimeMs: stats.cumulativeTimeMs,
			totalRuns: stats.totalRuns,
			longestRunMs: stats.longestRunMs || undefined,
			authToken: registration.authToken,
			deltaMs,
			deltaRuns,
			clientTotalTimeMs: stats.cumulativeTimeMs,
			source,
		});

		if (result.success) {
			useSettingsStore.getState().setLeaderboardRegistration({
				...registration,
				lastSubmissionAt: Date.now(),
			});
		} else {
			logger.warn(`Leaderboard delta submission failed: ${result.error ?? result.message}`);
		}
	} catch (error) {
		// Background submission: a network blip must not break the run that
		// earned the time. The delta is lost for this submission (the server is
		// delta-accumulated, so there is no retry queue today) — report it so
		// the loss is visible rather than silent.
		Sentry.captureException(error, {
			extra: { operation: 'leaderboard-delta-submit', deltaMs, deltaRuns },
		});
		logger.warn(
			`Leaderboard delta submission threw: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
	}
}
