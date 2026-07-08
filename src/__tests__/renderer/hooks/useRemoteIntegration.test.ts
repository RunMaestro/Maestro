import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRemoteIntegration } from '../../../renderer/hooks';
import type { Session, AITab } from '../../../renderer/types';
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';

const createMockTab = (overrides: Partial<AITab> = {}): AITab =>
	createMockAITab({
		createdAt: 1700000000000,
		saveToHistory: true,
		...overrides,
	});

// Thin wrapper: pre-populates an AI tab so remote integration handlers
// have a tab to dispatch events to.
const createMockSession = (overrides: Partial<Session> = {}): Session => {
	const baseTab = createMockTab();
	return baseCreateMockSession({
		isGitRepo: true,
		aiTabs: [baseTab],
		activeTabId: baseTab.id,
		...overrides,
	});
};

describe('useRemoteIntegration', () => {
	const originalMaestro = { ...window.maestro };

	let onRemoteCommandHandler:
		((sessionId: string, command: string, inputMode?: 'ai' | 'terminal') => void) | undefined;
	let onRemoteSwitchModeHandler: ((sessionId: string, mode: 'ai' | 'terminal') => void) | undefined;
	let onRemoteInterruptHandler: ((sessionId: string) => void) | undefined;
	let onRemoteSelectSessionHandler: ((sessionId: string, tabId?: string) => void) | undefined;
	let onRemoteSelectTabHandler: ((sessionId: string, tabId: string) => void) | undefined;
	let onRemoteNewTabHandler: ((sessionId: string, responseChannel: string) => void) | undefined;
	let onRemoteCloseTabHandler: ((sessionId: string, tabId: string) => void) | undefined;
	let onRemoteRenameTabHandler:
		((sessionId: string, tabId: string, newName: string) => void) | undefined;
	let onRemoteStarTabHandler:
		((sessionId: string, tabId: string, starred: boolean) => void) | undefined;
	let onRemoteReorderTabHandler:
		((sessionId: string, fromIndex: number, toIndex: number) => void) | undefined;
	let onRemoteToggleBookmarkHandler: ((sessionId: string) => void) | undefined;
	let onRemoteNewAITabWithPromptHandler:
		((sessionId: string, prompt: string, responseChannel: string) => void) | undefined;
	let onRemoteNotifyToastHandler:
		| ((params: {
				title: string;
				message: string;
				color: 'green' | 'yellow' | 'orange' | 'red' | 'theme';
				duration?: number;
				dismissible?: boolean;
				sessionId?: string;
				tabId?: string;
				actionUrl?: string;
				actionLabel?: string;
				clickAction?:
					| { kind: 'jump-session'; sessionId: string; tabId?: string }
					| { kind: 'open-file'; sessionId: string; path: string }
					| { kind: 'open-url'; url: string };
		  }) => void)
		| undefined;
	const remoteHandlers: Record<string, (...args: any[]) => any> = {};

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
		onRemoteNewAITabWithPrompt: vi.fn().mockImplementation((handler) => {
			onRemoteNewAITabWithPromptHandler = handler;
			return () => {};
		}),
		sendRemoteNewAITabWithPromptResponse: vi.fn(),
		onRemoteOpenFileTab: vi.fn().mockImplementation((handler) => {
			remoteHandlers.openFileTab = handler;
			return () => {};
		}),
		onRemoteRefreshFileTree: vi.fn().mockImplementation((handler) => {
			remoteHandlers.refreshFileTree = handler;
			return () => {};
		}),
		onRemoteOpenBrowserTab: vi.fn().mockImplementation((handler) => {
			remoteHandlers.openBrowserTab = handler;
			return () => {};
		}),
		sendRemoteOpenBrowserTabResponse: vi.fn(),
		onRemoteOpenTerminalTab: vi.fn().mockImplementation((handler) => {
			remoteHandlers.openTerminalTab = handler;
			return () => {};
		}),
		sendRemoteOpenTerminalTabResponse: vi.fn(),
		onRemoteRefreshAutoRunDocs: vi.fn().mockImplementation((handler) => {
			remoteHandlers.refreshAutoRunDocs = handler;
			return () => {};
		}),
		onRemoteConfigureAutoRun: vi.fn().mockImplementation((handler) => {
			remoteHandlers.configureAutoRun = handler;
			return () => {};
		}),
		onRemoteSetAutoRunFolder: vi.fn().mockImplementation((handler) => {
			remoteHandlers.setAutoRunFolder = handler;
			return () => {};
		}),
		sendRemoteNewTabResponse: vi.fn(),
		sendRemoteConfigureAutoRunResponse: vi.fn(),
		sendRemoteSetAutoRunFolderResponse: vi.fn(),
		onRemoteGetAutoRunDocs: vi.fn().mockImplementation((handler) => {
			remoteHandlers.getAutoRunDocs = handler;
			return () => {};
		}),
		onRemoteGetAutoRunDocContent: vi.fn().mockImplementation((handler) => {
			remoteHandlers.getAutoRunDocContent = handler;
			return () => {};
		}),
		onRemoteSaveAutoRunDoc: vi.fn().mockImplementation((handler) => {
			remoteHandlers.saveAutoRunDoc = handler;
			return () => {};
		}),
		sendRemoteSaveAutoRunDocResponse: vi.fn(),
		sendRemoteGetAutoRunDocsResponse: vi.fn(),
		sendRemoteGetAutoRunDocContentResponse: vi.fn(),
		onRemoteStopAutoRun: vi.fn().mockImplementation((handler) => {
			remoteHandlers.stopAutoRun = handler;
			return () => {};
		}),
		onRemoteSetSetting: vi.fn().mockImplementation((handler) => {
			remoteHandlers.setSetting = handler;
			return () => {};
		}),
		sendRemoteSetSettingResponse: vi.fn(),
		onRemoteCreateSession: vi.fn().mockImplementation((handler) => {
			remoteHandlers.createSession = handler;
			return () => {};
		}),
		sendRemoteCreateSessionResponse: vi.fn(),
		onRemoteCreateWorktreeSession: vi.fn().mockImplementation((handler) => {
			remoteHandlers.createWorktreeSession = handler;
			return () => {};
		}),
		sendRemoteCreateWorktreeSessionResponse: vi.fn(),
		onRemoteDeleteSession: vi.fn().mockImplementation((handler) => {
			remoteHandlers.deleteSession = handler;
			return () => {};
		}),
		onRemoteRenameSession: vi.fn().mockImplementation((handler) => {
			remoteHandlers.renameSession = handler;
			return () => {};
		}),
		sendRemoteRenameSessionResponse: vi.fn(),
		onRemoteUpdateSessionCwd: vi.fn().mockImplementation((handler) => {
			remoteHandlers.updateSessionCwd = handler;
			return () => {};
		}),
		sendRemoteUpdateSessionCwdResponse: vi.fn(),
		onRemoteUpdateSessionSsh: vi.fn().mockImplementation((handler) => {
			remoteHandlers.updateSessionSsh = handler;
			return () => {};
		}),
		sendRemoteUpdateSessionSshResponse: vi.fn(),
		onRemoteUpdateSessionConfig: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteUpdateSessionConfigResponse: vi.fn(),
		onRemoteCreateGroup: vi.fn().mockImplementation((handler) => {
			remoteHandlers.createGroup = handler;
			return () => {};
		}),
		sendRemoteCreateGroupResponse: vi.fn(),
		onRemoteRenameGroup: vi.fn().mockImplementation((handler) => {
			remoteHandlers.renameGroup = handler;
			return () => {};
		}),
		sendRemoteRenameGroupResponse: vi.fn(),
		onRemoteDeleteGroup: vi.fn().mockImplementation((handler) => {
			remoteHandlers.deleteGroup = handler;
			return () => {};
		}),
		onRemoteMoveSessionToGroup: vi.fn().mockImplementation((handler) => {
			remoteHandlers.moveSessionToGroup = handler;
			return () => {};
		}),
		sendRemoteMoveSessionToGroupResponse: vi.fn(),
		onRemoteGetGitStatus: vi.fn().mockImplementation((handler) => {
			remoteHandlers.getGitStatus = handler;
			return () => {};
		}),
		sendRemoteGetGitStatusResponse: vi.fn(),
		onRemoteGetGitDiff: vi.fn().mockImplementation((handler) => {
			remoteHandlers.getGitDiff = handler;
			return () => {};
		}),
		sendRemoteGetGitDiffResponse: vi.fn(),
		onRemoteCreateGist: vi.fn().mockImplementation((handler) => {
			remoteHandlers.createGist = handler;
			return () => {};
		}),
		sendRemoteCreateGistResponse: vi.fn(),
		onRemoteTriggerCueSubscription: vi.fn().mockImplementation((handler) => {
			remoteHandlers.triggerCueSubscription = handler;
			return () => {};
		}),
		sendRemoteTriggerCueSubscriptionResponse: vi.fn(),
		onRemoteResetAutoRunDocTasks: vi.fn().mockImplementation((handler) => {
			remoteHandlers.resetAutoRunDocTasks = handler;
			return () => {};
		}),
		sendRemoteResetAutoRunDocTasksResponse: vi.fn(),
		onRemoteResumeAutoRunError: vi.fn().mockImplementation((handler) => {
			remoteHandlers.resumeAutoRunError = handler;
			return () => {};
		}),
		sendRemoteResumeAutoRunErrorResponse: vi.fn(),
		onRemoteSkipAutoRunDocument: vi.fn().mockImplementation((handler) => {
			remoteHandlers.skipAutoRunDocument = handler;
			return () => {};
		}),
		sendRemoteSkipAutoRunDocumentResponse: vi.fn(),
		onRemoteAbortAutoRunError: vi.fn().mockImplementation((handler) => {
			remoteHandlers.abortAutoRunError = handler;
			return () => {};
		}),
		sendRemoteAbortAutoRunErrorResponse: vi.fn(),
		onRemoteListPlaybooks: vi.fn().mockImplementation((handler) => {
			remoteHandlers.listPlaybooks = handler;
			return () => {};
		}),
		sendRemoteListPlaybooksResponse: vi.fn(),
		onRemoteCreatePlaybook: vi.fn().mockImplementation((handler) => {
			remoteHandlers.createPlaybook = handler;
			return () => {};
		}),
		sendRemoteCreatePlaybookResponse: vi.fn(),
		onRemoteUpdatePlaybook: vi.fn().mockImplementation((handler) => {
			remoteHandlers.updatePlaybook = handler;
			return () => {};
		}),
		sendRemoteUpdatePlaybookResponse: vi.fn(),
		onRemoteDeletePlaybook: vi.fn().mockImplementation((handler) => {
			remoteHandlers.deletePlaybook = handler;
			return () => {};
		}),
		sendRemoteDeletePlaybookResponse: vi.fn(),
		onRemoteNotifyToast: vi.fn().mockImplementation((handler) => {
			onRemoteNotifyToastHandler = handler;
			return () => {};
		}),
		onRemoteNotifyCenterFlash: vi.fn().mockImplementation((handler) => {
			remoteHandlers.notifyCenterFlash = handler;
			return () => {};
		}),
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

	const mockCue = {
		...window.maestro.cue,
		triggerSubscription: vi.fn().mockResolvedValue(true),
	};

	const mockSettings = {
		...window.maestro.settings,
		set: vi.fn().mockResolvedValue(undefined),
	};

	const mockGit = {
		...window.maestro.git,
		status: vi
			.fn()
			.mockResolvedValue({ stdout: ' M src/app.ts\nA  src/new.ts\nR  old.ts -> src/renamed.ts\n' }),
		branch: vi.fn().mockResolvedValue({ stdout: 'feature/test\n' }),
		info: vi.fn().mockResolvedValue({ ahead: 2, behind: 1 }),
		diff: vi.fn().mockResolvedValue({
			stdout:
				'diff --git a/src/app.ts b/src/app.ts\n+changed\ndiff --git a/src/new.ts b/src/new.ts\n+new\n',
		}),
		createGist: vi.fn().mockResolvedValue({ success: true, gistUrl: 'https://gist.example/1' }),
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
		onRemoteNewAITabWithPromptHandler = undefined;
		onRemoteNotifyToastHandler = undefined;
		for (const key of Object.keys(remoteHandlers)) {
			delete remoteHandlers[key];
		}

		// Reset zustand stores so cross-test state doesn't leak.
		useSessionStore.setState({ sessions: [] });
		useNotificationStore.setState({ toasts: [] });

		window.maestro = {
			...originalMaestro,
			process: mockProcess as typeof window.maestro.process,
			live: mockLive as typeof window.maestro.live,
			web: mockWeb as typeof window.maestro.web,
			claude: mockClaude as typeof window.maestro.claude,
			agentSessions: mockAgentSessions as typeof window.maestro.agentSessions,
			history: mockHistory as typeof window.maestro.history,
			cue: mockCue as typeof window.maestro.cue,
			settings: mockSettings as typeof window.maestro.settings,
			git: mockGit as typeof window.maestro.git,
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
			defaultShowThinking: 'off' as const,
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
					detail: {
						sessionId: 'session-1',
						command: 'test command',
						inputMode: 'ai',
						tabId: undefined,
						force: undefined,
						images: undefined,
					},
				})
			);

			dispatchEventSpy.mockRestore();
		});

		it('forwards force=true so `dispatch --force` survives the IPC boundary into the renderer', () => {
			const session = createMockSession({ id: 'session-1', state: 'busy' });
			const deps = createDeps({ sessions: [session] });
			const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteCommandHandler?.('session-1', 'concurrent', 'ai', undefined, true);
			});

			// busy guard is bypassed when force=true
			expect(dispatchEventSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'maestro:remoteCommand',
					detail: expect.objectContaining({ force: true }),
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

	describe('remote new AI tab with prompt', () => {
		it('creates tab, dispatches remoteCommand, and acks true with the new tab id on idle session', () => {
			const session = createMockSession({ id: 'session-1', state: 'idle' });
			const deps = createDeps({ sessions: [session] });
			const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteNewAITabWithPromptHandler?.('session-1', 'Hello', 'chan-1');
			});

			expect(deps.setSessions).toHaveBeenCalled();
			expect(deps.setActiveSessionId).toHaveBeenCalledWith('session-1');
			// The dispatched event carries the freshly-created tabId so
			// useRemoteHandlers writes into the new tab even if the user
			// switches active tabs while the event is in flight.
			expect(dispatchEventSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'maestro:remoteCommand',
					detail: expect.objectContaining({
						sessionId: 'session-1',
						command: 'Hello',
						inputMode: 'ai',
						tabId: expect.any(String),
					}),
				})
			);
			// The renderer surfaces the new tab id through the IPC ack so
			// `maestro-cli dispatch --new-tab` can return an addressable id.
			expect(mockProcess.sendRemoteNewAITabWithPromptResponse).toHaveBeenCalledWith(
				'chan-1',
				true,
				expect.any(String)
			);

			dispatchEventSpy.mockRestore();
		});

		it('acks false and skips dispatch when session is missing', () => {
			const deps = createDeps({ sessions: [] });
			const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteNewAITabWithPromptHandler?.('nonexistent', 'Hello', 'chan-missing');
			});

			expect(deps.setSessions).not.toHaveBeenCalled();
			expect(dispatchEventSpy).not.toHaveBeenCalled();
			expect(mockProcess.sendRemoteNewAITabWithPromptResponse).toHaveBeenCalledWith(
				'chan-missing',
				false
			);

			dispatchEventSpy.mockRestore();
		});

		it('acks false and skips dispatch when session is busy', () => {
			const session = createMockSession({ id: 'session-1', state: 'busy' });
			const deps = createDeps({ sessions: [session] });
			const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteNewAITabWithPromptHandler?.('session-1', 'Hello', 'chan-busy');
			});

			expect(deps.setSessions).not.toHaveBeenCalled();
			expect(dispatchEventSpy).not.toHaveBeenCalled();
			expect(mockProcess.sendRemoteNewAITabWithPromptResponse).toHaveBeenCalledWith(
				'chan-busy',
				false
			);

			dispatchEventSpy.mockRestore();
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

	describe('remote notify toast', () => {
		// Regression: the renderer used to fall back to `session.activeTabId` when
		// the IPC payload omitted `tabId`. That caused every agent-scoped toast
		// (e.g. cron-fired notifications) to be stamped with whatever AI tab was
		// front-most in that agent, leaking an unrelated tab name into the toast.
		it('does NOT synthesize a tabId from activeTabId when caller omits tabId', () => {
			const tab = createMockTab({ id: 'tab-foreground', name: 'Foreground Tab' });
			const session = createMockSession({
				id: 'session-1',
				name: 'Pedsidian-chain-7',
				aiTabs: [tab],
				activeTabId: 'tab-foreground',
			});
			useSessionStore.setState({ sessions: [session] });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteNotifyToastHandler?.({
					title: 'New stars',
					message: 'Hello world',
					color: 'yellow',
					dismissible: true,
					sessionId: 'session-1',
					clickAction: {
						kind: 'open-file',
						sessionId: 'session-1',
						path: '/notes/stars.md',
					},
				});
			});

			const toasts = useNotificationStore.getState().toasts;
			expect(toasts).toHaveLength(1);
			expect(toasts[0]).toMatchObject({
				title: 'New stars',
				message: 'Hello world',
				project: 'Pedsidian-chain-7',
				sessionId: 'session-1',
			});
			expect(toasts[0].tabId).toBeUndefined();
			expect(toasts[0].tabName).toBeUndefined();
		});

		it('honors an explicit tabId from the caller', () => {
			const tab = createMockTab({ id: 'tab-target', name: 'Target Tab' });
			const otherTab = createMockTab({ id: 'tab-foreground', name: 'Foreground Tab' });
			const session = createMockSession({
				id: 'session-1',
				name: 'Some Agent',
				aiTabs: [otherTab, tab],
				activeTabId: 'tab-foreground',
			});
			useSessionStore.setState({ sessions: [session] });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteNotifyToastHandler?.({
					title: 'Done',
					message: 'Task finished',
					color: 'green',
					sessionId: 'session-1',
					tabId: 'tab-target',
				});
			});

			const toasts = useNotificationStore.getState().toasts;
			expect(toasts).toHaveLength(1);
			expect(toasts[0]).toMatchObject({
				project: 'Some Agent',
				sessionId: 'session-1',
				tabId: 'tab-target',
				tabName: 'Target Tab',
			});
		});

		it('still resolves project (agent) name when sessionId is provided without tabId', () => {
			const session = createMockSession({
				id: 'session-1',
				name: 'Pedsidian',
				aiTabs: [],
			});
			useSessionStore.setState({ sessions: [session] });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteNotifyToastHandler?.({
					title: 'Heads up',
					message: 'Cron fired',
					color: 'theme',
					sessionId: 'session-1',
				});
			});

			const toasts = useNotificationStore.getState().toasts;
			expect(toasts[0]?.project).toBe('Pedsidian');
			expect(toasts[0]?.tabId).toBeUndefined();
			expect(toasts[0]?.tabName).toBeUndefined();
		});

		it('shows an explicit sourceAgent label in the header without any sessionId', () => {
			useSessionStore.setState({ sessions: [] });
			const deps = createDeps({ sessions: [] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteNotifyToastHandler?.({
					title: 'Watchdog',
					message: 'Discover broken',
					color: 'red',
					sourceAgent: 'Maestro Marketing · Twitter Watchdog',
				});
			});

			const toasts = useNotificationStore.getState().toasts;
			expect(toasts).toHaveLength(1);
			expect(toasts[0]?.project).toBe('Maestro Marketing · Twitter Watchdog');
			expect(toasts[0]?.sessionId).toBeUndefined();
		});

		it('prefers an explicit sourceAgent label over the store-resolved session name', () => {
			const session = createMockSession({
				id: 'session-1',
				name: 'Maestro Marketing',
				aiTabs: [],
			});
			useSessionStore.setState({ sessions: [session] });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteNotifyToastHandler?.({
					title: 'Post stalled',
					message: 'Approved drafts not posting',
					color: 'orange',
					sessionId: 'session-1',
					sourceAgent: 'Twitter Post',
				});
			});

			const toasts = useNotificationStore.getState().toasts;
			// Label wins for display; sessionId still rides along for click-to-jump.
			expect(toasts[0]?.project).toBe('Twitter Post');
			expect(toasts[0]?.sessionId).toBe('session-1');
		});
	});

	describe('remote event bridge handlers', () => {
		it('dispatches DOM events with the full remote payload for App-level handlers', () => {
			const deps = createDeps();
			const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');
			const terminalConfig = { cwd: '/repo', shell: '/bin/zsh', name: 'Logs' };
			const autoRunConfig = { mode: 'plan', prompt: 'Review docs' };
			const worktreeConfig = { branchName: 'feature/test', cwd: '/repo' };
			const sshPatch = { enabled: true, host: 'example.test' };

			renderHook(() => useRemoteIntegration(deps));

			const cases = [
				{
					handler: 'openFileTab',
					type: 'maestro:openFileTab',
					invoke: () => remoteHandlers.openFileTab('session-1', '/repo/src/app.ts', true),
					detail: { sessionId: 'session-1', filePath: '/repo/src/app.ts', switchToAgent: true },
				},
				{
					handler: 'refreshFileTree',
					type: 'maestro:refreshFileTree',
					invoke: () => remoteHandlers.refreshFileTree('session-1'),
					detail: { sessionId: 'session-1' },
				},
				{
					handler: 'openBrowserTab',
					type: 'maestro:openBrowserTab',
					invoke: () =>
						remoteHandlers.openBrowserTab('session-1', 'https://runmaestro.ai', 'chan-browser'),
					detail: {
						sessionId: 'session-1',
						url: 'https://runmaestro.ai',
						responseChannel: 'chan-browser',
					},
				},
				{
					handler: 'openTerminalTab',
					type: 'maestro:openTerminalTab',
					invoke: () =>
						remoteHandlers.openTerminalTab('session-1', terminalConfig, 'chan-terminal'),
					detail: {
						sessionId: 'session-1',
						config: terminalConfig,
						responseChannel: 'chan-terminal',
					},
				},
				{
					handler: 'refreshAutoRunDocs',
					type: 'maestro:refreshAutoRunDocs',
					invoke: () => remoteHandlers.refreshAutoRunDocs('session-1'),
					detail: { sessionId: 'session-1' },
				},
				{
					handler: 'configureAutoRun',
					type: 'maestro:configureAutoRun',
					invoke: () => remoteHandlers.configureAutoRun('session-1', autoRunConfig, 'chan-config'),
					detail: { sessionId: 'session-1', config: autoRunConfig, responseChannel: 'chan-config' },
				},
				{
					handler: 'createWorktreeSession',
					type: 'maestro:createWorktreeSession',
					invoke: () =>
						remoteHandlers.createWorktreeSession('parent-session', worktreeConfig, 'chan-worktree'),
					detail: {
						parentSessionId: 'parent-session',
						config: worktreeConfig,
						responseChannel: 'chan-worktree',
					},
				},
				{
					handler: 'setAutoRunFolder',
					type: 'maestro:setAutoRunFolder',
					invoke: () =>
						remoteHandlers.setAutoRunFolder('session-1', '/repo/.maestro', 'chan-folder'),
					detail: {
						sessionId: 'session-1',
						folderPath: '/repo/.maestro',
						responseChannel: 'chan-folder',
					},
				},
				{
					handler: 'getAutoRunDocs',
					type: 'maestro:getAutoRunDocs',
					invoke: () => remoteHandlers.getAutoRunDocs('session-1', 'chan-docs'),
					detail: { sessionId: 'session-1', responseChannel: 'chan-docs' },
				},
				{
					handler: 'getAutoRunDocContent',
					type: 'maestro:getAutoRunDocContent',
					invoke: () =>
						remoteHandlers.getAutoRunDocContent('session-1', 'game-plan.md', 'chan-content'),
					detail: {
						sessionId: 'session-1',
						filename: 'game-plan.md',
						responseChannel: 'chan-content',
					},
				},
				{
					handler: 'saveAutoRunDoc',
					type: 'maestro:saveAutoRunDoc',
					invoke: () =>
						remoteHandlers.saveAutoRunDoc('session-1', 'game-plan.md', '# plan', 'chan-save'),
					detail: {
						sessionId: 'session-1',
						filename: 'game-plan.md',
						content: '# plan',
						responseChannel: 'chan-save',
					},
				},
				{
					handler: 'stopAutoRun',
					type: 'maestro:stopAutoRun',
					invoke: () => remoteHandlers.stopAutoRun('session-1'),
					detail: { sessionId: 'session-1' },
				},
				{
					handler: 'resetAutoRunDocTasks',
					type: 'maestro:resetAutoRunDocTasks',
					invoke: () =>
						remoteHandlers.resetAutoRunDocTasks('session-1', 'game-plan.md', 'chan-reset'),
					detail: {
						sessionId: 'session-1',
						filename: 'game-plan.md',
						responseChannel: 'chan-reset',
					},
				},
				{
					handler: 'resumeAutoRunError',
					type: 'maestro:resumeAutoRunError',
					invoke: () => remoteHandlers.resumeAutoRunError('session-1', 'chan-resume'),
					detail: { sessionId: 'session-1', responseChannel: 'chan-resume' },
				},
				{
					handler: 'skipAutoRunDocument',
					type: 'maestro:skipAutoRunDocument',
					invoke: () => remoteHandlers.skipAutoRunDocument('session-1', 'chan-skip'),
					detail: { sessionId: 'session-1', responseChannel: 'chan-skip' },
				},
				{
					handler: 'abortAutoRunError',
					type: 'maestro:abortAutoRunError',
					invoke: () => remoteHandlers.abortAutoRunError('session-1', 'chan-abort'),
					detail: { sessionId: 'session-1', responseChannel: 'chan-abort' },
				},
				{
					handler: 'listPlaybooks',
					type: 'maestro:listPlaybooks',
					invoke: () => remoteHandlers.listPlaybooks('session-1', 'chan-list'),
					detail: { sessionId: 'session-1', responseChannel: 'chan-list' },
				},
				{
					handler: 'createPlaybook',
					type: 'maestro:createPlaybook',
					invoke: () =>
						remoteHandlers.createPlaybook('session-1', { name: 'Review' }, 'chan-create-playbook'),
					detail: {
						sessionId: 'session-1',
						playbook: { name: 'Review' },
						responseChannel: 'chan-create-playbook',
					},
				},
				{
					handler: 'updatePlaybook',
					type: 'maestro:updatePlaybook',
					invoke: () =>
						remoteHandlers.updatePlaybook(
							'session-1',
							'playbook-1',
							{ name: 'Updated' },
							'chan-update-playbook'
						),
					detail: {
						sessionId: 'session-1',
						playbookId: 'playbook-1',
						updates: { name: 'Updated' },
						responseChannel: 'chan-update-playbook',
					},
				},
				{
					handler: 'deletePlaybook',
					type: 'maestro:deletePlaybook',
					invoke: () =>
						remoteHandlers.deletePlaybook('session-1', 'playbook-1', 'chan-delete-playbook'),
					detail: {
						sessionId: 'session-1',
						playbookId: 'playbook-1',
						responseChannel: 'chan-delete-playbook',
					},
				},
				{
					handler: 'createSession',
					type: 'maestro:remoteCreateSession',
					invoke: () =>
						remoteHandlers.createSession(
							'New Agent',
							'codex',
							'/repo',
							'group-1',
							{ model: 'gpt' },
							'chan-create'
						),
					detail: {
						name: 'New Agent',
						toolType: 'codex',
						cwd: '/repo',
						groupId: 'group-1',
						config: { model: 'gpt' },
						responseChannel: 'chan-create',
					},
				},
				{
					handler: 'deleteSession',
					type: 'maestro:remoteDeleteSession',
					invoke: () => remoteHandlers.deleteSession('session-1'),
					detail: { sessionId: 'session-1' },
				},
				{
					handler: 'renameSession',
					type: 'maestro:remoteRenameSession',
					invoke: () => remoteHandlers.renameSession('session-1', 'Renamed Agent', 'chan-rename'),
					detail: {
						sessionId: 'session-1',
						newName: 'Renamed Agent',
						responseChannel: 'chan-rename',
					},
				},
				{
					handler: 'updateSessionCwd',
					type: 'maestro:remoteUpdateSessionCwd',
					invoke: () => remoteHandlers.updateSessionCwd('session-1', '/repo/next', 'chan-cwd'),
					detail: { sessionId: 'session-1', newCwd: '/repo/next', responseChannel: 'chan-cwd' },
				},
				{
					handler: 'updateSessionSsh',
					type: 'maestro:remoteUpdateSessionSsh',
					invoke: () => remoteHandlers.updateSessionSsh('session-1', sshPatch, 'chan-ssh'),
					detail: { sessionId: 'session-1', sshPatch, responseChannel: 'chan-ssh' },
				},
				{
					handler: 'createGroup',
					type: 'maestro:remoteCreateGroup',
					invoke: () => remoteHandlers.createGroup('Backend', 'B', 'chan-group-create'),
					detail: { name: 'Backend', emoji: 'B', responseChannel: 'chan-group-create' },
				},
				{
					handler: 'renameGroup',
					type: 'maestro:remoteRenameGroup',
					invoke: () => remoteHandlers.renameGroup('group-1', 'Platform', 'chan-group-rename'),
					detail: { groupId: 'group-1', name: 'Platform', responseChannel: 'chan-group-rename' },
				},
				{
					handler: 'deleteGroup',
					type: 'maestro:remoteDeleteGroup',
					invoke: () => remoteHandlers.deleteGroup('group-1'),
					detail: { groupId: 'group-1' },
				},
				{
					handler: 'moveSessionToGroup',
					type: 'maestro:remoteMoveSessionToGroup',
					invoke: () => remoteHandlers.moveSessionToGroup('session-1', null, 'chan-move'),
					detail: { sessionId: 'session-1', groupId: null, responseChannel: 'chan-move' },
				},
			];

			for (const testCase of cases) {
				dispatchEventSpy.mockClear();
				act(() => {
					testCase.invoke();
				});
				expect(remoteHandlers[testCase.handler]).toEqual(expect.any(Function));
				expect(dispatchEventSpy).toHaveBeenCalledWith(
					expect.objectContaining({
						type: testCase.type,
						detail: testCase.detail,
					})
				);
			}

			dispatchEventSpy.mockRestore();
		});
	});

	describe('remote settings and git handlers', () => {
		it('sets a setting and acknowledges success or failure', async () => {
			const deps = createDeps();

			renderHook(() => useRemoteIntegration(deps));

			await act(async () => {
				await remoteHandlers.setSetting('theme', 'dark', 'chan-setting-ok');
			});

			expect(mockSettings.set).toHaveBeenCalledWith('theme', 'dark');
			expect(mockProcess.sendRemoteSetSettingResponse).toHaveBeenCalledWith(
				'chan-setting-ok',
				true
			);

			mockSettings.set.mockRejectedValueOnce(new Error('settings unavailable'));

			await act(async () => {
				await remoteHandlers.setSetting('theme', 'light', 'chan-setting-fail');
			});

			expect(mockProcess.sendRemoteSetSettingResponse).toHaveBeenCalledWith(
				'chan-setting-fail',
				false
			);
		});

		it('returns parsed git status for the requested session cwd', async () => {
			const session = createMockSession({ id: 'session-1', cwd: '/repo' });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			await act(async () => {
				await remoteHandlers.getGitStatus('session-1', 'chan-git-status');
			});

			expect(mockGit.status).toHaveBeenCalledWith('/repo');
			expect(mockGit.branch).toHaveBeenCalledWith('/repo');
			expect(mockGit.info).toHaveBeenCalledWith('/repo');
			expect(mockProcess.sendRemoteGetGitStatusResponse).toHaveBeenCalledWith('chan-git-status', {
				branch: 'feature/test',
				files: [
					{ path: 'src/app.ts', status: 'M', staged: false },
					{ path: 'src/new.ts', status: 'A', staged: true },
					{ path: 'src/renamed.ts', status: 'R', staged: true },
				],
				ahead: 2,
				behind: 1,
			});
		});

		it('returns changed files from a git diff and falls back for missing sessions', async () => {
			const session = createMockSession({ id: 'session-1', cwd: '/repo' });
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			await act(async () => {
				await remoteHandlers.getGitDiff('session-1', 'src/app.ts', 'chan-git-diff');
			});

			expect(mockGit.diff).toHaveBeenCalledWith('/repo', 'src/app.ts');
			expect(mockProcess.sendRemoteGetGitDiffResponse).toHaveBeenCalledWith('chan-git-diff', {
				diff: expect.stringContaining('diff --git a/src/app.ts b/src/app.ts'),
				files: ['src/app.ts', 'src/new.ts'],
			});

			await act(async () => {
				await remoteHandlers.getGitDiff('missing-session', undefined, 'chan-git-missing');
			});

			expect(mockProcess.sendRemoteGetGitDiffResponse).toHaveBeenCalledWith('chan-git-missing', {
				diff: '',
				files: [],
			});
		});
	});

	describe('remote Cue and gist handlers', () => {
		it('forwards Cue subscription trigger results to the response channel', async () => {
			const deps = createDeps();

			renderHook(() => useRemoteIntegration(deps));

			await act(async () => {
				await remoteHandlers.triggerCueSubscription(
					'Daily Check',
					'Summarize',
					'chan-cue',
					'session-1'
				);
			});

			expect(mockCue.triggerSubscription).toHaveBeenCalledWith(
				'Daily Check',
				'Summarize',
				'session-1'
			);
			expect(mockProcess.sendRemoteTriggerCueSubscriptionResponse).toHaveBeenCalledWith(
				'chan-cue',
				true
			);
		});

		it('publishes AI tab transcript content through the gist IPC handler', async () => {
			const tab = createMockTab({
				id: 'tab-1',
				name: 'Planning',
				logs: [
					{ id: 'log-1', timestamp: 1, source: 'user', text: 'What should we test?' },
					{ id: 'log-2', timestamp: 2, source: 'ai', text: 'Cover the remote bridge.' },
				],
			});
			const session = createMockSession({
				id: 'session-1',
				name: 'My Session!',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			await act(async () => {
				await remoteHandlers.createGist('session-1', 'Remote transcript', false, 'chan-gist');
			});

			expect(mockGit.createGist).toHaveBeenCalledWith(
				'My_Session__context.md',
				expect.stringContaining('# My Session!'),
				'Remote transcript',
				false
			);
			expect(mockGit.createGist).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining('## Tab: Planning'),
				expect.any(String),
				expect.any(Boolean)
			);
			expect(mockGit.createGist).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining('USER:\nWhat should we test?'),
				expect.any(String),
				expect.any(Boolean)
			);
			expect(mockGit.createGist).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining('ASSISTANT:\nCover the remote bridge.'),
				expect.any(String),
				expect.any(Boolean)
			);
			expect(mockProcess.sendRemoteCreateGistResponse).toHaveBeenCalledWith('chan-gist', {
				success: true,
				gistUrl: 'https://gist.example/1',
			});
		});

		it('reports a structured gist error when the target session has no transcript', async () => {
			const session = createMockSession({
				id: 'session-1',
				name: 'Empty Session',
				aiTabs: [createMockTab({ logs: [] })],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			await act(async () => {
				await remoteHandlers.createGist('session-1', 'Empty', true, 'chan-empty-gist');
			});

			expect(mockGit.createGist).not.toHaveBeenCalled();
			expect(mockProcess.sendRemoteCreateGistResponse).toHaveBeenCalledWith('chan-empty-gist', {
				success: false,
				error: 'Session has no conversation history to publish',
			});
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
