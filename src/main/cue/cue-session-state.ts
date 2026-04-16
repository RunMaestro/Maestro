import type { CueConfig, CueSessionStatus, CueSubscription } from './cue-types';
import type { CueTriggerSource } from './triggers/cue-trigger-source';

/**
 * Internal state per session with an active Cue config.
 *
 * Phase 4 cleanup: replaced the previous parallel `timers: Timer[]` /
 * `watchers: (() => void)[]` arrays with a single `triggerSources` array.
 * Each source owns its own underlying mechanism (interval, watcher, poller)
 * and reports its next-fire time via `nextTriggerAt()`.
 */
export interface SessionState {
	config: CueConfig;
	triggerSources: CueTriggerSource[];
	yamlWatcher: (() => void) | null;
	sleepPrevented: boolean;
	lastTriggered?: string;
}

/**
 * Returns true when `sub` is reported as "active for" the given session — the
 * session is either the owner (by agent_id) OR an unowned legacy sub OR a
 * participating fan-out target.
 *
 * Fan-out subscriptions are owned by a single agent (so the trigger source is
 * wired exactly once, on the owner), but every fan_out target runs when the
 * trigger fires. From the dashboard's point of view all targets are active
 * participants and should surface Status=Active + a Run Now button. Matching
 * fan_out by both sessionName and sessionId mirrors the dispatch service's
 * lookup (`s.name === targetName || s.id === targetName`).
 */
export function isSubscriptionParticipant(
	sub: CueSubscription,
	sessionId: string,
	sessionName: string
): boolean {
	if (!sub.agent_id) return true;
	if (sub.agent_id === sessionId) return true;
	if (sub.fan_out && (sub.fan_out.includes(sessionName) || sub.fan_out.includes(sessionId))) {
		return true;
	}
	return false;
}

export function countActiveSubscriptions(
	subscriptions: CueSubscription[],
	sessionId: string,
	sessionName: string
): number {
	return subscriptions.filter(
		(sub) => sub.enabled !== false && isSubscriptionParticipant(sub, sessionId, sessionName)
	).length;
}

export function getEarliestNextTriggerIso(state: SessionState): string | undefined {
	let earliest: number | null = null;
	for (const source of state.triggerSources) {
		const next = source.nextTriggerAt();
		if (next == null) continue;
		if (earliest === null || next < earliest) {
			earliest = next;
		}
	}
	return earliest === null ? undefined : new Date(earliest).toISOString();
}

export function hasTimeBasedSubscriptions(config: CueConfig, sessionId: string): boolean {
	return config.subscriptions.some(
		(sub) =>
			sub.enabled !== false &&
			(!sub.agent_id || sub.agent_id === sessionId) &&
			((sub.event === 'time.heartbeat' &&
				typeof sub.interval_minutes === 'number' &&
				sub.interval_minutes > 0) ||
				(sub.event === 'time.scheduled' &&
					Array.isArray(sub.schedule_times) &&
					sub.schedule_times.length > 0))
	);
}

export function toSessionStatus(params: {
	sessionId: string;
	sessionName: string;
	toolType: string;
	projectRoot: string;
	enabled: boolean;
	subscriptionCount: number;
	activeRuns: number;
	state?: SessionState;
}): CueSessionStatus {
	return {
		sessionId: params.sessionId,
		sessionName: params.sessionName,
		toolType: params.toolType,
		projectRoot: params.projectRoot,
		enabled: params.enabled,
		subscriptionCount: params.subscriptionCount,
		activeRuns: params.activeRuns,
		lastTriggered: params.state?.lastTriggered,
		nextTrigger: params.state ? getEarliestNextTriggerIso(params.state) : undefined,
	};
}
