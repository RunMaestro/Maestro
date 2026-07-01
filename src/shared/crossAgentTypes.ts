/**
 * @file crossAgentTypes.ts
 * @description Types shared by main + renderer for the cross-agent `@@mention`
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
 * A single cross-agent dispatch: the user pinged `@@target` from a source
 * agent's chat. Carries the windowed source transcript plus the user's prompt
 * so the target agent can answer with context.
 */
export interface CrossAgentRequest {
	/** Correlates the dispatch with its streamed response chunks. */
	requestId: string;
	/** The agent (session) the user typed the mention in. */
	sourceSessionId: string;
	/** The AI tab within the source agent that owns the conversation. */
	sourceTabId: string;
	/** The agent (session) being consulted. */
	targetSessionId: string;
	/** The user's message (still contains the `@@target` token verbatim). */
	userPrompt: string;
	/** The (already windowed by Phase 02) source transcript to forward. */
	transcript: CrossAgentTranscriptEntry[];
	/** How the transcript was windowed (for logging / provenance). */
	strategy: ContextWindowStrategy;
	/** When the request was created (epoch ms). */
	createdAt: number;
}

/**
 * The renderer -> main payload for `window.maestro.crossAgent.send`. The main
 * process stamps `requestId` + `createdAt` to form the full
 * {@link CrossAgentRequest}.
 */
export type CrossAgentSendRequest = Omit<CrossAgentRequest, 'requestId' | 'createdAt'>;

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
	/** Display name of the consulted agent (for provenance rendering). */
	targetAgentName: string;
	/** Tool type of the consulted agent (for provenance rendering). */
	targetToolType: ToolType;
	/** The response text for this chunk (may be the whole response). */
	chunk: string;
	/** True once the target agent has finished (or errored). */
	done: boolean;
	/** Present only on the terminal failure chunk. */
	error?: string;
}
