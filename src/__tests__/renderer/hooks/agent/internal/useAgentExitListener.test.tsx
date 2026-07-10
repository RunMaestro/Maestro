import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentExitListener } from '../../../../../renderer/hooks/agent/internal/useAgentExitListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';

const { mockRefreshReviewReadyMovement } = vi.hoisted(() => ({
	mockRefreshReviewReadyMovement: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../../../renderer/hooks/agent/internal/helpers/exitReviewReady', () => ({
	refreshReviewReadyMovement: mockRefreshReviewReadyMovement,
}));

let handler: ((sessionId: string, code: number) => Promise<void>) | undefined;
const mockUnsubscribe = vi.fn();

const mockProcess = {
	onExit: vi.fn((h: any) => {
		handler = h;
		return mockUnsubscribe;
	}),
	getActiveProcesses: vi.fn().mockResolvedValue([]),
};

function makeRef(): {
	current: Map<string, { toolName: string; toolState?: any }>;
} {
	return { current: new Map() };
}

function makeDeps() {
	return {
		getBatchStateRef: { current: null },
		processQueuedItemRef: { current: null },
		addHistoryEntryRef: { current: null },
		spawnBackgroundSynopsisRef: { current: null },
		rightPanelRef: { current: null },
		batchedUpdater: {
			appendLog: vi.fn(),
			markDelivered: vi.fn(),
			markUnread: vi.fn(),
			updateUsage: vi.fn(),
			updateContextUsage: vi.fn(),
			updateCycleBytes: vi.fn(),
			updateCycleTokens: vi.fn(),
			flushNow: vi.fn(),
		},
		activeHiddenToolRef: makeRef(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	handler = undefined;
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
	});
	useSettingsStore.setState({
		encoreFeatures: {
			...useSettingsStore.getState().encoreFeatures,
			concerto: false,
		},
	});
	(window as any).maestro = {
		...((window as any).maestro || {}),
		process: mockProcess,
		stats: { recordQuery: vi.fn().mockResolvedValue(undefined) },
		logger: { log: vi.fn() },
	};
});

describe('useAgentExitListener', () => {
	it('skips terminal-tab format session ids', async () => {
		renderHook(() => useAgentExitListener(makeDeps()));
		await handler!('sess-1-terminal-tab-1', 0);
		expect(mockProcess.getActiveProcesses).not.toHaveBeenCalled();
	});

	it('skips batch session ids', async () => {
		renderHook(() => useAgentExitListener(makeDeps()));
		await handler!('sess-1-batch-tab-1', 0);
		expect(mockProcess.getActiveProcesses).not.toHaveBeenCalled();
	});

	it('transitions an exiting AI tab to idle', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			state: 'busy',
			thinkingStartTime: 0,
		});
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentExitListener(makeDeps()));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 0);
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs[0].state).toBe('idle');
		expect(updated.state).toBe('idle');
	});

	it('refreshes the review-ready Movement after successful queue-empty write work', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			state: 'busy',
			showThinking: 'on',
			logs: [
				{ id: 'user', timestamp: 1, source: 'user', text: 'Implement the feature' },
				{ id: 'tool', timestamp: 2, source: 'tool', text: 'Edit file' },
				{ id: 'ai', timestamp: 3, source: 'stdout', text: 'Implemented.' },
			],
		});
		const session = createMockSession({
			id: 'sess-1',
			name: 'Maestro',
			cwd: '/repo',
			isGitRepo: true,
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
		});
		useSessionStore.setState({ sessions: [session] } as any);
		useSettingsStore.setState({
			encoreFeatures: {
				...useSettingsStore.getState().encoreFeatures,
				concerto: true,
			},
		});

		renderHook(() => useAgentExitListener(makeDeps()));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 0);
		});

		expect(mockRefreshReviewReadyMovement).toHaveBeenCalledWith({
			sessionId: 'sess-1',
			tabId: 'tab-1',
			projectName: 'Maestro',
			cwd: '/repo',
			sshRemoteId: undefined,
		});
	});

	it('does not surface review-ready work from a read-only tab', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			state: 'busy',
			readOnlyMode: true,
			showThinking: 'on',
			logs: [
				{ id: 'user', timestamp: 1, source: 'user', text: 'Inspect the feature' },
				{ id: 'tool', timestamp: 2, source: 'tool', text: 'Read file' },
			],
		});
		const session = createMockSession({
			id: 'sess-1',
			isGitRepo: true,
			aiTabs: [tab],
			activeTabId: 'tab-1',
			state: 'busy',
		});
		useSessionStore.setState({ sessions: [session] } as any);
		useSettingsStore.setState({
			encoreFeatures: {
				...useSettingsStore.getState().encoreFeatures,
				concerto: true,
			},
		});

		renderHook(() => useAgentExitListener(makeDeps()));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 0);
		});

		expect(mockRefreshReviewReadyMovement).not.toHaveBeenCalled();
	});

	it('appends a system log on terminal exit', async () => {
		const session = createMockSession({ id: 'sess-1', shellLogs: [] });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentExitListener(makeDeps()));
		await act(async () => {
			await handler!('sess-1-terminal', 1);
		});

		const updated = useSessionStore.getState().sessions[0];
		const log = updated.shellLogs[updated.shellLogs.length - 1];
		expect(log?.text).toContain('exited with code 1');
	});

	it('retires a finished orphan and dispatches the next queued item for ANOTHER tab exactly once', async () => {
		// Regression: A is a closed/orphaned tab whose turn just finished. B is a
		// second closed/orphaned tab with a queued read-only message; C is an open
		// tab with a queued read-only message. When A exits, the retire branch must
		// dequeue B's item (in lockstep with the post-reducer spawn) and mark B busy
		// - NOT leave it in the queue. Leaving it queued caused B to run twice (once
		// from queuedItemToProcess at A's exit, again when that run exited) and never
		// surface as busy in the UI.
		const orphanA = createMockAITab({ id: 'tab-A', state: 'busy', thinkingStartTime: 0 });
		const orphanB = createMockAITab({ id: 'tab-B', state: 'idle', agentSessionId: 'asid-B' });
		const tabC = createMockAITab({ id: 'tab-C', state: 'idle' });
		const itemB = {
			id: 'item-B',
			timestamp: 1,
			tabId: 'tab-B',
			type: 'message' as const,
			text: 'BRAVO',
			readOnlyMode: true,
		};
		const itemC = {
			id: 'item-C',
			timestamp: 2,
			tabId: 'tab-C',
			type: 'message' as const,
			text: 'CHARLIE',
			readOnlyMode: true,
		};
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tabC],
			orphanedThinkingTabs: [orphanA, orphanB],
			activeTabId: 'tab-C',
			state: 'busy',
			busySource: 'ai',
			executionQueue: [itemB, itemC] as any,
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const processQueuedItem = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps();
		deps.processQueuedItemRef.current = processQueuedItem as any;

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-A', 0);
			// queued-item dispatch is fired on a setTimeout(0) after the reducer
			await new Promise((r) => setTimeout(r, 0));
		});

		const updated = useSessionStore.getState().sessions[0];
		// A retired; B promoted to busy and dequeued; C still queued.
		expect(updated.orphanedThinkingTabs?.map((t) => t.id)).toEqual(['tab-B']);
		expect(updated.orphanedThinkingTabs?.[0].state).toBe('busy');
		expect(updated.executionQueue.map((i) => i.id)).toEqual(['item-C']);
		expect(updated.state).toBe('busy');
		// Spawned exactly once, with B's item.
		expect(processQueuedItem).toHaveBeenCalledTimes(1);
		expect(processQueuedItem.mock.calls[0][1].id).toBe('item-B');
	});

	it('retires a finished orphan with no queued work and goes idle', async () => {
		const orphanA = createMockAITab({ id: 'tab-A', state: 'busy', thinkingStartTime: 0 });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [createMockAITab({ id: 'tab-C', state: 'idle' })],
			orphanedThinkingTabs: [orphanA],
			activeTabId: 'tab-C',
			state: 'busy',
			busySource: 'ai',
			executionQueue: [],
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const processQueuedItem = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps();
		deps.processQueuedItemRef.current = processQueuedItem as any;

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-A', 0);
			await new Promise((r) => setTimeout(r, 0));
		});

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.orphanedThinkingTabs).toBeUndefined();
		expect(updated.state).toBe('idle');
		expect(processQueuedItem).not.toHaveBeenCalled();
	});

	it('deletes activeHiddenToolRef entry on AI exit', async () => {
		const tab = createMockAITab({ id: 'tab-1', state: 'busy' });
		const session = createMockSession({
			id: 'sess-1',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const deps = makeDeps();
		deps.activeHiddenToolRef.current.set('sess-1:tab-1', { toolName: 'Read' });

		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 0);
		});

		expect(deps.activeHiddenToolRef.current.has('sess-1:tab-1')).toBe(false);
	});
});
