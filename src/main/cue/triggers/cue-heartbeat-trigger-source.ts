/**
 * Trigger source for `time.heartbeat` subscriptions.
 *
 * Wraps `setInterval` and fires the subscription's prompt on a fixed cadence
 * (`interval_minutes`). Mirrors the historical "fire immediately on start,
 * then on every interval" behaviour but routes both fire paths through a
 * single helper so the dispatch logic stops being duplicated.
 *
 * One run per interval window, also across a sleep or pause. Every run is
 * recorded in the registry (`markHeartbeatFired`), and so is the sleep
 * catch-up the reconciler fires. A tick that finds a catch-up less than one
 * interval old does not fire: it re-arms for the rest of that window, so the
 * interval restarts from the catch-up. Whether the tick is overdue on resume
 * depends on what stopped the process (SIGSTOP, a VM pause or Windows sleep
 * leave the monotonic timer clock running; a Linux or macOS suspend stops
 * it), and this check gives the same result either way. The reverse order,
 * the tick first and the catch-up second, is handled in `cue-reconciler.ts`.
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
	let rearmTimer: ReturnType<typeof setTimeout> | null = null;
	let nextFireMs: number | null = null;
	// This source's own last run, to tell it apart from a catch-up's.
	let ownFiredAtMs: number | undefined;

	function fire(label: string): void {
		const event = createCueEvent('time.heartbeat', ctx.subscription.name, {
			interval_minutes: intervalMinutes,
		});

		// Always advance nextFireMs so nextTriggerAt() stays current even when the
		// filter rejects the event and ctx.emit is skipped.
		const now = Date.now();
		nextFireMs = now + intervalMs;
		ownFiredAtMs = now;
		ctx.registry.markHeartbeatFired(ctx.session.id, ctx.subscription.name, now);

		if (!passesFilter(ctx.subscription, event, ctx.onLog)) return;

		ctx.onLog('cue', `[CUE] "${ctx.subscription.name}" triggered (${label})`);
		ctx.emit(event);
	}

	function startInterval(): void {
		// Each tick checks ctx.enabled() so that disabling the engine takes
		// effect immediately even if a timer callback was already queued by the
		// event loop.
		timer = setInterval(tick, intervalMs);
	}

	function tick(): void {
		if (!ctx.enabled()) return;

		const lastMs = ctx.registry.heartbeatFiredAt(ctx.session.id, ctx.subscription.name);
		const sinceLastMs = lastMs === undefined ? Infinity : Date.now() - lastMs;
		// A negative age means the wall clock moved backward; fire as usual
		// rather than stall for however far it jumped.
		if (lastMs !== ownFiredAtMs && sinceLastMs >= 0 && sinceLastMs < intervalMs) {
			// The sleep catch-up already ran this window. Restart the interval
			// from the catch-up instead of running a second time.
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			const remainingMs = intervalMs - sinceLastMs;
			nextFireMs = Date.now() + remainingMs;
			rearmTimer = setTimeout(() => {
				rearmTimer = null;
				startInterval();
				tick();
			}, remainingMs);
			return;
		}

		fire('time.heartbeat');
	}

	return {
		start() {
			if (timer || rearmTimer) return; // idempotent

			// Fire once immediately on start, mirroring the legacy behaviour where
			// users expect a heartbeat to run as soon as Cue picks up the config.
			fire('time.heartbeat, initial');

			// Then on the configured interval.
			startInterval();
		},

		stop() {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			if (rearmTimer) {
				clearTimeout(rearmTimer);
				rearmTimer = null;
			}
			nextFireMs = null;
		},

		nextTriggerAt() {
			return nextFireMs;
		},
	};
}
