/**
 * Cue Time Event Reconciler - catches up on missed time-based events after sleep/wake.
 *
 * When the CueEngine detects a heartbeat gap (laptop sleep), this module fires
 * exactly one catch-up event per affected `time.heartbeat` and `time.scheduled`
 * subscription. One event per subscription regardless of how many intervals or
 * scheduled slots fell inside the gap - the payload reports the count, and the
 * agent can act on it once rather than getting flooded after a multi-day sleep.
 *
 * Does NOT reconcile `file.changed`, `agent.completed`, `github.*`, or
 * `task.pending`. File watchers and agent completions don't need reconciliation
 * (FSEvents survives sleep; fan-in state is durable). GitHub pollers self-heal
 * on the next tick - `engine.reconcileAfterWake()` triggers an immediate poll
 * via `pollNow()` rather than synthesizing events here.
 */

import { createCueEvent, type CueConfig, type CueEvent, type CueSubscription } from './cue-types';

export interface ReconcileSessionInfo {
	config: CueConfig;
	sessionName: string;
}

export interface ReconcileConfig {
	sleepStartMs: number;
	wakeTimeMs: number;
	sessions: Map<string, ReconcileSessionInfo>;
	onDispatch: (sessionId: string, subscription: CueSubscription, event: CueEvent) => void;
	onLog: (level: string, message: string) => void;
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * Reconcile missed time-based events during a sleep gap.
 *
 * For each enabled `time.heartbeat` subscription with `interval_minutes`, fires
 * one catch-up event with `missedCount = floor(gap / interval)`.
 *
 * For each enabled `time.scheduled` subscription, fires one catch-up event for
 * the most recent (HH:MM, day) slot that fell inside the gap. The payload
 * carries `missedCount` (total slots in the gap) and `mostRecentSlotMs` (the
 * one being acted on) so prompts can branch on backlog size if they care.
 */
export function reconcileMissedTimeEvents(config: ReconcileConfig): void {
	const { sleepStartMs, wakeTimeMs, sessions, onDispatch, onLog } = config;
	const gapMs = wakeTimeMs - sleepStartMs;

	if (gapMs <= 0) return;

	for (const [sessionId, sessionInfo] of sessions) {
		for (const sub of sessionInfo.config.subscriptions) {
			if (sub.enabled === false) continue;

			if (sub.event === 'time.heartbeat') {
				reconcileHeartbeat(sessionId, sub, sleepStartMs, wakeTimeMs, onDispatch, onLog);
			} else if (sub.event === 'time.scheduled') {
				reconcileScheduled(sessionId, sub, sleepStartMs, wakeTimeMs, onDispatch, onLog);
			}
		}
	}
}

function reconcileHeartbeat(
	sessionId: string,
	sub: CueSubscription,
	sleepStartMs: number,
	wakeTimeMs: number,
	onDispatch: ReconcileConfig['onDispatch'],
	onLog: ReconcileConfig['onLog']
): void {
	if (!sub.interval_minutes || sub.interval_minutes <= 0) return;

	const gapMs = wakeTimeMs - sleepStartMs;
	const intervalMs = sub.interval_minutes * 60_000;
	const missedCount = Math.floor(gapMs / intervalMs);

	if (missedCount === 0) return;

	onLog(
		'cue',
		`[CUE] Reconciling "${sub.name}": ${missedCount} interval(s) missed during sleep, firing catch-up`
	);

	const event = createCueEvent('time.heartbeat', sub.name, {
		interval_minutes: sub.interval_minutes,
		reconciled: true,
		missedCount,
		sleepDurationMs: gapMs,
	});

	onDispatch(sessionId, sub, event);
}

function reconcileScheduled(
	sessionId: string,
	sub: CueSubscription,
	sleepStartMs: number,
	wakeTimeMs: number,
	onDispatch: ReconcileConfig['onDispatch'],
	onLog: ReconcileConfig['onLog']
): void {
	const times = sub.schedule_times ?? [];
	if (times.length === 0) return;
	const days = sub.schedule_days;

	const slots = collectMissedScheduledSlots(times, days, sleepStartMs, wakeTimeMs);
	if (slots.length === 0) return;

	// Most recent slot wins - after a multi-day sleep we fire ONE catch-up for
	// the latest occurrence rather than flooding with one per missed slot.
	const mostRecentSlotMs = slots[slots.length - 1];
	const missedCount = slots.length;
	const mostRecentDate = new Date(mostRecentSlotMs);
	const matchedTime = `${pad2(mostRecentDate.getHours())}:${pad2(mostRecentDate.getMinutes())}`;
	const matchedDay = DAY_NAMES[mostRecentDate.getDay()];

	onLog(
		'cue',
		`[CUE] Reconciling "${sub.name}": ${missedCount} scheduled slot(s) missed during sleep, firing catch-up for most recent (${matchedTime})`
	);

	const event = createCueEvent('time.scheduled', sub.name, {
		schedule_times: times,
		schedule_days: days,
		matched_time: matchedTime,
		matched_day: matchedDay,
		reconciled: true,
		missedCount,
		mostRecentSlotMs,
		sleepDurationMs: wakeTimeMs - sleepStartMs,
	});

	onDispatch(sessionId, sub, event);
}

/**
 * Returns ascending timestamps of every (HH:MM, day) slot that fell inside
 * `[sleepStartMs, wakeTimeMs)`. Upper bound is exclusive so a wake that lands
 * exactly on a slot boundary lets the live trigger source fire it instead of
 * the reconciler - prevents double-fires.
 */
function collectMissedScheduledSlots(
	times: string[],
	days: string[] | undefined,
	sleepStartMs: number,
	wakeTimeMs: number
): number[] {
	const dayFilter = days && days.length > 0 ? new Set(days) : null;
	const slots: number[] = [];

	const start = new Date(sleepStartMs);
	const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
	const endExclusive = wakeTimeMs;

	// Walk day-by-day from sleep-start's local midnight through wake. Multi-day
	// sleeps are bounded by real-world sleep durations (days, not years), so the
	// linear walk is fine.
	while (cursor.getTime() < endExclusive) {
		const dayName = DAY_NAMES[cursor.getDay()];
		if (!dayFilter || dayFilter.has(dayName)) {
			for (const time of times) {
				const [hourStr, minStr] = time.split(':');
				const hour = parseInt(hourStr, 10);
				const min = parseInt(minStr, 10);
				if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
				if (!Number.isInteger(min) || min < 0 || min > 59) continue;

				const slot = new Date(cursor);
				slot.setHours(hour, min, 0, 0);
				const slotMs = slot.getTime();
				if (slotMs >= sleepStartMs && slotMs < endExclusive) {
					slots.push(slotMs);
				}
			}
		}
		cursor.setDate(cursor.getDate() + 1);
	}

	slots.sort((a, b) => a - b);
	return slots;
}

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}
