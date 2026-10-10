import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import type { CueSubscriptionInfo, CueActivityEntry } from '../types';
import { composeCueSubscriptionId } from '../../../shared/cue/subscription-id';

/** Display-formats a Cue subscription's schedule for `cue list`. Surfaces
 *  `schedule_times`, `interval_minutes`, and `schedule_days` in a single
 *  human-readable string so day-pinned schedules don't show up as
 *  `undefined` in the CLI:
 *
 *  - `schedule_times: ['07:00']`                              → `"07:00"`
 *  - `schedule_times: ['07:00']`, `schedule_days: ['mon','wed']` → `"07:00 (Mon, Wed)"`
 *  - `interval_minutes: 5`                                    → `"every 5m"`
 *  - `schedule_days: ['mon','wed']` (no times, no interval)   → `"days: Mon, Wed"`
 *  - none of the above                                        → `undefined`
 */
function formatCueSchedule(sub: {
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

export function registerCueCallbacks(
	server: WebServer,
	deps: Pick<
		WebServerFactoryDependencies,
		'getCueGraphData' | 'setCueSubscriptionEnabled' | 'getCueActivityLog' | 'triggerCueSubscription'
	>
): void {
	// Get Cue subscriptions - calls engine directly in the main process.
	// Previous implementation forwarded `remote:getCueSubscriptions` to
	// the renderer and waited 30 s for a response, but no renderer code
	// ever registered a handler for that channel. The CLI's 10 s timeout
	// fired every time, surfacing as `cue list` hanging with
	// `Command timed out waiting for cue_subscriptions`. Mirrors the same
	// pattern as `triggerCueSubscription` below - the engine lives in
	// main process anyway, so the IPC bounce was never needed.
	server.setGetCueSubscriptionsCallback(async (sessionId?: string) => {
		if (!deps.getCueGraphData) {
			logger.warn('getCueGraphData dependency not available', 'WebServer');
			return [];
		}
		const graph = deps.getCueGraphData();
		const filtered =
			typeof sessionId === 'string' && sessionId.length > 0
				? graph.filter((gs) => gs.sessionId === sessionId)
				: graph;
		const subs: CueSubscriptionInfo[] = [];
		for (const session of filtered) {
			for (const sub of session.subscriptions) {
				subs.push({
					// No stable per-subscription id in YAML; compose one from
					// session + pipeline + name. Names are unique within a
					// pipeline (validator contract), so the pipeline
					// discriminator is what guarantees the id stays unique
					// when two pipelines under the same session each define
					// a sub with the same name. Without it, downstream
					// resolvers (e.g. `setSubscriptionEnabled` in the
					// follow-up PR) would match by name only and silently
					// toggle the wrong row.
					id: composeCueSubscriptionId(session.sessionId, sub),
					name: sub.name,
					eventType: sub.event,
					pattern: typeof sub.watch === 'string' ? sub.watch : undefined,
					schedule: formatCueSchedule(sub),
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					enabled: sub.enabled !== false,
					// Per-subscription last-triggered / count are not yet
					// tracked by the engine (only per-session). Leave the
					// numeric fields zero so the CLI renders "never triggered"
					// rather than fabricating a value.
					triggerCount: 0,
				});
			}
		}
		return subs;
	});

	// Toggle Cue subscription - calls engine directly in the main process.
	// Previous implementation forwarded `remote:toggleCueSubscription` to
	// the renderer and waited 10 s for a response, but no renderer code
	// ever registered a handler for that channel. Every web-UI toggle
	// silently became a no-op after a 10 s stall. Same dead-bridge fix as
	// `setGetCueSubscriptionsCallback` and `setTriggerCueSubscriptionCallback`.
	server.setToggleCueSubscriptionCallback(async (subscriptionId: string, enabled: boolean) => {
		if (!deps.setCueSubscriptionEnabled) {
			logger.warn('setCueSubscriptionEnabled dependency not available', 'WebServer');
			return false;
		}
		return deps.setCueSubscriptionEnabled(subscriptionId, enabled);
	});

	// Get Cue activity log - calls engine directly in the main process.
	// Previously forwarded to the renderer with no listener registered -
	// the 30 s timeout fired every time and the web UI's activity tab
	// always rendered empty. Maps `CueRunResult[]` from the engine into
	// the web-facing `CueActivityEntry[]` shape and applies the same
	// optional `sessionId` filter the IPC bounce used to apply renderer-side.
	server.setGetCueActivityCallback(async (sessionId?: string, limit?: number) => {
		if (!deps.getCueActivityLog) {
			logger.warn('getCueActivityLog dependency not available', 'WebServer');
			return [];
		}
		const runs = deps.getCueActivityLog();
		const filteredBySession =
			typeof sessionId === 'string' && sessionId.length > 0
				? runs.filter((r) => r.sessionId === sessionId)
				: runs;
		// `limit` is applied after sessionId filtering so the caller gets
		// `N` matching entries rather than `N` total of which some may be
		// filtered out - mirroring how `cueEngine.getActivityLog(limit)`
		// would behave without the per-session filter.
		const limited =
			typeof limit === 'number' && limit > 0
				? filteredBySession.slice(0, limit)
				: filteredBySession;
		const entries: CueActivityEntry[] = limited.map((r) => ({
			id: r.runId,
			// Same identity contract as the subscriptions list - the
			// pipeline discriminator falls back to base-name stripping
			// when the run record has no `pipelineName`, matching how
			// `getCueGraphData`'s flatten emits ids.
			subscriptionId: composeCueSubscriptionId(r.sessionId, {
				name: r.subscriptionName,
				pipeline_name: r.pipelineName,
			}),
			subscriptionName: r.subscriptionName,
			eventType: r.event.type,
			sessionId: r.sessionId,
			timestamp: Date.parse(r.startedAt) || 0,
			// Map engine-side status (`timeout` / `stopped` are terminal
			// failure variants) onto the web-facing four-state enum.
			status:
				r.status === 'completed'
					? 'completed'
					: r.status === 'running'
						? 'running'
						: r.status === 'failed' || r.status === 'timeout' || r.status === 'stopped'
							? 'failed'
							: 'triggered',
			result: r.status === 'completed' ? r.stdout || undefined : r.stderr || undefined,
			duration: r.durationMs,
		}));
		return entries;
	});

	// Trigger a Cue subscription by name - calls engine directly in the main process.
	// Previous implementation routed through the renderer via IPC round-trip, which
	// caused sourceAgentId to be dropped during Electron IPC serialization.
	server.setTriggerCueSubscriptionCallback(
		async (subscriptionName: string, prompt?: string, sourceAgentId?: string) => {
			if (!deps.triggerCueSubscription) {
				logger.warn('triggerCueSubscription dependency not available', 'WebServer');
				return false;
			}
			return deps.triggerCueSubscription(subscriptionName, prompt, sourceAgentId);
		}
	);
}
