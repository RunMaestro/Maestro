/**
 * Trigger source for `time.heartbeat` subscriptions.
 *
 * Wraps `setInterval` and fires the subscription's prompt on a fixed cadence
 * (`interval_minutes`). Mirrors the historical "fire immediately on start,
 * then on every interval" behaviour but routes both fire paths through a
 * single helper so the dispatch logic stops being duplicated.
 */

import { createCueEvent } from '../cue-types';
import { passesFilter } from './cue-trigger-filter';
import type { CueTriggerSource, CueTriggerSourceContext } from './cue-trigger-source';

export function createCueHeartbeatTriggerSource(
	ctx: CueTriggerSourceContext
): CueTriggerSource | null {
	const intervalMinutes = ctx.subscription.interval_minutes;
	if (typeof intervalMinutes !== 'number' || intervalMinutes <= 0) {
		return null;
	}

	const intervalMs = intervalMinutes * 60 * 1000;
	let timer: ReturnType<typeof setInterval> | null = null;
	let nextFireMs: number | null = null;

	function fire(label: string): void {
		const event = createCueEvent('time.heartbeat', ctx.subscription.name, {
			interval_minutes: intervalMinutes,
		});

		if (!passesFilter(ctx.subscription, event, ctx.onLog)) return;

		ctx.onLog('cue', `[CUE] "${ctx.subscription.name}" triggered (${label})`);
		nextFireMs = Date.now() + intervalMs;
		ctx.emit(event);
	}

	return {
		start() {
			if (timer) return; // idempotent

			// Fire once immediately on start, mirroring the legacy behaviour where
			// users expect a heartbeat to run as soon as Cue picks up the config.
			fire('time.heartbeat, initial');

			// Then on the configured interval. Each tick checks ctx.enabled() so
			// that disabling the engine takes effect immediately even if a timer
			// callback was already queued by the event loop.
			timer = setInterval(() => {
				if (!ctx.enabled()) return;
				fire('time.heartbeat');
			}, intervalMs);

			// In case the immediate fire was skipped by a filter, still set the
			// next-trigger time so the UI shows when the next attempt will be.
			nextFireMs = Date.now() + intervalMs;
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
