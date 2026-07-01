/**
 * crossAgentInFlightStore - Zustand store tracking in-flight cross-agent
 * (`@@mention`) requests so the input area can surface a live
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
