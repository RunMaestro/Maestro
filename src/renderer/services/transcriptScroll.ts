/**
 * transcriptScroll - ask the mounted AI transcript to follow the tail again.
 *
 * The transcript follows new output on its own, but only while auto-scroll is
 * live: scrolling up to read history pauses it, and from then on new entries
 * land offscreen behind the unread badge. That is right for output the AGENT
 * produced on its own schedule, and wrong for output the user just asked for
 * by pressing Enter - a bang command's card starts streaming immediately, and
 * a command whose output you cannot see has not really run.
 *
 * `TerminalOutput` owns the pause state locally (`autoScrollPaused`) and is
 * mounted several levels below the composer that dispatches the command, so
 * the request rides one app-level CustomEvent rather than a callback drilled
 * up through MainPanel and App - the same shape `requestHeadingPalette` and
 * `requestFileTreeRefresh` use.
 *
 * The request names its session and tab: the transcript ignores anything that
 * is not the conversation currently on screen, so a command dispatched into a
 * background tab cannot yank the view off what the user is reading.
 */

/** Event name the mounted `TerminalOutput` listens for. */
export const TRANSCRIPT_SCROLL_TO_BOTTOM_EVENT = 'maestro:scrollTranscriptToBottom';

export interface TranscriptScrollToBottomDetail {
	/** Agent whose transcript should scroll. */
	sessionId: string;
	/** AI tab the new content landed in. */
	tabId: string;
}

/**
 * Ask the transcript showing `tabId` to jump to the bottom and resume
 * following new output.
 *
 * Fire-and-forget: a no-op when that tab is not the one on screen, which is
 * the correct behavior - the point is to reveal output the user is waiting
 * for, not to steal the view from a conversation they switched to.
 */
export function requestTranscriptScrollToBottom(sessionId: string, tabId: string): void {
	window.dispatchEvent(
		new CustomEvent<TranscriptScrollToBottomDetail>(TRANSCRIPT_SCROLL_TO_BOTTOM_EVENT, {
			detail: { sessionId, tabId },
		})
	);
}
