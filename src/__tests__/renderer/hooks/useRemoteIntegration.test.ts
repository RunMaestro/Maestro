import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRemoteIntegration } from '../../../renderer/hooks';
import type { Session, AITab } from '../../../renderer/types';
import * as tabHelpers from '../../../renderer/utils/tabHelpers';

const createMockTab = (overrides: Partial<AITab> = {}): AITab => ({
	id: 'tab-1',
	agentSessionId: null,
	name: null,
	starred: false,
	logs: [],
	inputValue: '',
	stagedImages: [],
	createdAt: 1700000000000,
	state: 'idle',
	saveToHistory: true,
	...overrides,
});

const createMockSession = (overrides: Partial<Session> = {}): Session => {
	const baseTab = createMockTab();

	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test/project',
		fullPath: '/test/project',
		projectRoot: '/test/project',
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
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		aiTabs: [baseTab],
		activeTabId: baseTab.id,
		closedTabHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		...overrides,
	};
};

describe('useRemoteIntegration', () => {
	const originalMaestro = { ...window.maestro };

	let onRemoteCommandHandler:
		| ((sessionId: string, command: string, inputMode?: 'ai' | 'terminal') => void)
		| undefined;
	let onRemoteSwitchModeHandler: ((sessionId: string, mode: 'ai' | 'terminal') => void) | undefined;
	let onRemoteInterruptHandler: ((sessionId: string) => void) | undefined;
	let onRemoteSelectSessionHandler: ((sessionId: string, tabId?: string) => void) | undefined;
	let onRemoteSelectTabHandler: ((sessionId: string, tabId: string) => void) | undefined;
	let onRemoteNewTabHandler: ((sessionId: string, responseChannel: string) => void) | undefined;
	let onRemoteCloseTabHandler: ((sessionId: string, tabId: string) => void) | undefined;
	let onRemoteRenameTabHandler:
		| ((sessionId: string, tabId: string, newName: string) => void)
		| undefined;
	let onRemoteStarTabHandler:
		| ((sessionId: string, tabId: string, starred: boolean) => void)
		| undefined;
	let onRemoteReorderTabHandler:
		| ((sessionId: string, fromIndex: number, toIndex: number) => void)
		| undefined;
	let onRemoteToggleBookmarkHandler: ((sessionId: string) => void) | undefined;

	const mockProcess = {
		...window.maestro.process,
		interrupt: vi.fn().mockResolvedValue(true),
		onRemoteCommand: vi.fn().mockImplementation((handler) => {
			onRemoteCommandHandler = handler;
			return () => {};
		}),
		onRemoteSwitchMode: vi.fn().mockImplementation((handler) => {
			onRemoteSwitchModeHandler = handler;
			return () => {};
		}),
		onRemoteInterrupt: vi.fn().mockImplementation((handler) => {
			onRemoteInterruptHandler = handler;
			return () => {};
		}),
		onRemoteSelectSession: vi.fn().mockImplementation((handler) => {
			onRemoteSelectSessionHandler = handler;
			return () => {};
		}),
		onRemoteSelectTab: vi.fn().mockImplementation((handler) => {
			onRemoteSelectTabHandler = handler;
			return () => {};
		}),
		onRemoteNewTab: vi.fn().mockImplementation((handler) => {
			onRemoteNewTabHandler = handler;
			return () => {};
		}),
		onRemoteCloseTab: vi.fn().mockImplementation((handler) => {
			onRemoteCloseTabHandler = handler;
			return () => {};
		}),
		onRemoteRenameTab: vi.fn().mockImplementation((handler) => {
			onRemoteRenameTabHandler = handler;
			return () => {};
		}),
		onRemoteStarTab: vi.fn().mockImplementation((handler) => {
			onRemoteStarTabHandler = handler;
			return () => {};
		}),
		onRemoteReorderTab: vi.fn().mockImplementation((handler) => {
			onRemoteReorderTabHandler = handler;
			return () => {};
		}),
		onRemoteToggleBookmark: vi.fn().mockImplementation((handler) => {
			onRemoteToggleBookmarkHandler = handler;
			return () => {};
		}),
		sendRemoteNewTabResponse: vi.fn(),
	};

	const mockLive = {
		...window.maestro.live,
		broadcastActiveSession: vi.fn(),
	};

	const mockWeb = {
		...window.maestro.web,
		broadcastTabsChange: vi.fn(),
		broadcastSessionState: vi.fn(),
	};

	const mockClaude = {
		...window.maestro.claude,
		updateSessionName: vi.fn().mockResolvedValue(undefined),
		updateSessionStarred: vi.fn().mockResolvedValue(undefined),
	};

	const mockAgentSessions = {
		...window.maestro.agentSessions,
		updateSessionName: vi.fn().mockResolvedValue(true),
		setSessionName: vi.fn().mockResolvedValue(undefined),
		setSessionStarred: vi.fn().mockResolvedValue(undefined),
	};

	const mockHistory = {
		...window.maestro.history,
		updateSessionName: vi.fn().mockResolvedValue(true),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		onRemoteCommandHandler = undefined;
		onRemoteSwitchModeHandler = undefined;
		onRemoteInterruptHandler = undefined;
		onRemoteSelectSessionHandler = undefined;
		onRemoteSelectTabHandler = undefined;
		onRemoteNewTabHandler = undefined;
		onRemoteCloseTabHandler = undefined;
		onRemoteRenameTabHandler = undefined;
		onRemoteStarTabHandler = undefined;
		onRemoteReorderTabHandler = undefined;
		onRemoteToggleBookmarkHandler = undefined;

		window.maestro = {
			...originalMaestro,
			process: mockProcess as typeof window.maestro.process,
			live: mockLive as typeof window.maestro.live,
			web: mockWeb as typeof window.maestro.web,
			claude: mockClaude as typeof window.maestro.claude,
			agentSessions: mockAgentSessions as typeof window.maestro.agentSessions,
			history: mockHistory as typeof window.maestro.history,
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
		window.maestro = originalMaestro;
	});

	const createDeps = (
		overrides: {
			sessions?: Session[];
			activeSessionId?: string;
			isLiveMode?: boolean;
		} = {}
	) => {
		const sessions = overrides.sessions ?? [createMockSession()];
		const activeSessionId = overrides.activeSessionId ?? sessions[0]?.id ?? '';
		const sessionsRef = { current: sessions };
		const activeSessionIdRef = { current: activeSessionId };
		const setSessions = vi.fn((fn: (prev: Session[]) => Session[]) => {
			const result = typeof fn === 'function' ? fn(sessions) : fn;
			sessionsRef.current = result;
			return result;
		});
		const setActiveSessionId = vi.fn();

		return {
			activeSessionId,
			isLiveMode: overrides.isLiveMode ?? false,
			sessionsRef,
			activeSessionIdRef,
			setSessions,
			setActiveSessionId,
			defaultSaveToHistory: true,
			defaultShowThinking: 'off' as const,
		};
	};

	const applyLastSessionUpdate = (
		deps: ReturnType<typeof createDeps>,
		sessions: Session[]
	): Session[] => {
		const updater = deps.setSessions.mock.calls.at(-1)?.[0];
		return typeof updater === 'function' ? updater(sessions) : updater;
	};

	describe('active session broadcast', () => {
		it('broadcasts active session when live mode is enabled', () => {
			const deps = createDeps({ isLiveMode: true, activeSessionId: 'session-1' });

			renderHook(() => useRemoteIntegration(deps));

			expect(mockLive.broadcastActiveSession).toHaveBeenCalledWith('session-1');
		});

		it('does not broadcast when live mode is disabled', () => {
			const deps = createDeps({ isLiveMode: false, activeSessionId: 'session-1' });

			renderHook(() => useRemoteIntegration(deps));

			expect(mockLive.broadcastActiveSession).not.toHaveBeenCalled();
		});
	});

	describe('remote command handling', () => {
		it('dispatches maestro:remoteCommand event when command is received', () => {
			const session = createMockSession({ id: 'session-1', state: 'idle' });
			const deps = createDeps({ sessions: [session] });
			const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteCommandHandler?.('session-1', 'test command', 'ai');
			});

			expect(deps.setActiveSessionId).toHaveBeenCalledWith('session-1');
			expect(dispatchEventSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'maestro:remoteCommand',
					detail: { sessionId: 'session-1', command: 'test command', inputMode: 'ai' },
				})
			);

			dispatchEventSpy.mockRestore();
		});

		it('ignores command when session not found', () => {
			const deps = createDeps({ sessions: [] });
			const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteCommandHandler?.('nonexistent', 'test command', 'ai');
			});

			expect(deps.setActiveSessionId).not.toHaveBeenCalled();
			expect(dispatchEventSpy).not.toHaveBeenCalled();
			expect(consoleWarn).toHaveBeenCalledWith(
				'[useRemoteIntegration] Session not found, dropping command'
			);

			dispatchEventSpy.mockRestore();
		});

		it('ignores command when session is busy', () => {
			const session = createMockSession({ id: 'session-1', state: 'busy' });
			const deps = createDeps({ sessions: [session] });
			const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteCommandHandler?.('session-1', 'test command', 'ai');
			});

			expect(deps.setActiveSessionId).not.toHaveBeenCalled();
			expect(dispatchEventSpy).not.toHaveBeenCalled();
			expect(consoleWarn).toHaveBeenCalledWith(
				'[useRemoteIntegration] Session is busy, dropping command. State:',
				'busy'
			);

			dispatchEventSpy.mockRestore();
		});

		it('syncs input mode when web provides different mode', () => {
			const session = createMockSession({ id: 'session-1', state: 'idle', inputMode: 'ai' });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteCommandHandler?.('session-1', 'ls -la', 'terminal');
			});

			expect(deps.setSessions).toHaveBeenCalled();
		});

		it('clears activeFileTabId when remote command syncs to terminal mode', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'idle',
				inputMode: 'ai',
				activeFileTabId: 'file-tab-1',
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteCommandHandler?.('session-1', 'ls -la', 'terminal');
			});

			const updater = deps.setSessions.mock.calls[0][0];
			const result = typeof updater === 'function' ? updater([session]) : updater;
			expect(result[0].inputMode).toBe('terminal');
			expect(result[0].activeFileTabId).toBeNull();
		});

		it('syncs only the targeted session when remote command changes input mode', () => {
			const session = createMockSession({ id: 'session-1', state: 'idle', inputMode: 'ai' });
			const otherSession = createMockSession({
				id: 'session-2',
				name: 'Other Session',
				inputMode: 'ai',
			});
			const deps = createDeps({ sessions: [session, otherSession] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteCommandHandler?.('session-1', 'pwd', 'terminal');
			});

			const result = applyLastSessionUpdate(deps, [session, otherSession]);
			expect(result[0].inputMode).toBe('terminal');
			expect(result[1]).toBe(otherSession);
		});
	});

	describe('remote mode switching', () => {
		it('updates session mode when switch mode received', () => {
			const session = createMockSession({ id: 'session-1', inputMode: 'ai' });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteSwitchModeHandler?.('session-1', 'terminal');
			});

			expect(deps.setSessions).toHaveBeenCalled();
			const updater = deps.setSessions.mock.calls[0][0];
			const result = typeof updater === 'function' ? updater([session]) : updater;
			expect(result[0].inputMode).toBe('terminal');
		});

		it('ignores switch mode when session not found', () => {
			const deps = createDeps({ sessions: [] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteSwitchModeHandler?.('nonexistent', 'terminal');
			});

			const updater = deps.setSessions.mock.calls[0][0];
			const result = typeof updater === 'function' ? updater([]) : updater;
			expect(result).toEqual([]);
		});

		it('ignores switch mode when session already in mode', () => {
			const session = createMockSession({ id: 'session-1', inputMode: 'ai' });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteSwitchModeHandler?.('session-1', 'ai');
			});

			const updater = deps.setSessions.mock.calls[0][0];
			const result = typeof updater === 'function' ? updater([session]) : updater;
			expect(result).toEqual([session]);
		});

		it('clears activeFileTabId when switching to terminal mode', () => {
			const session = createMockSession({
				id: 'session-1',
				inputMode: 'ai',
				activeFileTabId: 'file-tab-1',
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteSwitchModeHandler?.('session-1', 'terminal');
			});

			const updater = deps.setSessions.mock.calls[0][0];
			const result = typeof updater === 'function' ? updater([session]) : updater;
			expect(result[0].inputMode).toBe('terminal');
			expect(result[0].activeFileTabId).toBeNull();
		});

		it('preserves activeFileTabId when switching to ai mode', () => {
			const session = createMockSession({
				id: 'session-1',
				inputMode: 'terminal',
				activeFileTabId: 'file-tab-1',
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteSwitchModeHandler?.('session-1', 'ai');
			});

			const updater = deps.setSessions.mock.calls[0][0];
			const result = typeof updater === 'function' ? updater([session]) : updater;
			expect(result[0].inputMode).toBe('ai');
			expect(result[0].activeFileTabId).toBe('file-tab-1');
		});

		it('leaves other sessions unchanged when switching mode', () => {
			const session = createMockSession({ id: 'session-1', inputMode: 'ai' });
			const otherSession = createMockSession({ id: 'session-2', inputMode: 'terminal' });
			const deps = createDeps({ sessions: [session, otherSession] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteSwitchModeHandler?.('session-1', 'terminal');
			});

			const result = applyLastSessionUpdate(deps, [session, otherSession]);
			expect(result[0].inputMode).toBe('terminal');
			expect(result[1]).toBe(otherSession);
		});
	});

	describe('remote interrupt handling', () => {
		it('sends interrupt and sets session to idle', async () => {
			const session = createMockSession({ id: 'session-1', state: 'busy', inputMode: 'ai' });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			await act(async () => {
				await onRemoteInterruptHandler?.('session-1');
			});

			expect(mockProcess.interrupt).toHaveBeenCalledWith('session-1-ai');
			expect(deps.setSessions).toHaveBeenCalled();
		});

		it('ignores interrupt when session not found', async () => {
			const deps = createDeps({ sessions: [] });

			renderHook(() => useRemoteIntegration(deps));

			await act(async () => {
				await onRemoteInterruptHandler?.('nonexistent');
			});

			expect(mockProcess.interrupt).not.toHaveBeenCalled();
		});

		it('interrupts terminal process when session is in terminal mode', async () => {
			const session = createMockSession({ id: 'session-1', state: 'busy', inputMode: 'terminal' });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			await act(async () => {
				await onRemoteInterruptHandler?.('session-1');
			});

			expect(mockProcess.interrupt).toHaveBeenCalledWith('session-1-terminal');
		});

		it('sets only the interrupted session idle after interrupt succeeds', async () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'busy',
				busySource: 'ai',
				thinkingStartTime: 123,
			});
			const otherSession = createMockSession({ id: 'session-2', state: 'busy' });
			const deps = createDeps({ sessions: [session, otherSession] });

			renderHook(() => useRemoteIntegration(deps));

			await act(async () => {
				await onRemoteInterruptHandler?.('session-1');
			});

			const result = applyLastSessionUpdate(deps, [session, otherSession]);
			expect(result[0]).toMatchObject({
				id: 'session-1',
				state: 'idle',
				busySource: undefined,
				thinkingStartTime: undefined,
			});
			expect(result[1]).toBe(otherSession);
		});

		it('logs and preserves state when remote interrupt fails', async () => {
			const error = new Error('interrupt failed');
			mockProcess.interrupt.mockRejectedValueOnce(error);
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const session = createMockSession({ id: 'session-1', state: 'busy' });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			await act(async () => {
				await onRemoteInterruptHandler?.('session-1');
			});

			expect(consoleError).toHaveBeenCalledWith('[Remote] Failed to interrupt session:', error);
			expect(deps.setSessions).not.toHaveBeenCalled();
			consoleError.mockRestore();
		});
	});

	describe('remote session selection', () => {
		it('switches to selected session', () => {
			const session = createMockSession({ id: 'session-1' });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteSelectSessionHandler?.('session-1');
			});

			expect(deps.setActiveSessionId).toHaveBeenCalledWith('session-1');
		});

		it('switches to session and tab when tabId provided', () => {
			const tab = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [createMockTab(), tab],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteSelectSessionHandler?.('session-1', 'tab-2');
			});

			expect(deps.setActiveSessionId).toHaveBeenCalledWith('session-1');
			expect(deps.setSessions).toHaveBeenCalled();
		});

		it('does not change active tab when provided tab is missing', () => {
			const session = createMockSession({ id: 'session-1', activeTabId: 'tab-1' });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteSelectSessionHandler?.('session-1', 'missing-tab');
			});

			const result = applyLastSessionUpdate(deps, [session]);
			expect(result[0]).toBe(session);
		});

		it('leaves other sessions unchanged when selecting a tab with a session', () => {
			const tab = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [createMockTab(), tab],
				activeTabId: 'tab-1',
			});
			const otherSession = createMockSession({ id: 'session-2', activeTabId: 'other-tab' });
			const deps = createDeps({ sessions: [session, otherSession] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteSelectSessionHandler?.('session-1', 'tab-2');
			});

			const result = applyLastSessionUpdate(deps, [session, otherSession]);
			expect(result[0].activeTabId).toBe('tab-2');
			expect(result[1]).toBe(otherSession);
		});

		it('ignores session selection when session not found', () => {
			const deps = createDeps({ sessions: [] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteSelectSessionHandler?.('nonexistent');
			});

			expect(deps.setActiveSessionId).not.toHaveBeenCalled();
		});
	});

	describe('remote tab selection', () => {
		it('switches to tab within session', () => {
			const tab = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [createMockTab(), tab],
			});
			const deps = createDeps({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteSelectTabHandler?.('session-1', 'tab-2');
			});

			expect(deps.setSessions).toHaveBeenCalled();
		});

		it('switches session first if not active', () => {
			const tab = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [createMockTab(), tab],
			});
			const deps = createDeps({ sessions: [session], activeSessionId: 'other-session' });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteSelectTabHandler?.('session-1', 'tab-2');
			});

			expect(deps.setActiveSessionId).toHaveBeenCalledWith('session-1');
		});

		it('does not switch sessions when selected tab session is already active', () => {
			const tab = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [createMockTab(), tab],
			});
			const deps = createDeps({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteSelectTabHandler?.('session-1', 'tab-2');
			});

			expect(deps.setActiveSessionId).not.toHaveBeenCalled();
		});

		it('leaves active tab unchanged when selected tab does not exist', () => {
			const session = createMockSession({ id: 'session-1', activeTabId: 'tab-1' });
			const deps = createDeps({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteSelectTabHandler?.('session-1', 'missing-tab');
			});

			const result = applyLastSessionUpdate(deps, [session]);
			expect(result[0]).toBe(session);
		});

		it('leaves non-target sessions unchanged when selecting a tab', () => {
			const tab = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [createMockTab(), tab],
				activeTabId: 'tab-1',
			});
			const otherSession = createMockSession({ id: 'session-2' });
			const deps = createDeps({ sessions: [session, otherSession], activeSessionId: 'session-1' });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteSelectTabHandler?.('session-1', 'tab-2');
			});

			const result = applyLastSessionUpdate(deps, [session, otherSession]);
			expect(result[0].activeTabId).toBe('tab-2');
			expect(result[1]).toBe(otherSession);
		});
	});

	describe('remote new tab', () => {
		it('creates new tab and sends response', () => {
			const session = createMockSession({ id: 'session-1' });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteNewTabHandler?.('session-1', 'response-channel-1');
			});

			expect(deps.setSessions).toHaveBeenCalled();
			const updatedSession = deps.sessionsRef.current[0];
			const newTabId = updatedSession.activeTabId;

			expect(updatedSession.aiTabs).toHaveLength(2);
			expect(mockProcess.sendRemoteNewTabResponse).toHaveBeenCalledWith('response-channel-1', {
				tabId: newTabId,
			});
		});

		it('sends a null response when new tab target session is missing', () => {
			const session = createMockSession({ id: 'session-1' });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteNewTabHandler?.('missing-session', 'response-channel-1');
			});

			expect(mockProcess.sendRemoteNewTabResponse).toHaveBeenCalledWith('response-channel-1', null);
		});

		it('sends a null response when the tab helper refuses to create a tab', () => {
			const createTabSpy = vi.spyOn(tabHelpers, 'createTab').mockReturnValueOnce(null);
			const session = createMockSession({ id: 'session-1' });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteNewTabHandler?.('session-1', 'response-channel-1');
			});

			expect(createTabSpy).toHaveBeenCalledWith(session, {
				saveToHistory: true,
				showThinking: 'off',
			});
			expect(deps.sessionsRef.current[0]).toBe(session);
			expect(mockProcess.sendRemoteNewTabResponse).toHaveBeenCalledWith('response-channel-1', null);
		});
	});

	describe('remote close tab', () => {
		it('closes tab in session', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteCloseTabHandler?.('session-1', 'tab-1');
			});

			expect(deps.setSessions).toHaveBeenCalled();
		});

		it('leaves sessions unchanged when closing a missing tab', () => {
			const session = createMockSession({ id: 'session-1' });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteCloseTabHandler?.('session-1', 'missing-tab');
			});

			const result = applyLastSessionUpdate(deps, [session]);
			expect(result[0]).toBe(session);
		});

		it('leaves other sessions unchanged when closing a tab', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({ id: 'session-1', aiTabs: [tab1, tab2] });
			const otherSession = createMockSession({ id: 'session-2' });
			const deps = createDeps({ sessions: [session, otherSession] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteCloseTabHandler?.('session-1', 'tab-1');
			});

			const result = applyLastSessionUpdate(deps, [session, otherSession]);
			expect(result[0].aiTabs).toHaveLength(1);
			expect(result[1]).toBe(otherSession);
		});
	});

	describe('remote rename tab', () => {
		it('renames tab and persists to agent session (claude-code)', () => {
			const tab = createMockTab({ id: 'tab-1', agentSessionId: 'agent-session-1' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab],
				projectRoot: '/test/project',
				toolType: 'claude-code',
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteRenameTabHandler?.('session-1', 'tab-1', 'New Tab Name');
			});

			expect(deps.setSessions).toHaveBeenCalled();
			// For claude-code sessions, it uses window.maestro.claude.updateSessionName
			expect(mockClaude.updateSessionName).toHaveBeenCalledWith(
				'/test/project',
				'agent-session-1',
				'New Tab Name'
			);
			expect(mockHistory.updateSessionName).toHaveBeenCalledWith('agent-session-1', 'New Tab Name');
		});

		it('ignores rename when tab not found', () => {
			const session = createMockSession({ id: 'session-1' });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteRenameTabHandler?.('session-1', 'nonexistent', 'New Name');
			});

			expect(mockClaude.updateSessionName).not.toHaveBeenCalled();
			expect(mockAgentSessions.setSessionName).not.toHaveBeenCalled();
		});

		it('renames tabs without persistence when tab has no agent session id', () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [createMockTab({ id: 'tab-1', agentSessionId: null })],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteRenameTabHandler?.('session-1', 'tab-1', '');
			});

			const result = applyLastSessionUpdate(deps, [session]);
			expect(result[0].aiTabs[0].name).toBeNull();
			expect(mockClaude.updateSessionName).not.toHaveBeenCalled();
			expect(mockAgentSessions.setSessionName).not.toHaveBeenCalled();
			expect(mockHistory.updateSessionName).not.toHaveBeenCalled();
		});

		it('renames only the target tab and leaves other sessions unchanged', () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [
					createMockTab({ id: 'tab-1', name: 'Old Name' }),
					createMockTab({ id: 'tab-2', name: 'Other Tab' }),
				],
			});
			const otherSession = createMockSession({ id: 'session-2' });
			const deps = createDeps({ sessions: [session, otherSession] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteRenameTabHandler?.('session-1', 'tab-1', 'New Name');
			});

			const result = applyLastSessionUpdate(deps, [session, otherSession]);
			expect(result[0].aiTabs.map((tab) => tab.name)).toEqual(['New Name', 'Other Tab']);
			expect(result[1]).toBe(otherSession);
		});

		it('persists non-Claude tab names through provider session storage', () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: 'codex',
				aiTabs: [createMockTab({ id: 'tab-1', agentSessionId: 'agent-session-1' })],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteRenameTabHandler?.('session-1', 'tab-1', '');
			});

			const result = applyLastSessionUpdate(deps, [session]);
			expect(result[0].aiTabs[0].name).toBeNull();
			expect(mockAgentSessions.setSessionName).toHaveBeenCalledWith(
				'codex',
				'/test/project',
				'agent-session-1',
				null
			);
			expect(mockHistory.updateSessionName).toHaveBeenCalledWith('agent-session-1', '');
		});

		it('falls back to claude-code persistence when session tool type is missing', () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: undefined,
				aiTabs: [createMockTab({ id: 'tab-1', agentSessionId: 'agent-session-1' })],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteRenameTabHandler?.('session-1', 'tab-1', '');
			});

			const result = applyLastSessionUpdate(deps, [session]);
			expect(result[0].aiTabs[0].name).toBeNull();
			expect(mockClaude.updateSessionName).toHaveBeenCalledWith(
				'/test/project',
				'agent-session-1',
				''
			);
		});

		it('logs persistence failures while still renaming the tab', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const nameError = new Error('name failed');
			const historyError = new Error('history failed');
			mockClaude.updateSessionName.mockRejectedValueOnce(nameError);
			mockHistory.updateSessionName.mockRejectedValueOnce(historyError);
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [createMockTab({ id: 'tab-1', agentSessionId: 'agent-session-1' })],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			await act(async () => {
				onRemoteRenameTabHandler?.('session-1', 'tab-1', 'New Name');
				await Promise.resolve();
			});

			const result = applyLastSessionUpdate(deps, [session]);
			expect(result[0].aiTabs[0].name).toBe('New Name');
			expect(consoleError).toHaveBeenCalledWith('Failed to persist tab name:', nameError);
			expect(consoleError).toHaveBeenCalledWith(
				'Failed to update history session names:',
				historyError
			);
			consoleError.mockRestore();
		});

		it('logs provider name persistence failures while still renaming the tab', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const error = new Error('provider name failed');
			mockAgentSessions.setSessionName.mockRejectedValueOnce(error);
			const session = createMockSession({
				id: 'session-1',
				toolType: 'codex',
				aiTabs: [createMockTab({ id: 'tab-1', agentSessionId: 'agent-session-1' })],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			await act(async () => {
				onRemoteRenameTabHandler?.('session-1', 'tab-1', 'New Name');
				await Promise.resolve();
			});

			const result = applyLastSessionUpdate(deps, [session]);
			expect(result[0].aiTabs[0].name).toBe('New Name');
			expect(consoleError).toHaveBeenCalledWith('Failed to persist tab name:', error);
			consoleError.mockRestore();
		});
	});

	describe('remote star tab', () => {
		it('updates starred state and persists claude-code tab metadata', () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: 'claude-code',
				aiTabs: [createMockTab({ id: 'tab-1', agentSessionId: 'agent-session-1' })],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteStarTabHandler?.('session-1', 'tab-1', true);
			});

			const result = applyLastSessionUpdate(deps, [session]);
			expect(result[0].aiTabs[0].starred).toBe(true);
			expect(mockClaude.updateSessionStarred).toHaveBeenCalledWith(
				'/test/project',
				'agent-session-1',
				true
			);
		});

		it('updates starred state through provider session storage for non-Claude tabs', () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: 'codex',
				aiTabs: [createMockTab({ id: 'tab-1', agentSessionId: 'agent-session-1' })],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteStarTabHandler?.('session-1', 'tab-1', true);
			});

			const result = applyLastSessionUpdate(deps, [session]);
			expect(result[0].aiTabs[0].starred).toBe(true);
			expect(mockAgentSessions.setSessionStarred).toHaveBeenCalledWith(
				'codex',
				'/test/project',
				'agent-session-1',
				true
			);
		});

		it('leaves state unchanged when starred tab has no persisted agent session', () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [createMockTab({ id: 'tab-1', agentSessionId: null, starred: false })],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteStarTabHandler?.('session-1', 'tab-1', true);
			});

			const result = applyLastSessionUpdate(deps, [session]);
			expect(result[0]).toBe(session);
			expect(mockClaude.updateSessionStarred).not.toHaveBeenCalled();
			expect(mockAgentSessions.setSessionStarred).not.toHaveBeenCalled();
		});

		it('stars only the target tab and leaves other sessions unchanged', () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [
					createMockTab({ id: 'tab-1', agentSessionId: 'agent-session-1', starred: false }),
					createMockTab({ id: 'tab-2', agentSessionId: 'agent-session-2', starred: false }),
				],
			});
			const otherSession = createMockSession({ id: 'session-2' });
			const deps = createDeps({ sessions: [session, otherSession] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteStarTabHandler?.('session-1', 'tab-1', true);
			});

			const result = applyLastSessionUpdate(deps, [session, otherSession]);
			expect(result[0].aiTabs.map((tab) => tab.starred)).toEqual([true, false]);
			expect(result[1]).toBe(otherSession);
		});

		it('falls back to claude-code starred persistence when session tool type is missing', () => {
			const session = createMockSession({
				id: 'session-1',
				toolType: undefined,
				aiTabs: [createMockTab({ id: 'tab-1', agentSessionId: 'agent-session-1' })],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteStarTabHandler?.('session-1', 'tab-1', false);
			});

			expect(mockClaude.updateSessionStarred).toHaveBeenCalledWith(
				'/test/project',
				'agent-session-1',
				false
			);
		});

		it('logs star persistence failures while keeping the optimistic starred state', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const error = new Error('star failed');
			mockClaude.updateSessionStarred.mockRejectedValueOnce(error);
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [createMockTab({ id: 'tab-1', agentSessionId: 'agent-session-1' })],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			await act(async () => {
				onRemoteStarTabHandler?.('session-1', 'tab-1', true);
				await Promise.resolve();
			});

			const result = applyLastSessionUpdate(deps, [session]);
			expect(result[0].aiTabs[0].starred).toBe(true);
			expect(consoleError).toHaveBeenCalledWith('Failed to persist tab starred:', error);
			consoleError.mockRestore();
		});

		it('logs provider star persistence failures while keeping the optimistic starred state', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const error = new Error('provider star failed');
			mockAgentSessions.setSessionStarred.mockRejectedValueOnce(error);
			const session = createMockSession({
				id: 'session-1',
				toolType: 'codex',
				aiTabs: [createMockTab({ id: 'tab-1', agentSessionId: 'agent-session-1' })],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			await act(async () => {
				onRemoteStarTabHandler?.('session-1', 'tab-1', true);
				await Promise.resolve();
			});

			const result = applyLastSessionUpdate(deps, [session]);
			expect(result[0].aiTabs[0].starred).toBe(true);
			expect(consoleError).toHaveBeenCalledWith('Failed to persist tab starred:', error);
			consoleError.mockRestore();
		});
	});

	describe('remote reorder and bookmarks', () => {
		it('reorders tabs within the target session', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const tab3 = createMockTab({ id: 'tab-3' });
			const session = createMockSession({ id: 'session-1', aiTabs: [tab1, tab2, tab3] });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteReorderTabHandler?.('session-1', 0, 2);
			});

			const result = applyLastSessionUpdate(deps, [session]);
			expect(result[0].aiTabs.map((tab) => tab.id)).toEqual(['tab-2', 'tab-3', 'tab-1']);
		});

		it('leaves sessions unchanged when reorder target does not match', () => {
			const session = createMockSession({ id: 'session-1' });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteReorderTabHandler?.('missing-session', 0, 1);
			});

			const result = applyLastSessionUpdate(deps, [session]);
			expect(result[0]).toBe(session);
		});

		it('toggles bookmarks only for the target session', () => {
			const session = createMockSession({ id: 'session-1', bookmarked: false });
			const otherSession = createMockSession({ id: 'session-2', bookmarked: true });
			const deps = createDeps({ sessions: [session, otherSession] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteToggleBookmarkHandler?.('session-1');
			});

			const result = applyLastSessionUpdate(deps, [session, otherSession]);
			expect(result[0].bookmarked).toBe(true);
			expect(result[1]).toBe(otherSession);
		});
	});

	describe('tab change broadcasting', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('broadcasts tab changes to web clients when in live mode', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			// IMPORTANT: isLiveMode must be true for broadcast interval to be set up
			const deps = createDeps({ sessions: [session], isLiveMode: true });

			renderHook(() => useRemoteIntegration(deps));

			// Broadcast happens on 500ms interval, advance timers
			vi.advanceTimersByTime(500);

			expect(mockWeb.broadcastTabsChange).toHaveBeenCalledWith(
				'session-1',
				expect.arrayContaining([expect.objectContaining({ id: 'tab-1' })]),
				'tab-1'
			);
		});

		it('does not broadcast when live mode is disabled', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			const deps = createDeps({ sessions: [session], isLiveMode: false });

			renderHook(() => useRemoteIntegration(deps));

			// Advance timers - should not broadcast since not in live mode
			vi.advanceTimersByTime(1000);

			expect(mockWeb.broadcastTabsChange).not.toHaveBeenCalled();
		});

		it('broadcasts session state changes without tabs', () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [],
				activeTabId: '',
				state: 'busy',
			});
			const deps = createDeps({ sessions: [session], isLiveMode: true });

			renderHook(() => useRemoteIntegration(deps));

			vi.advanceTimersByTime(500);

			expect(mockWeb.broadcastSessionState).toHaveBeenCalledWith('session-1', 'busy', {
				name: 'Test Session',
				toolType: 'claude-code',
				inputMode: 'ai',
				cwd: '/test/project',
			});
			expect(mockWeb.broadcastTabsChange).not.toHaveBeenCalled();
		});

		it('uses the first tab as active tab fallback during broadcast', () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [createMockTab({ id: 'tab-1' })],
				activeTabId: '',
			});
			const deps = createDeps({ sessions: [session], isLiveMode: true });

			renderHook(() => useRemoteIntegration(deps));

			vi.advanceTimersByTime(500);

			expect(mockWeb.broadcastTabsChange).toHaveBeenCalledWith(
				'session-1',
				expect.arrayContaining([expect.objectContaining({ id: 'tab-1' })]),
				'tab-1'
			);
		});

		it('skips tab rebroadcasts when tab metadata has not changed', () => {
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [createMockTab({ id: 'tab-1' })],
				activeTabId: 'tab-1',
			});
			const deps = createDeps({ sessions: [session], isLiveMode: true });

			renderHook(() => useRemoteIntegration(deps));

			vi.advanceTimersByTime(500);
			vi.advanceTimersByTime(500);

			expect(mockWeb.broadcastTabsChange).toHaveBeenCalledTimes(1);
		});

		it('rebroadcasts tabs when active tab changes after initial broadcast', () => {
			const tab1 = createMockTab({ id: 'tab-1' });
			const tab2 = createMockTab({ id: 'tab-2' });
			const session = createMockSession({
				id: 'session-1',
				aiTabs: [tab1, tab2],
				activeTabId: 'tab-1',
			});
			const deps = createDeps({ sessions: [session], isLiveMode: true });

			renderHook(() => useRemoteIntegration(deps));

			vi.advanceTimersByTime(500);
			deps.sessionsRef.current = [{ ...session, activeTabId: 'tab-2' }];
			vi.advanceTimersByTime(500);

			expect(mockWeb.broadcastTabsChange).toHaveBeenCalledTimes(2);
			expect(mockWeb.broadcastTabsChange).toHaveBeenLastCalledWith(
				'session-1',
				expect.arrayContaining([expect.objectContaining({ id: 'tab-2' })]),
				'tab-2'
			);
		});
	});
});
