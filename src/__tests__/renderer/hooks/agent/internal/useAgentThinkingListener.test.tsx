import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentThinkingListener } from '../../../../../renderer/hooks/agent/internal/useAgentThinkingListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';

let handler: ((sessionId: string, content: string) => void) | undefined;
const mockUnsubscribe = vi.fn();

const mockProcess = {
	onThinkingChunk: vi.fn((h: any) => {
		handler = h;
		return mockUnsubscribe;
	}),
};

let originalRaf: typeof requestAnimationFrame;
let originalCancelRaf: typeof cancelAnimationFrame;
// Map id -> callback so cancelAnimationFrame can actually remove the queued
// callback (matches real browser semantics). A vi.fn() stub here would let a
// post-unmount flushRaf() still fire the callback, masking cleanup bugs.
let scheduled: Map<number, () => void> = new Map();
let nextRafId = 0;
const cancelRafSpy = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	cancelRafSpy.mockClear();
	handler = undefined;
	scheduled = new Map();
	nextRafId = 0;
	originalRaf = global.requestAnimationFrame;
	originalCancelRaf = global.cancelAnimationFrame;
	global.requestAnimationFrame = ((cb: FrameRequestCallback) => {
		nextRafId += 1;
		const id = nextRafId;
		scheduled.set(id, () => cb(performance.now()));
		return id;
	}) as any;
	global.cancelAnimationFrame = ((id: number) => {
		cancelRafSpy(id);
		scheduled.delete(id);
	}) as any;

	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
	});
	(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
});

afterEach(() => {
	global.requestAnimationFrame = originalRaf;
	global.cancelAnimationFrame = originalCancelRaf;
});

function flushRaf() {
	const queued = Array.from(scheduled.values());
	scheduled.clear();
	queued.forEach((cb) => cb());
}

describe('useAgentThinkingListener', () => {
	it('subscribes once and unsubscribes on unmount', () => {
		const { unmount } = renderHook(() => useAgentThinkingListener());
		expect(mockProcess.onThinkingChunk).toHaveBeenCalledTimes(1);
		unmount();
		expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
	});

	it('appends a thinking log on first chunk and merges on subsequent chunks (RAF-batched)', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentThinkingListener());
		handler!('sess-1-ai-tab-1', 'hello ');
		handler!('sess-1-ai-tab-1', 'world');

		// Before flush — no log yet.
		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(0);

		flushRaf();

		const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
		expect(tabAfter.logs).toHaveLength(1);
		expect(tabAfter.logs[0].source).toBe('thinking');
		expect(tabAfter.logs[0].text).toBe('hello world');
	});

	it('skips when tab.showThinking is off', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'off' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentThinkingListener());
		handler!('sess-1-ai-tab-1', 'should not render');
		flushRaf();

		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(0);
	});

	it('cancels pending RAF on unmount and post-unmount flushRaf is a no-op', () => {
		// First mount with no events scheduled — nothing to cancel.
		renderHook(() => useAgentThinkingListener()).unmount();
		expect(cancelRafSpy).not.toHaveBeenCalled();

		// Second mount: schedule a RAF, unmount, then assert flushing the RAF
		// queue does NOT invoke the previously scheduled callback (it was
		// cancelled and removed from the queue).
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		const { unmount } = renderHook(() => useAgentThinkingListener());
		handler!('sess-1-ai-tab-1', 'data');
		unmount();
		expect(cancelRafSpy).toHaveBeenCalled();

		flushRaf();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(0);
	});

	it('flushes only the requested tab synchronously and leaves its scheduled RAF harmless', () => {
		const firstTab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const secondTab = createMockAITab({ id: 'tab-2', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [firstTab, secondTab] });
		useSessionStore.setState({ sessions: [session] } as any);

		const { result } = renderHook(() => useAgentThinkingListener());
		handler!('sess-1-ai-tab-1', 'first thinking');
		handler!('sess-1-ai-tab-2', 'second thinking');

		result.current('sess-1-ai-tab-1');
		let tabs = useSessionStore.getState().sessions[0].aiTabs;
		expect(tabs[0].logs.map((log) => log.text)).toEqual(['first thinking']);
		expect(tabs[1].logs).toHaveLength(0);

		flushRaf();
		tabs = useSessionStore.getState().sessions[0].aiTabs;
		expect(tabs[0].logs.map((log) => log.text)).toEqual(['first thinking']);
		expect(tabs[1].logs.map((log) => log.text)).toEqual(['second thinking']);
	});

	it('ignores non-AI session ids', () => {
		const tab = createMockAITab({ id: 'tab-1', showThinking: 'on' });
		const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentThinkingListener());
		handler!('sess-1-terminal', 'data');
		flushRaf();

		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs).toHaveLength(0);
	});
});
