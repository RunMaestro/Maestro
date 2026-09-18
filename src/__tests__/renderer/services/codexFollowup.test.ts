/**
 * Tests for the followup-chip request.
 *
 * The module is four lines, but it is the whole contract between two files that
 * never import each other: the chat component map raises the request and the
 * listener in `App.tsx` answers it. So what is pinned here is the event NAME
 * both sides bind and every field of the detail the receiver decides on - it
 * checks the session and the tab before it sends anything, and it reads the
 * mode to tell a send from a prefill, so a dropped field is a prompt landing
 * somewhere the user did not ask for.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	requestCodexFollowup,
	CODEX_FOLLOWUP_EVENT,
	type CodexFollowupRequest,
} from '../../../renderer/services/codexFollowup';

const REQUEST: CodexFollowupRequest = {
	prompt: 'Design the canonical schema for the events table.',
	sessionId: 'agent-1',
	tabId: 'tab-1',
	mode: 'send',
};

let listener: ReturnType<typeof vi.fn<(event: Event) => void>>;

function detailOf(call: number): CodexFollowupRequest {
	return (listener.mock.calls[call][0] as CustomEvent<CodexFollowupRequest>).detail;
}

beforeEach(() => {
	listener = vi.fn<(event: Event) => void>();
	window.addEventListener(CODEX_FOLLOWUP_EVENT, listener);
	return () => window.removeEventListener(CODEX_FOLLOWUP_EVENT, listener);
});

describe('requestCodexFollowup', () => {
	it('binds the event name the App listener answers', () => {
		// Hard-coded rather than read from the constant: this string is the
		// contract, so a rename has to break a test rather than silently leave
		// every chip inert.
		expect(CODEX_FOLLOWUP_EVENT).toBe('maestro:codexFollowup');
	});

	it('reaches a listener registered on window with the full request', () => {
		requestCodexFollowup(REQUEST);

		expect(listener).toHaveBeenCalledTimes(1);
		// Every field, not a subset: the receiver verifies the session and the
		// tab before it sends, so a missing one would degrade a live send into a
		// prefill (or worse, fail the check and send nowhere).
		expect(detailOf(0)).toEqual(REQUEST);
	});

	it('carries the prefill mode through unchanged', () => {
		requestCodexFollowup({ ...REQUEST, mode: 'prefill' });

		expect(detailOf(0).mode).toBe('prefill');
	});

	it('copies the request rather than sharing the object it was handed', () => {
		const mutable = { ...REQUEST };
		requestCodexFollowup(mutable);
		mutable.prompt = 'rm -rf /';

		// The chip's own render closure owns the object it built. Sharing it would
		// let anything that touched it afterwards change what the listener reads.
		expect(detailOf(0).prompt).toBe(REQUEST.prompt);
	});

	it('is fire-and-forget when nothing is listening', () => {
		window.removeEventListener(CODEX_FOLLOWUP_EVENT, listener);

		// A transcript the user has navigated away from is the expected case, not
		// an error.
		expect(() => requestCodexFollowup(REQUEST)).not.toThrow();
	});
});
