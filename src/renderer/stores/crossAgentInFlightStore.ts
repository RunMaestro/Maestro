/**
 * crossAgentInFlightStore - Zustand store tracking in-flight cross-agent
 * (`@mention`) requests so the input area can surface a live
 * "N agents responding…" indicator (Phase 05).
 *
 * This is purely informational, decoupled from the response-accumulation state
 * in {@link useCrossAgentDispatch} (which owns the source-tab LogEntries). The
 * dispatch hook registers a request here once `crossAgent.send` resolves and
 * removes it on the terminal (`done`) chunk, so the map always reflects what is
 * still streaming.
 *
 * Keyed by `requestId`. Stored as a plain object (not a Map) so zustand's
 * shallow equality works for selectors.
 */

import { useMemo } from 'react';
import { create } from 'zustand';
import type { ToolType } from '../types';

/** One cross-agent request that is still streaming a response. */
export interface InFlightCrossAgentRequest {
	/** Correlates with the CrossAgentRequest / its response chunks. */
	requestId: string;
	/** The agent (session) the mention was typed in - the response destination. */
	sourceSessionId: string;
	/** The AI tab within the source agent that owns the conversation. */
	sourceTabId: string;
	/** The consulted agent (session) producing the response. */
	targetSessionId: string;
	/**
	 * The consult tab inside the target agent that is running the request, so the
	 * indicator's agent chip can jump straight to the conversation doing the work
	 * instead of dropping the user on whatever tab that agent last had active.
	 * Absent when the consult tab could not be resolved (target removed mid-flight).
	 */
	targetTabId?: string;
	/** The consulted agent's display name (for the indicator dropdown). */
	targetAgentName: string;
	/** The consulted agent's tool type (for the provider icon), if known. */
	targetToolType?: ToolType;
	/** When the request was registered (epoch ms) - drives elapsed-time display. */
	startedAt: number;
}

interface CrossAgentInFlightState {
	/** requestId -> in-flight request. */
	requests: Record<string, InFlightCrossAgentRequest>;
	/** Register a newly-dispatched request. No-op if already present. */
	start: (request: InFlightCrossAgentRequest) => void;
	/** Remove a request once its response has finished (or errored). */
	finish: (requestId: string) => void;
}

export const useCrossAgentInFlightStore = create<CrossAgentInFlightState>()((set) => ({
	requests: {},
	start: (request) =>
		set((state) => {
			if (state.requests[request.requestId]) return state;
			return { requests: { ...state.requests, [request.requestId]: request } };
		}),
	finish: (requestId) =>
		set((state) => {
			if (!state.requests[requestId]) return state;
			const next = { ...state.requests };
			delete next[requestId];
			return { requests: next };
		}),
}));

/**
 * Select the in-flight cross-agent requests targeting a specific source tab,
 * ordered by start time (oldest first). Pass the source agent + tab currently
 * on screen so the indicator only counts responses streaming into *this* view.
 */
export function selectInFlightForTab(
	requests: Record<string, InFlightCrossAgentRequest>,
	sourceSessionId: string | null | undefined,
	sourceTabId: string | null | undefined
): InFlightCrossAgentRequest[] {
	if (!sourceSessionId || !sourceTabId) return [];
	return Object.values(requests)
		.filter((r) => r.sourceSessionId === sourceSessionId && r.sourceTabId === sourceTabId)
		.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Reactive: whether a specific agent is currently answering a consult.
 *
 * A cross-agent consult runs under a synthetic `cross-agent-<requestId>`
 * process id and writes into a hidden tab, so it deliberately never touches the
 * consulted agent's `state`, unread flags, or attention badge - the whole point
 * is that a question asked on someone else's behalf must not disturb the
 * conversation the user has open with that agent. The cost is that a consulted
 * agent looked completely idle in the Left Bar while it was working. This is the
 * one signal that leaks back out: enough to show a busy dot, not enough to mark
 * the agent as needing attention.
 *
 * Mirrors `useSessionHasActiveOutage` - a boolean selector, so a row only
 * re-renders when the answer actually flips.
 */
export function useSessionIsBeingConsulted(sessionId: string): boolean {
	return useCrossAgentInFlightStore((s) => {
		for (const id in s.requests) {
			if (s.requests[id].targetSessionId === sessionId) return true;
		}
		return false;
	});
}

/**
 * The set of agents currently answering a consult, for surfaces that draw many
 * rows in one pass (the collapsed rail, the worktree pill strip) and so cannot
 * call {@link useSessionIsBeingConsulted} per row. Derived from the `requests`
 * object, whose identity only changes on start/finish, so the Set is stable
 * between consults.
 */
export function selectConsultedSessionIds(
	requests: Record<string, InFlightCrossAgentRequest>
): Set<string> {
	const ids = new Set<string>();
	for (const id in requests) ids.add(requests[id].targetSessionId);
	return ids;
}

/** Reactive form of {@link selectConsultedSessionIds}. */
export function useConsultedSessionIds(): ReadonlySet<string> {
	const requests = useCrossAgentInFlightStore((s) => s.requests);
	return useMemo(() => selectConsultedSessionIds(requests), [requests]);
}
