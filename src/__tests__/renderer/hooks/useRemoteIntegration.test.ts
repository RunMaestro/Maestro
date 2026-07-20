import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRemoteIntegration } from '../../../renderer/hooks';
import type { Session, AITab } from '../../../renderer/types';
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import { useMovementStore } from '../../../renderer/stores/movementStore';
import type { MovementPayload } from '../../../shared/movement-types';
import { CONCERTO_DESIGNER_CHANNEL } from '../../../shared/concerto-html';
import {
	clearConcertoDesignerFramesForTests,
	handleConcertoDesignerMessage,
	registerConcertoDesignerFrame,
} from '../../../renderer/components/Concerto/concertoDesignerBridge';

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
		| ((
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				force?: boolean,
				images?: string[],
				background?: boolean
		  ) => void)
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
	let onRemoteNewAITabWithPromptHandler:
		| ((sessionId: string, prompt: string, responseChannel: string, background?: boolean) => void)
		| undefined;
	let onRemoteEnqueueCommandHandler:
		| ((
				sessionId: string,
				command: string,
				responseChannel: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				images?: string[],
				background?: boolean
		  ) => void)
		| undefined;
	let onRemoteListQueueHandler:
		| ((sessionId: string | undefined, responseChannel: string) => void)
		| undefined;
	let onRemoteRemoveQueueItemHandler:
		| ((sessionId: string, itemId: string, responseChannel: string) => void)
		| undefined;
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
	let onRemoteMovementHandler:
		| ((params: MovementPayload, responseChannel?: string) => void)
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
		onRemoteEnqueueCommand: vi.fn().mockImplementation((handler) => {
			onRemoteEnqueueCommandHandler = handler;
			return () => {};
		}),
		sendRemoteEnqueueCommandResponse: vi.fn(),
		onRemoteListQueue: vi.fn().mockImplementation((handler) => {
			onRemoteListQueueHandler = handler;
			return () => {};
		}),
		sendRemoteListQueueResponse: vi.fn(),
		onRemoteRemoveQueueItem: vi.fn().mockImplementation((handler) => {
			onRemoteRemoveQueueItemHandler = handler;
			return () => {};
		}),
		sendRemoteRemoveQueueItemResponse: vi.fn(),
		onRemoteOpenFileTab: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		onRemoteRefreshFileTree: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		onRemoteOpenBrowserTab: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteOpenBrowserTabResponse: vi.fn(),
		onRemoteOpenTerminalTab: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteOpenTerminalTabResponse: vi.fn(),
		onRemoteRefreshAutoRunDocs: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		onRemoteConfigureAutoRun: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		onRemoteSetAutoRunFolder: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteNewTabResponse: vi.fn(),
		sendRemoteConfigureAutoRunResponse: vi.fn(),
		sendRemoteSetAutoRunFolderResponse: vi.fn(),
		onRemoteGetAutoRunDocs: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		onRemoteGetAutoRunDocContent: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		onRemoteSaveAutoRunDoc: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteSaveAutoRunDocResponse: vi.fn(),
		sendRemoteGetAutoRunDocsResponse: vi.fn(),
		sendRemoteGetAutoRunDocContentResponse: vi.fn(),
		onRemoteStopAutoRun: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		onRemoteSetSetting: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteSetSettingResponse: vi.fn(),
		onRemoteCreateSession: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteCreateSessionResponse: vi.fn(),
		onRemoteCreateWorktreeSession: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteCreateWorktreeSessionResponse: vi.fn(),
		onRemoteDeleteSession: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		onRemoteRenameSession: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteRenameSessionResponse: vi.fn(),
		onRemoteUpdateSessionCwd: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteUpdateSessionCwdResponse: vi.fn(),
		onRemoteUpdateSessionSsh: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteUpdateSessionSshResponse: vi.fn(),
		onRemoteUpdateSessionConfig: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteUpdateSessionConfigResponse: vi.fn(),
		onRemoteCreateGroup: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteCreateGroupResponse: vi.fn(),
		onRemoteRenameGroup: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteRenameGroupResponse: vi.fn(),
		onRemoteDeleteGroup: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		onRemoteMoveSessionToGroup: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteMoveSessionToGroupResponse: vi.fn(),
		onRemoteGetGitStatus: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteGetGitStatusResponse: vi.fn(),
		onRemoteGetGitDiff: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteGetGitDiffResponse: vi.fn(),
		onRemoteCreateGist: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteCreateGistResponse: vi.fn(),
		onRemoteTriggerCueSubscription: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		sendRemoteTriggerCueSubscriptionResponse: vi.fn(),
		// Auto Run parity additions - playbook CRUD + task reset + error recovery.
		// Each hook subscribes but the tests here don't drive these handlers;
		// a no-op unsubscribe keeps useRemoteIntegration setup from throwing.
		onRemoteResetAutoRunDocTasks: vi.fn().mockImplementation(() => () => {}),
		sendRemoteResetAutoRunDocTasksResponse: vi.fn(),
		onRemoteResumeAutoRunError: vi.fn().mockImplementation(() => () => {}),
		sendRemoteResumeAutoRunErrorResponse: vi.fn(),
		onRemoteSkipAutoRunDocument: vi.fn().mockImplementation(() => () => {}),
		sendRemoteSkipAutoRunDocumentResponse: vi.fn(),
		onRemoteAbortAutoRunError: vi.fn().mockImplementation(() => () => {}),
		sendRemoteAbortAutoRunErrorResponse: vi.fn(),
		onRemoteListPlaybooks: vi.fn().mockImplementation(() => () => {}),
		sendRemoteListPlaybooksResponse: vi.fn(),
		onRemoteCreatePlaybook: vi.fn().mockImplementation(() => () => {}),
		sendRemoteCreatePlaybookResponse: vi.fn(),
		onRemoteUpdatePlaybook: vi.fn().mockImplementation(() => () => {}),
		sendRemoteUpdatePlaybookResponse: vi.fn(),
		onRemoteDeletePlaybook: vi.fn().mockImplementation(() => () => {}),
		sendRemoteDeletePlaybookResponse: vi.fn(),
		onRemoteNotifyToast: vi.fn().mockImplementation((handler) => {
			onRemoteNotifyToastHandler = handler;
			return () => {};
		}),
		onRemoteNotifyCenterFlash: vi.fn().mockImplementation(() => {
			return () => {};
		}),
		onRemoteMovement: vi.fn().mockImplementation((handler) => {
			onRemoteMovementHandler = handler;
			return () => {};
		}),
		sendMovementAppliedResponse: vi.fn(),
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
		onRemoteEnqueueCommandHandler = undefined;
		onRemoteListQueueHandler = undefined;
		onRemoteRemoveQueueItemHandler = undefined;
		onRemoteNotifyToastHandler = undefined;
		onRemoteMovementHandler = undefined;

		// Reset zustand stores so cross-test state doesn't leak.
		useSessionStore.setState({ sessions: [] });
		useNotificationStore.setState({ toasts: [] });
		useMovementStore.setState({ items: [], hidden: false });
		clearConcertoDesignerFramesForTests();

		window.maestro = {
			...originalMaestro,
			process: mockProcess as typeof window.maestro.process,
			live: mockLive as typeof window.maestro.live,
			web: mockWeb as typeof window.maestro.web,
			claude: mockClaude as typeof window.maestro.claude,
			agentSessions: mockAgentSessions as typeof window.maestro.agentSessions,
			history: mockHistory as typeof window.maestro.history,
			cue: mockCue as typeof window.maestro.cue,
		};
	});

	afterEach(() => {
		clearConcertoDesignerFramesForTests();
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

		it('does NOT switch the active session when background=true (background dispatch)', () => {
			const session = createMockSession({ id: 'session-1', state: 'idle' });
			const deps = createDeps({ sessions: [session], activeSessionId: 'other-session' });
			const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				// (sessionId, command, inputMode, tabId, force, images, background)
				onRemoteCommandHandler?.(
					'session-1',
					'quietly',
					'ai',
					undefined,
					undefined,
					undefined,
					true
				);
			});

			// Focus side effect suppressed, but the command still runs.
			expect(deps.setActiveSessionId).not.toHaveBeenCalled();
			expect(dispatchEventSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'maestro:remoteCommand',
					detail: expect.objectContaining({ sessionId: 'session-1', command: 'quietly' }),
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

		it('creates the tab in the background without focusing when background=true (background new-tab dispatch)', () => {
			const session = createMockSession({ id: 'session-1', state: 'idle' });
			const originalActiveTabId = session.activeTabId;
			const originalTabCount = session.aiTabs.length;
			const deps = createDeps({ sessions: [session], activeSessionId: 'other-session' });
			const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteNewAITabWithPromptHandler?.('session-1', 'Hello', 'chan-bg', true);
			});

			// Tab was created and the prompt still dispatched...
			expect(deps.setSessions).toHaveBeenCalled();
			expect(dispatchEventSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'maestro:remoteCommand',
					detail: expect.objectContaining({
						sessionId: 'session-1',
						command: 'Hello',
						tabId: expect.any(String),
					}),
				})
			);
			// ...but the agent is NOT brought to the foreground.
			expect(deps.setActiveSessionId).not.toHaveBeenCalled();

			// The new tab is appended but NOT made active: the previously-active
			// tab is preserved so the user's visible view never changes.
			const updater = deps.setSessions.mock.calls[0][0];
			const [updated] = updater([session]);
			expect(updated.aiTabs).toHaveLength(originalTabCount + 1);
			expect(updated.activeTabId).toBe(originalActiveTabId);

			dispatchEventSpy.mockRestore();
		});
	});

	describe('remote enqueue command (dispatch --queue)', () => {
		it('enqueues a message on a busy session and acks the queue position', () => {
			const tab = createMockTab({ id: 'tab-1', name: 'PR review' });
			const session = createMockSession({
				id: 'session-1',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				executionQueue: [],
			});
			const deps = createDeps({ sessions: [session] });
			const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteEnqueueCommandHandler?.('session-1', 'Second task', 'chan-q', 'ai', 'tab-1');
			});

			// Busy target: no immediate dispatch, the prompt is appended to the queue.
			expect(dispatchEventSpy).not.toHaveBeenCalled();
			expect(deps.setSessions).toHaveBeenCalled();
			const updater = deps.setSessions.mock.calls[0][0];
			const [updated] = updater([session]);
			expect(updated.executionQueue).toHaveLength(1);
			expect(updated.executionQueue[0]).toMatchObject({
				type: 'message',
				text: 'Second task',
				tabId: 'tab-1',
				tabName: 'PR review',
			});

			// Ack carries queued=true + a 1-based position + the item id.
			expect(mockProcess.sendRemoteEnqueueCommandResponse).toHaveBeenCalledWith(
				'chan-q',
				expect.objectContaining({
					success: true,
					tabId: 'tab-1',
					queued: true,
					queuePosition: 1,
					itemId: expect.any(String),
				})
			);

			dispatchEventSpy.mockRestore();
		});

		it('appends after existing items so ordering stays FIFO and position advances', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const existing = {
				id: 'existing-1',
				timestamp: 1,
				tabId: 'tab-1',
				type: 'message' as const,
				text: 'first',
			};
			const session = createMockSession({
				id: 'session-1',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				executionQueue: [existing],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteEnqueueCommandHandler?.('session-1', 'second', 'chan-q2', 'ai', 'tab-1');
			});

			const updater = deps.setSessions.mock.calls[0][0];
			const [updated] = updater([session]);
			expect(updated.executionQueue.map((i: { text?: string }) => i.text)).toEqual([
				'first',
				'second',
			]);
			expect(mockProcess.sendRemoteEnqueueCommandResponse).toHaveBeenCalledWith(
				'chan-q2',
				expect.objectContaining({ queued: true, queuePosition: 2, queueLength: 2 })
			);
		});

		it('dispatches immediately (queued=false) when the session is idle', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'session-1',
				state: 'idle',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			const deps = createDeps({ sessions: [session] });
			const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteEnqueueCommandHandler?.('session-1', 'Run now', 'chan-idle', 'ai', 'tab-1');
			});

			// Idle target: no queue mutation, dispatched through the shared path.
			expect(dispatchEventSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'maestro:remoteCommand',
					detail: expect.objectContaining({
						sessionId: 'session-1',
						command: 'Run now',
						inputMode: 'ai',
						tabId: 'tab-1',
					}),
				})
			);
			expect(mockProcess.sendRemoteEnqueueCommandResponse).toHaveBeenCalledWith(
				'chan-idle',
				expect.objectContaining({ success: true, tabId: 'tab-1', queued: false })
			);

			dispatchEventSpy.mockRestore();
		});

		it('acks an error when the explicit tab does not exist (no silent reroute)', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'session-1',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-1',
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteEnqueueCommandHandler?.('session-1', 'x', 'chan-badtab', 'ai', 'ghost-tab');
			});

			expect(deps.setSessions).not.toHaveBeenCalled();
			expect(mockProcess.sendRemoteEnqueueCommandResponse).toHaveBeenCalledWith(
				'chan-badtab',
				expect.objectContaining({
					success: false,
					error: expect.stringContaining('ghost-tab'),
				})
			);
		});

		it('acks an error when the session is missing', () => {
			const deps = createDeps({ sessions: [] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteEnqueueCommandHandler?.('nope', 'x', 'chan-nosession');
			});

			expect(deps.setSessions).not.toHaveBeenCalled();
			expect(mockProcess.sendRemoteEnqueueCommandResponse).toHaveBeenCalledWith(
				'chan-nosession',
				expect.objectContaining({ success: false, error: 'Session not found' })
			);
		});
	});

	describe('remote queue admin (queue list / remove)', () => {
		it('lists sessions with queued items and acks the snapshot', () => {
			const tab = createMockTab({ id: 'tab-1', name: 'PR review' });
			const item = {
				id: 'q1',
				timestamp: 5,
				tabId: 'tab-1',
				type: 'message' as const,
				text: 'queued prompt',
				tabName: 'PR review',
			};
			const session = createMockSession({
				id: 'session-1',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				executionQueue: [item],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteListQueueHandler?.(undefined, 'chan-list');
			});

			expect(mockProcess.sendRemoteListQueueResponse).toHaveBeenCalledWith(
				'chan-list',
				expect.objectContaining({
					success: true,
					queues: [
						expect.objectContaining({
							sessionId: 'session-1',
							items: [expect.objectContaining({ id: 'q1', text: 'queued prompt' })],
						}),
					],
				})
			);
		});

		it('removes a queued item by id and acks removed:true', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const item = { id: 'q1', timestamp: 1, tabId: 'tab-1', type: 'message' as const, text: 'x' };
			const session = createMockSession({
				id: 'session-1',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				executionQueue: [item],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteRemoveQueueItemHandler?.('session-1', 'q1', 'chan-rm');
			});

			const updater = deps.setSessions.mock.calls[0][0];
			const [updated] = updater([session]);
			expect(updated.executionQueue).toHaveLength(0);
			expect(mockProcess.sendRemoteRemoveQueueItemResponse).toHaveBeenCalledWith(
				'chan-rm',
				expect.objectContaining({ success: true, removed: true })
			);
		});

		it('acks removed:false when the item id is not in the queue', () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'session-1',
				state: 'busy',
				aiTabs: [tab],
				activeTabId: 'tab-1',
				executionQueue: [],
			});
			const deps = createDeps({ sessions: [session] });

			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteRemoveQueueItemHandler?.('session-1', 'ghost', 'chan-rm2');
			});

			expect(mockProcess.sendRemoteRemoveQueueItemResponse).toHaveBeenCalledWith(
				'chan-rm2',
				expect.objectContaining({ success: true, removed: false })
			);
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

	describe('movement commit acknowledgements', () => {
		it('still applies plugin movements that do not carry a response channel', () => {
			const deps = createDeps();
			renderHook(() => useRemoteIntegration(deps));

			act(() => {
				onRemoteMovementHandler?.({
					op: 'add',
					id: 'com.acme.metrics/summary',
					body: '{"blocks":[]}',
				});
			});

			expect(useMovementStore.getState().items).toHaveLength(1);
			expect(mockProcess.sendMovementAppliedResponse).not.toHaveBeenCalled();
		});

		it('waits for the routed HTML revision to register and become ready', async () => {
			const deps = createDeps();
			renderHook(() => useRemoteIntegration(deps));
			const frame = document.createElement('iframe');
			document.body.appendChild(frame);
			vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
				x: 0,
				y: 0,
				width: 640,
				height: 480,
				top: 0,
				right: 640,
				bottom: 480,
				left: 0,
				toJSON: () => ({}),
			});
			registerConcertoDesignerFrame('movement', 'mockup', 21, frame);

			act(() => {
				onRemoteMovementHandler?.(
					{
						op: 'add',
						id: 'mockup',
						viewType: 'html',
						body: '<button>Continue</button>',
						revision: 21,
					},
					'movement-response'
				);
			});
			expect(mockProcess.sendMovementAppliedResponse).not.toHaveBeenCalled();

			await act(async () => {
				handleConcertoDesignerMessage('movement', 'mockup', {
					source: frame.contentWindow,
					data: { channel: CONCERTO_DESIGNER_CHANNEL, kind: 'ready' },
				} as MessageEvent);
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(mockProcess.sendMovementAppliedResponse).toHaveBeenCalledWith(
				'movement-response',
				true
			);
			frame.remove();
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
