/**
 * Tests for useQueueProcessing hook
 *
 * Tests:
 *   - processQueuedItem delegates to agentStore with the correct config
 *   - Ref values (customAICommands, speckitCommands, openspecCommands) use null-coalescing
 *   - processQueuedItemRef always points to the latest closure
 *   - Startup recovery: finds idle sessions with queued items after sessionsLoaded
 *   - Startup recovery: sets session + target tab to busy state
 *   - Startup recovery: removes first item from executionQueue
 *   - Startup recovery: calls processQueuedItem for each eligible session
 *   - Startup recovery: re-scans at timer fire for sessions that become idle during the delay
 *   - Startup recovery: on processing error, re-queues the item and resets to idle
 *   - Startup recovery: skips sessions when sessionsLoaded is false
 *   - Startup recovery: runs only once (ref guard prevents repeat runs)
 *   - Startup recovery: skips sessions with empty queues
 *   - Startup recovery: skips sessions that are not idle (e.g., busy)
 *   - Startup recovery: uses getActiveTab fallback when tabId does not match any tab
 *   - Startup recovery: cleans up the timer on unmount
 *   - Runtime recovery: dispatches stuck items after error-to-idle transition
 *   - Runtime recovery: guards against double-dispatch via state re-check
 *   - Runtime recovery: does not fire before startup recovery
 *   - Runtime recovery: skips busy and error sessions
 *   - Agent Resilience: holds the queue while a retry counts down for the target tab
 *   - Agent Resilience: drains the held queue once the retry clears
 *   - Busy target tab: does not dequeue or dispatch onto a tab already mid-turn
 *   - Failed dispatch: clears only the tab it marked busy, leaving other turns alone
 *   - Return value: exposes processQueuedItem and processQueuedItemRef
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// ============================================================================
// Mocks (declared before imports)
// ============================================================================

const mockAgentStoreProcessQueuedItem = vi.fn();

const mockLoggerError = vi.fn();

vi.mock('../../../renderer/utils/logger', () => ({
	logger: {
		error: (...args: unknown[]) => mockLoggerError(...args),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../renderer/stores/agentStore', () => ({
	useAgentStore: Object.assign(vi.fn(), {
		getState: () => ({
			processQueuedItem: mockAgentStoreProcessQueuedItem,
		}),
		setState: vi.fn(),
		subscribe: vi.fn(() => vi.fn()),
	}),
}));

const mockSetSessions = vi.fn();

vi.mock('../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(
		(selector: (s: Record<string, unknown>) => unknown) => selector(mockSessionStoreState),
		{
			getState: () => ({
				...mockSessionStoreState,
				setSessions: mockSetSessions,
			}),
			setState: vi.fn(),
			subscribe: vi.fn(() => vi.fn()),
		}
	),
}));

/**
 * Agent Resilience. `pendingRetryTabs` is the set of tabs with a retry counting
 * down; `mockRetries` is the store slice the hook subscribes to so a cleared
 * retry re-runs the runtime-recovery effect.
 */
const pendingRetryTabs = new Set<string>();
let mockRetries: Record<string, unknown> = {};

const mockRegisterDispatchDepsProvider = vi.fn();

vi.mock('../../../renderer/stores/retryStore', () => ({
	hasPendingRetry: (_sessionId: string, tabId: string) => pendingRetryTabs.has(tabId),
	registerDispatchDepsProvider: (...args: unknown[]) => mockRegisterDispatchDepsProvider(...args),
	useRetryStore: Object.assign(
		(selector: (s: Record<string, unknown>) => unknown) => selector({ retries: mockRetries }),
		{
			getState: () => ({ retries: mockRetries }),
			setState: vi.fn(),
			subscribe: vi.fn(() => vi.fn()),
		}
	),
}));

const mockGetActiveTab = vi.fn();

vi.mock('../../../renderer/utils/tabHelpers', () => ({
	getActiveTab: (...args: unknown[]) => mockGetActiveTab(...args),
	// Mirror the real resolver so the dispatch path can be exercised, but route the
	// active-tab fallback through mockGetActiveTab (tests assert on that call).
	resolveQueuedItemTarget: (session: any, item: any) => {
		if (item?.tabId) {
			if (session?.aiTabs?.some((t: any) => t.id === item.tabId)) {
				return { tabId: item.tabId, location: 'aiTab' };
			}
			const orphan = session?.orphanedThinkingTabs?.find((t: any) => t.id === item.tabId);
			if (orphan) return { tabId: orphan.id, location: 'orphan' };
		}
		const active = mockGetActiveTab(session);
		return active ? { tabId: active.id, location: 'active' } : null;
	},
	markTabRunningQueuedItem: (tab: any, item: any) => {
		const now = Date.now();
		const next = { ...tab, state: 'busy', thinkingStartTime: now };
		if (item?.type === 'message' && item?.text) {
			next.logs = [
				...tab.logs,
				{
					id: 'mock-log-id',
					timestamp: now,
					source: 'user',
					text: item.text,
					images: item.images,
					...(item.forceParallel && { forceParallel: true }),
					...(item.readOnlyMode && { readOnly: true }),
				},
			];
		}
		return next;
	},
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { useQueueProcessing } from '../../../renderer/hooks/agent/useQueueProcessing';
import type { UseQueueProcessingDeps } from '../../../renderer/hooks/agent/useQueueProcessing';
import type { Session, AITab, QueuedItem } from '../../../renderer/types';

// ============================================================================
// Mutable store state (mutated in each test)
// ============================================================================

const mockSessionStoreState: {
	sessionsLoaded: boolean;
	sessions: Session[];
} = {
	sessionsLoaded: false,
	sessions: [],
};

// ============================================================================
// Test Helpers
// ============================================================================

function createTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle',
		...overrides,
	} as AITab;
}

function createQueuedItem(overrides: Partial<QueuedItem> = {}): QueuedItem {
	return {
		id: 'item-1',
		timestamp: Date.now(),
		tabId: 'tab-1',
		type: 'message',
		text: 'Hello',
		...overrides,
	};
}

function createSession(overrides: Partial<Session> = {}): Session {
	const tab = createTab();
	return {
		id: 'session-1',
		name: 'Test Agent',
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
		port: 0,
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [tab],
		activeTabId: tab.id,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai' as const, id: tab.id }],
		unifiedClosedTabHistory: [],
		autoRunFolderPath: '/test/project/.maestro-autorun',
		terminalTabs: [],
		activeTerminalTabId: null,
		...overrides,
	} as Session;
}

function createDeps(overrides: Partial<UseQueueProcessingDeps> = {}): UseQueueProcessingDeps {
	return {
		conductorProfile: 'default',
		customAICommandsRef: { current: [] },
		speckitCommandsRef: { current: [] },
		openspecCommandsRef: { current: [] },
		...overrides,
	};
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();

	mockSessionStoreState.sessionsLoaded = false;
	mockSessionStoreState.sessions = [];

	pendingRetryTabs.clear();
	mockRetries = {};

	// Mirror the real store: `setSessions` runs the updater exactly once,
	// synchronously (sessionStore.setSessions -> zustand `set`). The hook reads
	// back whether the dequeue actually took the item, so a spy that never runs
	// the updater would report "nothing dequeued" and suppress every dispatch.
	// The result is deliberately not committed - tests drive `sessions` directly.
	mockSetSessions.mockImplementation((updater: unknown) => {
		if (typeof updater === 'function') {
			(updater as (prev: Session[]) => Session[])(mockSessionStoreState.sessions);
		}
	});

	// Default: agentStore.processQueuedItem resolves immediately
	mockAgentStoreProcessQueuedItem.mockResolvedValue(undefined);

	// Default: getActiveTab returns the first tab of the session
	mockGetActiveTab.mockImplementation((session: Session) => session.aiTabs[0]);
});

afterEach(() => {
	vi.useRealTimers();
	cleanup();
});

// ============================================================================
// processQueuedItem - delegation to agentStore
// ============================================================================

describe('processQueuedItem - delegation to agentStore', () => {
	it('calls agentStore.processQueuedItem with sessionId, item, and config', async () => {
		const deps = createDeps({ conductorProfile: 'my-profile' });
		const { result } = renderHook(() => useQueueProcessing(deps));

		const item = createQueuedItem();

		await act(async () => {
			await result.current.processQueuedItem('session-1', item);
		});

		expect(mockAgentStoreProcessQueuedItem).toHaveBeenCalledOnce();
		expect(mockAgentStoreProcessQueuedItem).toHaveBeenCalledWith('session-1', item, {
			conductorProfile: 'my-profile',
			customAICommands: [],
			speckitCommands: [],
			openspecCommands: [],
			bmadCommands: [],
		});
	});

	it('passes customAICommands from ref', async () => {
		const customCommands = [{ name: 'cmd1', prompt: 'do something' }] as any[];
		const deps = createDeps({
			customAICommandsRef: { current: customCommands },
		});
		const { result } = renderHook(() => useQueueProcessing(deps));

		await act(async () => {
			await result.current.processQueuedItem('session-1', createQueuedItem());
		});

		const callConfig = mockAgentStoreProcessQueuedItem.mock.calls[0][2];
		expect(callConfig.customAICommands).toBe(customCommands);
	});

	it('passes speckitCommands from ref', async () => {
		const speckitCommands = [{ name: 'spec-cmd', prompt: 'speckit prompt' }] as any[];
		const deps = createDeps({
			speckitCommandsRef: { current: speckitCommands },
		});
		const { result } = renderHook(() => useQueueProcessing(deps));

		await act(async () => {
			await result.current.processQueuedItem('session-1', createQueuedItem());
		});

		const callConfig = mockAgentStoreProcessQueuedItem.mock.calls[0][2];
		expect(callConfig.speckitCommands).toBe(speckitCommands);
	});

	it('passes openspecCommands from ref', async () => {
		const openspecCommands = [{ name: 'openspec-cmd', prompt: 'openspec prompt' }] as any[];
		const deps = createDeps({
			openspecCommandsRef: { current: openspecCommands },
		});
		const { result } = renderHook(() => useQueueProcessing(deps));

		await act(async () => {
			await result.current.processQueuedItem('session-1', createQueuedItem());
		});

		const callConfig = mockAgentStoreProcessQueuedItem.mock.calls[0][2];
		expect(callConfig.openspecCommands).toBe(openspecCommands);
	});

	it('falls back to empty array when customAICommandsRef.current is null', async () => {
		const deps = createDeps({
			customAICommandsRef: { current: null as any },
		});
		const { result } = renderHook(() => useQueueProcessing(deps));

		await act(async () => {
			await result.current.processQueuedItem('session-1', createQueuedItem());
		});

		const callConfig = mockAgentStoreProcessQueuedItem.mock.calls[0][2];
		expect(callConfig.customAICommands).toEqual([]);
	});

	it('falls back to empty array when speckitCommandsRef.current is null', async () => {
		const deps = createDeps({
			speckitCommandsRef: { current: null as any },
		});
		const { result } = renderHook(() => useQueueProcessing(deps));

		await act(async () => {
			await result.current.processQueuedItem('session-1', createQueuedItem());
		});

		const callConfig = mockAgentStoreProcessQueuedItem.mock.calls[0][2];
		expect(callConfig.speckitCommands).toEqual([]);
	});

	it('falls back to empty array when openspecCommandsRef.current is null', async () => {
		const deps = createDeps({
			openspecCommandsRef: { current: null as any },
		});
		const { result } = renderHook(() => useQueueProcessing(deps));

		await act(async () => {
			await result.current.processQueuedItem('session-1', createQueuedItem());
		});

		const callConfig = mockAgentStoreProcessQueuedItem.mock.calls[0][2];
		expect(callConfig.openspecCommands).toEqual([]);
	});

	it('updates config when conductorProfile changes between calls', async () => {
		const deps = createDeps({ conductorProfile: 'profile-a' });
		const { result, rerender } = renderHook((d: UseQueueProcessingDeps) => useQueueProcessing(d), {
			initialProps: deps,
		});

		await act(async () => {
			await result.current.processQueuedItem('session-1', createQueuedItem());
		});

		// Rerender with new conductorProfile
		rerender(createDeps({ conductorProfile: 'profile-b' }));

		await act(async () => {
			await result.current.processQueuedItem('session-1', createQueuedItem());
		});

		expect(mockAgentStoreProcessQueuedItem.mock.calls[0][2].conductorProfile).toBe('profile-a');
		expect(mockAgentStoreProcessQueuedItem.mock.calls[1][2].conductorProfile).toBe('profile-b');
	});
});

// ============================================================================
// processQueuedItemRef - always reflects latest closure
// ============================================================================

describe('processQueuedItemRef', () => {
	it('is initialized to a function on first render', () => {
		const deps = createDeps();
		const { result } = renderHook(() => useQueueProcessing(deps));

		expect(result.current.processQueuedItemRef.current).toBeTypeOf('function');
	});

	it('ref current delegates to agentStore when called', async () => {
		const deps = createDeps({ conductorProfile: 'via-ref' });
		const { result } = renderHook(() => useQueueProcessing(deps));

		const item = createQueuedItem();

		await act(async () => {
			await result.current.processQueuedItemRef.current!('session-1', item);
		});

		expect(mockAgentStoreProcessQueuedItem).toHaveBeenCalledOnce();
		expect(mockAgentStoreProcessQueuedItem.mock.calls[0][2].conductorProfile).toBe('via-ref');
	});

	it('ref current updates when conductorProfile changes', async () => {
		const { result, rerender } = renderHook((d: UseQueueProcessingDeps) => useQueueProcessing(d), {
			initialProps: createDeps({ conductorProfile: 'old-profile' }),
		});

		rerender(createDeps({ conductorProfile: 'new-profile' }));

		await act(async () => {
			await result.current.processQueuedItemRef.current!('session-1', createQueuedItem());
		});

		expect(mockAgentStoreProcessQueuedItem.mock.calls[0][2].conductorProfile).toBe('new-profile');
	});
});

// ============================================================================
// Startup recovery - skipping conditions
// ============================================================================

describe('startup recovery - skipping conditions', () => {
	it('does not process queues when sessionsLoaded is false', () => {
		vi.useFakeTimers();

		mockSessionStoreState.sessionsLoaded = false;
		mockSessionStoreState.sessions = [
			createSession({
				state: 'idle',
				executionQueue: [createQueuedItem()],
			}),
		];

		renderHook(() => useQueueProcessing(createDeps()));

		act(() => {
			vi.advanceTimersByTime(1000);
		});

		expect(mockSetSessions).not.toHaveBeenCalled();
		expect(mockAgentStoreProcessQueuedItem).not.toHaveBeenCalled();
	});

	it('does not process queues when all sessions have empty queues', () => {
		vi.useFakeTimers();

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [createSession({ state: 'idle', executionQueue: [] })];

		renderHook(() => useQueueProcessing(createDeps()));

		act(() => {
			vi.advanceTimersByTime(1000);
		});

		expect(mockSetSessions).not.toHaveBeenCalled();
		expect(mockAgentStoreProcessQueuedItem).not.toHaveBeenCalled();
	});

	it('does not process queues for sessions that are not idle', () => {
		vi.useFakeTimers();

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [
			createSession({
				state: 'busy' as any,
				executionQueue: [createQueuedItem()],
			}),
		];

		renderHook(() => useQueueProcessing(createDeps()));

		act(() => {
			vi.advanceTimersByTime(1000);
		});

		expect(mockSetSessions).not.toHaveBeenCalled();
		expect(mockAgentStoreProcessQueuedItem).not.toHaveBeenCalled();
	});

	it('runs only once even when re-rendered after sessionsLoaded becomes true', () => {
		vi.useFakeTimers();

		mockSessionStoreState.sessionsLoaded = true;
		const item = createQueuedItem();
		mockSessionStoreState.sessions = [createSession({ state: 'idle', executionQueue: [item] })];

		const { rerender } = renderHook(() => useQueueProcessing(createDeps()));

		act(() => {
			vi.advanceTimersByTime(600);
		});

		const firstCallCount = mockSetSessions.mock.calls.length;

		// Simulate a re-render (sessions state changing triggers effect again)
		rerender();

		act(() => {
			vi.advanceTimersByTime(600);
		});

		// setSessions should not be called additional times due to the ref guard
		expect(mockSetSessions.mock.calls.length).toBe(firstCallCount);
	});

	it('does not fire the timer when there are no eligible sessions', () => {
		vi.useFakeTimers();

		mockSessionStoreState.sessionsLoaded = true;
		// Mix: one busy (not eligible) and one idle with empty queue (not eligible)
		mockSessionStoreState.sessions = [
			createSession({ id: 'busy-1', state: 'busy' as any, executionQueue: [createQueuedItem()] }),
			createSession({ id: 'idle-empty', state: 'idle', executionQueue: [] }),
		];

		renderHook(() => useQueueProcessing(createDeps()));

		act(() => {
			vi.advanceTimersByTime(1000);
		});

		expect(mockAgentStoreProcessQueuedItem).not.toHaveBeenCalled();
	});
});

// ============================================================================
// Startup recovery - happy path
// ============================================================================

describe('startup recovery - happy path', () => {
	it('calls setSessions to set session and tab to busy after 500ms delay', () => {
		vi.useFakeTimers();

		const tab = createTab({ id: 'tab-a', state: 'idle' });
		const item = createQueuedItem({ tabId: 'tab-a' });
		const session = createSession({
			id: 'sess-1',
			state: 'idle',
			aiTabs: [tab],
			activeTabId: 'tab-a',
			executionQueue: [item],
		});

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [session];

		// getActiveTab returns the tab matching the item's tabId
		mockGetActiveTab.mockReturnValue(tab);

		renderHook(() => useQueueProcessing(createDeps()));

		// Before delay: setSessions not called
		expect(mockSetSessions).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect(mockSetSessions).toHaveBeenCalled();
	});

	it('the setSessions updater sets session state to busy with ai busySource', () => {
		vi.useFakeTimers();

		const tab = createTab({ id: 'tab-1', state: 'idle' });
		const item = createQueuedItem({ tabId: 'tab-1' });
		const session = createSession({
			id: 'sess-1',
			state: 'idle',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			executionQueue: [item],
		});

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [session];
		mockGetActiveTab.mockReturnValue(tab);

		let capturedUpdater: ((prev: Session[]) => Session[]) | null = null;
		mockSetSessions.mockImplementation((updater: any) => {
			capturedUpdater = updater;
			updater(mockSessionStoreState.sessions);
		});

		renderHook(() => useQueueProcessing(createDeps()));

		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect(capturedUpdater).not.toBeNull();
		const updated = capturedUpdater!([session]);

		expect(updated[0].state).toBe('busy');
		expect(updated[0].busySource).toBe('ai');
		expect(updated[0].thinkingStartTime).toBeGreaterThan(0);
		expect(updated[0].currentCycleTokens).toBe(0);
		expect(updated[0].currentCycleBytes).toBe(0);
	});

	it('the setSessions updater removes the first item from executionQueue', () => {
		vi.useFakeTimers();

		const tab = createTab({ id: 'tab-1' });
		const item1 = createQueuedItem({ id: 'item-1', tabId: 'tab-1' });
		const item2 = createQueuedItem({ id: 'item-2', tabId: 'tab-1' });
		const session = createSession({
			id: 'sess-1',
			state: 'idle',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			executionQueue: [item1, item2],
		});

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [session];
		mockGetActiveTab.mockReturnValue(tab);

		let capturedUpdater: ((prev: Session[]) => Session[]) | null = null;
		mockSetSessions.mockImplementation((updater: any) => {
			capturedUpdater = updater;
			updater(mockSessionStoreState.sessions);
		});

		renderHook(() => useQueueProcessing(createDeps()));

		act(() => {
			vi.advanceTimersByTime(500);
		});

		const updated = capturedUpdater!([session]);
		expect(updated[0].executionQueue).toHaveLength(1);
		expect(updated[0].executionQueue[0].id).toBe('item-2');
	});

	it('the setSessions updater sets the target tab (by tabId) to busy', () => {
		vi.useFakeTimers();

		const targetTab = createTab({ id: 'target-tab', state: 'idle' });
		const otherTab = createTab({ id: 'other-tab', state: 'idle' });
		const item = createQueuedItem({ tabId: 'target-tab' });
		const session = createSession({
			id: 'sess-1',
			state: 'idle',
			aiTabs: [targetTab, otherTab],
			activeTabId: 'other-tab',
			executionQueue: [item],
		});

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [session];
		// getActiveTab is NOT needed here because tabId matches
		mockGetActiveTab.mockReturnValue(otherTab);

		let capturedUpdater: ((prev: Session[]) => Session[]) | null = null;
		mockSetSessions.mockImplementation((updater: any) => {
			capturedUpdater = updater;
			updater(mockSessionStoreState.sessions);
		});

		renderHook(() => useQueueProcessing(createDeps()));

		act(() => {
			vi.advanceTimersByTime(500);
		});

		const updated = capturedUpdater!([session]);
		const updatedTarget = updated[0].aiTabs.find((t) => t.id === 'target-tab');
		const updatedOther = updated[0].aiTabs.find((t) => t.id === 'other-tab');

		expect(updatedTarget?.state).toBe('busy');
		expect(updatedTarget?.thinkingStartTime).toBeGreaterThan(0);
		expect(updatedOther?.state).toBe('idle');
	});

	it('falls back to getActiveTab when tabId does not match any tab', () => {
		vi.useFakeTimers();

		const activeTab = createTab({ id: 'active-tab', state: 'idle' });
		const item = createQueuedItem({ tabId: 'nonexistent-tab' });
		const session = createSession({
			id: 'sess-1',
			state: 'idle',
			aiTabs: [activeTab],
			activeTabId: 'active-tab',
			executionQueue: [item],
		});

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [session];
		mockGetActiveTab.mockReturnValue(activeTab);

		let capturedUpdater: ((prev: Session[]) => Session[]) | null = null;
		mockSetSessions.mockImplementation((updater: any) => {
			capturedUpdater = updater;
			updater(mockSessionStoreState.sessions);
		});

		renderHook(() => useQueueProcessing(createDeps()));

		act(() => {
			vi.advanceTimersByTime(500);
		});

		const updated = capturedUpdater!([session]);
		// Should have used getActiveTab fallback and set activeTab to busy
		const updatedActive = updated[0].aiTabs.find((t) => t.id === 'active-tab');
		expect(updatedActive?.state).toBe('busy');
		expect(mockGetActiveTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-1' }));
	});

	it('calls agentStore.processQueuedItem with the first queued item after 500ms', async () => {
		vi.useFakeTimers();

		const tab = createTab({ id: 'tab-1' });
		const item = createQueuedItem({ id: 'item-1', tabId: 'tab-1' });
		const session = createSession({
			id: 'sess-1',
			state: 'idle',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			executionQueue: [item],
		});

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [session];
		mockGetActiveTab.mockReturnValue(tab);

		renderHook(() => useQueueProcessing(createDeps({ conductorProfile: 'test-profile' })));

		await act(async () => {
			vi.advanceTimersByTime(500);
			// Flush the promise from processQueuedItem
			await Promise.resolve();
		});

		expect(mockAgentStoreProcessQueuedItem).toHaveBeenCalledOnce();
		expect(mockAgentStoreProcessQueuedItem).toHaveBeenCalledWith('sess-1', item, {
			conductorProfile: 'test-profile',
			customAICommands: [],
			speckitCommands: [],
			openspecCommands: [],
			bmadCommands: [],
		});
	});

	it('processes all eligible sessions when multiple have queued items', async () => {
		vi.useFakeTimers();

		const tab1 = createTab({ id: 'tab-1' });
		const item1 = createQueuedItem({ id: 'item-a', tabId: 'tab-1' });
		const session1 = createSession({
			id: 'sess-1',
			state: 'idle',
			aiTabs: [tab1],
			activeTabId: 'tab-1',
			executionQueue: [item1],
		});

		const tab2 = createTab({ id: 'tab-2' });
		const item2 = createQueuedItem({ id: 'item-b', tabId: 'tab-2' });
		const session2 = createSession({
			id: 'sess-2',
			state: 'idle',
			aiTabs: [tab2],
			activeTabId: 'tab-2',
			executionQueue: [item2],
		});

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [session1, session2];
		mockGetActiveTab.mockImplementation((session: Session) => session.aiTabs[0]);

		renderHook(() => useQueueProcessing(createDeps()));

		await act(async () => {
			vi.advanceTimersByTime(500);
			await Promise.resolve();
		});

		// Both sessions should have been processed
		expect(mockAgentStoreProcessQueuedItem).toHaveBeenCalledTimes(2);
		const calledSessionIds = mockAgentStoreProcessQueuedItem.mock.calls.map((call) => call[0]);
		expect(calledSessionIds).toContain('sess-1');
		expect(calledSessionIds).toContain('sess-2');
	});

	it('re-scans at timer fire so a session that becomes idle+runnable during the delay is recovered', async () => {
		vi.useFakeTimers();

		const tab1 = createTab({ id: 'tab-1' });
		const item1 = createQueuedItem({ id: 'item-early', tabId: 'tab-1' });
		const session1 = createSession({
			id: 'sess-early',
			state: 'idle',
			aiTabs: [tab1],
			activeTabId: 'tab-1',
			executionQueue: [item1],
		});

		// Second session is busy at mount - not in the startup snapshot.
		const tab2 = createTab({ id: 'tab-2' });
		const item2 = createQueuedItem({ id: 'item-late', tabId: 'tab-2' });
		const session2Busy = createSession({
			id: 'sess-late',
			state: 'busy',
			aiTabs: [tab2],
			activeTabId: 'tab-2',
			executionQueue: [item2],
		});

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [session1, session2Busy];
		mockGetActiveTab.mockImplementation((session: Session) => session.aiTabs[0]);

		const { rerender } = renderHook(() => useQueueProcessing(createDeps()));

		// Mid-delay: late session becomes idle with a runnable item. Runtime
		// recovery bails while startupRecoveryComplete is still false.
		mockSessionStoreState.sessions = [
			session1,
			createSession({
				id: 'sess-late',
				state: 'idle',
				aiTabs: [tab2],
				activeTabId: 'tab-2',
				executionQueue: [item2],
			}),
		];
		act(() => {
			rerender();
		});
		expect(mockAgentStoreProcessQueuedItem).not.toHaveBeenCalled();

		await act(async () => {
			vi.advanceTimersByTime(500);
			await Promise.resolve();
		});

		// Timer re-scan must pick up both the original and the late session.
		expect(mockAgentStoreProcessQueuedItem).toHaveBeenCalledTimes(2);
		const calledSessionIds = mockAgentStoreProcessQueuedItem.mock.calls.map((call) => call[0]);
		expect(calledSessionIds).toContain('sess-early');
		expect(calledSessionIds).toContain('sess-late');
	});

	it('does not touch sessions without queued items when others are processed', async () => {
		vi.useFakeTimers();

		const tabWithQueue = createTab({ id: 'tab-queue' });
		const itemQueued = createQueuedItem({ tabId: 'tab-queue' });
		const sessionWithQueue = createSession({
			id: 'sess-queued',
			state: 'idle',
			aiTabs: [tabWithQueue],
			activeTabId: 'tab-queue',
			executionQueue: [itemQueued],
		});

		const tabEmpty = createTab({ id: 'tab-empty' });
		const sessionEmpty = createSession({
			id: 'sess-empty',
			state: 'idle',
			aiTabs: [tabEmpty],
			activeTabId: 'tab-empty',
			executionQueue: [],
		});

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [sessionWithQueue, sessionEmpty];
		mockGetActiveTab.mockImplementation((session: Session) => session.aiTabs[0]);

		let capturedUpdater: ((prev: Session[]) => Session[]) | null = null;
		mockSetSessions.mockImplementation((updater: any) => {
			capturedUpdater = updater;
			updater(mockSessionStoreState.sessions);
		});

		renderHook(() => useQueueProcessing(createDeps()));

		await act(async () => {
			vi.advanceTimersByTime(500);
			await Promise.resolve();
		});

		const updated = capturedUpdater!([sessionWithQueue, sessionEmpty]);
		const updatedEmpty = updated.find((s) => s.id === 'sess-empty');
		// Session without queue should be returned unchanged (state stays idle)
		expect(updatedEmpty?.state).toBe('idle');
	});
});

// ============================================================================
// Startup recovery - error handling
// ============================================================================

describe('startup recovery - error handling', () => {
	it('logs the rejection when processQueuedItem fails, and leaves recovery to agentStore', async () => {
		vi.useFakeTimers();

		const tab = createTab({ id: 'tab-1' });
		const item = createQueuedItem({ tabId: 'tab-1' });
		const session = createSession({
			id: 'sess-log',
			state: 'idle',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			executionQueue: [item],
		});

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [session];
		mockGetActiveTab.mockReturnValue(tab);

		mockAgentStoreProcessQueuedItem.mockRejectedValueOnce(new Error('oops'));

		const setSessionsUpdaters: Array<(prev: Session[]) => Session[]> = [];
		mockSetSessions.mockImplementation((updater: any) => {
			setSessionsUpdaters.push(updater);
			updater(mockSessionStoreState.sessions);
		});

		renderHook(() => useQueueProcessing(createDeps()));

		await act(async () => {
			vi.advanceTimersByTime(500);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(mockLoggerError).toHaveBeenCalled();
		expect(String(mockLoggerError.mock.calls[0][0])).toContain('sess-log');
		// The dispatch transition, and nothing after it: re-queueing the prompt is
		// `agentStore.processQueuedItem`'s job now (see queueDispatchRecovery.test).
		expect(setSessionsUpdaters).toHaveLength(1);
	});
});

// ============================================================================
// Startup recovery - timer cleanup
// ============================================================================

describe('startup recovery - timer cleanup', () => {
	it('cancels the startup timer when the component unmounts before 500ms', () => {
		vi.useFakeTimers();

		const tab = createTab({ id: 'tab-1' });
		const item = createQueuedItem({ tabId: 'tab-1' });
		const session = createSession({
			id: 'sess-unmount',
			state: 'idle',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			executionQueue: [item],
		});

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [session];
		mockGetActiveTab.mockReturnValue(tab);

		const { unmount } = renderHook(() => useQueueProcessing(createDeps()));

		// Unmount before timer fires
		unmount();

		act(() => {
			vi.advanceTimersByTime(1000);
		});

		expect(mockSetSessions).not.toHaveBeenCalled();
		expect(mockAgentStoreProcessQueuedItem).not.toHaveBeenCalled();
	});
});

// ============================================================================
// Return type
// ============================================================================

// ============================================================================
// Runtime queue recovery - dispatches stuck items after error recovery
// ============================================================================

describe('runtime queue recovery', () => {
	it('dispatches queued items when a session transitions from error to idle', () => {
		vi.useFakeTimers();

		// Start with sessions loaded and startup recovery already done (no queued items initially)
		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [createSession({ state: 'idle', executionQueue: [] })];

		const { rerender } = renderHook(() => useQueueProcessing(createDeps()));

		// Advance past startup recovery
		act(() => {
			vi.advanceTimersByTime(600);
		});

		mockSetSessions.mockClear();
		mockAgentStoreProcessQueuedItem.mockClear();

		// Simulate: session now idle with a stuck queued item (post-error recovery)
		const tab = createTab({ id: 'tab-1', state: 'idle' });
		const item = createQueuedItem({ id: 'stuck-item', tabId: 'tab-1' });
		mockSessionStoreState.sessions = [
			createSession({
				id: 'session-1',
				state: 'idle',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				executionQueue: [item],
			}),
		];
		mockGetActiveTab.mockReturnValue(tab);

		act(() => {
			rerender();
		});

		expect(mockSetSessions).toHaveBeenCalled();
	});

	it('the updater guards against double-dispatch by re-checking state', () => {
		vi.useFakeTimers();

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [createSession({ state: 'idle', executionQueue: [] })];

		const { rerender } = renderHook(() => useQueueProcessing(createDeps()));

		act(() => {
			vi.advanceTimersByTime(600);
		});

		mockSetSessions.mockClear();

		const tab = createTab({ id: 'tab-1' });
		const item = createQueuedItem({ tabId: 'tab-1' });
		const session = createSession({
			id: 'session-1',
			state: 'idle',
			aiTabs: [tab],
			executionQueue: [item],
		});

		mockSessionStoreState.sessions = [session];
		mockGetActiveTab.mockReturnValue(tab);

		let capturedUpdater: ((prev: Session[]) => Session[]) | null = null;
		mockSetSessions.mockImplementation((updater: any) => {
			capturedUpdater = updater;
			updater(mockSessionStoreState.sessions);
		});

		act(() => {
			rerender();
		});

		// Calling updater with a session already busy should be a no-op
		const alreadyBusy = createSession({
			id: 'session-1',
			state: 'busy',
			aiTabs: [tab],
			executionQueue: [item],
		});
		const result = capturedUpdater!([alreadyBusy]);
		expect(result[0]).toBe(alreadyBusy); // unchanged reference = no mutation
	});

	it('does not fire before startup recovery has completed', () => {
		vi.useFakeTimers();

		const tab = createTab({ id: 'tab-1' });
		const item = createQueuedItem({ tabId: 'tab-1' });

		// Sessions loaded with queued items - startup recovery should handle this, not runtime
		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [
			createSession({
				state: 'idle',
				aiTabs: [tab],
				executionQueue: [item],
			}),
		];
		mockGetActiveTab.mockReturnValue(tab);

		renderHook(() => useQueueProcessing(createDeps()));

		// Before startup timer fires (500ms), runtime recovery should NOT have dispatched
		// because startupRecoveryComplete is still false
		expect(mockSetSessions).not.toHaveBeenCalled();

		// After startup timer fires - startup recovery dispatches the items
		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect(mockSetSessions).toHaveBeenCalled();
	});

	it('skips sessions that are busy', () => {
		vi.useFakeTimers();

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [createSession({ state: 'idle', executionQueue: [] })];

		const { rerender } = renderHook(() => useQueueProcessing(createDeps()));

		act(() => {
			vi.advanceTimersByTime(600);
		});

		mockSetSessions.mockClear();

		// Session is busy with queued items - should NOT dispatch
		mockSessionStoreState.sessions = [
			createSession({
				state: 'busy',
				executionQueue: [createQueuedItem()],
			}),
		];

		act(() => {
			rerender();
		});

		expect(mockSetSessions).not.toHaveBeenCalled();
	});

	it('skips sessions in error state', () => {
		vi.useFakeTimers();

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [createSession({ state: 'idle', executionQueue: [] })];

		const { rerender } = renderHook(() => useQueueProcessing(createDeps()));

		act(() => {
			vi.advanceTimersByTime(600);
		});

		mockSetSessions.mockClear();

		// Session in error state with queued items - should NOT dispatch
		mockSessionStoreState.sessions = [
			createSession({
				state: 'error',
				executionQueue: [createQueuedItem()],
			}),
		];

		act(() => {
			rerender();
		});

		expect(mockSetSessions).not.toHaveBeenCalled();
	});

	it('after auto-resume, dispatches only the runnable item and leaves paused items held', async () => {
		// Auto-Resume On Limit (Phase 4): when the coordinator clears a limit pause
		// the session goes idle and this effect drains the persisted queue. Items the
		// user individually held (paused: true) must stay skipped - the resume must
		// not un-pause them.
		vi.useFakeTimers();

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [createSession({ state: 'idle', executionQueue: [] })];

		const { rerender } = renderHook(() => useQueueProcessing(createDeps()));

		// Complete startup recovery so runtime recovery is allowed to fire.
		act(() => {
			vi.advanceTimersByTime(600);
		});

		mockSetSessions.mockClear();
		mockAgentStoreProcessQueuedItem.mockClear();

		const tab = createTab({ id: 'tab-1', state: 'idle' });
		const heldItem = createQueuedItem({ id: 'held', tabId: 'tab-1', paused: true });
		const runnableItem = createQueuedItem({ id: 'runnable', tabId: 'tab-1' });
		const session = createSession({
			id: 'session-1',
			state: 'idle',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			// Held item is ahead of the runnable one in the queue.
			executionQueue: [heldItem, runnableItem],
		});

		mockSessionStoreState.sessions = [session];
		mockGetActiveTab.mockReturnValue(tab);

		let capturedUpdater: ((prev: Session[]) => Session[]) | null = null;
		mockSetSessions.mockImplementation((updater: any) => {
			capturedUpdater = updater;
			updater(mockSessionStoreState.sessions);
		});

		await act(async () => {
			rerender();
			await Promise.resolve();
		});

		// Only the runnable item was dispatched; the held one was skipped.
		expect(mockAgentStoreProcessQueuedItem).toHaveBeenCalledOnce();
		expect(mockAgentStoreProcessQueuedItem.mock.calls[0][1].id).toBe('runnable');

		// The held item stays in the queue (still paused); the runnable one is removed.
		const updated = capturedUpdater!([session]);
		expect(updated[0].executionQueue.map((i) => i.id)).toEqual(['held']);
		expect(updated[0].executionQueue[0].paused).toBe(true);
	});

	it('does not dispatch at all when every queued item is paused', () => {
		vi.useFakeTimers();

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [createSession({ state: 'idle', executionQueue: [] })];

		const { rerender } = renderHook(() => useQueueProcessing(createDeps()));

		act(() => {
			vi.advanceTimersByTime(600);
		});

		mockSetSessions.mockClear();
		mockAgentStoreProcessQueuedItem.mockClear();

		const tab = createTab({ id: 'tab-1', state: 'idle' });
		mockSessionStoreState.sessions = [
			createSession({
				id: 'session-1',
				state: 'idle',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				executionQueue: [
					createQueuedItem({ id: 'held-a', tabId: 'tab-1', paused: true }),
					createQueuedItem({ id: 'held-b', tabId: 'tab-1', paused: true }),
				],
			}),
		];
		mockGetActiveTab.mockReturnValue(tab);

		act(() => {
			rerender();
		});

		// All held → queue reads as drained → nothing dispatched, session stays put.
		expect(mockSetSessions).not.toHaveBeenCalled();
		expect(mockAgentStoreProcessQueuedItem).not.toHaveBeenCalled();
	});
});

// ============================================================================
// Agent Resilience hold
// ============================================================================

describe('runtime recovery — Agent Resilience hold', () => {
	/** Render, run out the startup window, and clear the setSessions spy. */
	function primeAfterStartup() {
		vi.useFakeTimers();
		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [createSession({ state: 'idle', executionQueue: [] })];

		const { rerender } = renderHook(() => useQueueProcessing(createDeps()));
		act(() => {
			vi.advanceTimersByTime(600);
		});
		mockSetSessions.mockClear();
		return rerender;
	}

	function idleSessionWithQueue(): Session[] {
		const tab = createTab({ id: 'tab-1', state: 'idle' });
		mockGetActiveTab.mockReturnValue(tab);
		return [
			createSession({
				id: 'session-1',
				state: 'idle',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				executionQueue: [
					createQueuedItem({ id: 'held-1', tabId: 'tab-1' }),
					createQueuedItem({ id: 'held-2', tabId: 'tab-1' }),
				],
			}),
		];
	}

	it('does not dispatch while a retry is counting down for the target tab', () => {
		const rerender = primeAfterStartup();

		// The agent errored on quota, Agent Resilience took over, and the exit path
		// left the agent idle with its queue intact. Recovery must not step in.
		pendingRetryTabs.add('tab-1');
		mockSessionStoreState.sessions = idleSessionWithQueue();

		act(() => {
			rerender();
		});

		expect(mockSetSessions).not.toHaveBeenCalled();
		expect(mockAgentStoreProcessQueuedItem).not.toHaveBeenCalled();
	});

	it('dispatches when the retry is for a different tab than the queued item', () => {
		const rerender = primeAfterStartup();

		pendingRetryTabs.add('some-other-tab');
		mockSessionStoreState.sessions = idleSessionWithQueue();

		act(() => {
			rerender();
		});

		expect(mockSetSessions).toHaveBeenCalled();
	});

	it('drains the held queue once the retry clears', () => {
		const rerender = primeAfterStartup();

		pendingRetryTabs.add('tab-1');
		mockSessionStoreState.sessions = idleSessionWithQueue();
		act(() => {
			rerender();
		});
		expect(mockSetSessions).not.toHaveBeenCalled();

		// The retry resolved (fired, recovered, or the user pressed Stop). The store
		// slice changes identity, which is what re-runs the recovery effect - the
		// session list is deliberately untouched here.
		pendingRetryTabs.delete('tab-1');
		mockRetries = { changed: true };

		act(() => {
			rerender();
		});

		expect(mockSetSessions).toHaveBeenCalled();
	});
});

// ============================================================================
// Busy target tab
// ============================================================================

describe('dispatch — busy target tab', () => {
	/**
	 * The agent reads idle while the item's own tab is still mid-turn. Real, and
	 * the reason main rejects the spawn with "Agent process already running for
	 * session <id>-ai-<tabId>": the process is keyed per tab, not per agent.
	 */
	function idleAgentBusyTab(): Session[] {
		const busyTab = createTab({ id: 'tab-1', state: 'busy' });
		mockGetActiveTab.mockReturnValue(busyTab);
		return [
			createSession({
				id: 'session-1',
				state: 'idle',
				aiTabs: [busyTab],
				activeTabId: 'tab-1',
				executionQueue: [createQueuedItem({ id: 'queued-1', tabId: 'tab-1' })],
			}),
		];
	}

	it('does not dispatch when the target tab is still mid-turn', () => {
		vi.useFakeTimers();
		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = idleAgentBusyTab();

		// Let the real updater run so the guard inside it is what decides.
		mockSetSessions.mockImplementation((updater: any) => {
			if (typeof updater === 'function') updater(mockSessionStoreState.sessions);
		});

		renderHook(() => useQueueProcessing(createDeps()));
		act(() => {
			vi.advanceTimersByTime(600);
		});

		expect(mockAgentStoreProcessQueuedItem).not.toHaveBeenCalled();
	});

	it('leaves the queued item in place when the target tab is busy', () => {
		vi.useFakeTimers();
		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = idleAgentBusyTab();

		let capturedUpdater: ((prev: Session[]) => Session[]) | null = null;
		mockSetSessions.mockImplementation((updater: any) => {
			capturedUpdater = updater;
			updater(mockSessionStoreState.sessions);
		});

		renderHook(() => useQueueProcessing(createDeps()));
		act(() => {
			vi.advanceTimersByTime(600);
		});

		const before = mockSessionStoreState.sessions;
		const after = capturedUpdater!(before);
		// Unchanged reference = the item was never taken off the queue.
		expect(after[0]).toBe(before[0]);
	});

	it('dispatches once the same tab goes idle', () => {
		vi.useFakeTimers();
		mockSessionStoreState.sessionsLoaded = true;
		const idleTab = createTab({ id: 'tab-1', state: 'idle' });
		mockGetActiveTab.mockReturnValue(idleTab);
		mockSessionStoreState.sessions = [
			createSession({
				id: 'session-1',
				state: 'idle',
				aiTabs: [idleTab],
				activeTabId: 'tab-1',
				executionQueue: [createQueuedItem({ id: 'queued-1', tabId: 'tab-1' })],
			}),
		];

		mockSetSessions.mockImplementation((updater: any) => {
			if (typeof updater === 'function') updater(mockSessionStoreState.sessions);
		});

		renderHook(() => useQueueProcessing(createDeps()));
		act(() => {
			vi.advanceTimersByTime(600);
		});

		expect(mockAgentStoreProcessQueuedItem).toHaveBeenCalledTimes(1);
	});
});

// ============================================================================
// Failed dispatch cleanup
// ============================================================================

describe('dispatch failure — the hook owns the rejection, not the recovery', () => {
	// Releasing the tab and putting the prompt back moved into
	// `agentStore.processQueuedItem`'s catch, because it is the only place that
	// can tell a transient spawn collision from a real failure - and because five
	// of the eight dispatch sites had no recovery of their own, which is how a
	// collision destroyed a user's message. What this hook still owns is the
	// REJECTION: unhandled, it surfaces as a crash report instead of a log.
	it('logs the rejection and writes no recovery updater of its own', async () => {
		vi.useFakeTimers();

		const target = createTab({ id: 'tab-1', state: 'idle' });
		const otherWorking = createTab({ id: 'tab-2', state: 'busy' });
		const item = createQueuedItem({ id: 'queued-1', tabId: 'tab-1' });
		const session = createSession({
			id: 'sess-mixed-busy',
			state: 'idle',
			aiTabs: [target, otherWorking],
			activeTabId: 'tab-1',
			executionQueue: [item],
		});

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [session];
		mockGetActiveTab.mockReturnValue(target);

		mockAgentStoreProcessQueuedItem.mockRejectedValueOnce(new Error('spawn refused'));

		const setSessionsUpdaters: Array<(prev: Session[]) => Session[]> = [];
		mockSetSessions.mockImplementation((updater: any) => {
			setSessionsUpdaters.push(updater);
			updater(mockSessionStoreState.sessions);
		});

		renderHook(() => useQueueProcessing(createDeps()));

		await act(async () => {
			vi.advanceTimersByTime(500);
			await Promise.resolve();
			await Promise.resolve();
		});

		// One updater only: the dispatch transition. No second, hook-local recovery.
		expect(setSessionsUpdaters).toHaveLength(1);
		expect(mockLoggerError).toHaveBeenCalled();
		expect(String(mockLoggerError.mock.calls[0][0])).toContain('sess-mixed-busy');
	});
});

// ============================================================================
// Agent Resilience deps provider
// ============================================================================

// A prompt spawned outside processQueuedItem (the composer's idle send, remote
// dispatch) snapshots through retryStore.noteDirectDispatch, which needs the
// same deps a queued send gets. This hook owns them, so it registers the builder.
describe('Agent Resilience deps provider', () => {
	it('registers a provider that returns the live deps', () => {
		const custom = [{ command: '/ship', description: 'Ship', prompt: 'ship it' }] as never;
		const customAICommandsRef = { current: custom };
		renderHook(() =>
			useQueueProcessing(createDeps({ conductorProfile: 'pedram', customAICommandsRef }))
		);

		expect(mockRegisterDispatchDepsProvider).toHaveBeenCalledTimes(1);
		const provider = mockRegisterDispatchDepsProvider.mock.calls[0][0] as () => {
			conductorProfile: string;
			customAICommands: unknown[];
			bmadCommands: unknown[];
		};
		const deps = provider();
		expect(deps.conductorProfile).toBe('pedram');
		expect(deps.customAICommands).toBe(custom);
		expect(deps.bmadCommands).toEqual([]);

		// Read at replay time, not frozen at mount: a command added later resolves.
		const later = [{ command: '/later', description: 'Later', prompt: 'later' }] as never;
		customAICommandsRef.current = later;
		expect(provider().customAICommands).toBe(later);
	});

	it('unregisters on unmount so a stale closure never supplies deps', () => {
		const { unmount } = renderHook(() => useQueueProcessing(createDeps()));
		unmount();

		expect(mockRegisterDispatchDepsProvider).toHaveBeenLastCalledWith(null);
	});
});

// ============================================================================
// Return type
// ============================================================================

describe('return type', () => {
	it('returns processQueuedItem as a function', () => {
		const { result } = renderHook(() => useQueueProcessing(createDeps()));
		expect(typeof result.current.processQueuedItem).toBe('function');
	});

	it('returns processQueuedItemRef as a mutable ref object', () => {
		const { result } = renderHook(() => useQueueProcessing(createDeps()));
		expect(result.current.processQueuedItemRef).toBeDefined();
		expect('current' in result.current.processQueuedItemRef).toBe(true);
	});

	it('processQueuedItemRef.current is the same function as processQueuedItem', async () => {
		const deps = createDeps();
		const { result } = renderHook(() => useQueueProcessing(deps));

		// Both should delegate to the same agentStore call
		const item = createQueuedItem();

		await act(async () => {
			await result.current.processQueuedItem('session-1', item);
		});

		await act(async () => {
			await result.current.processQueuedItemRef.current!('session-1', item);
		});

		expect(mockAgentStoreProcessQueuedItem).toHaveBeenCalledTimes(2);
	});
});
