/**
 * Trigger source for `time.scheduled` subscriptions.
 *
 * Polls every 60 seconds, compares the current `HH:MM` against the
 * subscription's `schedule_times` array (filtered by `schedule_days` if
 * provided), and fires when they match. Uses the registry's
 * `markScheduledFired` to dedupe concurrent fires within the same minute
 * (e.g. when a YAML hot-reload re-creates the source mid-minute).
 */

import { createCueEvent } from '../cue-types';
import { passesFilter } from './cue-trigger-filter';
import { calculateNextScheduledTime, getDayName } from './cue-schedule-utils';
import type { CueTriggerSource, CueTriggerSourceContext } from './cue-trigger-source';

const POLL_INTERVAL_MS = 60_000; // 1 minute

export function createCueScheduledTriggerSource(
	ctx: CueTriggerSourceContext
): CueTriggerSource | null {
	const times = ctx.subscription.schedule_times ?? [];
	if (times.length === 0) return null;

	const days = ctx.subscription.schedule_days;
	let timer: ReturnType<typeof setInterval> | null = null;
	let nextFireMs: number | null = null;

	function recomputeNextFire(): void {
		nextFireMs = calculateNextScheduledTime(times, days);
	}

	function checkAndFire(): void {
		if (!ctx.enabled()) return;

		const now = new Date();
		const currentDay = getDayName(now);
		const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

		// Check day filter (if specified, current day must match)
		if (days && days.length > 0 && !days.includes(currentDay)) {
			return;
		}

		if (!times.includes(currentTime)) {
			// Evict stale fired-keys from previous minutes so the dedup map does
			// not grow unboundedly.
			ctx.registry.evictStaleScheduledKeys(ctx.session.id, ctx.subscription.name, currentTime);
			return;
		}

		// Atomic check-and-set against the registry. Returns false if a previous
		// invocation already fired within the same minute (rare but possible
		// during config refreshes).
		if (!ctx.registry.markScheduledFired(ctx.session.id, ctx.subscription.name, currentTime)) {
			return;
		}

		const event = createCueEvent('time.scheduled', ctx.subscription.name, {
			schedule_times: times,
			schedule_days: days,
			matched_time: currentTime,
			matched_day: currentDay,
		});

		// Refresh next-trigger projection regardless of filter outcome so the UI
		// stays current even when a filter is rejecting today's slot.
		recomputeNextFire();

		if (!passesFilter(ctx.subscription, event, ctx.onLog)) return;

		ctx.onLog('cue', `[CUE] "${ctx.subscription.name}" triggered (time.scheduled, ${currentTime})`);
		ctx.emit(event);
	}

	return {
		start() {
			if (timer) return; // idempotent
			// Check the current minute immediately so an occurrence that falls within
			// the same minute as start() is not missed waiting for the first interval tick.
			checkAndFire();
			timer = setInterval(checkAndFire, POLL_INTERVAL_MS);
			recomputeNextFire();
		},

		stop() {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			nextFireMs = null;
		},

		nextTriggerAt() {
			return nextFireMs;
		},
	};
}
