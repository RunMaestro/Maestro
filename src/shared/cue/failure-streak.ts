/**
 * Cue failure streaks - shared types and rules.
 *
 * A subscription can fail on every run while the dashboard still shows it as
 * Active: the engine records each `failed` row, but nothing summed them. The
 * engine (`src/main/cue/cue-failure-streak.ts`) counts consecutive failed runs
 * per (agent, subscription) with these rules, and the Cue dashboard, the
 * `cue list` CLI, and the failure toast read the same shapes.
 */

import type { CueRunStatus, CueSettings } from './contracts';

/** Consecutive failed runs before a subscription reads as failing. */
export const DEFAULT_CUE_FAILURE_ALERT_THRESHOLD = 3;

/** Highest accepted `settings.failure_alert_threshold`. */
export const MAX_CUE_FAILURE_ALERT_THRESHOLD = 1000;

/**
 * The second (and last) alert of one streak fires at this multiple of the
 * threshold. With the default of 3 the user hears at 3 and again at 30, and
 * never again until a run succeeds.
 */
export const CUE_FAILURE_ESCALATION_MULTIPLIER = 10;

/** Longest `lastError` kept on a streak, so a stack trace cannot flood a toast. */
export const CUE_FAILURE_ERROR_MAX_CHARS = 300;

/**
 * One subscription's current run of consecutive failures on one agent.
 * Fan-out targets each get their own streak: the key is the agent that RAN the
 * subscription, not the agent that owns it.
 */
export interface CueFailureStreak {
	sessionId: string;
	sessionName: string;
	subscriptionName: string;
	consecutiveFailures: number;
	/** ISO time of the first failure in this streak. */
	firstFailedAt: string;
	/** ISO time of the most recent failure. */
	lastFailedAt: string;
	lastStatus: 'failed' | 'timeout';
	/** First line(s) of the last failure's error text, capped. */
	lastError?: string;
	/** Threshold in force when the last failure was recorded. 0 = alerts off. */
	alertThreshold: number;
	/** True once `consecutiveFailures` reached `alertThreshold` (never when it is 0). */
	failing: boolean;
}

/** `cue list` health field. `failing` holds until a run of that subscription succeeds. */
export type CueSubscriptionHealth = 'ok' | 'failing';

/** A run status that extends a streak. `stopped` is a user abort and neither counts nor resets. */
export function isFailedRunStatus(status: CueRunStatus): status is 'failed' | 'timeout' {
	return status === 'failed' || status === 'timeout';
}

/**
 * Strip the two-phase `:output` suffix so the output phase of a run and the
 * run itself share one streak.
 */
export function baseSubscriptionName(name: string): string {
	return name.endsWith(':output') ? name.slice(0, -':output'.length) : name;
}

/** The threshold a cue.yaml asks for, falling back to the default when unset or invalid. */
export function resolveFailureAlertThreshold(settings?: Partial<CueSettings> | null): number {
	const raw = settings?.failure_alert_threshold;
	if (
		typeof raw === 'number' &&
		Number.isInteger(raw) &&
		raw >= 0 &&
		raw <= MAX_CUE_FAILURE_ALERT_THRESHOLD
	) {
		return raw;
	}
	return DEFAULT_CUE_FAILURE_ALERT_THRESHOLD;
}

/** Failure count at which a streak raises its second alert. 0 when alerts are off. */
export function failureStreakEscalationThreshold(threshold: number): number {
	return threshold > 0 ? threshold * CUE_FAILURE_ESCALATION_MULTIPLIER : 0;
}

/** One-line description, shared by the dashboard tooltip and `cue list`. */
export function describeFailureStreak(
	streak: Pick<CueFailureStreak, 'consecutiveFailures' | 'lastError'>
): string {
	const runs = streak.consecutiveFailures === 1 ? 'run' : 'runs';
	const base = `${streak.consecutiveFailures} failed ${runs} in a row`;
	return streak.lastError ? `${base} - last error: ${streak.lastError}` : base;
}
