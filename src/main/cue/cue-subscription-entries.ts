/**
 * The Cue subscriptions view's one mapping, shared by every surface that shows it.
 *
 * Three readers serve `cue list`: the desktop app answers `get_cue_subscriptions`
 * from its engine (`cueCallbacks.ts`), a headless host answers it from the engine
 * it runs (`host-cue.ts`), and the CLI reads cue.yaml itself when a headless host
 * cannot answer (`cue-list.ts`). All three flatten the engine's graph data
 * through this module, so they cannot disagree about ids, schedules, or which
 * agent a subscription is listed under.
 *
 * Runtime imports are limited to `src/shared`, so the CLI bundle can load it
 * without Electron or the engine; the main-process types below are type-only.
 */

import { composeCueSubscriptionId } from '../../shared/cue/subscription-id';
import { cueTurnSettingsOf } from '../../shared/cue/turn-settings';
import type { CueGraphSession } from '../../shared/cue/contracts';
import type { CueSubscriptionInfo } from '../web-server/types';
import type { CueSubscriptionTriggerStat } from './cue-db';

/** Display-formats a Cue subscription's schedule for `cue list`. Surfaces
 *  `schedule_times`, `interval_minutes`, and `schedule_days` in a single
 *  human-readable string so day-pinned schedules don't show up as
 *  `undefined` in the CLI:
 *
 *  - `schedule_times: ['07:00']`                              -> `"07:00"`
 *  - `schedule_times: ['07:00']`, `schedule_days: ['mon','wed']` -> `"07:00 (Mon, Wed)"`
 *  - `interval_minutes: 5`                                    -> `"every 5m"`
 *  - `schedule_days: ['mon','wed']` (no times, no interval)   -> `"days: Mon, Wed"`
 *  - none of the above                                        -> `undefined`
 */
export function formatCueSchedule(sub: {
	schedule_times?: string[];
	schedule_days?: string[];
	interval_minutes?: number;
}): string | undefined {
	const days =
		Array.isArray(sub.schedule_days) && sub.schedule_days.length > 0
			? sub.schedule_days.map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')
			: null;
	if (Array.isArray(sub.schedule_times) && sub.schedule_times.length > 0) {
		const base = sub.schedule_times.join(', ');
		return days ? `${base} (${days})` : base;
	}
	if (typeof sub.interval_minutes === 'number') {
		return `every ${sub.interval_minutes}m`;
	}
	if (days) {
		return `days: ${days}`;
	}
	return undefined;
}

/**
 * The rows `cue list` shows: every subscription in the graph, for one agent or all of them.
 *
 * `triggerStats` are the per-subscription counts and last-trigger times from the
 * `cue.db` event journal (`getCueSubscriptionTriggerStats()`). The engine keeps
 * last-triggered only per session, in memory, so a reader without the journal
 * (the CLI reading cue.yaml itself) passes none and every row reads "never
 * triggered". Keyed by session and raw name: `pipeline_id` is NULL whenever
 * usage stats are off.
 */
export function toCueSubscriptionInfos(
	graph: CueGraphSession[],
	sessionId?: string,
	triggerStats: readonly CueSubscriptionTriggerStat[] = []
): CueSubscriptionInfo[] {
	const filtered =
		typeof sessionId === 'string' && sessionId.length > 0
			? graph.filter((gs) => gs.sessionId === sessionId)
			: graph;
	const statsByKey = new Map<string, CueSubscriptionTriggerStat>();
	for (const stat of triggerStats) {
		statsByKey.set(`${stat.sessionId}\u0000${stat.subscriptionName}`, stat);
	}
	const subs: CueSubscriptionInfo[] = [];
	for (const session of filtered) {
		for (const sub of session.subscriptions) {
			const stat = statsByKey.get(`${session.sessionId}\u0000${sub.name}`);
			subs.push({
				// No stable per-subscription id in YAML; compose one from
				// session + pipeline + name. Names are unique within a
				// pipeline (validator contract), so the pipeline
				// discriminator is what guarantees the id stays unique
				// when two pipelines under the same session each define
				// a sub with the same name. Without it, downstream
				// resolvers (e.g. `setSubscriptionEnabled`) would match by
				// name only and silently toggle the wrong row.
				id: composeCueSubscriptionId(session.sessionId, sub),
				name: sub.name,
				eventType: sub.event,
				pattern: typeof sub.watch === 'string' ? sub.watch : undefined,
				schedule: formatCueSchedule(sub),
				sessionId: session.sessionId,
				sessionName: session.sessionName,
				enabled: sub.enabled !== false,
				// No journal rows = genuinely never fired; the CLI renders
				// "never triggered" for an absent `lastTriggered`.
				triggerCount: stat?.triggerCount ?? 0,
				lastTriggered: stat?.lastTriggered,
				...cueTurnSettingsOf(sub),
			});
		}
	}
	return subs;
}
