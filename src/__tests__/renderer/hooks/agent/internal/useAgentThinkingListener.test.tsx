import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentThinkingListener } from '../../../../../renderer/hooks/agent/internal/useAgentThinkingListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';
import type { LogEntry } from '../../../../../renderer/types';

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

		// Before flush - no log yet.
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
		// First mount with no events scheduled - nothing to cancel.
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

	// Regression: the fast (rAF) writer must not append a thinking log below the
	// turn's answer, which the slow (200ms batched) writer flushed in between.
	describe('stale straggler after the turn answer landed', () => {
		function makeLog(source: LogEntry['source'], text: string, id: string): LogEntry {
			return { id, timestamp: 1, source, text };
		}

		it('drops the chunk when the last log is the turn stdout answer', () => {
			const logs = [makeLog('user', 'prompt', 'l1'), makeLog('stdout', 'final answer', 'l2')];
			const tab = createMockAITab({ id: 'tab-1', showThinking: 'on', logs });
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentThinkingListener());
			handler!('sess-1-ai-tab-1', 'final ans');
			flushRaf();

			const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(tabAfter.logs).toHaveLength(2);
			expect(tabAfter.logs.some((l) => l.source === 'thinking')).toBe(false);
			expect(tabAfter.logs).toEqual(logs);
		});

		it('still appends when the last log is the user prompt (normal turn start)', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				showThinking: 'on',
				logs: [makeLog('user', 'prompt', 'l1')],
			});
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentThinkingListener());
			handler!('sess-1-ai-tab-1', 'thinking...');
			flushRaf();

			const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(tabAfter.logs).toHaveLength(2);
			expect(tabAfter.logs[1].source).toBe('thinking');
			expect(tabAfter.logs[1].text).toBe('thinking...');
		});

		it('still coalesces into an open thinking log', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				showThinking: 'on',
				logs: [makeLog('user', 'prompt', 'l1'), makeLog('thinking', 'hello ', 'l2')],
			});
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentThinkingListener());
			handler!('sess-1-ai-tab-1', 'world');
			flushRaf();

			const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(tabAfter.logs).toHaveLength(2);
			expect(tabAfter.logs[1].source).toBe('thinking');
			expect(tabAfter.logs[1].text).toBe('hello world');
		});

		it('drops the stale chunk in sticky mode but keeps existing thinking logs', () => {
			const logs = [
				makeLog('thinking', 'earlier reasoning', 'l1'),
				makeLog('stdout', 'final answer', 'l2'),
			];
			const tab = createMockAITab({ id: 'tab-1', showThinking: 'sticky', logs });
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentThinkingListener());
			handler!('sess-1-ai-tab-1', 'final ans');
			flushRaf();

			const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(tabAfter.logs).toEqual(logs);
			expect(tabAfter.logs.filter((l) => l.source === 'thinking')).toHaveLength(1);
		});

		it('still appends when the last log is tool activity (thinking resumes mid-turn)', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				showThinking: 'on',
				logs: [makeLog('user', 'prompt', 'l1'), makeLog('tool', 'Read(file.ts)', 'l2')],
			});
			const session = createMockSession({ id: 'sess-1', aiTabs: [tab] });
			useSessionStore.setState({ sessions: [session] } as any);

			renderHook(() => useAgentThinkingListener());
			handler!('sess-1-ai-tab-1', 'back to thinking');
			flushRaf();

			const tabAfter = useSessionStore.getState().sessions[0].aiTabs[0];
			expect(tabAfter.logs).toHaveLength(3);
			expect(tabAfter.logs[2].source).toBe('thinking');
			expect(tabAfter.logs[2].text).toBe('back to thinking');
		});
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
