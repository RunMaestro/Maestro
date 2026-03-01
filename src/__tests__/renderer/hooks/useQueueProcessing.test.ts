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
 *   - Startup recovery: on processing error, re-queues the item and resets to idle
 *   - Startup recovery: skips sessions when sessionsLoaded is false
 *   - Startup recovery: runs only once (ref guard prevents repeat runs)
 *   - Startup recovery: skips sessions with empty queues
 *   - Startup recovery: skips sessions that are not idle (e.g., busy)
 *   - Startup recovery: uses getActiveTab fallback when tabId does not match any tab
 *   - Startup recovery: cleans up the timer on unmount
 *   - Return value: exposes processQueuedItem and processQueuedItemRef
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// ============================================================================
// Mocks (declared before imports)
// ============================================================================

const mockAgentStoreProcessQueuedItem = vi.fn();

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

const mockGetActiveTab = vi.fn();

vi.mock('../../../renderer/utils/tabHelpers', () => ({
	getActiveTab: (...args: unknown[]) => mockGetActiveTab(...args),
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
// processQueuedItem — delegation to agentStore
// ============================================================================

describe('processQueuedItem — delegation to agentStore', () => {
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
// processQueuedItemRef — always reflects latest closure
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
// Startup recovery — skipping conditions
// ============================================================================

describe('startup recovery — skipping conditions', () => {
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

		// Capture setSessions calls so we can simulate state
		mockSetSessions.mockImplementation(() => {});

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
// Startup recovery — happy path
// ============================================================================

describe('startup recovery — happy path', () => {
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

		// setSessions is a no-op here; we just want to verify the IPC call
		mockSetSessions.mockImplementation(() => {});

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
		mockSetSessions.mockImplementation(() => {});

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
// Startup recovery — error handling
// ============================================================================

describe('startup recovery — error handling', () => {
	it('calls the second setSessions to re-queue item and reset to idle on processQueuedItem failure', async () => {
		vi.useFakeTimers();

		const tab = createTab({ id: 'tab-1', state: 'idle' });
		const item = createQueuedItem({ id: 'item-fail', tabId: 'tab-1' });
		const session = createSession({
			id: 'sess-fail',
			state: 'idle',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			executionQueue: [item],
		});

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [session];
		mockGetActiveTab.mockReturnValue(tab);

		// processQueuedItem rejects to trigger the catch path
		mockAgentStoreProcessQueuedItem.mockRejectedValueOnce(new Error('agent crashed'));

		const setSessionsUpdaters: Array<(prev: Session[]) => Session[]> = [];
		mockSetSessions.mockImplementation((updater: any) => {
			setSessionsUpdaters.push(updater);
		});

		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		renderHook(() => useQueueProcessing(createDeps()));

		await act(async () => {
			vi.advanceTimersByTime(500);
			// Flush the rejection through the microtask queue
			await Promise.resolve();
			await Promise.resolve();
		});

		consoleError.mockRestore();

		// First call: set to busy. Second call: reset to idle on error.
		expect(setSessionsUpdaters.length).toBeGreaterThanOrEqual(2);

		// Apply the second updater (error recovery)
		const busySession: Session = {
			...session,
			state: 'busy' as any,
			busySource: 'ai' as any,
			thinkingStartTime: Date.now(),
			executionQueue: [], // first item was removed
			aiTabs: [{ ...tab, state: 'busy' as const, thinkingStartTime: Date.now() }],
		};

		const recovered = setSessionsUpdaters[1]([busySession]);
		expect(recovered[0].state).toBe('idle');
		expect(recovered[0].busySource).toBeUndefined();
		expect(recovered[0].thinkingStartTime).toBeUndefined();
	});

	it('re-queues the failed item at the front of executionQueue on error', async () => {
		vi.useFakeTimers();

		const tab = createTab({ id: 'tab-1', state: 'idle' });
		const failedItem = createQueuedItem({ id: 'item-fail', tabId: 'tab-1' });
		const laterItem = createQueuedItem({ id: 'item-later', tabId: 'tab-1' });
		const session = createSession({
			id: 'sess-fail',
			state: 'idle',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			executionQueue: [failedItem, laterItem],
		});

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [session];
		mockGetActiveTab.mockReturnValue(tab);

		mockAgentStoreProcessQueuedItem.mockRejectedValueOnce(new Error('boom'));

		const setSessionsUpdaters: Array<(prev: Session[]) => Session[]> = [];
		mockSetSessions.mockImplementation((updater: any) => {
			setSessionsUpdaters.push(updater);
		});

		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		renderHook(() => useQueueProcessing(createDeps()));

		await act(async () => {
			vi.advanceTimersByTime(500);
			await Promise.resolve();
			await Promise.resolve();
		});

		consoleError.mockRestore();

		// The error recovery updater is the second one
		expect(setSessionsUpdaters.length).toBeGreaterThanOrEqual(2);

		// Simulate the state after the busy updater: queue has only laterItem
		const busySession: Session = {
			...session,
			state: 'busy' as any,
			executionQueue: [laterItem],
			aiTabs: [{ ...tab, state: 'busy' as const }],
		};

		const recovered = setSessionsUpdaters[1]([busySession]);
		// failedItem should be back at the front of the queue
		expect(recovered[0].executionQueue[0].id).toBe('item-fail');
		expect(recovered[0].executionQueue[1].id).toBe('item-later');
	});

	it('resets busy tabs to idle on error recovery', async () => {
		vi.useFakeTimers();

		const tab = createTab({ id: 'tab-1', state: 'idle' });
		const item = createQueuedItem({ tabId: 'tab-1' });
		const session = createSession({
			id: 'sess-fail',
			state: 'idle',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			executionQueue: [item],
		});

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [session];
		mockGetActiveTab.mockReturnValue(tab);

		mockAgentStoreProcessQueuedItem.mockRejectedValueOnce(new Error('boom'));

		const setSessionsUpdaters: Array<(prev: Session[]) => Session[]> = [];
		mockSetSessions.mockImplementation((updater: any) => {
			setSessionsUpdaters.push(updater);
		});

		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		renderHook(() => useQueueProcessing(createDeps()));

		await act(async () => {
			vi.advanceTimersByTime(500);
			await Promise.resolve();
			await Promise.resolve();
		});

		consoleError.mockRestore();

		expect(setSessionsUpdaters.length).toBeGreaterThanOrEqual(2);

		const busySession: Session = {
			...session,
			state: 'busy' as any,
			executionQueue: [],
			aiTabs: [{ ...tab, state: 'busy' as const, thinkingStartTime: Date.now() }],
		};

		const recovered = setSessionsUpdaters[1]([busySession]);
		expect(recovered[0].aiTabs[0].state).toBe('idle');
		expect(recovered[0].aiTabs[0].thinkingStartTime).toBeUndefined();
	});

	it('does not modify tabs that are not busy during error recovery', async () => {
		vi.useFakeTimers();

		const busyTab = createTab({ id: 'tab-busy', state: 'busy' as const });
		const idleTab = createTab({ id: 'tab-idle', state: 'idle' });
		const item = createQueuedItem({ tabId: 'tab-busy' });
		const session = createSession({
			id: 'sess-mixed',
			state: 'idle',
			aiTabs: [busyTab, idleTab],
			activeTabId: 'tab-busy',
			executionQueue: [item],
		});

		mockSessionStoreState.sessionsLoaded = true;
		mockSessionStoreState.sessions = [session];
		mockGetActiveTab.mockReturnValue(busyTab);

		mockAgentStoreProcessQueuedItem.mockRejectedValueOnce(new Error('boom'));

		const setSessionsUpdaters: Array<(prev: Session[]) => Session[]> = [];
		mockSetSessions.mockImplementation((updater: any) => {
			setSessionsUpdaters.push(updater);
		});

		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		renderHook(() => useQueueProcessing(createDeps()));

		await act(async () => {
			vi.advanceTimersByTime(500);
			await Promise.resolve();
			await Promise.resolve();
		});

		consoleError.mockRestore();

		const busySession: Session = {
			...session,
			state: 'busy' as any,
			executionQueue: [],
			aiTabs: [
				{ ...busyTab, state: 'busy' as const },
				{ ...idleTab, state: 'idle' as const },
			],
		};

		const recovered = setSessionsUpdaters[1]([busySession]);
		const recoveredIdle = recovered[0].aiTabs.find((t) => t.id === 'tab-idle');
		// idle tab should remain idle (only busy tabs get reset)
		expect(recoveredIdle?.state).toBe('idle');
	});

	it('logs an error to console when processQueuedItem rejects', async () => {
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
		mockSetSessions.mockImplementation(() => {});

		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		renderHook(() => useQueueProcessing(createDeps()));

		await act(async () => {
			vi.advanceTimersByTime(500);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(consoleError).toHaveBeenCalled();
		const [logMsg] = consoleError.mock.calls[0];
		expect(logMsg).toContain('sess-log');

		consoleError.mockRestore();
	});
});

// ============================================================================
// Startup recovery — timer cleanup
// ============================================================================

describe('startup recovery — timer cleanup', () => {
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
