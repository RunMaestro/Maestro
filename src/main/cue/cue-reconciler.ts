/**
 * Cue Time Event Reconciler — catches up on missed time.interval events after sleep/wake.
 *
 * When the CueEngine detects a heartbeat gap (laptop sleep), this module calculates
 * which interval subscriptions missed their scheduled runs and fires exactly one
 * catch-up event per subscription (to avoid flooding the system).
 *
 * Does NOT reconcile file.changed or agent.completed events — file watchers re-initialize
 * naturally and agent completions are durable through the fan-in tracker.
 */

import * as crypto from 'crypto';
import type { CueConfig, CueEvent, CueSubscription } from './cue-types';

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

/**
 * Reconcile missed time.interval events during a sleep gap.
 *
 * For each enabled time.interval subscription, calculates how many intervals
 * were missed and fires exactly one catch-up event with metadata indicating
 * how many intervals were skipped.
 */
export function reconcileMissedTimeEvents(config: ReconcileConfig): void {
	const { sleepStartMs, wakeTimeMs, sessions, onDispatch, onLog } = config;
	const gapMs = wakeTimeMs - sleepStartMs;

	if (gapMs <= 0) return;

	for (const [sessionId, sessionInfo] of sessions) {
		for (const sub of sessionInfo.config.subscriptions) {
			// Only reconcile time.interval subscriptions that are enabled
			if (sub.event !== 'time.interval' || sub.enabled === false) continue;
			if (!sub.interval_minutes || sub.interval_minutes <= 0) continue;

			const intervalMs = sub.interval_minutes * 60_000;
			const missedCount = Math.floor(gapMs / intervalMs);

			if (missedCount === 0) continue;

			onLog(
				'cue',
				`[CUE] Reconciling "${sub.name}": ${missedCount} interval(s) missed during sleep, firing catch-up`
			);

			const event: CueEvent = {
				id: crypto.randomUUID(),
				type: 'time.interval',
				timestamp: new Date().toISOString(),
				triggerName: sub.name,
				payload: {
					interval_minutes: sub.interval_minutes,
					reconciled: true,
					missedCount,
					sleepDurationMs: gapMs,
				},
			};

			// Route through normal dispatch path to respect concurrency limits
			onDispatch(sessionId, sub, event);
		}
	}
}
