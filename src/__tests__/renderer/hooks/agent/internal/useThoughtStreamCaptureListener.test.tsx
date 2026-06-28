import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useThoughtStreamCaptureListener } from '../../../../../renderer/hooks/agent/internal/useThoughtStreamCaptureListener';
import { useThoughtStreamStore } from '../../../../../renderer/stores/thoughtStreamStore';

// Capture the registered onThinkingChunk handler so tests can drive it directly.
let thinkingHandler: ((sessionId: string, content: string) => void) | undefined;
const mockUnsubscribe = vi.fn();

const SESSION_ID = 'session-abc';

beforeEach(() => {
	vi.clearAllMocks();
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

	// rAF runs the callback synchronously so we can assert without waiting a frame.
	vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
		cb(0);
		return 1;
	});
	vi.stubGlobal('cancelAnimationFrame', vi.fn());

	useThoughtStreamStore.setState({
		panelSessionId: null,
		minimized: false,
		buffers: {},
		capturing: {},
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('useThoughtStreamCaptureListener', () => {
	it('captures Auto Run thinking chunks despite the `-batch-` streaming id', () => {
		// Regression: Auto Run spawns its agent as `{sessionId}-batch-{timestamp}`,
		// which never matched REGEX_AI_TAB, so every chunk was dropped.
		renderHook(() => useThoughtStreamCaptureListener());
		// Capture the base session, as the Auto Run card's "View Thoughts" does.
		act(() => useThoughtStreamStore.getState().openPanel(SESSION_ID));

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-batch-1699999999999`, 'auto-run reasoning ');
		});

		const entries = useThoughtStreamStore.getState().buffers[SESSION_ID]?.entries ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe('auto-run reasoning ');
	});

	it('captures interactive `-ai-` tab thinking chunks too', () => {
		renderHook(() => useThoughtStreamCaptureListener());
		act(() => useThoughtStreamStore.getState().openPanel(SESSION_ID));

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-ai-tab1`, 'interactive reasoning');
		});

		const entries = useThoughtStreamStore.getState().buffers[SESSION_ID]?.entries ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe('interactive reasoning');
		expect(entries[0].tabId).toBe('tab1');
	});

	it('drops chunks for a session that is not capturing', () => {
		renderHook(() => useThoughtStreamCaptureListener());
		// No openPanel - nothing is capturing.

		act(() => {
			thinkingHandler?.(`${SESSION_ID}-batch-1699999999999`, 'ignored');
		});

		expect(useThoughtStreamStore.getState().buffers[SESSION_ID]).toBeUndefined();
	});

	it('does not cross-contaminate a different session', () => {
		renderHook(() => useThoughtStreamCaptureListener());
		act(() => useThoughtStreamStore.getState().openPanel(SESSION_ID));

		act(() => {
			// Chunk for a DIFFERENT base session - must not land in SESSION_ID's buffer.
			thinkingHandler?.('other-session-batch-1700000000000', 'not mine');
		});

		expect(useThoughtStreamStore.getState().buffers[SESSION_ID]?.entries ?? []).toHaveLength(0);
		expect(useThoughtStreamStore.getState().buffers['other-session']).toBeUndefined();
	});
});
