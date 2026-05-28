import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentExitListener } from '../../../../../renderer/hooks/agent/internal/useAgentExitListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';

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

function makeBatched() {
	return {
		appendLog: vi.fn(),
		markDelivered: vi.fn(),
		markUnread: vi.fn(),
		updateUsage: vi.fn(),
		updateContextUsage: vi.fn(),
		updateCycleBytes: vi.fn(),
		updateCycleTokens: vi.fn(),
		flushNow: vi.fn(),
	};
}

function makeDeps() {
	return {
		batchedUpdater: makeBatched(),
		getBatchStateRef: { current: null },
		processQueuedItemRef: { current: null },
		addHistoryEntryRef: { current: null },
		spawnBackgroundSynopsisRef: { current: null },
		rightPanelRef: { current: null },
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

	// Regression for #1022: trailing batched stdout chunks must be flushed
	// before the queued-message dispatch appends a new user log entry,
	// otherwise late chunks land after the user entry and merge with the
	// next response's bubble in collapsedLogs grouping.
	it('flushes batched updates at the top of onExit', async () => {
		const deps = makeDeps();
		renderHook(() => useAgentExitListener(deps));
		await act(async () => {
			await handler!('sess-1-ai-tab-1', 0);
		});
		expect(deps.batchedUpdater.flushNow).toHaveBeenCalled();
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
