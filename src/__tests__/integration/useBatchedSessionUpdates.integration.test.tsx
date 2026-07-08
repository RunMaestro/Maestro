import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBatchedSessionUpdates } from '../../renderer/hooks/session/useBatchedSessionUpdates';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import type { AITab, LogEntry, Session, UsageStats } from '../../renderer/types';

function usage(overrides: Partial<UsageStats> = {}): UsageStats {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0,
		contextWindow: 200000,
		...overrides,
	};
}

function log(
	source: LogEntry['source'],
	text: string,
	overrides: Partial<LogEntry> = {}
): LogEntry {
	return {
		id: `${source}-${text}`,
		timestamp: Date.now(),
		source,
		text,
		...overrides,
	};
}

function tab(overrides: Partial<AITab> = {}): AITab {
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
	};
}

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test',
		fullPath: '/test',
		projectRoot: '/test',
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
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

function resetStore() {
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		sessionsLoaded: true,
		initialLoadComplete: true,
		removedWorktreePaths: new Set(),
		cyclePosition: -1,
	} as any);
}

function getSession(id = 'session-1'): Session {
	const found = useSessionStore.getState().sessions.find((candidate) => candidate.id === id);
	if (!found) {
		throw new Error(`Missing test session ${id}`);
	}
	return found;
}

describe('useBatchedSessionUpdates integration', () => {
	beforeEach(() => {
		resetStore();
	});

	afterEach(() => {
		cleanup();
		resetStore();
	});

	it('flushes AI logs, markers, status, usage, context, cycle, and unread state together', () => {
		const now = Date.now();
		useSessionStore.setState({
			sessions: [
				session({
					state: 'busy',
					usageStats: usage({ inputTokens: 10, totalCostUsd: 0.5 }),
					contextUsage: 5,
					currentCycleBytes: 2,
					currentCycleTokens: 3,
					aiTabs: [
						tab({
							usageStats: usage({ totalCostUsd: 0.25 }),
							logs: [
								log('user', 'first', { id: 'user-1', timestamp: now - 300, delivered: false }),
								log('user', 'second', { id: 'user-2', timestamp: now - 250, delivered: false }),
								log('thinking', 'planning', { id: 'thinking-1', timestamp: now - 200 }),
								log('tool', 'reading', { id: 'tool-1', timestamp: now - 150 }),
								log('stdout', 'partial', { id: 'stdout-1', timestamp: now - 100 }),
							],
						}),
					],
					activeTabId: 'tab-1',
				}),
			],
			activeSessionId: 'session-1',
		});
		const { result } = renderHook(() => useBatchedSessionUpdates(1000));

		act(() => {
			result.current.appendLog('session-1', 'tab-1', true, ' chunk');
			result.current.appendLog('session-1', 'tab-1', true, ' done');
			result.current.setStatus('session-1', 'busy');
			result.current.setStatus('session-1', 'idle');
			result.current.setTabStatus('session-1', 'tab-1', 'busy');
			result.current.updateUsage(
				'session-1',
				null,
				usage({
					inputTokens: 1,
					outputTokens: 2,
					cacheReadInputTokens: 3,
					cacheCreationInputTokens: 4,
					totalCostUsd: 0.1,
					reasoningTokens: 5,
					contextWindow: 100000,
				})
			);
			result.current.updateUsage(
				'session-1',
				null,
				usage({
					inputTokens: 6,
					outputTokens: 7,
					cacheReadInputTokens: 8,
					cacheCreationInputTokens: 9,
					totalCostUsd: 0.2,
					reasoningTokens: 10,
					contextWindow: 120000,
				})
			);
			result.current.updateUsage(
				'session-1',
				'tab-1',
				usage({ inputTokens: 20, outputTokens: 30, totalCostUsd: 0.3, contextWindow: 80000 })
			);
			result.current.updateUsage(
				'session-1',
				'tab-1',
				usage({
					inputTokens: 40,
					outputTokens: 50,
					totalCostUsd: 0.4,
					reasoningTokens: 6,
					contextWindow: 90000,
				})
			);
			result.current.updateContextUsage('session-1', 80);
			result.current.resetContextUsage('session-1', 12);
			result.current.markDelivered('session-1', 'tab-1');
			result.current.updateCycleBytes('session-1', 10);
			result.current.updateCycleBytes('session-1', 5);
			result.current.updateCycleTokens('session-1', 11);
			result.current.updateCycleTokens('session-1', 7);
			result.current.markUnread('session-1', 'tab-1', true);
		});
		expect(result.current.hasPending).toBe(true);

		act(() => result.current.flushNow());

		const updated = getSession();
		const updatedTab = updated.aiTabs[0];
		expect(result.current.hasPending).toBe(false);
		expect(updated.state).toBe('idle');
		expect(updated.contextUsage).toBe(12);
		expect(updated.currentCycleBytes).toBe(17);
		expect(updated.currentCycleTokens).toBe(21);
		expect(updated.usageStats).toMatchObject({
			inputTokens: 17,
			outputTokens: 9,
			cacheReadInputTokens: 11,
			cacheCreationInputTokens: 13,
			totalCostUsd: 0.8,
			reasoningTokens: 15,
			contextWindow: 120000,
		});
		expect(updatedTab.state).toBe('busy');
		expect(updatedTab.hasUnread).toBe(true);
		expect(updatedTab.usageStats).toMatchObject({
			inputTokens: 40,
			outputTokens: 50,
			totalCostUsd: 0.95,
			reasoningTokens: 6,
			contextWindow: 90000,
		});
		expect(updatedTab.logs.map((entry) => entry.source)).toEqual(['user', 'user', 'stdout']);
		expect(updatedTab.logs[0].delivered).toBe(false);
		expect(updatedTab.logs[1].delivered).toBe(true);
		expect(updatedTab.logs[2].text).toBe('partial chunk done');
	});

	it('handles sticky AI logs, stderr, shell grouping, missing tabs, and missing sessions', () => {
		useSessionStore.setState({
			sessions: [
				session({
					id: 'sticky',
					state: 'busy',
					aiTabs: [
						tab({
							showThinking: 'sticky',
							logs: [log('thinking', 'keep'), log('tool', 'keep tool')],
						}),
					],
					activeTabId: 'tab-1',
					shellLogs: [log('stdout', 'shell')],
				}),
				session({
					id: 'idle-shell',
					state: 'idle',
					shellLogs: [log('stdout', 'idle-shell')],
					aiTabs: [tab({ id: 'other-tab' })],
					activeTabId: 'other-tab',
				}),
			],
		});
		const before = useSessionStore.getState().sessions;
		const { result } = renderHook(() => useBatchedSessionUpdates(1000));

		act(() => {
			result.current.appendLog('sticky', 'tab-1', true, ' final');
			result.current.appendLog('sticky', null, false, ' out');
			result.current.appendLog('sticky', null, false, ' err-one', true);
			result.current.appendLog('sticky', null, false, ' err-two', true);
			result.current.appendLog('idle-shell', null, false, ' new');
			result.current.setTabStatus('idle-shell', 'missing-tab', 'busy');
			result.current.markDelivered('idle-shell', 'missing-tab');
			result.current.markUnread('idle-shell', 'missing-tab', true);
			result.current.appendLog('missing-session', null, false, 'ignored');
			result.current.appendLog('sticky', 'tab-1', true, '');
		});

		act(() => result.current.flushNow());

		const sticky = getSession('sticky');
		expect(sticky.aiTabs[0].logs.map((entry) => entry.source)).toEqual([
			'thinking',
			'tool',
			'stdout',
		]);
		expect(sticky.aiTabs[0].logs[2].text).toBe(' final');
		expect(sticky.shellLogs.map((entry) => entry.text)).toEqual(['shell out', ' err-one err-two']);
		const idleShell = getSession('idle-shell');
		expect(idleShell.shellLogs.map((entry) => entry.text)).toEqual(['idle-shell', ' new']);
		expect(idleShell.aiTabs[0].state).toBe('idle');
		expect(idleShell.aiTabs[0].hasUnread).toBeUndefined();
		expect(useSessionStore.getState().sessions).not.toBe(before);

		const currentSessions = useSessionStore.getState().sessions;
		act(() => {
			result.current.appendLog('missing-again', null, false, 'ignored');
			result.current.flushNow();
		});
		expect(useSessionStore.getState().sessions).toBe(currentSessions);

		act(() => {
			result.current.appendLog('sticky', 'tab-1', true, ' err', true);
			result.current.flushNow();
		});
		expect(getSession('sticky').aiTabs[0].logs.map((entry) => entry.source)).toEqual([
			'thinking',
			'tool',
			'stdout',
			'stderr',
		]);
	});

	it('flushes by interval and on unmount without waiting for the default interval', async () => {
		useSessionStore.setState({
			sessions: [
				session({ id: 'interval', shellLogs: [], aiTabs: [], activeTabId: '' }),
				session({ id: 'unmount', shellLogs: [], aiTabs: [], activeTabId: '' }),
			],
		});
		const intervalHook = renderHook(() => useBatchedSessionUpdates(5));

		act(() => intervalHook.result.current.appendLog('interval', null, false, 'tick'));
		await waitFor(() => expect(getSession('interval').shellLogs[0]?.text).toBe('tick'));
		intervalHook.unmount();

		const unmountHook = renderHook(() => useBatchedSessionUpdates(1000));
		act(() => unmountHook.result.current.appendLog('unmount', null, false, 'bye'));
		expect(getSession('unmount').shellLogs).toHaveLength(0);
		unmountHook.unmount();
		expect(getSession('unmount').shellLogs[0].text).toBe('bye');
	});
});
