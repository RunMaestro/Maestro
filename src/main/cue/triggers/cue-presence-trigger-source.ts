/**
 * Trigger source for `presence.return` and `presence.leave` subscriptions.
 *
 * Listens to the process-wide {@link CuePresenceMonitor} and applies the
 * subscription's own thresholds:
 *
 *  - `presence.leave` fires once the user has been away `away_minutes`. The
 *    clock starts at their last input (a lock, an idle stretch, a suspend),
 *    and a return before it runs out cancels it. A timer that wakes far later
 *    than it was due means the machine slept through the threshold; nobody is
 *    around to act on a "left" event delivered at wake, so it is dropped.
 *  - `presence.return` fires when the user comes back from an absence of at
 *    least `away_minutes`. With `settle_minutes > 0` it waits that long first
 *    and fires only if the user is still there - a quick unlock, glance, and
 *    re-lock drops the return. A dropped return CARRIES its absence forward:
 *    the next return is measured from when the user originally left, so two
 *    hours away broken by a ten-second glance still counts as two hours.
 */

import { DEFAULT_PRESENCE_AWAY_MINUTES } from '../../../shared/cue/contracts';
import {
	getCuePresenceMonitor,
	type PresenceReturnReason,
	type PresenceTransition,
} from '../cue-presence-monitor';
import { createCueEvent } from '../cue-types';
import { passesFilter } from './cue-trigger-filter';
import type { CueTriggerSource, CueTriggerSourceContext } from './cue-trigger-source';

/** A leave timer this late was frozen across a system sleep. */
const LEAVE_LATE_TOLERANCE_MS = 60_000;

const MINUTE_MS = 60_000;

export function createCuePresenceTriggerSource(
	ctx: CueTriggerSourceContext
): CueTriggerSource | null {
	const { subscription } = ctx;
	const eventType = subscription.event;
	if (eventType !== 'presence.return' && eventType !== 'presence.leave') return null;

	const monitor = getCuePresenceMonitor();
	if (!monitor) {
		ctx.onLog(
			'warn',
			`[CUE] "${subscription.name}" (${eventType}) has no presence signal source in this process; it will not fire`
		);
		return null;
	}

	const awayMinutes =
		typeof subscription.away_minutes === 'number' && subscription.away_minutes > 0
			? subscription.away_minutes
			: DEFAULT_PRESENCE_AWAY_MINUTES;
	const awayMs = awayMinutes * MINUTE_MS;
	const settleMs =
		typeof subscription.settle_minutes === 'number' && subscription.settle_minutes > 0
			? subscription.settle_minutes * MINUTE_MS
			: 0;

	let unsubscribe: (() => void) | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let timerDueAt: number | null = null;
	/** presence.return: absence start inherited from a return the settle window dropped. */
	let carriedAwaySince: number | null = null;
	/** presence.return: a qualifying return waiting out its settle window. */
	let pendingReturn: {
		awaySince: number;
		returnedAt: number;
		reason: PresenceReturnReason;
	} | null = null;

	function clearTimer(): void {
		if (timer) clearTimeout(timer);
		timer = null;
		timerDueAt = null;
	}

	function arm(dueAt: number, onFire: () => void): void {
		clearTimer();
		timerDueAt = dueAt;
		timer = setTimeout(
			() => {
				timer = null;
				timerDueAt = null;
				onFire();
			},
			Math.max(0, dueAt - Date.now())
		);
	}

	function fire(payload: Record<string, unknown>, label: string): void {
		if (!ctx.enabled()) return;
		const event = createCueEvent(eventType, subscription.name, payload);
		if (!passesFilter(subscription, event, ctx.onLog)) return;
		ctx.onLog('cue', `[CUE] "${subscription.name}" triggered (${eventType}, ${label})`);
		ctx.emit(event);
	}

	function returnPayload(awaySince: number, returnedAt: number, reason: PresenceReturnReason) {
		return {
			presence: 'return',
			reason,
			away_since: new Date(awaySince).toISOString(),
			returned_at: new Date(returnedAt).toISOString(),
			away_minutes: Math.round((returnedAt - awaySince) / MINUTE_MS),
			away_duration_ms: returnedAt - awaySince,
		};
	}

	function onLeaveTransition(t: PresenceTransition): void {
		if (t.kind === 'return') {
			clearTimer();
			return;
		}
		const dueAt = t.awaySince + awayMs;
		// A threshold already behind us (the absence began before it was noticed)
		// fires straight away; lateness is measured from when it was meant to run.
		const scheduledFor = Math.max(dueAt, Date.now());
		const reason = t.reason;
		arm(dueAt, () => {
			const now = Date.now();
			const snapshot = monitor!.getSnapshot();
			if (!snapshot.away || snapshot.awaySince !== t.awaySince) return;
			if (now - scheduledFor > LEAVE_LATE_TOLERANCE_MS) {
				ctx.onLog(
					'cue',
					`[CUE] "${subscription.name}" skipped: the machine slept through the ${awayMinutes}m away threshold`
				);
				return;
			}
			fire(
				{
					presence: 'leave',
					reason,
					away_since: new Date(t.awaySince).toISOString(),
					away_minutes: Math.round((now - t.awaySince) / MINUTE_MS),
					away_duration_ms: now - t.awaySince,
				},
				reason
			);
		});
	}

	function onReturnTransition(t: PresenceTransition): void {
		if (t.kind === 'away') {
			// Gone again before the settle window closed: drop the return, but
			// keep the original absence so the next return is measured from it.
			if (pendingReturn) {
				carriedAwaySince = pendingReturn.awaySince;
				pendingReturn = null;
				clearTimer();
			}
			return;
		}
		const awaySince = carriedAwaySince ?? t.awaySince;
		carriedAwaySince = null;
		if (t.at - awaySince < awayMs) return;
		if (settleMs === 0) {
			fire(returnPayload(awaySince, t.at, t.reason), t.reason);
			return;
		}
		pendingReturn = { awaySince, returnedAt: t.at, reason: t.reason };
		arm(t.at + settleMs, () => {
			const settled = pendingReturn;
			pendingReturn = null;
			if (!settled || monitor!.getSnapshot().away) return;
			fire(returnPayload(settled.awaySince, settled.returnedAt, settled.reason), settled.reason);
		});
	}

	return {
		start() {
			if (unsubscribe) return; // idempotent
			unsubscribe = monitor.subscribe(
				eventType === 'presence.leave' ? onLeaveTransition : onReturnTransition
			);
		},

		stop() {
			unsubscribe?.();
			unsubscribe = null;
			clearTimer();
			pendingReturn = null;
			carriedAwaySince = null;
		},

		nextTriggerAt() {
			// Only known while a leave threshold or a settle window is counting down.
			return timerDueAt;
		},
	};
}
