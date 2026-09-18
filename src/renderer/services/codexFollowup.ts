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
