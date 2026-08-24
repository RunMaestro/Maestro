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

	it('captures interactive `-ai-` tab thinking chunks too', () => {
		renderHook(() => useThoughtStreamCaptureListener());

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-ai-tab1`, 'interactive reasoning');
		});
		flush();

		const entries = useThoughtStreamStore.getState().buffers[SESSION_ID]?.entries ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe('interactive reasoning');
		expect(entries[0].tabId).toBe('tab1');
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
			thinkingHandler?.(`${SESSION_ID}-ai-tab1`, 'one ');
			thinkingHandler?.(`${SESSION_ID}-ai-tab1`, 'two ');
			thinkingHandler?.(`${SESSION_ID}-ai-tab1`, 'three');
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
			thinkingHandler?.(`${SESSION_ID}-ai-tab1`, 'last words');
		});
		act(() => unmount());

		const entries = useThoughtStreamStore.getState().buffers[SESSION_ID]?.entries ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe('last words');
		expect(mockUnsubscribe).toHaveBeenCalled();
	});
});
