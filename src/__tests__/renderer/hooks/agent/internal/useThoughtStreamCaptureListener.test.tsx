import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useThoughtStreamCaptureListener,
	THOUGHT_FLUSH_MS,
} from '../../../../../renderer/hooks/agent/internal/useThoughtStreamCaptureListener';
import { useThoughtStreamStore } from '../../../../../renderer/stores/thoughtStreamStore';

// Capture the registered onThinkingChunk handler so tests can drive it directly.
let thinkingHandler: ((sessionId: string, content: string) => void) | undefined;
const mockUnsubscribe = vi.fn();

const SESSION_ID = 'session-abc';

/** Run the coalescing timer so buffered chunks land in the store. */
function flush() {
	act(() => {
		vi.advanceTimersByTime(THOUGHT_FLUSH_MS);
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	thinkingHandler = undefined;

	(window as any).maestro = {
		...((window as any).maestro || {}),
		process: {
			...((window as any).maestro?.process || {}),
			onThinkingChunk: vi.fn((h: (sessionId: string, content: string) => void) => {
				thinkingHandler = h;
				return mockUnsubscribe;
			}),
		},
	};

	useThoughtStreamStore.setState({
		panelSessionId: null,
		buffers: {},
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('useThoughtStreamCaptureListener', () => {
	it('captures Auto Run thinking chunks despite the `-batch-` streaming id', () => {
		// Regression: Auto Run spawns its agent as `{sessionId}-batch-{timestamp}`,
		// which never matched REGEX_AI_TAB, so every chunk was dropped.
		renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-batch-1699999999999`, 'auto-run reasoning ');
		});
		flush();

		const entries = useThoughtStreamStore.getState().buffers[SESSION_ID]?.entries ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe('auto-run reasoning ');
	});

	// This used to assert the opposite - that interactive chunks were captured
	// "too". That was the fix for an under-capture (matching only AI tabs dropped
	// every Auto Run chunk) overshooting into an over-capture, and it is the bug
	// the user reported: both consumers of this buffer are Auto Run surfaces
	// (AutoRun.tsx's Thoughts button, RightPanel's brain button on the Auto Run
	// card), so ordinary conversation appearing there is never right.
	it('does not capture interactive `-ai-` tab thinking chunks', () => {
		renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-ai-tab1`, 'interactive reasoning');
		});
		flush();

		expect(useThoughtStreamStore.getState().buffers[SESSION_ID]).toBeUndefined();
	});

	// The reason capture is ambient: by the time a user goes looking at a wedged
	// run, the reasoning that explains it has already streamed past.
	it('buffers with no panel open so a later open has history to show', () => {
		renderHook(() => useThoughtStreamCaptureListener());
		expect(useThoughtStreamStore.getState().panelSessionId).toBeNull();

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-batch-1699999999999`, 'reasoning nobody watched');
		});
		flush();

		const entries = useThoughtStreamStore.getState().buffers[SESSION_ID]?.entries ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe('reasoning nobody watched');
	});

	it('keeps parallel sessions in their own buffers', () => {
		renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-batch-1700000000000`, 'mine');
			thinkingHandler?.('other-session-batch-1700000000000', 'not mine');
		});
		flush();

		const state = useThoughtStreamStore.getState();
		expect(state.buffers[SESSION_ID].entries.map((e) => e.text)).toEqual(['mine']);
		expect(state.buffers['other-session'].entries.map((e) => e.text)).toEqual(['not mine']);
	});

	it('coalesces chunks inside one flush window into a single entry', () => {
		renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-batch-1700000000001`, 'one ');
			thinkingHandler?.(`${SESSION_ID}-batch-1700000000001`, 'two ');
			thinkingHandler?.(`${SESSION_ID}-batch-1700000000001`, 'three');
		});
		// Nothing has landed yet - the timer has not fired.
		expect(useThoughtStreamStore.getState().buffers[SESSION_ID]).toBeUndefined();
		flush();

		const entries = useThoughtStreamStore.getState().buffers[SESSION_ID].entries;
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe('one two three');
	});

	it('lands mid-coalesce chunks on unmount instead of dropping them', () => {
		const { unmount } = renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-batch-1700000000001`, 'last words');
		});
		act(() => unmount());

		const entries = useThoughtStreamStore.getState().buffers[SESSION_ID]?.entries ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe('last words');
		expect(mockUnsubscribe).toHaveBeenCalled();
	});

	// The Thought Stream is an Auto Run surface: both entry points (the Auto Run
	// panel's Thoughts button, and the active-run card in the Right Bar) belong to
	// a run. Interactive conversation is not part of that, and it used to leak in
	// because every spawn shape for one agent resolves to the SAME base session id
	// - the key the buffer is stored under - so an Auto Run and an ordinary chat in
	// the same agent shared one buffer.
	it('ignores an interactive AI tab chunk on the same base session', () => {
		renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-ai-tab-7`, 'ordinary conversation ');
		});
		flush();

		expect(useThoughtStreamStore.getState().buffers[SESSION_ID]).toBeUndefined();
	});

	it('ignores a background synopsis chunk', () => {
		// Non-conversational, but not an Auto Run either - a synopsis summarizes a
		// finished turn, and showing it under a run's Thoughts would misattribute it.
		renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-synopsis-1699999999999`, 'summarizing ');
		});
		flush();

		expect(useThoughtStreamStore.getState().buffers[SESSION_ID]).toBeUndefined();
	});

	it('keeps only the Auto Run chunk when both arrive for one agent', () => {
		// The reported bug, end to end: same agent, one run and one chat, and the
		// panel showed both.
		renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-batch-1699999999999`, 'auto-run reasoning ');
			thinkingHandler?.(`${SESSION_ID}-ai-tab-7`, 'ordinary conversation ');
		});
		flush();

		const entries = useThoughtStreamStore.getState().buffers[SESSION_ID]?.entries ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toContain('auto-run reasoning');
		expect(entries.map((e) => e.text).join('')).not.toContain('ordinary conversation');
	});
});
