/**
 * useCrossAgentDispatch
 *
 * Owns the renderer side of the cross-agent `@mention` pipeline (Phase 03):
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
import { updateSessionWith, updateAiTab, useSessionStore } from '../../stores/sessionStore';
import { useCrossAgentInFlightStore } from '../../stores/crossAgentInFlightStore';
import { createTab } from '../../utils/tabHelpers';
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
	/** Display name of the source (calling) agent, for the target's consult tab + history. */
	sourceAgentName: string;
	/** The AI tab within the source agent. */
	sourceTabId: string;
	/** The resolved target agent (session) to consult. */
	targetSessionId: string;
	/** The user's message (still contains the `@target` token). */
	userPrompt: string;
	/** The source tab's logs (windowed before sending). */
	sourceLogs: LogEntry[];
	/**
	 * The source agent's working directory. Forwarded so the consulted agent can
	 * be told it may READ files here to inform its answer (it runs in its own
	 * cwd, so this is the only pointer it has to the user's project).
	 */
	sourceCwd?: string;
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
				// The consult tab on the target that holds the persisted answer, so the
				// attribution pill's jump arrow lands on the real conversation.
				fromTabId: chunk.targetTabId,
				fromAgentName: chunk.targetAgentName,
				fromToolType: chunk.targetToolType,
				// Streaming until the terminal (`done`) chunk lands. Phase 04's
				// attribution pill shows a spinner + pulses the border while true.
				streaming: !chunk.done,
				// Phase 05: surface the failure inline as a red-tinted bubble
				// variant instead of throwing.
				...(chunk.error ? { error: chunk.error } : {}),
			},
		},
	};
}

/** Label for a consult tab on the target: signals an inbound consult + who from. */
export function buildConsultTabName(sourceAgentName: string): string {
	return `↩ ${sourceAgentName}`;
}

/**
 * Find-or-create the consult tab on the TARGET agent for this (source tab ->
 * target) pairing, and append the user's question to it.
 *
 * The consult tab is the continuity store: one per
 * (sourceSessionId, sourceTabId, targetSessionId) triple, tagged with
 * `consultOrigin`. A repeat mention from the SAME source tab reuses it (and
 * resumes its captured provider `agentSessionId`); a mention from a fresh source
 * tab makes a new one. Creation does NOT steal focus - the user stays put in the
 * source agent.
 *
 * Returns the consult tab id plus the provider session id to resume (undefined on
 * the first mention), or null if the target session no longer exists.
 */
export function ensureConsultTab(opts: {
	targetSessionId: string;
	sourceSessionId: string;
	sourceTabId: string;
	sourceAgentName: string;
	question: string;
}): { targetTabId: string; resumeAgentSessionId?: string } | null {
	const questionEntry: LogEntry = {
		id: generateId(),
		timestamp: Date.now(),
		source: 'user',
		text: opts.question,
	};

	let resolvedTabId: string | null = null;
	let resumeAgentSessionId: string | undefined;

	updateSessionWith(opts.targetSessionId, (session) => {
		const existing = session.aiTabs.find(
			(t) =>
				t.consultOrigin?.sourceSessionId === opts.sourceSessionId &&
				t.consultOrigin?.sourceTabId === opts.sourceTabId
		);
		if (existing) {
			resolvedTabId = existing.id;
			resumeAgentSessionId = existing.agentSessionId ?? undefined;
			return {
				...session,
				aiTabs: session.aiTabs.map((t) =>
					t.id === existing.id ? { ...t, logs: [...t.logs, questionEntry] } : t
				),
			};
		}

		// Reuse the canonical tab factory (defaults + unifiedTabOrder insertion),
		// then restore the pre-existing focus pointers so the new consult tab is
		// added silently rather than yanking the user into the target agent.
		const created = createTab(session, {
			name: buildConsultTabName(opts.sourceAgentName),
			logs: [questionEntry],
			saveToHistory: false,
		});
		if (!created) return session;
		resolvedTabId = created.tab.id;
		resumeAgentSessionId = undefined;
		return {
			...created.session,
			activeTabId: session.activeTabId,
			activeFileTabId: session.activeFileTabId,
			activeBrowserTabId: session.activeBrowserTabId,
			activeTerminalTabId: session.activeTerminalTabId,
			inputMode: session.inputMode,
			aiTabs: created.session.aiTabs.map((t) =>
				t.id === created.tab.id
					? {
							...t,
							consultOrigin: {
								sourceSessionId: opts.sourceSessionId,
								sourceTabId: opts.sourceTabId,
							},
						}
					: t
			),
		};
	});

	if (!resolvedTabId) return null;
	return { targetTabId: resolvedTabId, resumeAgentSessionId };
}

/** Per-request tracking so streamed chunks land on one stable LogEntry. */
interface TrackedRequest {
	sourceSessionId: string;
	sourceTabId: string;
	/** The attribution-bubble entry id on the SOURCE tab. */
	logEntryId: string;
	/** The consulted (target) agent + its consult tab, so chunks persist there too. */
	targetSessionId: string;
	targetTabId?: string;
	/** The answer entry id inside the consult tab on the target. */
	targetLogEntryId: string;
	/** The calling agent's display name (for the target's history entry). */
	sourceAgentName?: string;
	accumulated: string;
}

/**
 * Record a durable History entry on the TARGET agent for a finished consult,
 * attributed to the calling agent (so the target's History shows who consulted
 * it). Best-effort: a failure here never disrupts response streaming.
 */
function recordConsultHistory(tracked: TrackedRequest, chunk: CrossAgentResponseChunk): void {
	if (!tracked.targetTabId) return; // No consult tab -> nothing to attribute.
	const state = useSessionStore.getState();
	const target = state.sessions.find((s) => s.id === chunk.targetSessionId);
	if (!target) return; // Target agent removed mid-flight; skip.

	const sourceAgentName =
		tracked.sourceAgentName ??
		state.sessions.find((s) => s.id === chunk.sourceSessionId)?.name ??
		'another agent';
	const consultTab = target.aiTabs.find((t) => t.id === tracked.targetTabId);

	void window.maestro.history
		.add({
			id: generateId(),
			type: 'AUTO',
			timestamp: Date.now(),
			summary: `Consulted by ${sourceAgentName}`,
			fullResponse: tracked.accumulated || undefined,
			agentSessionId: chunk.targetAgentSessionId ?? consultTab?.agentSessionId ?? undefined,
			sessionId: chunk.targetSessionId,
			sessionName: consultTab?.name ?? target.name ?? undefined,
			projectPath: target.cwd,
			sourceAgentName,
			success: !chunk.error,
		})
		.catch((err) => {
			logger.warn('[useCrossAgentDispatch] Failed to record consult history', undefined, err);
		});
}

export interface UseCrossAgentDispatchResult {
	sendCrossAgentRequest: (opts: SendCrossAgentRequestOptions) => void;
}

export function useCrossAgentDispatch(): UseCrossAgentDispatchResult {
	// requestId -> tracking state. A ref (not state): chunk handling mutates it
	// between renders and must not itself trigger a re-render.
	const pendingRef = useRef<Map<string, TrackedRequest>>(new Map());
	// requestIds whose terminal (`done`) chunk already landed. Guards the race
	// where a fast failure/short response arrives BEFORE send() resolves: without
	// it, the late .then() re-registers pendingRef and calls start() for an
	// already-finished request, leaving the "N agents responding" pill stuck.
	const completedRef = useRef<Set<string>>(new Set());

	const applyChunk = useCallback((chunk: CrossAgentResponseChunk): void => {
		const map = pendingRef.current;
		let tracked = map.get(chunk.requestId);
		if (!tracked) {
			// Chunk for a request this instance didn't register (e.g. a reload
			// mid-flight). Fall back to the chunk's own ids so the response still
			// lands, on a fresh entry - including the consult tab if the chunk names one.
			tracked = {
				sourceSessionId: chunk.sourceSessionId,
				sourceTabId: chunk.sourceTabId,
				logEntryId: generateId(),
				targetSessionId: chunk.targetSessionId,
				targetTabId: chunk.targetTabId,
				targetLogEntryId: generateId(),
				accumulated: '',
			};
			map.set(chunk.requestId, tracked);
		}

		const { accumulated, displayText } = accumulateCrossAgentChunk(tracked.accumulated, chunk);
		tracked.accumulated = accumulated;

		const entryId = tracked.logEntryId;
		const sourceTabId = tracked.sourceTabId;

		// 1. The attribution bubble on the SOURCE tab (what the user reads inline).
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

		// 2. The persisted copy on the TARGET's consult tab (what the jump arrow
		// lands on, and what makes the target "remember it was consulted"). Written
		// as a native `ai` answer - no crossAgent provenance, since from the target's
		// point of view this IS its own reply.
		const targetTabId = tracked.targetTabId;
		if (targetTabId) {
			const answerId = tracked.targetLogEntryId;
			updateAiTab(chunk.targetSessionId, targetTabId, (tab) => {
				const existingIndex = tab.logs.findIndex((l) => l.id === answerId);
				const timestamp = existingIndex >= 0 ? tab.logs[existingIndex].timestamp : Date.now();
				const answer: LogEntry = {
					id: answerId,
					timestamp,
					source: chunk.error ? 'error' : 'ai',
					text: displayText,
				};
				const nextLogs =
					existingIndex >= 0
						? tab.logs.map((l, i) => (i === existingIndex ? answer : l))
						: [...tab.logs, answer];
				// On success, store the target's captured provider session id so the
				// next mention from this source tab resumes it (continuity).
				const agentSessionId =
					chunk.done && chunk.targetAgentSessionId
						? chunk.targetAgentSessionId
						: tab.agentSessionId;
				return { ...tab, logs: nextLogs, agentSessionId };
			});
		}

		if (chunk.done) {
			// The target now has a durable record of the consult, attributed to the
			// caller so its History shows who consulted it.
			recordConsultHistory(tracked, chunk);
			map.delete(chunk.requestId);
			completedRef.current.add(chunk.requestId);
			// Drop it from the live "N agents responding…" indicator.
			useCrossAgentInFlightStore.getState().finish(chunk.requestId);
		}
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

		// Find-or-create the consult tab on the target BEFORE dispatch, so the
		// question is persisted immediately and we know which provider session to
		// resume. A repeat mention from the same source tab reuses the tab (and its
		// captured `agentSessionId`); a fresh source tab makes a new one.
		const consult = ensureConsultTab({
			targetSessionId: opts.targetSessionId,
			sourceSessionId: opts.sourceSessionId,
			sourceTabId: opts.sourceTabId,
			sourceAgentName: opts.sourceAgentName,
			question: opts.userPrompt,
		});

		// Fire-and-forget: never await before the caller clears the input.
		void window.maestro.crossAgent
			.send({
				sourceSessionId: opts.sourceSessionId,
				sourceAgentName: opts.sourceAgentName,
				sourceTabId: opts.sourceTabId,
				targetSessionId: opts.targetSessionId,
				targetTabId: consult?.targetTabId,
				resumeAgentSessionId: consult?.resumeAgentSessionId,
				userPrompt: opts.userPrompt,
				transcript,
				strategy,
				sourceCwd: opts.sourceCwd,
			})
			.then(({ requestId }) => {
				// The terminal chunk already landed (fast failure/short response that
				// beat this resolution) - don't resurrect a finished request.
				if (completedRef.current.has(requestId)) return;
				// Pre-register so streamed chunks reuse one stable LogEntry id.
				if (!pendingRef.current.has(requestId)) {
					pendingRef.current.set(requestId, {
						sourceSessionId: opts.sourceSessionId,
						sourceTabId: opts.sourceTabId,
						logEntryId: generateId(),
						targetSessionId: opts.targetSessionId,
						targetTabId: consult?.targetTabId,
						targetLogEntryId: generateId(),
						sourceAgentName: opts.sourceAgentName,
						accumulated: '',
					});
				}
				// Register for the live "N agents responding…" indicator. Resolve
				// the target's display name/tool type now (it came from the same
				// sessions list) rather than waiting on the first response chunk.
				const target = useSessionStore
					.getState()
					.sessions.find((s) => s.id === opts.targetSessionId);
				useCrossAgentInFlightStore.getState().start({
					requestId,
					sourceSessionId: opts.sourceSessionId,
					sourceTabId: opts.sourceTabId,
					targetSessionId: opts.targetSessionId,
					targetAgentName: target?.name ?? 'agent',
					targetToolType: target?.toolType,
					startedAt: Date.now(),
				});
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
