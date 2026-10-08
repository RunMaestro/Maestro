/**
 * Pure scheduling logic for plugin cue triggers.
 *
 * The supervised plugin scheduler (main process) polls on a fixed cadence and
 * asks this module which triggers are due, given the wall clock and the prior
 * fire state. Everything here is pure and deterministic so it can be unit-tested
 * without timers: the caller passes `now` (ms + local HH:MM + day key) and the
 * current per-trigger state, and gets back the due triggers plus the next state.
 *
 * Interval triggers are SEEDED on first observation (they do not fire
 * immediately on startup, avoiding a thundering herd when many plugins load);
 * they fire once their interval has elapsed since the last fire. Daily-time
 * triggers fire at most once per matching clock-minute per day.
 */

import type { CueTriggerContribution } from './contributions';

/** Wall-clock snapshot the host passes in (keeps this module timezone-pure). */
export interface SchedulerNow {
	ms: number;
	/** Local time as 'HH:MM' (24h). */
	hhmm: string;
	/** Local day key as 'YYYY-MM-DD'. */
	dayKey: string;
}

/** Per-trigger fire bookkeeping. */
export interface TriggerState {
	/** Interval triggers: ms of the last fire (or seed). */
	lastFiredMs?: number;
	/** Interval triggers: seeded (observed at least once) so it can start timing. */
	seeded?: boolean;
	/** Daily triggers: the last 'YYYY-MM-DD HH:MM' that fired (dedupe within minute). */
	lastMinuteStamp?: string;
}

export interface SchedulerStep {
	due: CueTriggerContribution[];
	nextState: Record<string, TriggerState>;
}

/**
 * Compute which triggers are due at `now`, returning the due triggers and the
 * updated state (immutable - the input state is not mutated). Triggers no longer
 * present are dropped from the next state so it cannot grow unbounded.
 */
export function computeDueTriggers(
	triggers: readonly CueTriggerContribution[],
	state: Record<string, TriggerState>,
	now: SchedulerNow
): SchedulerStep {
	const due: CueTriggerContribution[] = [];
	const nextState: Record<string, TriggerState> = {};

	for (const trigger of triggers) {
		const prev = state[trigger.id] ?? {};
		if (trigger.schedule.kind === 'interval') {
			if (!prev.seeded) {
				// First time we see it: start the clock, do not fire.
				nextState[trigger.id] = { seeded: true, lastFiredMs: now.ms };
				continue;
			}
			const elapsed = now.ms - (prev.lastFiredMs ?? now.ms);
			if (elapsed >= trigger.schedule.everyMinutes * 60_000) {
				due.push(trigger);
				nextState[trigger.id] = { seeded: true, lastFiredMs: now.ms };
			} else {
				nextState[trigger.id] = prev;
			}
		} else {
			const stamp = `${now.dayKey} ${now.hhmm}`;
			if (trigger.schedule.times.includes(now.hhmm) && prev.lastMinuteStamp !== stamp) {
				due.push(trigger);
				nextState[trigger.id] = { ...prev, lastMinuteStamp: stamp };
			} else {
				nextState[trigger.id] = prev;
			}
		}
	}

	return { due, nextState };
}

/** Derive a SchedulerNow from a Date (host helper; kept here for one source). */
export function schedulerNowFromDate(date: Date): SchedulerNow {
	const pad = (n: number): string => String(n).padStart(2, '0');
	const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const dayKey = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	return { ms: date.getTime(), hhmm, dayKey };
}
