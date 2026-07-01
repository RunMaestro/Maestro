/**
 * useCrossAgentDispatch
 *
 * Owns the renderer side of the cross-agent `@@mention` pipeline (Phase 03):
 *
 * 1. `sendCrossAgentRequest` windows the source transcript with the Phase-02
 *    heuristics and fires `window.maestro.crossAgent.send(...)`. It's
 *    fire-and-forget: the source chat is never blocked.
 * 2. On mount it subscribes to `window.maestro.crossAgent.onChunk`. As chunks
 *    stream back, it accumulates text per `requestId` and appends/updates a
 *    single `source: 'ai'` LogEntry on the SOURCE tab, stamped with
 *    `metadata.crossAgent` provenance so Phase 04 can render the attribution
 *    pill.
 *
 * Mount this once (App-level) so the subscription is a singleton; call
 * `sendCrossAgentRequest` from the message-send path.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { LogEntry } from '../../types';
import { updateSessionWith } from '../../stores/sessionStore';
import { generateId } from '../../utils/ids';
import { logger } from '../../utils/logger';
import { inferContextStrategy, selectContextWindow } from '../../../shared/crossAgentContext';
import type {
	CrossAgentResponseChunk,
	CrossAgentTranscriptEntry,
} from '../../../shared/crossAgentTypes';

/** Options for a single cross-agent dispatch (one resolved target). */
export interface SendCrossAgentRequestOptions {
	/** The agent the user typed the mention in. */
	sourceSessionId: string;
	/** The AI tab within the source agent. */
	sourceTabId: string;
	/** The resolved target agent (session) to consult. */
	targetSessionId: string;
	/** The user's message (still contains the `@@target` token). */
	userPrompt: string;
	/** The source tab's logs (windowed before sending). */
	sourceLogs: LogEntry[];
}

/**
 * Pure: fold a chunk's text into the prior accumulation and resolve what should
 * be displayed. On an error chunk with no accumulated text, we surface a short
 * failure note instead of an empty entry. Exported for unit testing.
 */
export function accumulateCrossAgentChunk(
	prior: string,
	chunk: CrossAgentResponseChunk
): { accumulated: string; displayText: string } {
	const accumulated = prior + (chunk.chunk ?? '');
	const displayText = chunk.error
		? accumulated || `⚠️ ${chunk.targetAgentName} could not respond: ${chunk.error}`
		: accumulated;
	return { accumulated, displayText };
}

/**
 * Pure: build the source-tab LogEntry for a cross-agent response. `source` is
 * 'ai' for now (Phase 04 introduces distinct cross-agent styling); provenance
 * lives on `metadata.crossAgent`. Exported for unit testing.
 */
export function buildCrossAgentLogEntry(
	logEntryId: string,
	timestamp: number,
	displayText: string,
	chunk: CrossAgentResponseChunk
): LogEntry {
	return {
		id: logEntryId,
		timestamp,
		source: 'ai',
		text: displayText,
		metadata: {
			crossAgent: {
				requestId: chunk.requestId,
				fromSessionId: chunk.targetSessionId,
				fromAgentName: chunk.targetAgentName,
				fromToolType: chunk.targetToolType,
				// Streaming until the terminal (`done`) chunk lands. Phase 04's
				// attribution pill shows a spinner + pulses the border while true.
				streaming: !chunk.done,
			},
		},
	};
}

/** Per-request tracking so streamed chunks land on one stable LogEntry. */
interface TrackedRequest {
	sourceSessionId: string;
	sourceTabId: string;
	logEntryId: string;
	accumulated: string;
}

export interface UseCrossAgentDispatchResult {
	sendCrossAgentRequest: (opts: SendCrossAgentRequestOptions) => void;
}

export function useCrossAgentDispatch(): UseCrossAgentDispatchResult {
	// requestId -> tracking state. A ref (not state): chunk handling mutates it
	// between renders and must not itself trigger a re-render.
	const pendingRef = useRef<Map<string, TrackedRequest>>(new Map());

	const applyChunk = useCallback((chunk: CrossAgentResponseChunk): void => {
		const map = pendingRef.current;
		let tracked = map.get(chunk.requestId);
		if (!tracked) {
			// Chunk for a request this instance didn't register (e.g. a reload
			// mid-flight). Fall back to the chunk's own ids so the response still
			// lands, on a fresh entry.
			tracked = {
				sourceSessionId: chunk.sourceSessionId,
				sourceTabId: chunk.sourceTabId,
				logEntryId: generateId(),
				accumulated: '',
			};
			map.set(chunk.requestId, tracked);
		}

		const { accumulated, displayText } = accumulateCrossAgentChunk(tracked.accumulated, chunk);
		tracked.accumulated = accumulated;

		const entryId = tracked.logEntryId;
		const sourceTabId = tracked.sourceTabId;

		updateSessionWith(tracked.sourceSessionId, (session) => {
			const tab = session.aiTabs.find((t) => t.id === sourceTabId);
			if (!tab) return session; // Source tab was closed; nothing to update.

			const existingIndex = tab.logs.findIndex((l) => l.id === entryId);
			const timestamp = existingIndex >= 0 ? tab.logs[existingIndex].timestamp : Date.now();
			const entry = buildCrossAgentLogEntry(entryId, timestamp, displayText, chunk);

			const nextLogs =
				existingIndex >= 0
					? tab.logs.map((l, i) => (i === existingIndex ? entry : l))
					: [...tab.logs, entry];

			return {
				...session,
				aiTabs: session.aiTabs.map((t) => (t.id === tab.id ? { ...t, logs: nextLogs } : t)),
			};
		});

		if (chunk.done) map.delete(chunk.requestId);
	}, []);

	useEffect(() => {
		const unsubscribe = window.maestro.crossAgent.onChunk(applyChunk);
		return () => unsubscribe();
	}, [applyChunk]);

	const sendCrossAgentRequest = useCallback((opts: SendCrossAgentRequestOptions): void => {
		const strategy = inferContextStrategy(opts.userPrompt);
		const windowed = selectContextWindow(opts.sourceLogs, strategy);
		const transcript: CrossAgentTranscriptEntry[] = windowed.map((l) => ({
			source: l.source,
			text: l.text,
			timestamp: l.timestamp,
		}));

		// Fire-and-forget: never await before the caller clears the input.
		void window.maestro.crossAgent
			.send({
				sourceSessionId: opts.sourceSessionId,
				sourceTabId: opts.sourceTabId,
				targetSessionId: opts.targetSessionId,
				userPrompt: opts.userPrompt,
				transcript,
				strategy,
			})
			.then(({ requestId }) => {
				// Pre-register so streamed chunks reuse one stable LogEntry id.
				if (!pendingRef.current.has(requestId)) {
					pendingRef.current.set(requestId, {
						sourceSessionId: opts.sourceSessionId,
						sourceTabId: opts.sourceTabId,
						logEntryId: generateId(),
						accumulated: '',
					});
				}
			})
			.catch((err) => {
				logger.error(
					'[useCrossAgentDispatch] Failed to dispatch cross-agent request',
					undefined,
					err
				);
			});
	}, []);

	return { sendCrossAgentRequest };
}

export default useCrossAgentDispatch;
