/**
 * contextTimelineHydration - backfills a renderer's Context Timeline buffer
 * from the RAW usage captures main kept (finding S1).
 *
 * Why this exists: `contextTimelineStore` is populated only by live
 * `process:usage` events, so every fresh renderer opened the Context Timeline
 * at zero turns - a web-desktop client, a reloaded window and a second desktop
 * window all started empty even when the agent had a long history elsewhere.
 * Main now keeps the raw events; this replays them through
 * `buildContextTimelinePoint`, the exact function the live listener uses, so
 * the four skip guards and the context-window precedence are reproduced by
 * construction rather than duplicated.
 *
 * Memory-only by design: main's log dies with the app, so a full restart shows
 * a legitimately empty timeline.
 */

import { useContextTimelineStore } from '../stores/contextTimelineStore';
import type { ContextTimelineHydrationPoint } from '../stores/contextTimelineStore';
import { parseSessionId } from '../utils/sessionIdParser';
import type { Session } from '../types';
import { buildContextTimelinePoint } from '../hooks/agent/internal/contextTimelinePoint';

/** Sessions with a fetch in flight, so a re-render cannot start a second one. */
const inFlight = new Set<string>();

/**
 * Bumped whenever an agent's captures are discarded. A fetch reads this before
 * awaiting and again before writing; a mismatch means the history it is holding
 * was thrown away mid-flight, so it must be dropped rather than restored
 * (review of PR #1365). Without it, clearing a timeline - or deleting the agent
 * - while `getCaptures` was in flight let the reply repopulate the buffer, or
 * recreate one for an agent that no longer exists.
 */
const discardEpoch = new Map<string, number>();

/**
 * Fetch and replay main's captures for one agent. No-op when the buffer has
 * already been hydrated (a reopen must never re-run this) or when a fetch for
 * the same agent is already running.
 *
 * The agent is passed in rather than read from `sessionStore` so this module
 * stays off that store's import graph - `sessionStore` calls
 * `forgetContextTimelineCaptures` below, and a cycle between the two would be a
 * load-order hazard for no benefit.
 */
export async function hydrateContextTimeline(
	baseSessionId: string,
	session: Session
): Promise<void> {
	if (!baseSessionId || !session || inFlight.has(baseSessionId)) return;

	const store = useContextTimelineStore.getState();
	if (store.buffers[baseSessionId]?.hydrated) return;

	const api = window.maestro?.contextTimeline;
	if (!api) {
		// No capture surface (an older main, or a stripped test harness). Mark the
		// buffer hydrated anyway so the panel stops waiting and shows its copy.
		store.hydrateSession(baseSessionId, [], false);
		return;
	}

	inFlight.add(baseSessionId);
	// Snapshot before the await; anything that discards this agent's history
	// while the fetch runs moves it on.
	const epochAtStart = discardEpoch.get(baseSessionId) ?? 0;
	try {
		const result = await api.getCaptures(baseSessionId);
		// A failed fetch is deliberately NOT marked hydrated, so reopening retries.
		if (!result?.success) return;
		// The user cleared the timeline (or deleted the agent) while this was in
		// flight. Writing now would resurrect exactly the history they discarded.
		if ((discardEpoch.get(baseSessionId) ?? 0) !== epochAtStart) return;

		const points: ContextTimelineHydrationPoint[] = [];
		for (const capture of result.captures ?? []) {
			const parsed = parseSessionId(capture.sessionId);
			// Main matches captures by raw-id prefix because it has no parser; this
			// is the exact filter that drops any agent whose id merely starts with
			// this one's.
			if (parsed.baseSessionId !== baseSessionId) continue;
			const built = buildContextTimelinePoint(parsed, capture.usageStats, session);
			if (!built.point) continue;
			points.push({
				...built.point,
				// The ORIGINAL capture time, not now: a restored turn must not claim
				// it happened when the panel opened.
				timestamp: capture.timestamp,
				seq: capture.seq,
			});
		}

		useContextTimelineStore
			.getState()
			.hydrateSession(baseSessionId, points, result.trimmed ?? false);
	} finally {
		inFlight.delete(baseSessionId);
	}
}

/**
 * Drop main's captures for an agent. Called when the user clears a timeline and
 * when an agent is deleted - without this, the next open would hydrate the very
 * history that was just discarded.
 */
export function forgetContextTimelineCaptures(baseSessionId: string): void {
	if (!baseSessionId) return;
	// Invalidate any fetch already in flight BEFORE the async clear, so a reply
	// that arrives in between cannot restore what is being discarded.
	discardEpoch.set(baseSessionId, (discardEpoch.get(baseSessionId) ?? 0) + 1);
	void window.maestro?.contextTimeline?.clearCaptures(baseSessionId);
}

/** Test-only: drop the epoch bookkeeping so cases don't leak into each other. */
export function __resetContextTimelineHydrationForTests(): void {
	inFlight.clear();
	discardEpoch.clear();
}
