import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useQueueProcessing } from '../../renderer/hooks/agent/useQueueProcessing';
import type { UseQueueProcessingDeps } from '../../renderer/hooks/agent/useQueueProcessing';
import { useAgentStore } from '../../renderer/stores/agentStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import type {
	AITab,
	CustomAICommand,
	OpenSpecCommand,
	QueuedItem,
	Session,
	SpecKitCommand,
} from '../../renderer/types';

const originalProcessQueuedItem = useAgentStore.getState().processQueuedItem;
const processQueuedItemMock = vi.fn();

function createTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 1700000000000,
		state: 'idle',
		...overrides,
	} as AITab;
}

function createQueuedItem(overrides: Partial<QueuedItem> = {}): QueuedItem {
	return {
		id: 'item-1',
		timestamp: 1700000000001,
		tabId: 'tab-1',
		type: 'message',
		text: 'Run the queued prompt',
		...overrides,
	};
}

function createSession(overrides: Partial<Session> = {}): Session {
	const tab = createTab();

	return {
		id: 'session-1',
		name: 'Queued Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo/project',
		fullPath: '/repo/project',
		projectRoot: '/repo/project',
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
		unifiedTabOrder: [{ type: 'ai', id: tab.id }],
		unifiedClosedTabHistory: [],
		autoRunFolderPath: '/repo/project/.maestro-autorun',
		...overrides,
	} as Session;
}

function renderQueueProcessing(overrides: Partial<UseQueueProcessingDeps> = {}) {
	return renderHook((props) => useQueueProcessing(props), {
		initialProps: {
			conductorProfile: 'integration-profile',
			customAICommandsRef: { current: [] as CustomAICommand[] },
			speckitCommandsRef: { current: [] as SpecKitCommand[] },
			openspecCommandsRef: { current: [] as OpenSpecCommand[] },
			...overrides,
		},
	});
}

async function advanceStartupTimer() {
	await act(async () => {
		vi.advanceTimersByTime(500);
		for (let i = 0; i < 6; i += 1) {
			await Promise.resolve();
		}
	});
}

describe('useQueueProcessing integration', () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers({ now: 1700000000500 });
		processQueuedItemMock.mockReset();
		processQueuedItemMock.mockResolvedValue(undefined);
		useAgentStore.setState({ processQueuedItem: processQueuedItemMock });
		useSessionStore.setState({
			sessions: [],
			activeSessionId: '',
			sessionsLoaded: false,
			initialLoadComplete: true,
			removedWorktreePaths: new Set(),
		});
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	});

	afterEach(() => {
		cleanup();
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		useAgentStore.setState({ processQueuedItem: originalProcessQueuedItem });
		useSessionStore.setState({
			sessions: [],
			activeSessionId: '',
			sessionsLoaded: false,
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
		});
		consoleLogSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});

	it('delegates queued item processing with the current command refs', async () => {
		const item = createQueuedItem();
		const customAICommands = [{ id: 'custom', label: 'Custom' }] as unknown as CustomAICommand[];
		const speckitCommands = [{ id: 'spec', name: 'Spec' }] as unknown as SpecKitCommand[];
		const openspecCommands = [{ id: 'open', name: 'Open' }] as unknown as OpenSpecCommand[];
		const { result } = renderQueueProcessing({
			customAICommandsRef: { current: customAICommands },
			speckitCommandsRef: { current: speckitCommands },
			openspecCommandsRef: { current: openspecCommands },
		});

		await act(async () => {
			await result.current.processQueuedItem('session-1', item);
		});

		expect(result.current.processQueuedItemRef.current).toBe(result.current.processQueuedItem);
		expect(processQueuedItemMock).toHaveBeenCalledWith('session-1', item, {
			conductorProfile: 'integration-profile',
			customAICommands,
			speckitCommands,
			openspecCommands,
			bmadCommands: [],
		});
	});

	it('falls back to empty command arrays when refs are null', async () => {
		const item = createQueuedItem();
		const { result } = renderQueueProcessing({
			customAICommandsRef: { current: null },
			speckitCommandsRef: { current: null },
			openspecCommandsRef: { current: null },
		});

		await act(async () => {
			await result.current.processQueuedItemRef.current?.('session-1', item);
		});

		expect(processQueuedItemMock).toHaveBeenCalledWith('session-1', item, {
			conductorProfile: 'integration-profile',
			customAICommands: [],
			speckitCommands: [],
			openspecCommands: [],
			bmadCommands: [],
		});
	});

	it('skips startup recovery until sessions are loaded and eligible', async () => {
		useSessionStore.setState({
			sessionsLoaded: false,
			sessions: [createSession({ executionQueue: [createQueuedItem()] })],
		});

		renderQueueProcessing();
		await advanceStartupTimer();

		expect(processQueuedItemMock).not.toHaveBeenCalled();

		act(() => {
			useSessionStore.setState({
				sessionsLoaded: true,
				sessions: [
					createSession({ id: 'empty-session', executionQueue: [] }),
					createSession({
						id: 'busy-session',
						state: 'busy',
						executionQueue: [createQueuedItem({ id: 'busy-item' })],
					}),
				],
			});
		});
		await advanceStartupTimer();

		expect(processQueuedItemMock).not.toHaveBeenCalled();
		expect(consoleLogSpy).not.toHaveBeenCalledWith(
			expect.stringContaining('leftover queued items')
		);
	});

	it('marks leftover queued sessions busy and processes the first queued item on startup', async () => {
		const firstItem = createQueuedItem({ id: 'item-1', tabId: 'tab-2' });
		const secondItem = createQueuedItem({ id: 'item-2', tabId: 'tab-1' });
		const session = createSession({
			executionQueue: [firstItem, secondItem],
			aiTabs: [createTab({ id: 'tab-1' }), createTab({ id: 'tab-2' })],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessionsLoaded: true, sessions: [session] });

		renderQueueProcessing();
		await advanceStartupTimer();

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.state).toBe('busy');
		expect(updated.busySource).toBe('ai');
		expect(updated.currentCycleTokens).toBe(0);
		expect(updated.currentCycleBytes).toBe(0);
		expect(updated.executionQueue).toEqual([secondItem]);
		expect(updated.aiTabs.find((tab) => tab.id === 'tab-2')?.state).toBe('busy');
		expect(updated.aiTabs.find((tab) => tab.id === 'tab-1')?.state).toBe('idle');
		expect(processQueuedItemMock).toHaveBeenCalledWith(
			session.id,
			firstItem,
			expect.objectContaining({ conductorProfile: 'integration-profile' })
		);
	});

	it('uses the active tab when a queued item references a missing tab', async () => {
		const queuedItem = createQueuedItem({ tabId: 'deleted-tab' });
		const session = createSession({
			executionQueue: [queuedItem],
			aiTabs: [createTab({ id: 'tab-1' }), createTab({ id: 'tab-2' })],
			activeTabId: 'tab-2',
		});
		useSessionStore.setState({ sessionsLoaded: true, sessions: [session] });

		renderQueueProcessing();
		await advanceStartupTimer();

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs.find((tab) => tab.id === 'tab-2')?.state).toBe('busy');
		expect(updated.aiTabs.find((tab) => tab.id === 'tab-1')?.state).toBe('idle');
	});

	it('requeues a failed startup item and resets busy state', async () => {
		const failure = new Error('queue failed');
		processQueuedItemMock.mockRejectedValueOnce(failure);
		const firstItem = createQueuedItem({ id: 'item-1', tabId: 'tab-2' });
		const secondItem = createQueuedItem({ id: 'item-2' });
		const session = createSession({
			executionQueue: [firstItem, secondItem],
			aiTabs: [createTab({ id: 'tab-1' }), createTab({ id: 'tab-2' })],
		});
		const untouchedSession = createSession({
			id: 'untouched-session',
			executionQueue: [],
			aiTabs: [createTab({ id: 'untouched-tab' })],
			activeTabId: 'untouched-tab',
		});
		useSessionStore.setState({ sessionsLoaded: true, sessions: [session, untouchedSession] });

		renderQueueProcessing();
		await advanceStartupTimer();

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.state).toBe('idle');
		expect(updated.busySource).toBeUndefined();
		expect(updated.thinkingStartTime).toBeUndefined();
		expect(updated.executionQueue).toEqual([firstItem, secondItem]);
		expect(updated.aiTabs.every((tab) => tab.state === 'idle')).toBe(true);
		expect(useSessionStore.getState().sessions[1]).toEqual(untouchedSession);
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			'[QueueProcessing] Failed for session session-1:',
			failure
		);
	});

	it('clears the startup recovery timer on unmount', async () => {
		const session = createSession({ executionQueue: [createQueuedItem()] });
		useSessionStore.setState({ sessionsLoaded: true, sessions: [session] });
		const { unmount } = renderQueueProcessing();

		unmount();
		await advanceStartupTimer();

		expect(processQueuedItemMock).not.toHaveBeenCalled();
		expect(useSessionStore.getState().sessions[0]).toEqual(session);
	});
});
