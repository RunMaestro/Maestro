/**
 * Pure builders for the metadata-only plugin lifecycle events derived from
 * session-store mutations.
 *
 * Kept free of Electron / store imports so it is trivially unit-testable, and
 * deliberately free of any message body, prompt text, agent output, file
 * contents, or secrets per the events.ts metadata-only contract. Payloads carry
 * ids / labels / a status string only, mirroring the existing
 * `pluginSessionsList` mapping in index.ts (toolType -> agentId, cwd ->
 * projectPath, name -> title).
 */

import type { PluginEvent } from '../../../shared/plugins/events';

/**
 * The minimal session shape the lifecycle differ reads. Only `id` is required
 * so callers can hand us raw `StoredSession` records without remapping; the
 * rest are read defensively (a missing field simply omits its payload key).
 */
export interface SessionLifecycleSnapshot {
	id: string;
	name?: string;
	toolType?: string;
	cwd?: string;
	/** Run state, e.g. 'idle' | 'busy' | 'waiting_input' (see SessionState). */
	state?: string;
}

/**
 * Diff a previous session set against the resulting one and produce the
 * metadata-only plugin events for the transition:
 *  - `session.created`     for an id present now but not before
 *  - `session.removed`     for an id present before but not now
 *  - `agent.statusChanged` for an id in both whose `state` string changed
 *  - `agent.awaiting`      additionally when that new `state` is `waiting_input`
 *
 * The single `at` timestamp is shared by every event the call produces so a
 * batch of changes carries a consistent ordering key.
 */
export function buildSessionLifecycleEvents(
	previous: ReadonlyMap<string, SessionLifecycleSnapshot>,
	current: readonly SessionLifecycleSnapshot[],
	at: string
): PluginEvent[] {
	const events: PluginEvent[] = [];
	const seen = new Set<string>();

	for (const s of current) {
		if (!s || typeof s.id !== 'string') continue;
		seen.add(s.id);
		const prev = previous.get(s.id);
		if (!prev) {
			events.push({
				topic: 'session.created',
				at,
				payload: {
					sessionId: s.id,
					...(typeof s.name === 'string' ? { title: s.name } : {}),
					...(typeof s.toolType === 'string' ? { agentId: s.toolType } : {}),
					...(typeof s.cwd === 'string' ? { projectPath: s.cwd } : {}),
				},
			});
			continue;
		}
		if (typeof s.state === 'string' && s.state !== prev.state) {
			const agentId = typeof s.toolType === 'string' ? s.toolType : s.id;
			events.push({
				topic: 'agent.statusChanged',
				at,
				payload: { agentId, tabId: s.id, status: s.state },
			});
			// `waiting_input` is the agent-blocked signal; surface it on the
			// dedicated topic too so a plugin can subscribe to just that without
			// filtering every status change. No prompt text - the kind/risk
			// fields are intentionally omitted (no clean metadata source here).
			if (s.state === 'waiting_input') {
				events.push({
					topic: 'agent.awaiting',
					at,
					payload: { agentId, tabId: s.id },
				});
			}
		}
	}

	for (const id of previous.keys()) {
		if (!seen.has(id)) {
			events.push({ topic: 'session.removed', at, payload: { sessionId: id } });
		}
	}

	return events;
}
