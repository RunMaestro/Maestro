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
	resolveCodexFollowup,
	codexDirectivesLiveForSource,
	CODEX_FOLLOWUP_EVENT,
	type CodexFollowupRequest,
} from '../../../renderer/services/codexFollowup';
import type { LogEntry } from '../../../renderer/types';

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

/**
 * The other half of the contract, and the consequential one: given where the
 * user actually is, does a click send, prefill, or do nothing?
 *
 * The prompt is AGENT-authored, so landing one in a conversation that never
 * offered it is not something the user can undo. Every case below is a way the
 * store can have moved between the click and the handler.
 */
describe('resolveCodexFollowup', () => {
	const ON_SCREEN = { activeSessionId: 'agent-1', activeTabId: 'tab-1' };

	it('sends when the chip names the conversation on screen', () => {
		expect(resolveCodexFollowup(REQUEST, ON_SCREEN)).toEqual({
			action: 'send',
			prompt: REQUEST.prompt,
			sessionId: 'agent-1',
			tabId: 'tab-1',
		});
	});

	it('will not send into another agent, and says the conversation moved', () => {
		// THE assertion. A transcript stays mounted while the user switches agents,
		// so a click can arrive after the store has moved on.
		expect(
			resolveCodexFollowup(REQUEST, { activeSessionId: 'agent-2', activeTabId: 'tab-1' })
		).toEqual({ action: 'prefill', prompt: REQUEST.prompt, tabId: 'tab-1', movedAway: true });
	});

	it('will not send into another tab of the same agent', () => {
		expect(
			resolveCodexFollowup(REQUEST, { activeSessionId: 'agent-1', activeTabId: 'tab-9' })
		).toEqual({ action: 'prefill', prompt: REQUEST.prompt, tabId: 'tab-9', movedAway: true });
	});

	it('will not send with nothing on screen at all', () => {
		expect(resolveCodexFollowup(REQUEST, { activeSessionId: null, activeTabId: null })).toEqual({
			action: 'prefill',
			prompt: REQUEST.prompt,
			tabId: null,
			movedAway: true,
		});
	});

	it('prefills into the tab on screen without calling it a downgrade', () => {
		// An Alt-click asked for the composer, so landing there is the requested
		// outcome - flashing "conversation moved" at it would be noise.
		const resolution = resolveCodexFollowup({ ...REQUEST, mode: 'prefill' }, ON_SCREEN);
		expect(resolution).toEqual({
			action: 'prefill',
			prompt: REQUEST.prompt,
			tabId: 'tab-1',
			movedAway: false,
		});
	});

	it('prefills the tab on screen even when the chip named another one', () => {
		// The named tab is not being drawn, so its composer is not the one the
		// caret would land in.
		const resolution = resolveCodexFollowup(
			{ ...REQUEST, mode: 'prefill' },
			{
				activeSessionId: 'agent-2',
				activeTabId: 'tab-7',
			}
		);
		expect(resolution).toEqual({
			action: 'prefill',
			prompt: REQUEST.prompt,
			tabId: 'tab-7',
			movedAway: false,
		});
	});

	it('trims the prompt it hands on, and ignores one that is only whitespace', () => {
		expect(resolveCodexFollowup({ ...REQUEST, prompt: '  Do it  ' }, ON_SCREEN)).toMatchObject({
			action: 'send',
			prompt: 'Do it',
		});
		// A prompt-less chip renders as plain text, so a blank request is
		// malformed rather than a click - acting on it would send an empty turn.
		expect(resolveCodexFollowup({ ...REQUEST, prompt: '   ' }, ON_SCREEN)).toEqual({
			action: 'ignore',
		});
		expect(resolveCodexFollowup({ ...REQUEST, prompt: '' }, ON_SCREEN)).toEqual({
			action: 'ignore',
		});
		expect(resolveCodexFollowup(undefined, ON_SCREEN)).toEqual({ action: 'ignore' });
	});
});

/**
 * Which transcript bodies a directive is live in.
 *
 * The failure this prevents is the worst one in the feature: a USER pasting or
 * quoting `::git-push{...}` - discussing the syntax, or pasting an agent's reply
 * back - being handed a live button that acts on their repository. The provider
 * check says the agent emits directives; this says whose words these are.
 */
describe('codexDirectivesLiveForSource', () => {
	it('is live for the agent own output and nothing else', () => {
		expect(codexDirectivesLiveForSource('stdout')).toBe(true);
		expect(codexDirectivesLiveForSource('ai')).toBe(true);

		// Every other source in the union, named one at a time so adding a source
		// to `LogEntry` does not silently opt it in.
		const inert: LogEntry['source'][] = ['user', 'system', 'stderr', 'error', 'thinking', 'tool'];
		for (const source of inert) {
			expect(codexDirectivesLiveForSource(source)).toBe(false);
		}
	});
});
