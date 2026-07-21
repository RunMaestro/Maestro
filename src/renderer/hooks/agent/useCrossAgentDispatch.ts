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
import type { LogEntry, Session, ToolType } from '../../types';
import { updateSessionWith, updateAiTab, useSessionStore } from '../../stores/sessionStore';
import { useCrossAgentInFlightStore } from '../../stores/crossAgentInFlightStore';
import { createTab } from '../../utils/tabHelpers';
import { generateId } from '../../utils/ids';
import { logger } from '../../utils/logger';
import {
	deriveConsultSubject,
	inferContextStrategy,
	selectContextWindow,
} from '../../../shared/crossAgentContext';
import { parseSynopsis } from '../../../shared/synopsis';
import type {
	CrossAgentResponseChunk,
	CrossAgentTranscriptEntry,
} from '../../../shared/crossAgentTypes';

/**
 * The subset of `spawnBackgroundSynopsis` (see `useAgentExecution`) this hook
 * needs to condense a finished consult. Kept as a local structural type so the
 * dispatch hook doesn't take a dependency on the agent-execution module.
 */
export type SpawnBackgroundSynopsisFn = (
	sessionId: string,
	cwd: string,
	resumeAgentSessionId: string,
	prompt: string,
	toolType?: ToolType,
	sessionConfig?: {
		customArgs?: string;
		customEnvVars?: Record<string, string>;
		customModel?: string;
		customContextWindow?: number;
		enableMaestroP?: boolean;
		maestroPMode?: 'interactive' | 'dynamic';
		maestroPPath?: string;
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
			workingDirOverride?: string;
		};
	}
) => Promise<{ success: boolean; response?: string }>;

/**
 * Prompt for the post-consult summary pass. Resumes the consulted agent's own
 * session (so it still has the full Q&A in context) and asks it to condense its
 * OWN answer into the `**Summary:** / **Details:**` shape `parseSynopsis`
 * understands. We deliberately do NOT reuse the Auto Run synopsis prompt: that
 * one synopsizes "work done in a session" and returns NOTHING_TO_REPORT for an
 * advice-only turn (no tools) - exactly the common consult case - which would
 * leave the detail view showing the raw response we're trying to condense.
 */
const CONSULT_SUMMARY_PROMPT =
	'You were just consulted by another agent and gave the response above. ' +
	'Summarize YOUR OWN response for a history log, in EXACTLY this format:\n\n' +
	'**Summary:** [one sentence naming what you advised or concluded]\n' +
	'**Details:** [2-4 sentences capturing the key points, recommendations, and any caveats]\n\n' +
	'Do not restate the question. Do not add anything outside those two sections.';

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
 * be displayed. Exported for unit testing.
 *
 * Three cases, all of which must show the user WHY a consult failed - the
 * attribution header only carries `error` in an `sr-only` span, so the reason has
 * to reach the bubble body:
 * - success: the accumulated text, verbatim.
 * - error, nothing accumulated: a standalone failure note.
 * - error WITH partial text (a timed-out consult that had already said something):
 *   the partial, followed by the reason. Dropping either one loses information.
 */
export function accumulateCrossAgentChunk(
	prior: string,
	chunk: CrossAgentResponseChunk
): { accumulated: string; displayText: string } {
	const accumulated = prior + (chunk.chunk ?? '');
	if (!chunk.error) return { accumulated, displayText: accumulated };
	const note = `⚠️ ${chunk.targetAgentName} could not respond: ${chunk.error}`;
	return {
		accumulated,
		displayText: accumulated ? `${accumulated}\n\n${note}` : note,
	};
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
 * tab makes a new one.
 *
 * The tab is created HIDDEN: it holds the transcript and the resume id, but does
 * not appear in the target's tab strip. A mention typed in some other agent is not
 * the user asking for a tab in this one - it surfaces only when they deliberately
 * open it from the response bubble's attribution header (see `revealAiTab`).
 * Creation therefore steals neither focus nor strip real estate.
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
		// then restore EVERY view pointer createTab moves. It focuses the new tab by
		// design (activeTabId, the non-AI active ids, inputMode, activeGroupId); a
		// consult must leave the target's view exactly as the user left it. Missing
		// activeGroupId in particular would silently pop the target out of a tiled
		// group it was displaying.
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
			activeGroupId: session.activeGroupId,
			inputMode: session.inputMode,
			aiTabs: created.session.aiTabs.map((t) =>
				t.id === created.tab.id
					? {
							...t,
							// Hidden until the user opens it from the attribution header.
							hidden: true,
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
	/**
	 * A short subject derived from the user's question (mentions stripped), used
	 * for the history entry's list line + attribution pill so repeat consults are
	 * distinguishable. Absent when a chunk lands before dispatch registered it.
	 */
	subject?: string;
	accumulated: string;
}

/**
 * Record a durable History entry on the TARGET agent for a finished consult,
 * attributed to the calling agent (so the target's History shows who consulted
 * it) AND what it was consulted about. Best-effort: a failure here never
 * disrupts response streaming.
 *
 * The entry is written immediately with the raw response as the detail-view
 * fallback, then `enrichConsultDetail` patches in a condensed summary once a
 * background synopsis pass returns (so the detail reads as a summary, not the
 * whole answer). The raw answer is never lost - it stays in the consult tab the
 * attribution pill jumps to.
 */
function recordConsultHistory(
	tracked: TrackedRequest,
	chunk: CrossAgentResponseChunk,
	spawnBackgroundSynopsis?: SpawnBackgroundSynopsisFn
): void {
	if (!tracked.targetTabId) return; // No consult tab -> nothing to attribute.
	const state = useSessionStore.getState();
	const target = state.sessions.find((s) => s.id === chunk.targetSessionId);
	if (!target) return; // Target agent removed mid-flight; skip.

	const sourceAgentName =
		tracked.sourceAgentName ??
		state.sessions.find((s) => s.id === chunk.sourceSessionId)?.name ??
		'another agent';
	const consultTab = target.aiTabs.find((t) => t.id === tracked.targetTabId);
	const subject = tracked.subject?.trim() || '';

	// List body names WHO consulted and ABOUT WHAT; the pill carries the subject
	// so multiple consults from the same agent are distinguishable at a glance.
	// The actual consult TAB stays named after the source agent (it's the reused
	// container for every consult from that tab) - only this per-consult entry
	// gets the subject.
	const summary = subject
		? `Consulted by ${sourceAgentName}: ${subject}`
		: `Consulted by ${sourceAgentName}`;
	const sessionName = subject ? `↩ ${subject}` : (consultTab?.name ?? target.name ?? undefined);

	const entryId = generateId();
	const historySessionId = chunk.targetSessionId;

	void window.maestro.history
		.add({
			id: entryId,
			type: 'AUTO',
			timestamp: Date.now(),
			summary,
			// Raw response is the immediate fallback for the detail view; replaced
			// with a condensed summary by enrichConsultDetail once it returns.
			fullResponse: tracked.accumulated || undefined,
			agentSessionId: chunk.targetAgentSessionId ?? consultTab?.agentSessionId ?? undefined,
			sessionId: historySessionId,
			sessionName,
			projectPath: target.cwd,
			sourceAgentName,
			success: !chunk.error,
		})
		.catch((err) => {
			logger.warn('[useCrossAgentDispatch] Failed to record consult history', undefined, err);
		});

	void enrichConsultDetail({
		spawnBackgroundSynopsis,
		target,
		resumeAgentSessionId: chunk.targetAgentSessionId,
		success: !chunk.error,
		entryId,
		historySessionId,
	});
}

/**
 * Replace a consult history entry's detail body with a condensed summary of the
 * response. Resumes the consulted agent's provider session (SSH/token-mode
 * honored by `spawnBackgroundSynopsis` itself) and asks it to summarize its own
 * answer, then patches `fullResponse`. Fully best-effort: on any miss (no
 * summarizer wired, a failed consult, no resumable session, synopsis failure, or
 * NOTHING_TO_REPORT) the entry keeps the raw-response fallback already stored.
 */
async function enrichConsultDetail(opts: {
	spawnBackgroundSynopsis?: SpawnBackgroundSynopsisFn;
	target: Session;
	resumeAgentSessionId?: string;
	success: boolean;
	entryId: string;
	historySessionId: string;
}): Promise<void> {
	const {
		spawnBackgroundSynopsis,
		target,
		resumeAgentSessionId,
		success,
		entryId,
		historySessionId,
	} = opts;
	// A failed consult never captures a resumable session id, and without a
	// summarizer or that id there is nothing to condense - keep the raw fallback.
	if (!spawnBackgroundSynopsis || !success || !resumeAgentSessionId) return;
	try {
		const result = await spawnBackgroundSynopsis(
			historySessionId,
			target.cwd,
			resumeAgentSessionId,
			CONSULT_SUMMARY_PROMPT,
			target.toolType,
			{
				customArgs: target.customArgs,
				customEnvVars: target.customEnvVars,
				customModel: target.customModel,
				customContextWindow: target.customContextWindow,
				enableMaestroP: target.enableMaestroP,
				maestroPMode: target.maestroPMode,
				maestroPPath: target.maestroPPath,
				sessionSshRemoteConfig: target.sessionSshRemoteConfig,
			}
		);
		if (!result.success || !result.response) return;
		const parsed = parseSynopsis(result.response);
		if (parsed.nothingToReport) return;
		const detail = parsed.fullSynopsis?.trim() || parsed.shortSummary?.trim();
		if (!detail) return;
		await window.maestro.history.update(entryId, { fullResponse: detail }, historySessionId);
	} catch (err) {
		logger.warn('[useCrossAgentDispatch] Consult detail summary failed', undefined, err);
	}
}

export interface UseCrossAgentDispatchResult {
	sendCrossAgentRequest: (opts: SendCrossAgentRequestOptions) => void;
}

export function useCrossAgentDispatch(
	spawnBackgroundSynopsis?: SpawnBackgroundSynopsisFn
): UseCrossAgentDispatchResult {
	// Held on a ref so `applyChunk` (a stable, deps-[] callback) always reads the
	// latest summarizer without being torn down and re-subscribed each render.
	const spawnSynopsisRef = useRef(spawnBackgroundSynopsis);
	spawnSynopsisRef.current = spawnBackgroundSynopsis;
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
			// caller so its History shows who consulted it (and about what).
			recordConsultHistory(tracked, chunk, spawnSynopsisRef.current);
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
		// Subject for the target's History entry + attribution pill. Derived once,
		// synchronously, from the user's question (mentions stripped).
		const subject = deriveConsultSubject(opts.userPrompt);
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
				// Pre-register so streamed chunks reuse one stable LogEntry id. If a
				// chunk already created a fallback entry (it lacks the source name +
				// subject, which only the send side knows), backfill them.
				const existing = pendingRef.current.get(requestId);
				if (existing) {
					existing.sourceAgentName ??= opts.sourceAgentName;
					existing.subject ??= subject;
				} else {
					pendingRef.current.set(requestId, {
						sourceSessionId: opts.sourceSessionId,
						sourceTabId: opts.sourceTabId,
						logEntryId: generateId(),
						targetSessionId: opts.targetSessionId,
						targetTabId: consult?.targetTabId,
						targetLogEntryId: generateId(),
						sourceAgentName: opts.sourceAgentName,
						subject,
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
