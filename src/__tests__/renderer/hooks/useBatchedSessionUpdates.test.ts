import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBatchedSessionUpdates } from '../../../renderer/hooks/session/useBatchedSessionUpdates';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { AITab, LogEntry, Session, UsageStats } from '../../../renderer/types';

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
	};
}

function createSession(overrides: Partial<Session> = {}): Session {
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
		sessionsLoaded: false,
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
		cyclePosition: -1,
	});
}

function getSession(id = 'session-1'): Session {
	const session = useSessionStore.getState().sessions.find((candidate) => candidate.id === id);
	if (!session) {
		throw new Error(`Missing test session ${id}`);
	}
	return session;
}

describe('useBatchedSessionUpdates', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		resetStore();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		resetStore();
	});

	it('batches AI log chunks, clears transient thinking logs, and applies tab markers', () => {
		const now = Date.now();
		useSessionStore.setState({
			sessions: [
				createSession({
					aiTabs: [
						createTab({
							logs: [
								log('user', 'Build it', {
									id: 'user-1',
									timestamp: now - 300,
									delivered: false,
								}),
								log('thinking', 'Planning', { id: 'thinking-1', timestamp: now - 250 }),
								log('tool', 'Reading files', { id: 'tool-1', timestamp: now - 200 }),
								log('stdout', 'partial', { id: 'stdout-1', timestamp: now - 100 }),
							],
						}),
					],
					activeTabId: 'tab-1',
				}),
			],
		});

		const { result, unmount } = renderHook(() => useBatchedSessionUpdates(1000));

		act(() => {
			result.current.appendLog('session-1', 'tab-1', true, ' chunk');
			result.current.appendLog('session-1', 'tab-1', true, ' done');
			result.current.setTabStatus('session-1', 'tab-1', 'busy');
			result.current.markDelivered('session-1', 'tab-1');
			result.current.markUnread('session-1', 'tab-1', true);
		});

		expect(result.current.hasPending).toBe(true);

		act(() => {
			result.current.flushNow();
		});

		const tab = getSession().aiTabs[0];
		expect(result.current.hasPending).toBe(false);
		expect(tab.state).toBe('busy');
		expect(tab.hasUnread).toBe(true);
		expect(tab.logs.map((entry) => entry.source)).toEqual(['user', 'stdout']);
		expect(tab.logs[0].delivered).toBe(true);
		expect(tab.logs[1].text).toBe('partial chunk done');

		unmount();
	});

	it('preserves thinking and tool logs when the tab is sticky', () => {
		useSessionStore.setState({
			sessions: [
				createSession({
					aiTabs: [
						createTab({
							showThinking: 'sticky',
							logs: [log('thinking', 'Keep this'), log('tool', 'Keep tool')],
						}),
					],
					activeTabId: 'tab-1',
				}),
			],
		});

		const { result, unmount } = renderHook(() => useBatchedSessionUpdates(1000));

		act(() => {
			result.current.appendLog('session-1', 'tab-1', true, 'Final answer');
			result.current.flushNow();
		});

		const tab = getSession().aiTabs[0];
		expect(tab.logs.map((entry) => entry.source)).toEqual(['thinking', 'tool', 'stdout']);
		expect(tab.logs[2].text).toBe('Final answer');

		unmount();
	});

	it('applies shell log grouping, status, context usage, and cycle counters', () => {
		const now = Date.now();
		useSessionStore.setState({
			sessions: [
				createSession({
					id: 'stdout-session',
					state: 'busy',
					shellLogs: [log('stdout', 'out', { timestamp: now - 100 })],
					contextUsage: 72,
					currentCycleBytes: 10,
					currentCycleTokens: 20,
				}),
				createSession({
					id: 'stderr-session',
					state: 'busy',
					shellLogs: [log('stderr', 'err', { timestamp: now - 100 })],
				}),
			],
		});

		const { result, unmount } = renderHook(() => useBatchedSessionUpdates(1000));

		act(() => {
			result.current.appendLog('stdout-session', null, false, ' more');
			result.current.setStatus('stdout-session', 'idle');
			result.current.updateContextUsage('stdout-session', 90);
			result.current.resetContextUsage('stdout-session', 25);
			result.current.updateCycleBytes('stdout-session', 5);
			result.current.updateCycleBytes('stdout-session', 7);
			result.current.updateCycleTokens('stdout-session', 11);
			result.current.updateCycleTokens('stdout-session', 13);
			result.current.appendLog('stderr-session', null, false, ' more', true);
			result.current.flushNow();
		});

		const stdoutSession = getSession('stdout-session');
		const stderrSession = getSession('stderr-session');
		expect(stdoutSession.state).toBe('idle');
		expect(stdoutSession.shellLogs).toHaveLength(1);
		expect(stdoutSession.shellLogs[0].text).toBe('out more');
		expect(stdoutSession.contextUsage).toBe(25);
		expect(stdoutSession.currentCycleBytes).toBe(22);
		expect(stdoutSession.currentCycleTokens).toBe(44);
		expect(stderrSession.shellLogs).toHaveLength(1);
		expect(stderrSession.shellLogs[0].text).toBe('err more');

		unmount();
	});

	it('accumulates session usage while keeping tab usage current', () => {
		useSessionStore.setState({
			sessions: [
				createSession({
					usageStats: usage({
						inputTokens: 10,
						outputTokens: 20,
						cacheReadInputTokens: 30,
						cacheCreationInputTokens: 40,
						totalCostUsd: 0.1,
						reasoningTokens: 5,
						contextWindow: 100000,
					}),
					aiTabs: [
						createTab({
							usageStats: usage({
								inputTokens: 1,
								outputTokens: 2,
								totalCostUsd: 0.5,
								contextWindow: 100000,
							}),
						}),
					],
					activeTabId: 'tab-1',
				}),
			],
		});

		const { result, unmount } = renderHook(() => useBatchedSessionUpdates(1000));

		act(() => {
			result.current.updateUsage(
				'session-1',
				null,
				usage({
					inputTokens: 3,
					outputTokens: 4,
					cacheReadInputTokens: 5,
					cacheCreationInputTokens: 6,
					totalCostUsd: 0.2,
					reasoningTokens: 7,
					contextWindow: 150000,
				})
			);
			result.current.updateUsage(
				'session-1',
				null,
				usage({
					inputTokens: 8,
					outputTokens: 9,
					cacheReadInputTokens: 10,
					cacheCreationInputTokens: 11,
					totalCostUsd: 0.3,
					reasoningTokens: 12,
					contextWindow: 175000,
				})
			);
			result.current.updateUsage(
				'session-1',
				'tab-1',
				usage({ inputTokens: 100, outputTokens: 200, totalCostUsd: 0.4 })
			);
			result.current.updateUsage(
				'session-1',
				'tab-1',
				usage({
					inputTokens: 300,
					outputTokens: 400,
					cacheReadInputTokens: 50,
					cacheCreationInputTokens: 60,
					totalCostUsd: 0.6,
					reasoningTokens: 70,
					contextWindow: 180000,
				})
			);
			result.current.flushNow();
		});

		const session = getSession();
		expect(session.usageStats).toEqual(
			usage({
				inputTokens: 21,
				outputTokens: 33,
				cacheReadInputTokens: 45,
				cacheCreationInputTokens: 57,
				totalCostUsd: 0.6,
				reasoningTokens: 24,
				contextWindow: 175000,
			})
		);
		expect(session.aiTabs[0].usageStats).toEqual(
			usage({
				inputTokens: 300,
				outputTokens: 400,
				cacheReadInputTokens: 50,
				cacheCreationInputTokens: 60,
				totalCostUsd: 1.5,
				reasoningTokens: 70,
				contextWindow: 180000,
			})
		);

		unmount();
	});

	it('handles unrelated sessions, missing tabs, stderr AI logs, and default counters', () => {
		const now = Date.now();
		const untouchedSession = createSession({ id: 'untouched-session' });
		useSessionStore.setState({
			sessions: [
				createSession({
					state: 'idle',
					shellLogs: [log('stdout', 'shell out', { timestamp: now - 100 })],
					aiTabs: [
						createTab({
							id: 'tab-1',
							logs: [log('stderr', 'old err', { timestamp: now - 100 })],
						}),
						createTab({
							id: 'tab-2',
							logs: [log('user', 'already delivered', { delivered: true })],
						}),
					],
					activeTabId: 'tab-1',
				}),
				createSession({
					id: 'no-tabs-session',
					aiTabs: undefined as unknown as AITab[],
				}),
				untouchedSession,
			],
		});

		const { result, unmount } = renderHook(() => useBatchedSessionUpdates(1000));

		act(() => {
			result.current.appendLog('session-1', 'tab-1', true, ' plus err', true);
			result.current.appendLog('session-1', 'tab-1', true, ' plus out');
			result.current.appendLog('session-1', null, false, ' shell err', true);
			result.current.updateUsage(
				'session-1',
				null,
				usage({
					inputTokens: 1,
					outputTokens: 2,
					cacheReadInputTokens: 3,
					cacheCreationInputTokens: 4,
					totalCostUsd: 0.5,
					contextWindow: 150000,
				})
			);
			result.current.updateUsage(
				'session-1',
				null,
				usage({
					inputTokens: 10,
					outputTokens: 20,
					totalCostUsd: 0.75,
					contextWindow: 160000,
				})
			);
			result.current.updateUsage(
				'session-1',
				'tab-2',
				usage({
					inputTokens: 7,
					outputTokens: 8,
					totalCostUsd: 0.25,
					contextWindow: 175000,
				})
			);
			result.current.updateUsage(
				'no-tabs-session',
				'missing-tab',
				usage({
					inputTokens: 1,
					contextWindow: 120000,
				})
			);
			result.current.setTabStatus('session-1', 'missing-tab', 'busy');
			result.current.setTabStatus('session-1', 'tab-2', 'busy');
			result.current.markDelivered('session-1', 'missing-tab');
			result.current.markDelivered('session-1', 'tab-2');
			result.current.markUnread('session-1', 'missing-tab', true);
			result.current.markUnread('session-1', 'tab-2', false);
			result.current.updateCycleBytes('session-1', 5);
			result.current.updateCycleTokens('session-1', 7);
			result.current.flushNow();
		});

		const sessions = useSessionStore.getState().sessions;
		const session = getSession();
		const noTabsSession = getSession('no-tabs-session');
		const [tab1, tab2] = session.aiTabs;

		expect(sessions[2]).toBe(untouchedSession);
		expect(noTabsSession.aiTabs).toBeUndefined();
		expect(tab1.logs).toHaveLength(1);
		expect(tab1.logs[0]).toMatchObject({
			source: 'stderr',
			text: 'old err plus err plus out',
		});
		expect(tab2.state).toBe('busy');
		expect(tab2.logs[0].delivered).toBe(true);
		expect(tab2.hasUnread).toBe(false);
		expect(tab2.usageStats).toEqual(
			usage({
				inputTokens: 7,
				outputTokens: 8,
				totalCostUsd: 0.25,
				contextWindow: 175000,
			})
		);
		expect(session.shellLogs.map((entry) => entry.source)).toEqual(['stdout', 'stderr']);
		expect(session.shellLogs[1].text).toBe(' shell err');
		expect(session.usageStats).toEqual(
			usage({
				inputTokens: 11,
				outputTokens: 22,
				cacheReadInputTokens: 3,
				cacheCreationInputTokens: 4,
				totalCostUsd: 1.25,
				reasoningTokens: 0,
				contextWindow: 160000,
			})
		);
		expect(session.currentCycleBytes).toBe(5);
		expect(session.currentCycleTokens).toBe(7);

		unmount();
	});

	it('flushes through the interval, preserves identity for missing sessions, and flushes on unmount', () => {
		const { result, unmount } = renderHook(() => useBatchedSessionUpdates(50));
		const emptySessions = useSessionStore.getState().sessions;

		act(() => {
			vi.advanceTimersByTime(50);
		});
		expect(result.current.hasPending).toBe(false);

		act(() => {
			result.current.appendLog('missing-session', null, false, '');
		});
		expect(result.current.hasPending).toBe(false);

		act(() => {
			result.current.appendLog('missing-session', null, false, 'ignored');
		});
		expect(result.current.hasPending).toBe(true);

		act(() => {
			vi.advanceTimersByTime(50);
		});

		expect(result.current.hasPending).toBe(false);
		expect(useSessionStore.getState().sessions).toBe(emptySessions);

		useSessionStore.setState({
			sessions: [
				createSession({
					id: 'cleanup-session',
				}),
			],
		});

		act(() => {
			result.current.appendLog('cleanup-session', null, false, 'cleanup output');
		});
		expect(result.current.hasPending).toBe(true);

		act(() => {
			unmount();
		});

		expect(getSession('cleanup-session').shellLogs[0].text).toBe('cleanup output');
	});
});
