/**
 * codexFollowup - carry a clicked `:codex-followup` chip back to the composer.
 *
 * A Codex agent ends a turn by OFFERING its next moves as directives embedded
 * in its own markdown (`src/shared/codexDirectives.ts` parses them,
 * `remarkCodexDirectives` turns them into elements). Clicking one has to reach
 * the thing that sends a prompt, which lives at the very top of the tree in
 * `App.tsx`.
 *
 * This is an EVENT rather than a prop because of where the chip is drawn.
 * `LogItem.tsx` renders `<MarkdownRenderer>` at six separate call sites, and a
 * chip can appear under any of the ones showing an assistant body. Threading an
 * `onFollowup` callback from `App.tsx` down through `MainPanel`,
 * `TerminalOutput`, `LogItem`, `MarkdownRenderer`, `Markdown` and the component
 * map to reach all six would add a prop to every layer in between purely as a
 * conduit - and the next surface that renders assistant markdown would have to
 * be threaded too, or its chips would silently do nothing. The codebase already
 * solved this shape with `requestHeadingPalette` and
 * `requestOpenStagedImagesOrganizer`: one app-level CustomEvent, one listener
 * near the top of the tree.
 *
 * The request names its session and tab. The listener verifies both against
 * what is actually on screen before it sends anything: a transcript stays
 * mounted and scrollable while the user switches tabs, so the conversation a
 * chip was drawn in is not necessarily the conversation a click would land in,
 * and a prompt sent into the wrong tab is not recoverable by the user.
 */

import type { LogEntry } from '../types';

/** Event name the app-level listener in `App.tsx` answers. */
export const CODEX_FOLLOWUP_EVENT = 'maestro:codexFollowup';

export interface CodexFollowupRequest {
	/** The agent-authored prompt to send, already unescaped by the parser. */
	prompt: string;
	/** Agent the chip was drawn for. */
	sessionId: string;
	/** AI tab the chip was drawn in. */
	tabId: string;
	/**
	 * `'send'` dispatches the prompt as a turn; `'prefill'` drops it in the
	 * composer and leaves the caret there. The chip offers both (plain click
	 * vs Alt-click) because the prompt is agent-authored - editing it before
	 * sending has to be one gesture away, not a copy-paste.
	 */
	mode: 'send' | 'prefill';
}

/**
 * Ask the app to act on a clicked follow-up chip.
 *
 * Fire-and-forget: a no-op when nothing is listening, which is the right
 * behavior for a chip in a transcript the user may have navigated away from.
 */
export function requestCodexFollowup(request: CodexFollowupRequest): void {
	window.dispatchEvent(
		new CustomEvent<CodexFollowupRequest>(CODEX_FOLLOWUP_EVENT, { detail: { ...request } })
	);
}

/** What the app should do with one clicked chip. */
export type CodexFollowupResolution =
	| { action: 'ignore' }
	| { action: 'send'; prompt: string; sessionId: string; tabId: string }
	| { action: 'prefill'; prompt: string; tabId: string | null; movedAway: boolean };

export interface CodexFollowupTargetState {
	/** Agent this client is looking at right now, or null. */
	activeSessionId: string | null;
	/** AI tab the active agent is showing right now, or null. */
	activeTabId: string | null;
}

/**
 * Decide what a clicked chip does, given where the user actually is.
 *
 * Pure and separate from the listener because this is the whole consequential
 * part - the listener is an event binding, this is the rule that keeps an
 * AGENT-AUTHORED prompt out of a conversation that never offered it. A chip is
 * only ever drawn in the tab on screen, so a request naming anything else means
 * the store moved between the click and the handler (the user switched agents or
 * tabs while a click was in flight, or a background transcript stayed mounted).
 * Sending there is not something the user can take back, so it degrades to a
 * prefill in the composer that IS on screen, with `movedAway` set so the caller
 * can say why. Pressing Enter stays their decision.
 *
 * `'prefill'` never reports `movedAway`: the user asked for the composer, so
 * landing in it is the requested outcome rather than a downgrade worth a notice.
 * Its `tabId` is the tab on SCREEN rather than the one the chip named, because
 * that is the only composer being drawn.
 */
export function resolveCodexFollowup(
	request: CodexFollowupRequest | undefined,
	state: CodexFollowupTargetState
): CodexFollowupResolution {
	const prompt = request?.prompt?.trim();
	// Nothing to act on. A chip with an empty prompt renders as plain text, so
	// this is a malformed or synthetic request rather than a click.
	if (!request || !prompt) return { action: 'ignore' };

	const onScreen =
		!!state.activeSessionId &&
		state.activeSessionId === request.sessionId &&
		state.activeTabId === request.tabId;

	if (request.mode === 'send' && onScreen) {
		return { action: 'send', prompt, sessionId: request.sessionId, tabId: request.tabId };
	}

	return {
		action: 'prefill',
		prompt,
		tabId: state.activeTabId,
		movedAway: request.mode === 'send',
	};
}

/**
 * Whether a directive in a transcript entry of this source is an OFFER the agent
 * made, rather than text that merely contains the syntax.
 *
 * `stdout` and `ai` are the agent's own output - the same pair
 * `useAgentExitListener` treats as the assistant speaking. Everything else in a
 * transcript is somebody or something else: a `user` entry is what the person
 * typed (and a user quoting the format must not be handed a live button that
 * pushes their repository), an `aiCommand` body is a generated shell command, and
 * an `error` body, a `thinking` block or `tool` output describes the format
 * rather than offering an action.
 *
 * Separate from the provider check (`session.toolType === 'codex'`), which asks
 * whether this AGENT emits directives at all. Both have to hold: the provider
 * decides whether the syntax is Codex's convention here, this decides which of
 * an entry's bodies it is live in.
 */
export function codexDirectivesLiveForSource(source: LogEntry['source']): boolean {
	return source === 'stdout' || source === 'ai';
}
