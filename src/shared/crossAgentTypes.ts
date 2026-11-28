/**
 * @file crossAgentTypes.ts
 * @description Types shared by main + renderer for the cross-agent `@mention`
 * dispatch pipeline (Phase 03).
 *
 * Lives in `src/shared` with NO renderer imports so both the main process
 * (router / IPC handler) and the renderer (dispatch hook) can consume it.
 *
 * Note on `transcript`: the renderer's `LogEntry` is a renderer-only type
 * (`src/renderer/types/index.ts`). Importing it here would drag DOM-only
 * renderer code into the main/cli tsconfigs - exactly the boundary Phase 02's
 * `crossAgentContext.ts` was careful to preserve. So the transcript is typed as
 * {@link CrossAgentTranscriptEntry}, a structural subset of `LogEntry`. A
 * `LogEntry[]` is assignable to `CrossAgentTranscriptEntry[]`, so the renderer
 * can still pass its logs straight through.
 */

import type { ContextWindowStrategy } from './crossAgentContext';
import type { ToolType } from './types';

/**
 * Display color for cross-agent (AGENT) history entries and graph segments.
 *
 * A fixed hue rather than a theme token, matching the `CUE_COLOR` precedent:
 * the theme-derived slots are already spoken for (accent = USER, warning =
 * AUTO, success/error = the run indicator), so a token would collide in some
 * palette. Magenta sits far from CUE's cyan and AUTO's orange everywhere.
 * Lives here (not in a renderer module) so the shared widget library and the
 * History surfaces can both reach it.
 */
export const AGENT_COLOR = '#ec4899';

/**
 * Session-id prefix for the ephemeral processes cross-agent dispatch spawns
 * (`cross-agent-<requestId>`).
 *
 * Lives in shared rather than beside the router because BOTH processes need it:
 * main mints the id, and the renderer's Process Monitor has to recognize one to
 * draw it. Before that, a consult was counted in the monitor's "N active" badge
 * and rendered nowhere - the process really was running, and the one surface a
 * user opens to check said nothing was.
 */
export const CROSS_AGENT_SESSION_PREFIX = 'cross-agent-';

/**
 * Stand-in source tab id for a consult nobody typed (`maestro-cli ask`). The consult
 * tab on the target is keyed by (source agent, source tab), so a constant here means
 * one consult tab per CALLING AGENT rather than one per tab the agent happened to have
 * selected - which is what makes a follow-up `ask` resume the earlier conversation
 * instead of starting over. It matches no real tab on purpose: the answer belongs to
 * the caller's tool result, not to its transcript.
 */
export const CROSS_AGENT_ASK_TAB_ID = 'cli-ask';

/**
 * Stand-in source agent id used when the caller does not name itself. Consults from
 * unattributed callers share one consult tab on each target.
 */
export const CROSS_AGENT_ASK_SESSION_ID = 'cli-ask';

/**
 * Whether a ProcessManager session id belongs to a cross-agent consult.
 */
export function isCrossAgentSessionId(sessionId: string): boolean {
	return sessionId.startsWith(CROSS_AGENT_SESSION_PREFIX);
}

/**
 * The `requestId` inside a `cross-agent-<requestId>` process session id, or null
 * when the id is not a consult. That id is the join key back to the renderer's
 * in-flight registry, which is where the source/target agent NAMES live - the
 * process id itself carries only a uuid.
 */
export function crossAgentRequestIdFromSessionId(sessionId: string): string | null {
	if (!isCrossAgentSessionId(sessionId)) return null;
	return sessionId.slice(CROSS_AGENT_SESSION_PREFIX.length) || null;
}

/**
 * The minimal transcript-entry shape the cross-agent pipeline forwards.
 * A structural subset of the renderer `LogEntry` (see file header).
 */
export interface CrossAgentTranscriptEntry {
	/** 'user' | 'ai' | 'system' | 'tool' | 'thinking' | ... (LogEntry.source). */
	source: string;
	/** Visible text for the entry, if any. */
	text?: string;
	/** Original entry timestamp (epoch ms), if available. */
	timestamp?: number;
}

/**
 * What a consult carries for an asker the answering machine does not hold: a local agent
 * consulting a hosted agent, asked of its Federation host. The host has no tab of the asker,
 * so the asker sends its own windowed context and name; a hand-off sends the answer to act on.
 */
export interface RemoteAskerContext {
	/** The asker's windowed transcript. Wins over reading the asker's tab. */
	transcript?: CrossAgentTranscriptEntry[];
	/** The asker's display name: names the consult tab and the History entry. */
	fromAgentName?: string;
	/** A HAND-OFF: the asker's final answer, which the target acts on (`ConsultAskInput`). */
	handoffAnswer?: string;
	/**
	 * Who is asking, as (asking machine, asking agent, asking tab): `buildRemoteAskerKey()`. The
	 * host keeps one consult tab per key, so a follow-up from the same asker continues its own
	 * thread, as a local asker's does. Absent (an older client): every such asker shares one tab.
	 */
	askerKey?: string;
}

/** The longest asker key a consult accepts off the wire (`buildRemoteAskerKey()` stays under it). */
export const MAX_WIRE_ASKER_KEY = 256;
/** The longest ENCODED part of an asker key, so the three always fit in {@link MAX_WIRE_ASKER_KEY}. */
const MAX_ASKER_KEY_PART = 80;
/**
 * The source-agent id a remote asker's consult tab is keyed on: this prefix, then its key. No
 * agent id on this machine starts with it, so a remote asker can only ever find a consult tab
 * made for a remote asker, never a local agent's tab or a local asker's consult tab.
 */
export const REMOTE_ASKER_SESSION_PREFIX = 'remote-asker:';
/** Printable ASCII with no space or `:` beyond the separators: what `encodeURIComponent` emits. */
const ASKER_KEY_PATTERN =
	/^[A-Za-z0-9\-_.!~*'()%]+\/[A-Za-z0-9\-_.!~*'()%]+\/[A-Za-z0-9\-_.!~*'()%]+$/;

/**
 * The asker key a consult of an agent on another machine carries: the asking machine (its
 * hostname), the asking agent, and the asking tab. Each part is URI-encoded and bounded after
 * encoding, so the key is plain ASCII that `parseWireAskerKey()` accepts.
 */
export function buildRemoteAskerKey(parts: {
	machine: string;
	agentId: string;
	tabId: string;
}): string {
	// Bounded after encoding, one whole character at a time: a non-ASCII name encodes to several
	// bytes per character, and a key past the wire bound would be dropped for the shared thread.
	const part = (value: string): string => {
		let encoded = '';
		for (const char of value.trim()) {
			let piece: string;
			try {
				piece = encodeURIComponent(char);
			} catch {
				continue; // A lone surrogate has no encoding; it names nothing.
			}
			if (encoded.length + piece.length > MAX_ASKER_KEY_PART) break;
			encoded += piece;
		}
		return encoded || '-';
	};
	return `${part(parts.machine)}/${part(parts.agentId)}/${part(parts.tabId)}`;
}

/**
 * Read an asker key off the wire: the shape `buildRemoteAskerKey()` makes, bounded. Undefined for
 * anything else, so the consult falls back to the shared remote-asker tab instead of failing.
 */
export function parseWireAskerKey(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length > MAX_WIRE_ASKER_KEY) return undefined;
	return ASKER_KEY_PATTERN.test(value) ? value : undefined;
}

/**
 * The consult-tab key for an asker on another machine. With a valid key it is that asker's own
 * (`REMOTE_ASKER_SESSION_PREFIX` + key, the constant ask tab); without one it is the shared
 * stand-in every unattributed caller uses.
 */
export function remoteAskerConsultKey(askerKey: string | undefined): {
	sourceSessionId: string;
	sourceTabId: string;
} {
	return {
		sourceSessionId: askerKey
			? `${REMOTE_ASKER_SESSION_PREFIX}${askerKey}`
			: CROSS_AGENT_ASK_SESSION_ID,
		sourceTabId: CROSS_AGENT_ASK_TAB_ID,
	};
}

/** The most transcript entries a consult accepts off the wire. A windowed context is far smaller. */
export const MAX_WIRE_TRANSCRIPT_ENTRIES = 200;
/** The longest text one wire transcript entry keeps. An entry a real asker sends is far shorter. */
export const MAX_WIRE_TRANSCRIPT_TEXT = 100_000;
/** The longest `source` a wire transcript entry may name (`user`, `ai`, `system`, ...). */
export const MAX_WIRE_TRANSCRIPT_SOURCE = 32;
/** The longest asker name a consult accepts off the wire: it names a tab and a History entry. */
export const MAX_WIRE_AGENT_NAME = 120;
/** The longest hand-off answer a consult accepts off the wire. */
export const MAX_WIRE_HANDOFF_ANSWER = 400_000;

/**
 * Read a consult's transcript off the wire (`consults.ask` from an asker on another machine).
 * Keeps only well-formed entries, each bounded: this text comes from another machine and goes
 * into a prompt. Undefined when the field is absent or holds none, so the caller falls back to
 * the context it reads itself.
 */
export function parseWireTranscript(value: unknown): CrossAgentTranscriptEntry[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const entries: CrossAgentTranscriptEntry[] = [];
	for (const raw of value.slice(-MAX_WIRE_TRANSCRIPT_ENTRIES)) {
		if (!raw || typeof raw !== 'object') continue;
		const entry = raw as Record<string, unknown>;
		if (typeof entry.source !== 'string' || entry.source.length > MAX_WIRE_TRANSCRIPT_SOURCE) {
			continue;
		}
		entries.push({
			source: entry.source,
			...(typeof entry.text === 'string'
				? { text: entry.text.slice(0, MAX_WIRE_TRANSCRIPT_TEXT) }
				: {}),
			...(typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)
				? { timestamp: entry.timestamp }
				: {}),
		});
	}
	return entries.length > 0 ? entries : undefined;
}

/** Read the asker's display name off the wire: trimmed and bounded, or undefined when empty. */
export function parseWireAgentName(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const name = value.trim().slice(0, MAX_WIRE_AGENT_NAME).trim();
	return name || undefined;
}

/** Read a hand-off answer off the wire, bounded. Undefined when the field is not a string. */
export function parseWireHandoffAnswer(value: unknown): string | undefined {
	return typeof value === 'string' ? value.slice(0, MAX_WIRE_HANDOFF_ANSWER) : undefined;
}

/**
 * A single cross-agent dispatch: the user pinged `@target` from a source
 * agent's chat. Carries the windowed source transcript plus the user's prompt
 * so the target agent can answer with context.
 */
export interface CrossAgentRequest {
	/** Correlates the dispatch with its streamed response chunks. */
	requestId: string;
	/** The agent (session) the user typed the mention in. */
	sourceSessionId: string;
	/**
	 * Display name of the source (calling) agent. Stamped onto the consult tab and
	 * the history entry the target keeps, so the target "remembers who consulted
	 * it". Optional so older payloads / tests stay valid.
	 */
	sourceAgentName?: string;
	/** The AI tab within the source agent that owns the conversation. */
	sourceTabId: string;
	/** The agent (session) being consulted. */
	targetSessionId: string;
	/**
	 * The consult tab on the TARGET agent that this request writes into. The
	 * renderer finds-or-creates one tab per (sourceSessionId, sourceTabId,
	 * targetSessionId) triple and passes its id so the answer is persisted there
	 * (and the jump arrow can deep-link to it). Absent on the very first dispatch
	 * before the tab exists is not possible - the renderer always creates it first.
	 */
	targetTabId?: string;
	/**
	 * The target's captured provider session id to RESUME, when this (source tab ->
	 * target) pairing has been consulted before. Null/undefined on the first
	 * mention (fresh session); on later mentions in the SAME source tab it carries
	 * the id captured from the first consult, so the target keeps continuity.
	 */
	resumeAgentSessionId?: string;
	/** The user's message (still contains the `@target` token verbatim). */
	userPrompt: string;
	/** The (already windowed by Phase 02) source transcript to forward. */
	transcript: CrossAgentTranscriptEntry[];
	/** How the transcript was windowed (for logging / provenance). */
	strategy: ContextWindowStrategy;
	/**
	 * The source agent's working directory. The consulted agent runs in its OWN
	 * cwd, so this is the only pointer it gets to the user's project; the router
	 * tells the agent it may READ files here to inform its answer. Optional so
	 * older payloads (and tests) stay valid.
	 */
	sourceCwd?: string;
	/**
	 * Set when this is a HAND-OFF rather than a consult: the source agent did the
	 * work the user asked for and this is its final answer, forwarded because
	 * the message said to pass the result on ("then send what you find to @X").
	 * The router tells the target it is receiving a result to act on, not a
	 * question to answer. Absent for a consult.
	 */
	handoffAnswer?: string;
	/** When the request was created (epoch ms). */
	createdAt: number;
}

/**
 * The renderer -> main payload for `window.maestro.crossAgent.send`. The main
 * process stamps `requestId` + `createdAt` to form the full
 * {@link CrossAgentRequest}.
 */
export type CrossAgentSendRequest = Omit<CrossAgentRequest, 'requestId' | 'createdAt'> & {
	/** Locator only. Native queue release and owning renderer are verified by the host. */
	managedQueue?: { dispatchId: string; generation: string; handoff?: boolean };
};

/**
 * One streamed piece of a target agent's response, routed back to the source
 * agent's tab. Text arrives as `chunk`; `done` marks the final chunk. On
 * failure a single final chunk carries `error` with `done: true`.
 */
export interface CrossAgentResponseChunk {
	/** Correlates back to the originating {@link CrossAgentRequest}. */
	requestId: string;
	/** The source agent (session) the response is being routed into. */
	sourceSessionId: string;
	/** The source AI tab that owns the conversation. */
	sourceTabId: string;
	/** The consulted agent (session) that produced this response. */
	targetSessionId: string;
	/**
	 * The consult tab on the target agent this response is persisted into. Echoed
	 * back from the request so the renderer writes into the same tab it created and
	 * the jump arrow can deep-link to it.
	 */
	targetTabId?: string;
	/** Display name of the consulted agent (for provenance rendering). */
	targetAgentName: string;
	/** Tool type of the consulted agent (for provenance rendering). */
	targetToolType: ToolType;
	/**
	 * The target's own provider session id, captured from its output stream. Sent
	 * on the terminal chunk so the renderer can store it on the consult tab and
	 * RESUME it on the next mention (continuity). Undefined for agents that don't
	 * report one.
	 */
	targetAgentSessionId?: string;
	/** The response text for this chunk (may be the whole response). */
	chunk: string;
	/** True once the target agent has finished (or errored). */
	done: boolean;
	/** Present only on the terminal failure chunk. */
	error?: string;
	/**
	 * The consult was terminated deliberately (the user pressed Stop in the source
	 * agent), not because the target failed. Distinct from {@link error} on
	 * purpose: a stopped consult must not render as "the agent could not respond",
	 * which blames the target for something the user did.
	 */
	canceled?: boolean;
}

/** Native aggregate progress for one accepted managed queue intent.
 * Step IDs and recipients are transport locators; only live host releases authorize them. */
export interface ManagedQueueRoutingProgress {
	failed: boolean;
	continuationStepId?: string;
	handoff?: { generation: string; targetSessionIds: string[] };
}
