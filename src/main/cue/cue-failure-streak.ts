/**
 * Cue failure streaks - consecutive failed runs per (agent, subscription).
 *
 * Before this, a subscription could fail every run for hours while the Cue
 * dashboard showed it green: each `failed` row landed in `cue_events`, but
 * nothing counted them. The engine feeds every natural completion into this
 * tracker (`onRunCompleted` in `cue-engine.ts`). When a streak reaches the
 * cue.yaml's `settings.failure_alert_threshold` (default 3) the engine emits a
 * `subscriptionFailing` payload, which the host turns into a red toast; one
 * more fires at ten times the threshold, then nothing until a run succeeds.
 * A `completed` run ends the streak and, if it had alerted, emits
 * `subscriptionRecovered`.
 *
 * `stopped` runs (user aborts) neither extend nor end a streak. The threshold
 * is read live through `thresholdFor`, so editing it in cue.yaml re-judges
 * existing streaks at once. State is in memory and re-seeded on engine start
 * from `cue_events` (`getCueFailureStreakRecords` in `cue-db.ts`), so a restart
 * neither forgets a failing subscription nor re-alerts for it.
 *
 * Electron-free on purpose: the toast is only DESCRIBED here
 * ({@link failureStreakToast}); `src/main/index.ts` sends it.
 */

import type { CueRunStatus } from './cue-types';
import type { CueLogPayload } from '../../shared/cue-log-types';
import {
	CUE_FAILURE_ERROR_MAX_CHARS,
	failureStreakEscalationThreshold,
	isFailedRunStatus,
	type CueFailureStreak,
} from '../../shared/cue/failure-streak';
import { truncateAtWordBoundary } from '../../shared/formatters';
import type { CueNotifyToastParams } from './cue-notify-bridge';

/** The slice of a finished run the tracker reads. `CueRunResult` satisfies it. */
export interface CueFailureStreakRun {
	sessionId: string;
	sessionName: string;
	subscriptionName: string;
	status: CueRunStatus;
	stderr?: string;
	/** ISO end time; defaults to now when absent or empty. */
	endedAt?: string;
}

/** A streak restored at engine start. The tracker derives threshold and health itself. */
export type CueFailureStreakSeed = Omit<CueFailureStreak, 'alertThreshold' | 'failing'>;

/** The alert threshold in force for one agent's cue.yaml. 0 = alerts off. */
export type CueFailureThresholdFor = (sessionId: string) => number;

export type CueFailureStreakTransition =
	| { kind: 'failing'; escalated: boolean; streak: CueFailureStreak }
	| { kind: 'recovered'; streak: CueFailureStreak };

export interface CueFailureStreakTracker {
	/**
	 * Fold one finished run into its streak. Returns the transition the caller
	 * must announce, or `null` when there is nothing to say.
	 */
	record(run: CueFailureStreakRun): CueFailureStreakTransition | null;
	/**
	 * Replace all state with streaks restored from `cue_events`, without
	 * announcing them. Alert levels a streak already reached count as sent, so
	 * a restart does not re-toast a subscription the user was already told about.
	 */
	seed(streaks: CueFailureStreakSeed[]): void;
	/** Current streaks (copies), judged against the current threshold, optionally for one agent. */
	list(sessionId?: string): CueFailureStreak[];
	/** Drop every streak of one agent (its Cue config went away). */
	clearSession(sessionId: string): void;
	clear(): void;
}

interface StreakEntry {
	streak: CueFailureStreakSeed;
	/**
	 * 0 = none, 1 = threshold alert sent, 2 = escalation sent. `null` for a
	 * streak restored at start and not yet judged: at boot the engine seeds
	 * before agents register, so their thresholds are not known yet. The first
	 * run of the subscription settles it (see {@link sentLevel}).
	 */
	alertsSent: number | null;
}

function streakKey(sessionId: string, subscriptionName: string): string {
	return `${sessionId}\u0000${subscriptionName}`;
}

/** Collapse whitespace and cap, so a multi-line stack trace fits a toast line. */
function summarizeError(stderr: string | null | undefined): string | undefined {
	const text = stderr?.replace(/\s+/g, ' ').trim();
	if (!text) return undefined;
	return truncateAtWordBoundary(text, CUE_FAILURE_ERROR_MAX_CHARS);
}

/** Alert levels a streak of `count` failures has reached under `threshold`. */
function alertLevelReached(count: number, threshold: number): number {
	if (threshold <= 0 || count < threshold) return 0;
	return count >= failureStreakEscalationThreshold(threshold) ? 2 : 1;
}

/**
 * The alert level already sent for a streak. A restored streak counts every
 * level its pre-restart count reached under the agent's threshold NOW, so the
 * user is not told twice and a restart never skips a level they were not told.
 */
function sentLevel(entry: StreakEntry, threshold: number): number {
	if (entry.alertsSent === null) {
		entry.alertsSent = alertLevelReached(entry.streak.consecutiveFailures, threshold);
	}
	return entry.alertsSent;
}

function judged(streak: CueFailureStreakSeed, threshold: number): CueFailureStreak {
	return {
		...streak,
		alertThreshold: threshold,
		failing: threshold > 0 && streak.consecutiveFailures >= threshold,
	};
}

export function createCueFailureStreakTracker(
	thresholdFor: CueFailureThresholdFor
): CueFailureStreakTracker {
	const entries = new Map<string, StreakEntry>();

	return {
		record(run) {
			const key = streakKey(run.sessionId, run.subscriptionName);
			const threshold = thresholdFor(run.sessionId);

			if (run.status === 'completed') {
				const ended = entries.get(key);
				if (!ended) return null;
				entries.delete(key);
				// No recovery news for a streak that never alerted, or once alerts are off.
				return threshold > 0 && sentLevel(ended, threshold) > 0
					? { kind: 'recovered', streak: judged(ended.streak, threshold) }
					: null;
			}
			if (!isFailedRunStatus(run.status)) return null;

			const at = run.endedAt || new Date().toISOString();
			let entry = entries.get(key);
			if (entry) {
				// Settle a restored streak's sent level on its pre-restart count.
				sentLevel(entry, threshold);
				entry.streak.consecutiveFailures += 1;
			} else {
				entry = {
					alertsSent: 0,
					streak: {
						sessionId: run.sessionId,
						sessionName: run.sessionName,
						subscriptionName: run.subscriptionName,
						consecutiveFailures: 1,
						firstFailedAt: at,
						lastFailedAt: at,
						lastStatus: run.status,
					},
				};
				entries.set(key, entry);
			}

			const { streak } = entry;
			streak.sessionName = run.sessionName;
			streak.lastFailedAt = at;
			streak.lastStatus = run.status;
			streak.lastError = summarizeError(run.stderr);

			// One alert per level crossed, never repeated: a threshold raised past
			// the count waits for the new level, one lowered below it fires next run.
			const level = alertLevelReached(streak.consecutiveFailures, threshold);
			const sent = sentLevel(entry, threshold);
			if (level <= sent) return null;
			const escalated = level === 2 && sent === 1;
			entry.alertsSent = level;
			return { kind: 'failing', escalated, streak: judged(streak, threshold) };
		},

		seed(streaks) {
			entries.clear();
			for (const seed of streaks) {
				entries.set(streakKey(seed.sessionId, seed.subscriptionName), {
					streak: { ...seed, lastError: summarizeError(seed.lastError) },
					alertsSent: null,
				});
			}
		},

		list(sessionId) {
			const out: CueFailureStreak[] = [];
			for (const { streak } of entries.values()) {
				if (sessionId === undefined || streak.sessionId === sessionId) {
					out.push(judged(streak, thresholdFor(streak.sessionId)));
				}
			}
			return out;
		},

		clearSession(sessionId) {
			for (const [key, { streak }] of entries) {
				if (streak.sessionId === sessionId) entries.delete(key);
			}
		},

		clear() {
			entries.clear();
		},
	};
}

/** The typed log payload a transition is announced with. */
export function failureStreakPayload(
	transition: CueFailureStreakTransition
): Extract<CueLogPayload, { type: 'subscriptionFailing' | 'subscriptionRecovered' }> {
	const { streak } = transition;
	if (transition.kind === 'recovered') {
		return {
			type: 'subscriptionRecovered',
			sessionId: streak.sessionId,
			sessionName: streak.sessionName,
			subscriptionName: streak.subscriptionName,
			consecutiveFailures: streak.consecutiveFailures,
		};
	}
	return {
		type: 'subscriptionFailing',
		sessionId: streak.sessionId,
		sessionName: streak.sessionName,
		subscriptionName: streak.subscriptionName,
		consecutiveFailures: streak.consecutiveFailures,
		threshold: streak.alertThreshold,
		escalated: transition.escalated,
		lastError: streak.lastError,
	};
}

/**
 * The toast for a failure-streak payload, or `null` for any other payload.
 * Failing toasts are red and sticky: the whole point is that the user did not
 * notice. Recovery is a plain green toast that dismisses itself.
 */
export function failureStreakToast(
	payload: CueLogPayload | undefined
): CueNotifyToastParams | null {
	if (payload?.type === 'subscriptionFailing') {
		const runs = `${payload.consecutiveFailures} runs in a row`;
		const error = payload.lastError ? ` Last error: ${payload.lastError}` : '';
		return {
			agentId: payload.sessionId,
			title: payload.escalated
				? `Cue subscription still failing: ${payload.subscriptionName}`
				: `Cue subscription failing: ${payload.subscriptionName}`,
			message: `"${payload.subscriptionName}" on ${payload.sessionName} failed ${runs}.${error} It shows as Failing in the Cue dashboard until a run succeeds.`,
			sticky: true,
			color: 'red',
		};
	}
	if (payload?.type === 'subscriptionRecovered') {
		const runs = payload.consecutiveFailures === 1 ? 'failed run' : 'failed runs';
		return {
			agentId: payload.sessionId,
			title: `Cue subscription recovered: ${payload.subscriptionName}`,
			message: `"${payload.subscriptionName}" on ${payload.sessionName} succeeded after ${payload.consecutiveFailures} ${runs}.`,
			color: 'green',
		};
	}
	return null;
}
