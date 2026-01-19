import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRemoteIntegration } from '../../../renderer/hooks';
import type { Session, AITab } from '../../../renderer/types';

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
		sendRemoteNewTabResponse: vi.fn(),
	};

	const mockLive = {
		...window.maestro.live,
		broadcastActiveSession: vi.fn(),
	};

	const mockWeb = {
		...window.maestro.web,
		broadcastTabsChange: vi.fn(),
	};

	const mockClaude = {
		...window.maestro.claude,
		updateSessionName: vi.fn().mockResolvedValue(undefined),
	};

	const mockAgentSessions = {
		...window.maestro.agentSessions,
		updateSessionName: vi.fn().mockResolvedValue(true),
		setSessionName: vi.fn().mockResolvedValue(undefined),
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
		};
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

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteCommandHandler?.('nonexistent', 'test command', 'ai');
			});

			expect(deps.setActiveSessionId).not.toHaveBeenCalled();
			expect(dispatchEventSpy).not.toHaveBeenCalled();

			dispatchEventSpy.mockRestore();
		});

		it('ignores command when session is busy', () => {
			const session = createMockSession({ id: 'session-1', state: 'busy' });
			const deps = createDeps({ sessions: [session] });
			const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteCommandHandler?.('session-1', 'test command', 'ai');
			});

			expect(deps.setActiveSessionId).not.toHaveBeenCalled();
			expect(dispatchEventSpy).not.toHaveBeenCalled();

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
			expect(mockProcess.sendRemoteNewTabResponse).toHaveBeenCalled();
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
	});
});
