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
 * `stopped` runs (user aborts) neither extend nor end a streak. State is in
 * memory and re-seeded from the hydrated activity log on engine start, so a
 * restart neither forgets a failing subscription nor re-alerts for it.
 *
 * Electron-free on purpose: the toast is only DESCRIBED here
 * ({@link failureStreakToast}); `src/main/index.ts` sends it.
 */

import type { CueRunStatus } from './cue-types';
import type { CueLogPayload } from '../../shared/cue-log-types';
import {
	CUE_FAILURE_ERROR_MAX_CHARS,
	baseSubscriptionName,
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

export type CueFailureStreakTransition =
	| { kind: 'failing'; escalated: boolean; streak: CueFailureStreak }
	| { kind: 'recovered'; streak: CueFailureStreak };

export interface CueFailureStreakTracker {
	/**
	 * Fold one finished run into its streak. Returns the transition the caller
	 * must announce, or `null` when there is nothing to say.
	 */
	record(run: CueFailureStreakRun, threshold: number): CueFailureStreakTransition | null;
	/**
	 * Rebuild streaks from past runs (oldest first) without announcing them.
	 * Alert levels a streak already reached count as sent, so a restart does
	 * not re-toast a subscription the user was already told about.
	 */
	seed(runs: CueFailureStreakRun[], thresholdFor: (sessionId: string) => number): void;
	/** Current streaks (copies), optionally for one agent. */
	list(sessionId?: string): CueFailureStreak[];
	/** Drop every streak of one agent (its Cue config went away). */
	clearSession(sessionId: string): void;
	clear(): void;
}

interface StreakEntry {
	streak: CueFailureStreak;
	/** 0 = none, 1 = threshold alert sent, 2 = escalation sent. */
	alertsSent: number;
}

function streakKey(sessionId: string, subscriptionName: string): string {
	return `${sessionId}\u0000${subscriptionName}`;
}

/** Collapse whitespace and cap, so a multi-line stack trace fits a toast line. */
function summarizeError(stderr: string | undefined): string | undefined {
	const text = stderr?.replace(/\s+/g, ' ').trim();
	if (!text) return undefined;
	return truncateAtWordBoundary(text, CUE_FAILURE_ERROR_MAX_CHARS);
}

export function createCueFailureStreakTracker(): CueFailureStreakTracker {
	const entries = new Map<string, StreakEntry>();

	function record(run: CueFailureStreakRun, threshold: number): CueFailureStreakTransition | null {
		const subscriptionName = baseSubscriptionName(run.subscriptionName);
		const key = streakKey(run.sessionId, subscriptionName);

		if (run.status === 'completed') {
			const ended = entries.get(key);
			if (!ended) return null;
			entries.delete(key);
			return ended.alertsSent > 0 ? { kind: 'recovered', streak: { ...ended.streak } } : null;
		}
		if (!isFailedRunStatus(run.status)) return null;

		// `||`, not `??`: runs rehydrated from cue_events carry '' when the row
		// never recorded a completion time.
		const at = run.endedAt || new Date().toISOString();
		const lastError = summarizeError(run.stderr);
		let entry = entries.get(key);
		if (entry) {
			entry.streak.consecutiveFailures += 1;
		} else {
			entry = {
				alertsSent: 0,
				streak: {
					sessionId: run.sessionId,
					sessionName: run.sessionName,
					subscriptionName,
					consecutiveFailures: 1,
					firstFailedAt: at,
					lastFailedAt: at,
					lastStatus: run.status,
					alertThreshold: threshold,
					failing: false,
				},
			};
			entries.set(key, entry);
		}

		const { streak } = entry;
		streak.sessionName = run.sessionName;
		streak.lastFailedAt = at;
		streak.lastStatus = run.status;
		streak.lastError = lastError;
		streak.alertThreshold = threshold;
		streak.failing = threshold > 0 && streak.consecutiveFailures >= threshold;

		if (!streak.failing) return null;
		if (entry.alertsSent === 0) {
			entry.alertsSent = 1;
			return { kind: 'failing', escalated: false, streak: { ...streak } };
		}
		if (
			entry.alertsSent === 1 &&
			streak.consecutiveFailures >= failureStreakEscalationThreshold(threshold)
		) {
			entry.alertsSent = 2;
			return { kind: 'failing', escalated: true, streak: { ...streak } };
		}
		return null;
	}

	return {
		record,

		seed(runs, thresholdFor) {
			entries.clear();
			for (const run of runs) {
				// Announcements are discarded; record() still marks the alert
				// levels each streak crossed as sent.
				record(run, thresholdFor(run.sessionId));
			}
		},

		list(sessionId) {
			const out: CueFailureStreak[] = [];
			for (const { streak } of entries.values()) {
				if (sessionId === undefined || streak.sessionId === sessionId) out.push({ ...streak });
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
