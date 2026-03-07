/**
 * Tests for useQueueHandlers hook
 *
 * Tests:
 *   - handleRemoveQueueItem: removes item from queue, no-op for missing item, only affects target session
 *   - handleSwitchQueueSession: sets active session ID
 *   - handleReorderQueueItems: move item up, move item down, first to last, last to first, only affects target session, empty queue edge case
 *   - Return type completeness
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { Session, QueuedItem } from '../../../renderer/types';

// ============================================================================
// Imports (after mocks — no external mocks needed for this hook)
// ============================================================================

import { useQueueHandlers } from '../../../renderer/hooks/agent/useQueueHandlers';
import { useSessionStore } from '../../../renderer/stores/sessionStore';

// ============================================================================
// Helpers
// ============================================================================

function createQueuedItem(overrides: Partial<QueuedItem> = {}): QueuedItem {
	return {
		id: 'item-1',
		timestamp: Date.now(),
		tabId: 'tab-1',
		type: 'message',
		text: 'Test message',
		...overrides,
	};
}

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'sess-1',
		name: 'Test Session',
		toolType: 'claude-code' as any,
		state: 'idle',
		cwd: '/test/project',
		fullPath: '/test/project',
		projectRoot: '/test/project',
		isGitRepo: false,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 3001,
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		shellCwd: '/test/project',
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [
			{
				id: 'tab-1',
				agentSessionId: null,
				name: null,
				starred: false,
				logs: [],
				inputValue: '',
				stagedImages: [],
				createdAt: Date.now(),
				state: 'idle',
				saveToHistory: false,
				showThinking: false,
			},
		],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai' as const, id: 'tab-1' }],
		unifiedClosedTabHistory: [],
		autoRunFolderPath: '/test/project/Auto Run Docs',
		terminalTabs: [],
		activeTerminalTabId: null,
		...overrides,
	} as Session;
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();

	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
	});
});

afterEach(() => {
	cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('useQueueHandlers', () => {
	// ========================================================================
	// handleRemoveQueueItem
	// ========================================================================
	describe('handleRemoveQueueItem', () => {
		it('removes the specified item from the session execution queue', () => {
			const item = createQueuedItem({ id: 'item-a', tabId: 'tab-1' });
			const session = createSession({ id: 'sess-1', executionQueue: [item] });
			useSessionStore.setState({ sessions: [session] });

			const { result } = renderHook(() => useQueueHandlers());

			act(() => {
				result.current.handleRemoveQueueItem('sess-1', 'item-a');
			});

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.executionQueue).toHaveLength(0);
		});

		it('removes only the matching item when multiple items exist', () => {
			const item1 = createQueuedItem({ id: 'item-a', tabId: 'tab-1', text: 'First' });
			const item2 = createQueuedItem({ id: 'item-b', tabId: 'tab-1', text: 'Second' });
			const item3 = createQueuedItem({ id: 'item-c', tabId: 'tab-1', text: 'Third' });
			const session = createSession({
				id: 'sess-1',
				executionQueue: [item1, item2, item3],
			});
			useSessionStore.setState({ sessions: [session] });

			const { result } = renderHook(() => useQueueHandlers());

			act(() => {
				result.current.handleRemoveQueueItem('sess-1', 'item-b');
			});

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.executionQueue).toHaveLength(2);
			expect(updated.executionQueue[0].id).toBe('item-a');
			expect(updated.executionQueue[1].id).toBe('item-c');
		});

		it('is a no-op when the item ID does not exist in the queue', () => {
			const item = createQueuedItem({ id: 'item-a', tabId: 'tab-1' });
			const session = createSession({ id: 'sess-1', executionQueue: [item] });
			useSessionStore.setState({ sessions: [session] });

			const { result } = renderHook(() => useQueueHandlers());

			act(() => {
				result.current.handleRemoveQueueItem('sess-1', 'nonexistent-item');
			});

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.executionQueue).toHaveLength(1);
			expect(updated.executionQueue[0].id).toBe('item-a');
		});

		it('is a no-op when the session ID does not match any session', () => {
			const item = createQueuedItem({ id: 'item-a', tabId: 'tab-1' });
			const session = createSession({ id: 'sess-1', executionQueue: [item] });
			useSessionStore.setState({ sessions: [session] });

			const { result } = renderHook(() => useQueueHandlers());

			act(() => {
				result.current.handleRemoveQueueItem('nonexistent-session', 'item-a');
			});

			// Original session should be untouched
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.executionQueue).toHaveLength(1);
			expect(updated.executionQueue[0].id).toBe('item-a');
		});

		it('handles an empty queue without throwing', () => {
			const session = createSession({ id: 'sess-1', executionQueue: [] });
			useSessionStore.setState({ sessions: [session] });

			const { result } = renderHook(() => useQueueHandlers());

			expect(() => {
				act(() => {
					result.current.handleRemoveQueueItem('sess-1', 'item-a');
				});
			}).not.toThrow();

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.executionQueue).toHaveLength(0);
		});

		it('only affects the target session when multiple sessions exist', () => {
			const item1 = createQueuedItem({ id: 'item-a', tabId: 'tab-1' });
			const item2 = createQueuedItem({ id: 'item-b', tabId: 'tab-1' });
			const session1 = createSession({ id: 'sess-1', executionQueue: [item1] });
			const session2 = createSession({ id: 'sess-2', executionQueue: [item2] });
			useSessionStore.setState({ sessions: [session1, session2] });

			const { result } = renderHook(() => useQueueHandlers());

			act(() => {
				result.current.handleRemoveQueueItem('sess-1', 'item-a');
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions[0].executionQueue).toHaveLength(0); // target — item removed
			expect(sessions[1].executionQueue).toHaveLength(1); // other — unchanged
			expect(sessions[1].executionQueue[0].id).toBe('item-b');
		});
	});

	// ========================================================================
	// handleSwitchQueueSession
	// ========================================================================
	describe('handleSwitchQueueSession', () => {
		it('sets the active session ID to the given session', () => {
			const session1 = createSession({ id: 'sess-1' });
			const session2 = createSession({ id: 'sess-2' });
			useSessionStore.setState({
				sessions: [session1, session2],
				activeSessionId: 'sess-1',
			});

			const { result } = renderHook(() => useQueueHandlers());

			act(() => {
				result.current.handleSwitchQueueSession('sess-2');
			});

			expect(useSessionStore.getState().activeSessionId).toBe('sess-2');
		});

		it('can switch to the already active session (idempotent)', () => {
			const session = createSession({ id: 'sess-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'sess-1' });

			const { result } = renderHook(() => useQueueHandlers());

			act(() => {
				result.current.handleSwitchQueueSession('sess-1');
			});

			expect(useSessionStore.getState().activeSessionId).toBe('sess-1');
		});

		it('sets active session ID even for an unknown session ID', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			const { result } = renderHook(() => useQueueHandlers());

			act(() => {
				result.current.handleSwitchQueueSession('nonexistent');
			});

			// The store accepts any ID — validation is the caller's responsibility
			expect(useSessionStore.getState().activeSessionId).toBe('nonexistent');
		});
	});

	// ========================================================================
	// handleReorderQueueItems
	// ========================================================================
	describe('handleReorderQueueItems', () => {
		it('moves an item up (from higher index to lower index)', () => {
			const item1 = createQueuedItem({ id: 'item-a', tabId: 'tab-1', text: 'First' });
			const item2 = createQueuedItem({ id: 'item-b', tabId: 'tab-1', text: 'Second' });
			const item3 = createQueuedItem({ id: 'item-c', tabId: 'tab-1', text: 'Third' });
			const session = createSession({
				id: 'sess-1',
				executionQueue: [item1, item2, item3],
			});
			useSessionStore.setState({ sessions: [session] });

			const { result } = renderHook(() => useQueueHandlers());

			// Move item at index 2 to index 0
			act(() => {
				result.current.handleReorderQueueItems('sess-1', 2, 0);
			});

			const queue = useSessionStore.getState().sessions[0].executionQueue;
			expect(queue[0].id).toBe('item-c');
			expect(queue[1].id).toBe('item-a');
			expect(queue[2].id).toBe('item-b');
		});

		it('moves an item down (from lower index to higher index)', () => {
			const item1 = createQueuedItem({ id: 'item-a', tabId: 'tab-1', text: 'First' });
			const item2 = createQueuedItem({ id: 'item-b', tabId: 'tab-1', text: 'Second' });
			const item3 = createQueuedItem({ id: 'item-c', tabId: 'tab-1', text: 'Third' });
			const session = createSession({
				id: 'sess-1',
				executionQueue: [item1, item2, item3],
			});
			useSessionStore.setState({ sessions: [session] });

			const { result } = renderHook(() => useQueueHandlers());

			// Move item at index 0 to index 2
			act(() => {
				result.current.handleReorderQueueItems('sess-1', 0, 2);
			});

			const queue = useSessionStore.getState().sessions[0].executionQueue;
			expect(queue[0].id).toBe('item-b');
			expect(queue[1].id).toBe('item-c');
			expect(queue[2].id).toBe('item-a');
		});

		it('moves first item to last position', () => {
			const item1 = createQueuedItem({ id: 'item-a', tabId: 'tab-1' });
			const item2 = createQueuedItem({ id: 'item-b', tabId: 'tab-1' });
			const item3 = createQueuedItem({ id: 'item-c', tabId: 'tab-1' });
			const item4 = createQueuedItem({ id: 'item-d', tabId: 'tab-1' });
			const session = createSession({
				id: 'sess-1',
				executionQueue: [item1, item2, item3, item4],
			});
			useSessionStore.setState({ sessions: [session] });

			const { result } = renderHook(() => useQueueHandlers());

			act(() => {
				result.current.handleReorderQueueItems('sess-1', 0, 3);
			});

			const queue = useSessionStore.getState().sessions[0].executionQueue;
			expect(queue.map((i: QueuedItem) => i.id)).toEqual(['item-b', 'item-c', 'item-d', 'item-a']);
		});

		it('moves last item to first position', () => {
			const item1 = createQueuedItem({ id: 'item-a', tabId: 'tab-1' });
			const item2 = createQueuedItem({ id: 'item-b', tabId: 'tab-1' });
			const item3 = createQueuedItem({ id: 'item-c', tabId: 'tab-1' });
			const item4 = createQueuedItem({ id: 'item-d', tabId: 'tab-1' });
			const session = createSession({
				id: 'sess-1',
				executionQueue: [item1, item2, item3, item4],
			});
			useSessionStore.setState({ sessions: [session] });

			const { result } = renderHook(() => useQueueHandlers());

			act(() => {
				result.current.handleReorderQueueItems('sess-1', 3, 0);
			});

			const queue = useSessionStore.getState().sessions[0].executionQueue;
			expect(queue.map((i: QueuedItem) => i.id)).toEqual(['item-d', 'item-a', 'item-b', 'item-c']);
		});

		it('swaps two adjacent items', () => {
			const item1 = createQueuedItem({ id: 'item-a', tabId: 'tab-1' });
			const item2 = createQueuedItem({ id: 'item-b', tabId: 'tab-1' });
			const session = createSession({
				id: 'sess-1',
				executionQueue: [item1, item2],
			});
			useSessionStore.setState({ sessions: [session] });

			const { result } = renderHook(() => useQueueHandlers());

			act(() => {
				result.current.handleReorderQueueItems('sess-1', 0, 1);
			});

			const queue = useSessionStore.getState().sessions[0].executionQueue;
			expect(queue[0].id).toBe('item-b');
			expect(queue[1].id).toBe('item-a');
		});

		it('reordering same index is effectively a no-op', () => {
			const item1 = createQueuedItem({ id: 'item-a', tabId: 'tab-1' });
			const item2 = createQueuedItem({ id: 'item-b', tabId: 'tab-1' });
			const session = createSession({
				id: 'sess-1',
				executionQueue: [item1, item2],
			});
			useSessionStore.setState({ sessions: [session] });

			const { result } = renderHook(() => useQueueHandlers());

			act(() => {
				result.current.handleReorderQueueItems('sess-1', 1, 1);
			});

			const queue = useSessionStore.getState().sessions[0].executionQueue;
			expect(queue[0].id).toBe('item-a');
			expect(queue[1].id).toBe('item-b');
		});

		it('is a no-op for sessions that do not match the given session ID', () => {
			const item1 = createQueuedItem({ id: 'item-a', tabId: 'tab-1' });
			const item2 = createQueuedItem({ id: 'item-b', tabId: 'tab-1' });
			const session = createSession({
				id: 'sess-1',
				executionQueue: [item1, item2],
			});
			useSessionStore.setState({ sessions: [session] });

			const { result } = renderHook(() => useQueueHandlers());

			act(() => {
				result.current.handleReorderQueueItems('nonexistent-session', 0, 1);
			});

			const queue = useSessionStore.getState().sessions[0].executionQueue;
			expect(queue[0].id).toBe('item-a');
			expect(queue[1].id).toBe('item-b');
		});

		it('only affects the target session when multiple sessions exist', () => {
			const itemA1 = createQueuedItem({ id: 'item-a1', tabId: 'tab-1', text: 'A first' });
			const itemA2 = createQueuedItem({ id: 'item-a2', tabId: 'tab-1', text: 'A second' });
			const itemB1 = createQueuedItem({ id: 'item-b1', tabId: 'tab-1', text: 'B first' });
			const itemB2 = createQueuedItem({ id: 'item-b2', tabId: 'tab-1', text: 'B second' });
			const session1 = createSession({ id: 'sess-1', executionQueue: [itemA1, itemA2] });
			const session2 = createSession({ id: 'sess-2', executionQueue: [itemB1, itemB2] });
			useSessionStore.setState({ sessions: [session1, session2] });

			const { result } = renderHook(() => useQueueHandlers());

			act(() => {
				result.current.handleReorderQueueItems('sess-1', 0, 1);
			});

			const sessions = useSessionStore.getState().sessions;
			// sess-1 queue should be reordered
			expect(sessions[0].executionQueue[0].id).toBe('item-a2');
			expect(sessions[0].executionQueue[1].id).toBe('item-a1');
			// sess-2 queue should be untouched
			expect(sessions[1].executionQueue[0].id).toBe('item-b1');
			expect(sessions[1].executionQueue[1].id).toBe('item-b2');
		});

		it('preserves all item data after reorder', () => {
			const item1 = createQueuedItem({
				id: 'item-a',
				tabId: 'tab-42',
				type: 'command',
				text: 'special command',
				timestamp: 1000,
			});
			const item2 = createQueuedItem({
				id: 'item-b',
				tabId: 'tab-99',
				type: 'message',
				text: 'hello world',
				timestamp: 2000,
			});
			const session = createSession({ id: 'sess-1', executionQueue: [item1, item2] });
			useSessionStore.setState({ sessions: [session] });

			const { result } = renderHook(() => useQueueHandlers());

			act(() => {
				result.current.handleReorderQueueItems('sess-1', 0, 1);
			});

			const queue = useSessionStore.getState().sessions[0].executionQueue;
			// item-b is now first
			expect(queue[0]).toMatchObject({
				id: 'item-b',
				tabId: 'tab-99',
				type: 'message',
				text: 'hello world',
				timestamp: 2000,
			});
			// item-a is now second
			expect(queue[1]).toMatchObject({
				id: 'item-a',
				tabId: 'tab-42',
				type: 'command',
				text: 'special command',
				timestamp: 1000,
			});
		});
	});

	// ========================================================================
	// Return type completeness
	// ========================================================================
	describe('return type', () => {
		it('returns all three handler functions', () => {
			const { result } = renderHook(() => useQueueHandlers());

			expect(typeof result.current.handleRemoveQueueItem).toBe('function');
			expect(typeof result.current.handleSwitchQueueSession).toBe('function');
			expect(typeof result.current.handleReorderQueueItems).toBe('function');
		});

		it('returns stable handler references across renders', () => {
			const { result, rerender } = renderHook(() => useQueueHandlers());

			const first = result.current;
			rerender();
			const second = result.current;

			expect(second.handleRemoveQueueItem).toBe(first.handleRemoveQueueItem);
			expect(second.handleSwitchQueueSession).toBe(first.handleSwitchQueueSession);
			expect(second.handleReorderQueueItems).toBe(first.handleReorderQueueItems);
		});
	});
});
