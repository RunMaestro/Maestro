/**
 * Tests for the transcript's scroll-to-bottom request.
 *
 * The module is deliberately tiny, but it is the contract between two files
 * that never import each other: `runShellCommand` raises the request and the
 * mounted `TerminalOutput` answers it. So the things worth pinning here are
 * the event NAME both sides bind, and the detail shape the receiver matches
 * on - a request that names the wrong tab is how a background command would
 * yank the view off what the user is reading.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	requestTranscriptScrollToBottom,
	TRANSCRIPT_SCROLL_TO_BOTTOM_EVENT,
	type TranscriptScrollToBottomDetail,
} from '../../../renderer/services/transcriptScroll';

let listener: ReturnType<typeof vi.fn<(event: Event) => void>>;

beforeEach(() => {
	listener = vi.fn<(event: Event) => void>();
	window.addEventListener(TRANSCRIPT_SCROLL_TO_BOTTOM_EVENT, listener);
	return () => window.removeEventListener(TRANSCRIPT_SCROLL_TO_BOTTOM_EVENT, listener);
});

describe('requestTranscriptScrollToBottom', () => {
	it('binds the event name the transcript listens for', () => {
		// Hard-coded rather than read from the constant: this string is the
		// contract with TerminalOutput's listener.
		expect(TRANSCRIPT_SCROLL_TO_BOTTOM_EVENT).toBe('maestro:scrollTranscriptToBottom');
	});

	it('raises the event naming both the agent and the tab', () => {
		requestTranscriptScrollToBottom('agent-1', 'tab-1');

		expect(listener).toHaveBeenCalledTimes(1);
		const detail = (listener.mock.calls[0][0] as CustomEvent<TranscriptScrollToBottomDetail>)
			.detail;
		// Both fields matter: the receiver ignores a request that does not name
		// the conversation currently on screen.
		expect(detail).toEqual({ sessionId: 'agent-1', tabId: 'tab-1' });
	});

	it('is fire-and-forget when nothing is listening', () => {
		window.removeEventListener(TRANSCRIPT_SCROLL_TO_BOTTOM_EVENT, listener);

		// No transcript mounted for that tab is the expected case, not an error.
		expect(() => requestTranscriptScrollToBottom('agent-1', 'tab-1')).not.toThrow();
	});
});
