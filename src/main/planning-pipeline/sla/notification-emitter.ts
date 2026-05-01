/**
 * notification-emitter.ts
 *
 * SlaBreachNotifier — drives breach → notification delivery with deduplication.
 *
 * The `NotificationChannel` interface is intentionally generic so any backend
 * can be injected (toast system, OS notification, webhook, etc.).  The real
 * desktop wiring that calls `notifyToast` will implement this interface in the
 * IPC/renderer layer — keeping this module storage- and UI-agnostic.
 *
 * Deduplication:
 *   A breach is identified by the key `<workItemId>:<stage>`.  Once a
 *   notification has been posted for a given key, further calls to
 *   `checkAndNotify` will NOT re-post until `resetNotified()` is called (or the
 *   notifier is reconstructed).  This prevents toast spam when `checkAndNotify`
 *   is called on a 60-second tick and the item remains in breach.
 *
 * @see sla-tracker.ts  — SlaTracker that produces SlaBreach values
 * @see sla-types.ts    — SlaConfig and SlaBreach types
 */

import type { SlaConfig, SlaBreach } from './sla-types';
import type { SlaTracker } from './sla-tracker';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Severity levels for notification delivery. */
export type NotificationSeverity = 'info' | 'warn' | 'error';

/**
 * A generic notification delivery channel.
 *
 * Implement this interface in the desktop layer to bridge to `notifyToast` /
 * `notifyCenterFlash`.  The interface is intentionally thin so mocks are trivial.
 */
export interface NotificationChannel {
	/**
	 * Posts a notification to whatever backend this channel represents.
	 *
	 * Must resolve when the notification has been handed off (not necessarily
	 * when the user has acknowledged it).
	 */
	post(args: {
		title: string;
		body: string;
		severity: NotificationSeverity;
		workItemId?: string;
	}): Promise<void>;
}

/** Return value from `checkAndNotify`. */
export interface CheckAndNotifyResult {
	/** Number of new breach notifications posted during this call. */
	notified: number;
}

// ---------------------------------------------------------------------------
// SlaBreachNotifier
// ---------------------------------------------------------------------------

export class SlaBreachNotifier {
	/**
	 * Tracks which `workItemId:stage` pairs have already received a notification
	 * in this notifier's lifetime.  Prevents duplicate toasts on repeated ticks.
	 */
	private readonly notified = new Set<string>();

	// ---------------------------------------------------------------------------
	// Public API
	// ---------------------------------------------------------------------------

	/**
	 * Computes current breaches and posts a notification for each one that has
	 * not been notified before.
	 *
	 * @param now      Current time in Unix epoch ms (injectable for determinism).
	 * @param tracker  SlaTracker to query for open durations.
	 * @param config   SLA configuration with per-stage thresholds.
	 * @param channel  Notification channel to post to.
	 * @returns        `{ notified: N }` — count of new notifications posted.
	 */
	async checkAndNotify(
		now: number,
		tracker: SlaTracker,
		config: SlaConfig,
		channel: NotificationChannel
	): Promise<CheckAndNotifyResult> {
		const breaches = tracker.findBreaches(now, config);
		let notified = 0;

		for (const breach of breaches) {
			const key = this.breachKey(breach);
			if (this.notified.has(key)) {
				continue;
			}

			await this.postBreachNotification(breach, channel);
			this.notified.add(key);
			notified += 1;
		}

		return { notified };
	}

	/**
	 * Clears the set of already-notified breach keys.
	 *
	 * Call this if you want to allow re-notification (e.g. after the item has
	 * moved stage and re-entered, or on app restart to re-alert about persisted
	 * breaches).
	 */
	resetNotified(): void {
		this.notified.clear();
	}

	/**
	 * Returns `true` if a breach for the given item+stage has already been
	 * posted.  Useful for testing and dashboard display.
	 */
	hasBeenNotified(workItemId: string, stage: string): boolean {
		return this.notified.has(`${workItemId}:${stage}`);
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	private breachKey(breach: SlaBreach): string {
		return `${breach.workItemId}:${breach.stage}`;
	}

	private async postBreachNotification(
		breach: SlaBreach,
		channel: NotificationChannel
	): Promise<void> {
		const overPercent = Math.round((breach.durationMs / breach.thresholdMs) * 100);
		const humanDuration = formatMs(breach.durationMs);
		const humanThreshold = formatMs(breach.thresholdMs);

		await channel.post({
			title: `SLA breach — ${breach.stage}`,
			body: `Work item ${breach.workItemId} has been in stage "${breach.stage}" for ${humanDuration} (budget: ${humanThreshold}, ${overPercent}% of budget).`,
			severity: 'warn',
			workItemId: breach.workItemId,
		});
	}
}

// ---------------------------------------------------------------------------
// Internal formatting helper (no shared import to stay storage-agnostic)
// ---------------------------------------------------------------------------

/**
 * Formats a millisecond duration into a human-readable string.
 *
 * Examples:
 *   600_000  → "10m"
 *   3_661_000 → "1h 1m"
 *   45_000   → "45s"
 */
function formatMs(ms: number): string {
	const totalSeconds = Math.floor(ms / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	if (minutes > 0) {
		return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	}
	return `${seconds}s`;
}
