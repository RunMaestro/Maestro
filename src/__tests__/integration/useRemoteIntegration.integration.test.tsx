import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRemoteIntegration } from '../../renderer/hooks/remote/useRemoteIntegration';
import type { AITab, Session } from '../../renderer/types';
import type { UseRemoteIntegrationDeps } from '../../renderer/hooks/remote/useRemoteIntegration';
import { logger } from '../../renderer/utils/logger';
import { captureException } from '../../renderer/utils/sentry';

vi.mock('../../renderer/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock('../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

type RemoteListeners = {
	command?: (sessionId: string, command: string, inputMode?: 'ai' | 'terminal') => void;
	switchMode?: (sessionId: string, mode: 'ai' | 'terminal') => void;
	interrupt?: (sessionId: string) => Promise<void>;
	selectSession?: (sessionId: string, tabId?: string) => void;
	selectTab?: (sessionId: string, tabId: string) => void;
	newTab?: (sessionId: string, responseChannel: string) => void;
	closeTab?: (sessionId: string, tabId: string) => void;
	renameTab?: (sessionId: string, tabId: string, newName: string) => void;
	starTab?: (sessionId: string, tabId: string, starred: boolean) => void;
	reorderTab?: (sessionId: string, fromIndex: number, toIndex: number) => void;
	toggleBookmark?: (sessionId: string) => void;
};

const createTab = (overrides: Partial<AITab> = {}): AITab => ({
	id: 'tab-1',
	agentSessionId: 'agent-session-1',
	name: null,
	starred: false,
	logs: [],
	inputValue: '',
	stagedImages: [],
	createdAt: 1700000000000,
	state: 'idle',
	saveToHistory: true,
	showThinking: 'off',
	...overrides,
});

const createSession = (overrides: Partial<Session> = {}): Session => {
	const tab = createTab();
	return {
		id: 'session-1',
		name: 'Remote Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/workspace/project',
		fullPath: '/workspace/project',
		projectRoot: '/workspace/project',
		createdAt: 1700000000000,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: true,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		aiTabs: [tab],
		activeTabId: tab.id,
		closedTabHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
};

function createHarness(
	overrides: {
		sessions?: Session[];
		activeSessionId?: string;
		isLiveMode?: boolean;
	} = {}
): UseRemoteIntegrationDeps {
	const sessions = overrides.sessions ?? [createSession()];
	const activeSessionId = overrides.activeSessionId ?? sessions[0]?.id ?? '';
	const sessionsRef = { current: sessions };
	const activeSessionIdRef = { current: activeSessionId };

	return {
		activeSessionId,
		isLiveMode: overrides.isLiveMode ?? false,
		sessionsRef,
		activeSessionIdRef,
		setSessions: vi.fn((updater: React.SetStateAction<Session[]>) => {
			sessionsRef.current = typeof updater === 'function' ? updater(sessionsRef.current) : updater;
		}),
		setActiveSessionId: vi.fn((id: string) => {
			activeSessionIdRef.current = id;
		}),
		defaultSaveToHistory: true,
		defaultShowThinking: 'off',
	};
}

describe('useRemoteIntegration integration', () => {
	const originalMaestro = window.maestro;
	let listeners: RemoteListeners;
	let cleanupFns: Record<string, ReturnType<typeof vi.fn>>;

	beforeEach(() => {
		vi.clearAllMocks();
		listeners = {};
		cleanupFns = {
			command: vi.fn(),
			switchMode: vi.fn(),
			interrupt: vi.fn(),
			selectSession: vi.fn(),
			selectTab: vi.fn(),
			newTab: vi.fn(),
			closeTab: vi.fn(),
			renameTab: vi.fn(),
			starTab: vi.fn(),
			reorderTab: vi.fn(),
			toggleBookmark: vi.fn(),
		};
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		window.maestro = {
			...originalMaestro,
			live: {
				...originalMaestro.live,
				broadcastActiveSession: vi.fn().mockResolvedValue(undefined),
			},
			web: {
				...originalMaestro.web,
				broadcastSessionState: vi.fn(),
				broadcastTabsChange: vi.fn(),
			},
			process: {
				...originalMaestro.process,
				interrupt: vi.fn().mockResolvedValue(true),
				sendRemoteNewTabResponse: vi.fn(),
				onRemoteCommand: vi.fn((handler) => {
					listeners.command = handler;
					return cleanupFns.command;
				}),
				onRemoteSwitchMode: vi.fn((handler) => {
					listeners.switchMode = handler;
					return cleanupFns.switchMode;
				}),
				onRemoteInterrupt: vi.fn((handler) => {
					listeners.interrupt = handler;
					return cleanupFns.interrupt;
				}),
				onRemoteSelectSession: vi.fn((handler) => {
					listeners.selectSession = handler;
					return cleanupFns.selectSession;
				}),
				onRemoteSelectTab: vi.fn((handler) => {
					listeners.selectTab = handler;
					return cleanupFns.selectTab;
				}),
				onRemoteNewTab: vi.fn((handler) => {
					listeners.newTab = handler;
					return cleanupFns.newTab;
				}),
				onRemoteCloseTab: vi.fn((handler) => {
					listeners.closeTab = handler;
					return cleanupFns.closeTab;
				}),
				onRemoteRenameTab: vi.fn((handler) => {
					listeners.renameTab = handler;
					return cleanupFns.renameTab;
				}),
				onRemoteStarTab: vi.fn((handler) => {
					listeners.starTab = handler;
					return cleanupFns.starTab;
				}),
				onRemoteReorderTab: vi.fn((handler) => {
					listeners.reorderTab = handler;
					return cleanupFns.reorderTab;
				}),
				onRemoteToggleBookmark: vi.fn((handler) => {
					listeners.toggleBookmark = handler;
					return cleanupFns.toggleBookmark;
				}),
			},
			claude: {
				...originalMaestro.claude,
				updateSessionName: vi.fn().mockResolvedValue(undefined),
				updateSessionStarred: vi.fn().mockResolvedValue(undefined),
			},
			agentSessions: {
				...originalMaestro.agentSessions,
				setSessionName: vi.fn().mockResolvedValue(undefined),
				setSessionStarred: vi.fn().mockResolvedValue(undefined),
			},
			history: {
				...originalMaestro.history,
				updateSessionName: vi.fn().mockResolvedValue(undefined),
			},
		};
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		window.maestro = originalMaestro;
	});

	it('broadcasts the active session and routes remote commands through desktop command events', () => {
		const dispatchEvent = vi.spyOn(window, 'dispatchEvent');
		const session = createSession({ activeFileTabId: 'file-preview-1', inputMode: 'ai' });
		const deps = createHarness({ sessions: [session], isLiveMode: true });

		renderHook(() => useRemoteIntegration(deps));

		expect(window.maestro.live.broadcastActiveSession).toHaveBeenCalledWith('session-1');

		act(() => {
			listeners.command?.('session-1', 'npm test', 'terminal');
		});

		expect(deps.setActiveSessionId).toHaveBeenCalledWith('session-1');
		expect(deps.sessionsRef.current[0].inputMode).toBe('terminal');
		expect(deps.sessionsRef.current[0].activeFileTabId).toBeNull();
		expect(dispatchEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'maestro:remoteCommand',
				detail: { sessionId: 'session-1', command: 'npm test', inputMode: 'terminal' },
			})
		);

		act(() => {
			listeners.command?.('missing', 'ignored', 'ai');
		});

		deps.sessionsRef.current = [{ ...deps.sessionsRef.current[0], state: 'busy' }];
		act(() => {
			listeners.command?.('session-1', 'still ignored', 'ai');
		});

		expect(logger.warn).toHaveBeenCalledWith(
			'[useRemoteIntegration] Session not found, dropping command'
		);
		expect(logger.warn).toHaveBeenCalledWith(
			'[useRemoteIntegration] Session is busy, dropping command. State:',
			undefined,
			'busy'
		);
		expect(dispatchEvent).toHaveBeenCalledTimes(1);
	});

	it('handles remote mode switches, interrupts, and interrupt errors', async () => {
		const session = createSession({
			state: 'busy',
			busySource: 'ai',
			thinkingStartTime: 1700000000000,
			activeFileTabId: 'file-preview-1',
		});
		const deps = createHarness({ sessions: [session] });

		renderHook(() => useRemoteIntegration(deps));

		act(() => {
			listeners.switchMode?.('session-1', 'terminal');
		});

		expect(deps.sessionsRef.current[0].inputMode).toBe('terminal');
		expect(deps.sessionsRef.current[0].activeFileTabId).toBeNull();

		await act(async () => {
			await listeners.interrupt?.('session-1');
		});

		expect(window.maestro.process.interrupt).toHaveBeenCalledWith('session-1-terminal');
		expect(deps.sessionsRef.current[0]).toMatchObject({
			state: 'idle',
			busySource: undefined,
			thinkingStartTime: undefined,
		});

		vi.mocked(window.maestro.process.interrupt).mockRejectedValueOnce(
			new Error('interrupt failed')
		);
		await act(async () => {
			await listeners.interrupt?.('session-1');
			await listeners.interrupt?.('missing');
		});

		expect(logger.error).toHaveBeenCalledWith(
			'[Remote] Failed to interrupt session:',
			undefined,
			expect.any(Error)
		);
	});

	it('keeps remote mode, interrupt, and selection guard paths as no-ops when targets are missing or unchanged', async () => {
		const first = createSession({ id: 'session-1', inputMode: 'ai' });
		const second = createSession({
			id: 'session-2',
			inputMode: 'terminal',
			activeFileTabId: 'file-preview-2',
		});
		const deps = createHarness({ sessions: [first, second], activeSessionId: 'session-1' });

		renderHook(() => useRemoteIntegration(deps));

		act(() => {
			listeners.switchMode?.('missing-session', 'terminal');
			listeners.switchMode?.('session-1', 'ai');
			listeners.switchMode?.('session-1', 'terminal');
			listeners.selectSession?.('missing-session', 'tab-1');
			listeners.selectSession?.('session-1', 'missing-tab');
			listeners.selectTab?.('session-2', 'missing-tab');
			listeners.selectTab?.('session-2', 'tab-1');
		});

		await act(async () => {
			await listeners.interrupt?.('missing-session');
			await listeners.interrupt?.('session-1');
		});

		expect(deps.sessionsRef.current.find((session) => session.id === 'session-1')).toMatchObject({
			inputMode: 'terminal',
			activeFileTabId: null,
		});
		expect(deps.sessionsRef.current.find((session) => session.id === 'session-2')).toMatchObject({
			inputMode: 'ai',
			activeTabId: 'tab-1',
			activeFileTabId: null,
		});
		expect(deps.setActiveSessionId).toHaveBeenCalledWith('session-2');
	});

	it('updates remote-selected sessions and tabs through real tab helpers and persistence bridges', () => {
		const firstTab = createTab({ id: 'tab-1', agentSessionId: 'claude-session-1' });
		const secondTab = createTab({ id: 'tab-2', agentSessionId: 'claude-session-2' });
		const session = createSession({
			aiTabs: [firstTab, secondTab],
			activeTabId: 'tab-1',
			toolType: 'claude-code',
		});
		const deps = createHarness({ sessions: [session], activeSessionId: 'other-session' });

		renderHook(() => useRemoteIntegration(deps));

		act(() => {
			listeners.selectSession?.('session-1', 'tab-2');
		});

		expect(deps.setActiveSessionId).toHaveBeenCalledWith('session-1');
		expect(deps.sessionsRef.current[0].activeTabId).toBe('tab-2');

		act(() => {
			listeners.selectTab?.('session-1', 'tab-1');
		});

		expect(deps.sessionsRef.current[0].activeTabId).toBe('tab-1');

		act(() => {
			listeners.newTab?.('session-1', 'new-tab-channel');
		});

		expect(window.maestro.process.sendRemoteNewTabResponse).toHaveBeenCalledWith(
			'new-tab-channel',
			expect.objectContaining({ tabId: expect.any(String) })
		);
		expect(deps.sessionsRef.current[0].aiTabs).toHaveLength(3);

		const createdTab = deps.sessionsRef.current[0].aiTabs.at(-1)!;

		act(() => {
			listeners.renameTab?.('session-1', 'tab-1', 'Renamed Tab');
			listeners.starTab?.('session-1', 'tab-1', true);
			listeners.reorderTab?.('session-1', 0, 2);
			listeners.closeTab?.('session-1', createdTab.id);
			listeners.toggleBookmark?.('session-1');
			listeners.newTab?.('missing-session', 'missing-channel');
		});

		expect(window.maestro.claude.updateSessionName).toHaveBeenCalledWith(
			'/workspace/project',
			'claude-session-1',
			'Renamed Tab'
		);
		expect(window.maestro.history.updateSessionName).toHaveBeenCalledWith(
			'claude-session-1',
			'Renamed Tab'
		);
		expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
			'/workspace/project',
			'claude-session-1',
			true
		);
		expect(deps.sessionsRef.current[0].bookmarked).toBe(true);
		expect(deps.sessionsRef.current[0].aiTabs.some((tab) => tab.id === createdTab.id)).toBe(false);
		expect(window.maestro.process.sendRemoteNewTabResponse).toHaveBeenCalledWith(
			'missing-channel',
			null
		);
	});

	it('persists non-Claude tab metadata through generic agent session storage', () => {
		const tab = createTab({ id: 'tab-1', agentSessionId: 'codex-session-1' });
		const session = createSession({
			toolType: 'codex',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		const deps = createHarness({ sessions: [session] });

		renderHook(() => useRemoteIntegration(deps));

		act(() => {
			listeners.renameTab?.('session-1', 'tab-1', '');
			listeners.starTab?.('session-1', 'tab-1', true);
		});

		expect(window.maestro.agentSessions.setSessionName).toHaveBeenCalledWith(
			'codex',
			'/workspace/project',
			'codex-session-1',
			null
		);
		expect(window.maestro.agentSessions.setSessionStarred).toHaveBeenCalledWith(
			'codex',
			'/workspace/project',
			'codex-session-1',
			true
		);
		expect(deps.sessionsRef.current[0].aiTabs[0]).toMatchObject({ name: null, starred: true });
	});

	it('logs generic agent-session persistence failures for non-Claude tab metadata', async () => {
		const tab = createTab({ id: 'tab-1', agentSessionId: 'codex-session-1' });
		const session = createSession({
			toolType: 'codex',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		const deps = createHarness({ sessions: [session] });

		vi.mocked(window.maestro.agentSessions.setSessionName).mockRejectedValueOnce(
			new Error('generic name failed')
		);
		vi.mocked(window.maestro.agentSessions.setSessionStarred).mockRejectedValueOnce(
			new Error('generic star failed')
		);

		renderHook(() => useRemoteIntegration(deps));

		act(() => {
			listeners.renameTab?.('session-1', 'tab-1', 'Generic Failure');
			listeners.starTab?.('session-1', 'tab-1', true);
		});

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(logger.error).toHaveBeenCalledWith(
			'Failed to persist tab name:',
			undefined,
			expect.any(Error)
		);
		expect(captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({
				extra: expect.objectContaining({
					operation: 'persist-tab-starred',
				}),
			})
		);
	});

	it('ignores missing tab targets and logs async persistence failures for tab metadata', async () => {
		const session = createSession({
			aiTabs: [
				createTab({ id: 'tab-1', agentSessionId: 'claude-session-1' }),
				createTab({ id: 'tab-2', agentSessionId: null }),
			],
			activeTabId: 'tab-1',
			toolType: 'claude-code',
		});
		const other = createSession({
			id: 'session-2',
			aiTabs: [createTab({ id: 'other-tab', agentSessionId: 'other-session' })],
			activeTabId: 'other-tab',
		});
		const deps = createHarness({ sessions: [session, other] });

		vi.mocked(window.maestro.claude.updateSessionName).mockRejectedValueOnce(
			new Error('name failed')
		);
		vi.mocked(window.maestro.history.updateSessionName).mockRejectedValueOnce(
			new Error('history failed')
		);
		vi.mocked(window.maestro.claude.updateSessionStarred).mockRejectedValueOnce(
			new Error('star failed')
		);

		renderHook(() => useRemoteIntegration(deps));

		act(() => {
			listeners.renameTab?.('missing-session', 'tab-1', 'Ignored');
			listeners.renameTab?.('session-1', 'missing-tab', 'Ignored');
			listeners.renameTab?.('session-1', 'tab-1', 'Broken Persistence');
			listeners.renameTab?.('session-1', 'tab-2', 'Local Only');
			listeners.starTab?.('missing-session', 'tab-1', true);
			listeners.starTab?.('session-1', 'missing-tab', true);
			listeners.starTab?.('session-1', 'tab-2', true);
			listeners.starTab?.('session-1', 'tab-1', true);
		});

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(logger.error).toHaveBeenCalledWith(
			'Failed to persist tab name:',
			undefined,
			expect.any(Error)
		);
		expect(logger.error).toHaveBeenCalledWith(
			'Failed to update history session names:',
			undefined,
			expect.any(Error)
		);
		expect(captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({
				extra: expect.objectContaining({
					operation: 'persist-tab-starred',
				}),
			})
		);
		expect(deps.sessionsRef.current[0].aiTabs.find((tab) => tab.id === 'tab-1')).toMatchObject({
			name: 'Broken Persistence',
			starred: true,
		});
		expect(deps.sessionsRef.current[0].aiTabs.find((tab) => tab.id === 'tab-2')).toMatchObject({
			name: 'Local Only',
			starred: false,
		});
		expect(deps.sessionsRef.current[1].activeTabId).toBe('other-tab');
	});

	it('leaves unrelated sessions unchanged for remote close, reorder, and bookmark actions', () => {
		const first = createSession({
			id: 'session-1',
			aiTabs: [createTab({ id: 'tab-1' }), createTab({ id: 'tab-2' })],
			activeTabId: 'tab-1',
		});
		const second = createSession({
			id: 'session-2',
			aiTabs: undefined as unknown as Session['aiTabs'],
			activeTabId: 'missing',
			bookmarked: false,
		});
		const deps = createHarness({ sessions: [first, second] });

		renderHook(() => useRemoteIntegration(deps));

		act(() => {
			listeners.closeTab?.('missing-session', 'tab-1');
			listeners.closeTab?.('session-1', 'missing-tab');
			listeners.reorderTab?.('missing-session', 0, 1);
			listeners.reorderTab?.('session-2', 0, 1);
			listeners.toggleBookmark?.('missing-session');
			listeners.toggleBookmark?.('session-2');
		});

		expect(deps.sessionsRef.current[0].aiTabs).toHaveLength(2);
		expect(deps.sessionsRef.current[1].bookmarked).toBe(true);
	});

	it('broadcasts session and tab changes while live mode is enabled and cleans up listeners', () => {
		vi.useFakeTimers();
		const session = createSession();
		const deps = createHarness({ sessions: [session], isLiveMode: true });

		const { unmount } = renderHook(() => useRemoteIntegration(deps));

		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect(window.maestro.web.broadcastSessionState).toHaveBeenCalledWith(
			'session-1',
			'idle',
			expect.objectContaining({ name: 'Remote Session', inputMode: 'ai' })
		);
		expect(window.maestro.web.broadcastTabsChange).toHaveBeenCalledWith(
			'session-1',
			[expect.objectContaining({ id: 'tab-1', agentSessionId: 'agent-session-1' })],
			'tab-1'
		);

		vi.mocked(window.maestro.web.broadcastSessionState).mockClear();
		vi.mocked(window.maestro.web.broadcastTabsChange).mockClear();

		deps.sessionsRef.current = [
			{
				...deps.sessionsRef.current[0],
				state: 'busy',
				aiTabs: [{ ...deps.sessionsRef.current[0].aiTabs[0], name: 'Named', starred: true }],
			},
		];

		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect(window.maestro.web.broadcastSessionState).toHaveBeenCalledWith(
			'session-1',
			'busy',
			expect.any(Object)
		);
		expect(window.maestro.web.broadcastTabsChange).toHaveBeenCalledWith(
			'session-1',
			[expect.objectContaining({ name: 'Named', starred: true })],
			'tab-1'
		);

		unmount();
		Object.values(cleanupFns).forEach((cleanup) => {
			expect(cleanup).toHaveBeenCalled();
		});
	});

	it('broadcasts session state but skips tab broadcasts when a live session has no tabs', () => {
		vi.useFakeTimers();
		const session = createSession({
			aiTabs: [],
			activeTabId: '',
		});
		const deps = createHarness({ sessions: [session], isLiveMode: true });

		renderHook(() => useRemoteIntegration(deps));

		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect(window.maestro.web.broadcastSessionState).toHaveBeenCalledWith(
			'session-1',
			'idle',
			expect.any(Object)
		);
		expect(window.maestro.web.broadcastTabsChange).not.toHaveBeenCalled();
	});
});
