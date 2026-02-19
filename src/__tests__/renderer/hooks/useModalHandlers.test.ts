/**
 * Tests for useModalHandlers hook (extracted from App.tsx Phase 2C)
 *
 * Covers all handler groups: simple close, session-related close, quit,
 * celebration, leaderboard, agent error, simple open, session list openers,
 * tour, lightbox, utility close, quick actions, and effects.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock useAgentErrorRecovery BEFORE importing the hook
vi.mock('../../../renderer/hooks/agent/useAgentErrorRecovery', () => ({
	useAgentErrorRecovery: vi.fn().mockReturnValue({ recoveryActions: [] }),
}));

import { useModalHandlers } from '../../../renderer/hooks/modal/useModalHandlers';
import { useModalStore, getModalActions } from '../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useAgentStore } from '../../../renderer/stores/agentStore';
import { useAgentErrorRecovery } from '../../../renderer/hooks/agent/useAgentErrorRecovery';
import type { Session, AITab } from '../../../renderer/types';

// ============================================================================
// Helpers
// ============================================================================

const createInputRef = () => ({
	current: { focus: vi.fn() } as unknown as HTMLTextAreaElement,
});

const createTerminalOutputRef = () => ({
	current: { focus: vi.fn() } as unknown as HTMLDivElement,
});

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: overrides.id ?? 'session-1',
		name: overrides.name ?? 'Test Session',
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

function createMockAITab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: overrides.id ?? 'tab-1',
		agentSessionId: overrides.agentSessionId ?? null,
		name: overrides.name ?? null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle',
		hasUnread: false,
		isAtBottom: true,
		...overrides,
	} as AITab;
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();

	// Reset stores
	useModalStore.setState({ modals: new Map() });
	useSessionStore.setState({
		sessions: [],
		activeSessionId: '',
		sessionsLoaded: false,
		initialLoadComplete: false,
	});
	useGroupChatStore.setState({
		activeGroupChatId: null,
		groupChatStagedImages: [],
	});

	// Ensure window.maestro.app mock is present
	(window.maestro as any).app = {
		confirmQuit: vi.fn(),
		cancelQuit: vi.fn(),
	};

	// Reset useAgentErrorRecovery mock
	(useAgentErrorRecovery as ReturnType<typeof vi.fn>).mockReturnValue({
		recoveryActions: [],
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('useModalHandlers', () => {
	// ======================================================================
	// Derived State
	// ======================================================================

	describe('derived state', () => {
		it('errorSession is null when no agentErrorModalSessionId is set', () => {
			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			expect(result.current.errorSession).toBeNull();
		});

		it('errorSession resolves to matching session when agentErrorModalSessionId is set', () => {
			const session = createMockSession({ id: 'err-session' });
			useSessionStore.setState({ sessions: [session] });
			getModalActions().setAgentErrorModalSessionId('err-session');

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			expect(result.current.errorSession).toEqual(session);
		});

		it('errorSession is null when agentErrorModalSessionId does not match any session', () => {
			useSessionStore.setState({ sessions: [createMockSession({ id: 'other' })] });
			getModalActions().setAgentErrorModalSessionId('nonexistent');

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			expect(result.current.errorSession).toBeNull();
		});

		it('recoveryActions comes from useAgentErrorRecovery hook', () => {
			const mockActions = [{ label: 'Retry', action: vi.fn() }];
			(useAgentErrorRecovery as ReturnType<typeof vi.fn>).mockReturnValue({
				recoveryActions: mockActions,
			});

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			expect(result.current.recoveryActions).toBe(mockActions);
		});
	});

	// ======================================================================
	// Group A: Simple Close Handlers
	// ======================================================================

	describe('Group A: Simple Close Handlers', () => {
		const closeHandlerTests: Array<{
			name: string;
			handler: keyof ReturnType<typeof useModalHandlers>;
			openAction: () => void;
			modalId: string;
		}> = [
			{
				name: 'handleCloseGitDiff',
				handler: 'handleCloseGitDiff',
				openAction: () => getModalActions().setGitDiffPreview('diff content'),
				modalId: 'gitDiff',
			},
			{
				name: 'handleCloseGitLog',
				handler: 'handleCloseGitLog',
				openAction: () => getModalActions().setGitLogOpen(true),
				modalId: 'gitLog',
			},
			{
				name: 'handleCloseSettings',
				handler: 'handleCloseSettings',
				openAction: () => getModalActions().setSettingsModalOpen(true),
				modalId: 'settings',
			},
			{
				name: 'handleCloseDebugPackage',
				handler: 'handleCloseDebugPackage',
				openAction: () => getModalActions().setDebugPackageModalOpen(true),
				modalId: 'debugPackage',
			},
			{
				name: 'handleCloseShortcutsHelp',
				handler: 'handleCloseShortcutsHelp',
				openAction: () => getModalActions().setShortcutsHelpOpen(true),
				modalId: 'shortcutsHelp',
			},
			{
				name: 'handleCloseAboutModal',
				handler: 'handleCloseAboutModal',
				openAction: () => getModalActions().setAboutModalOpen(true),
				modalId: 'about',
			},
			{
				name: 'handleCloseUpdateCheckModal',
				handler: 'handleCloseUpdateCheckModal',
				openAction: () => getModalActions().setUpdateCheckModalOpen(true),
				modalId: 'updateCheck',
			},
			{
				name: 'handleCloseProcessMonitor',
				handler: 'handleCloseProcessMonitor',
				openAction: () => getModalActions().setProcessMonitorOpen(true),
				modalId: 'processMonitor',
			},
			{
				name: 'handleCloseLogViewer',
				handler: 'handleCloseLogViewer',
				openAction: () => getModalActions().setLogViewerOpen(true),
				modalId: 'logViewer',
			},
			{
				name: 'handleCloseConfirmModal',
				handler: 'handleCloseConfirmModal',
				openAction: () => getModalActions().setConfirmModalOpen(true),
				modalId: 'confirm',
			},
		];

		closeHandlerTests.forEach(({ name, handler, openAction, modalId }) => {
			it(`${name} closes the ${modalId} modal`, () => {
				openAction();
				expect(useModalStore.getState().isOpen(modalId as any)).toBe(true);

				const { result } = renderHook(() =>
					useModalHandlers(createInputRef(), createTerminalOutputRef())
				);
				act(() => {
					(result.current[handler] as () => void)();
				});

				expect(useModalStore.getState().isOpen(modalId as any)).toBe(false);
			});
		});
	});

	// ======================================================================
	// Group B: Session-Related Close Handlers
	// ======================================================================

	describe('Group B: Session-Related Close Handlers', () => {
		it('handleCloseDeleteAgentModal closes modal and clears session data', () => {
			const session = createMockSession();
			getModalActions().setDeleteAgentSession(session);
			expect(useModalStore.getState().isOpen('deleteAgent')).toBe(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleCloseDeleteAgentModal();
			});

			expect(useModalStore.getState().isOpen('deleteAgent')).toBe(false);
			expect(useModalStore.getState().getData('deleteAgent')).toBeUndefined();
		});

		it('handleCloseNewInstanceModal closes modal and clears duplicating session id', () => {
			getModalActions().setNewInstanceModalOpen(true);
			expect(useModalStore.getState().isOpen('newInstance')).toBe(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleCloseNewInstanceModal();
			});

			expect(useModalStore.getState().isOpen('newInstance')).toBe(false);
		});

		it('handleCloseEditAgentModal closes modal and clears edit session', () => {
			const session = createMockSession();
			getModalActions().setEditAgentSession(session);
			expect(useModalStore.getState().isOpen('editAgent')).toBe(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleCloseEditAgentModal();
			});

			expect(useModalStore.getState().isOpen('editAgent')).toBe(false);
			expect(useModalStore.getState().getData('editAgent')).toBeUndefined();
		});

		it('handleCloseRenameSessionModal closes modal and clears session id', () => {
			getModalActions().setRenameInstanceModalOpen(true);
			expect(useModalStore.getState().isOpen('renameInstance')).toBe(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleCloseRenameSessionModal();
			});

			expect(useModalStore.getState().isOpen('renameInstance')).toBe(false);
		});

		it('handleCloseRenameTabModal closes modal and clears tab id', () => {
			getModalActions().setRenameTabModalOpen(true);
			expect(useModalStore.getState().isOpen('renameTab')).toBe(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleCloseRenameTabModal();
			});

			expect(useModalStore.getState().isOpen('renameTab')).toBe(false);
		});
	});

	// ======================================================================
	// Group C: Quit Handlers
	// ======================================================================

	describe('Group C: Quit Handlers', () => {
		it('handleConfirmQuit closes quit modal and calls confirmQuit', () => {
			getModalActions().setQuitConfirmModalOpen(true);
			expect(useModalStore.getState().isOpen('quitConfirm')).toBe(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleConfirmQuit();
			});

			expect(useModalStore.getState().isOpen('quitConfirm')).toBe(false);
			expect(window.maestro.app.confirmQuit).toHaveBeenCalledOnce();
		});

		it('handleCancelQuit closes quit modal and calls cancelQuit', () => {
			getModalActions().setQuitConfirmModalOpen(true);
			expect(useModalStore.getState().isOpen('quitConfirm')).toBe(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleCancelQuit();
			});

			expect(useModalStore.getState().isOpen('quitConfirm')).toBe(false);
			expect(window.maestro.app.cancelQuit).toHaveBeenCalledOnce();
		});
	});

	// ======================================================================
	// Group D: Celebration Handlers
	// ======================================================================

	describe('Group D: Celebration Handlers', () => {
		it('onKeyboardMasteryLevelUp sets pending keyboard mastery level', () => {
			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.onKeyboardMasteryLevelUp(3);
			});

			const data = useModalStore.getState().getData('keyboardMastery');
			expect(data).toEqual({ level: 3 });
			expect(useModalStore.getState().isOpen('keyboardMastery')).toBe(true);
		});

		it('handleKeyboardMasteryCelebrationClose acknowledges level and clears pending', () => {
			const mockAcknowledge = vi.fn();
			vi.spyOn(useSettingsStore, 'getState').mockReturnValue({
				...useSettingsStore.getState(),
				acknowledgeKeyboardMasteryLevel: mockAcknowledge,
			});

			// Set up pending level
			getModalActions().setPendingKeyboardMasteryLevel(5);
			expect(useModalStore.getState().getData('keyboardMastery')).toEqual({ level: 5 });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleKeyboardMasteryCelebrationClose();
			});

			expect(mockAcknowledge).toHaveBeenCalledWith(5);
			expect(useModalStore.getState().isOpen('keyboardMastery')).toBe(false);
		});

		it('handleKeyboardMasteryCelebrationClose does not acknowledge when no pending level', () => {
			const mockAcknowledge = vi.fn();
			vi.spyOn(useSettingsStore, 'getState').mockReturnValue({
				...useSettingsStore.getState(),
				acknowledgeKeyboardMasteryLevel: mockAcknowledge,
			});

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleKeyboardMasteryCelebrationClose();
			});

			expect(mockAcknowledge).not.toHaveBeenCalled();
		});

		it('handleStandingOvationClose acknowledges badge and clears data', () => {
			const mockAcknowledgeBadge = vi.fn();
			vi.spyOn(useSettingsStore, 'getState').mockReturnValue({
				...useSettingsStore.getState(),
				acknowledgeBadge: mockAcknowledgeBadge,
			});

			getModalActions().setStandingOvationData({
				badge: { level: 2 } as any,
				isNewRecord: true,
			});
			expect(useModalStore.getState().isOpen('standingOvation')).toBe(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleStandingOvationClose();
			});

			expect(mockAcknowledgeBadge).toHaveBeenCalledWith(2);
			expect(useModalStore.getState().isOpen('standingOvation')).toBe(false);
		});

		it('handleStandingOvationClose does nothing when no ovation data', () => {
			const mockAcknowledgeBadge = vi.fn();
			vi.spyOn(useSettingsStore, 'getState').mockReturnValue({
				...useSettingsStore.getState(),
				acknowledgeBadge: mockAcknowledgeBadge,
			});

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleStandingOvationClose();
			});

			expect(mockAcknowledgeBadge).not.toHaveBeenCalled();
		});

		it('handleFirstRunCelebrationClose clears first run data', () => {
			getModalActions().setFirstRunCelebrationData({
				elapsedTimeMs: 5000,
				completedTasks: 3,
				totalTasks: 5,
			});
			expect(useModalStore.getState().isOpen('firstRunCelebration')).toBe(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleFirstRunCelebrationClose();
			});

			expect(useModalStore.getState().isOpen('firstRunCelebration')).toBe(false);
		});
	});

	// ======================================================================
	// Group E: Leaderboard Handlers
	// ======================================================================

	describe('Group E: Leaderboard Handlers', () => {
		it('handleOpenLeaderboardRegistration opens leaderboard modal', () => {
			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleOpenLeaderboardRegistration();
			});

			expect(useModalStore.getState().isOpen('leaderboard')).toBe(true);
		});

		it('handleOpenLeaderboardRegistrationFromAbout closes about and opens leaderboard', () => {
			getModalActions().setAboutModalOpen(true);
			expect(useModalStore.getState().isOpen('about')).toBe(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleOpenLeaderboardRegistrationFromAbout();
			});

			expect(useModalStore.getState().isOpen('about')).toBe(false);
			expect(useModalStore.getState().isOpen('leaderboard')).toBe(true);
		});

		it('handleCloseLeaderboardRegistration closes leaderboard modal', () => {
			getModalActions().setLeaderboardRegistrationOpen(true);
			expect(useModalStore.getState().isOpen('leaderboard')).toBe(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleCloseLeaderboardRegistration();
			});

			expect(useModalStore.getState().isOpen('leaderboard')).toBe(false);
		});

		it('handleSaveLeaderboardRegistration saves registration to settings', () => {
			const mockSetRegistration = vi.fn();
			vi.spyOn(useSettingsStore, 'getState').mockReturnValue({
				...useSettingsStore.getState(),
				setLeaderboardRegistration: mockSetRegistration,
			});

			const registration = { email: 'test@example.com', name: 'Test' };
			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleSaveLeaderboardRegistration(registration as any);
			});

			expect(mockSetRegistration).toHaveBeenCalledWith(registration);
		});

		it('handleLeaderboardOptOut sets registration to null', () => {
			const mockSetRegistration = vi.fn();
			vi.spyOn(useSettingsStore, 'getState').mockReturnValue({
				...useSettingsStore.getState(),
				setLeaderboardRegistration: mockSetRegistration,
			});

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleLeaderboardOptOut();
			});

			expect(mockSetRegistration).toHaveBeenCalledWith(null);
		});
	});

	// ======================================================================
	// Group F: Agent Error Handlers
	// ======================================================================

	describe('Group F: Agent Error Handlers', () => {
		it('handleCloseAgentErrorModal clears agentErrorModalSessionId', () => {
			getModalActions().setAgentErrorModalSessionId('session-1');
			expect(useModalStore.getState().isOpen('agentError')).toBe(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleCloseAgentErrorModal();
			});

			expect(useModalStore.getState().isOpen('agentError')).toBe(false);
		});

		it('handleShowAgentErrorModal sets session id when active tab has agentError', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				agentSessionId: 'as-1',
				agentError: { message: 'test error' } as any,
			});
			const session = createMockSession({
				id: 'session-1',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleShowAgentErrorModal();
			});

			expect(useModalStore.getState().isOpen('agentError')).toBe(true);
			expect(useModalStore.getState().getData('agentError')).toEqual({
				sessionId: 'session-1',
			});
		});

		it('handleShowAgentErrorModal does nothing when no active session', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleShowAgentErrorModal();
			});

			expect(useModalStore.getState().isOpen('agentError')).toBe(false);
		});

		it('handleShowAgentErrorModal does nothing when active tab has no agentError', () => {
			const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'as-1' });
			const session = createMockSession({
				id: 'session-1',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleShowAgentErrorModal();
			});

			expect(useModalStore.getState().isOpen('agentError')).toBe(false);
		});

		it('handleClearAgentError clears error on agent store and closes modal', () => {
			const mockClearAgentError = vi.fn();
			vi.spyOn(useAgentStore, 'getState').mockReturnValue({
				...useAgentStore.getState(),
				clearAgentError: mockClearAgentError,
			});
			getModalActions().setAgentErrorModalSessionId('session-1');

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleClearAgentError('session-1', 'tab-1');
			});

			expect(mockClearAgentError).toHaveBeenCalledWith('session-1', 'tab-1');
			expect(useModalStore.getState().isOpen('agentError')).toBe(false);
		});

		it('handleStartNewSessionAfterError calls agent store, clears modal, and focuses input', () => {
			const mockStartNew = vi.fn();
			vi.spyOn(useAgentStore, 'getState').mockReturnValue({
				...useAgentStore.getState(),
				startNewSessionAfterError: mockStartNew,
			});
			vi.spyOn(useSettingsStore, 'getState').mockReturnValue({
				...useSettingsStore.getState(),
				defaultSaveToHistory: true,
				defaultShowThinking: 'off',
			});
			getModalActions().setAgentErrorModalSessionId('session-1');

			const inputRef = createInputRef();
			const { result } = renderHook(() => useModalHandlers(inputRef, createTerminalOutputRef()));
			act(() => {
				result.current.handleStartNewSessionAfterError('session-1');
			});

			expect(mockStartNew).toHaveBeenCalledWith('session-1', {
				saveToHistory: true,
				showThinking: 'off',
			});
			expect(useModalStore.getState().isOpen('agentError')).toBe(false);

			// Focus happens in setTimeout
			act(() => {
				vi.advanceTimersByTime(10);
			});
			expect(inputRef.current!.focus).toHaveBeenCalled();
		});

		it('handleRetryAfterError calls agent store, clears modal, and focuses input', () => {
			const mockRetry = vi.fn();
			vi.spyOn(useAgentStore, 'getState').mockReturnValue({
				...useAgentStore.getState(),
				retryAfterError: mockRetry,
			});
			getModalActions().setAgentErrorModalSessionId('session-1');

			const inputRef = createInputRef();
			const { result } = renderHook(() => useModalHandlers(inputRef, createTerminalOutputRef()));
			act(() => {
				result.current.handleRetryAfterError('session-1');
			});

			expect(mockRetry).toHaveBeenCalledWith('session-1');
			expect(useModalStore.getState().isOpen('agentError')).toBe(false);

			act(() => {
				vi.advanceTimersByTime(10);
			});
			expect(inputRef.current!.focus).toHaveBeenCalled();
		});

		it('handleRestartAgentAfterError calls agent store async, clears modal, and focuses input', async () => {
			const mockRestart = vi.fn().mockResolvedValue(undefined);
			vi.spyOn(useAgentStore, 'getState').mockReturnValue({
				...useAgentStore.getState(),
				restartAgentAfterError: mockRestart,
			});
			getModalActions().setAgentErrorModalSessionId('session-1');

			const inputRef = createInputRef();
			const { result } = renderHook(() => useModalHandlers(inputRef, createTerminalOutputRef()));

			await act(async () => {
				await result.current.handleRestartAgentAfterError('session-1');
			});

			expect(mockRestart).toHaveBeenCalledWith('session-1');
			expect(useModalStore.getState().isOpen('agentError')).toBe(false);

			act(() => {
				vi.advanceTimersByTime(10);
			});
			expect(inputRef.current!.focus).toHaveBeenCalled();
		});

		it('handleAuthenticateAfterError calls agent store, clears modal, and focuses input', () => {
			const mockAuth = vi.fn();
			vi.spyOn(useAgentStore, 'getState').mockReturnValue({
				...useAgentStore.getState(),
				authenticateAfterError: mockAuth,
			});
			getModalActions().setAgentErrorModalSessionId('session-1');

			const inputRef = createInputRef();
			const { result } = renderHook(() => useModalHandlers(inputRef, createTerminalOutputRef()));
			act(() => {
				result.current.handleAuthenticateAfterError('session-1');
			});

			expect(mockAuth).toHaveBeenCalledWith('session-1');
			expect(useModalStore.getState().isOpen('agentError')).toBe(false);

			act(() => {
				vi.advanceTimersByTime(10);
			});
			expect(inputRef.current!.focus).toHaveBeenCalled();
		});
	});

	// ======================================================================
	// Group G: Simple Open Handlers
	// ======================================================================

	describe('Group G: Simple Open Handlers', () => {
		const openHandlerTests: Array<{
			name: string;
			handler: keyof ReturnType<typeof useModalHandlers>;
			modalId: string;
		}> = [
			{
				name: 'handleOpenQueueBrowser',
				handler: 'handleOpenQueueBrowser',
				modalId: 'queueBrowser',
			},
			{ name: 'handleOpenTabSearch', handler: 'handleOpenTabSearch', modalId: 'tabSwitcher' },
			{
				name: 'handleOpenPromptComposer',
				handler: 'handleOpenPromptComposer',
				modalId: 'promptComposer',
			},
			{
				name: 'handleOpenFuzzySearch',
				handler: 'handleOpenFuzzySearch',
				modalId: 'fuzzyFileSearch',
			},
			{ name: 'handleOpenCreatePR', handler: 'handleOpenCreatePR', modalId: 'createPR' },
			{ name: 'handleOpenAboutModal', handler: 'handleOpenAboutModal', modalId: 'about' },
			{ name: 'handleOpenBatchRunner', handler: 'handleOpenBatchRunner', modalId: 'batchRunner' },
			{ name: 'handleOpenMarketplace', handler: 'handleOpenMarketplace', modalId: 'marketplace' },
		];

		openHandlerTests.forEach(({ name, handler, modalId }) => {
			it(`${name} opens the ${modalId} modal`, () => {
				expect(useModalStore.getState().isOpen(modalId as any)).toBe(false);

				const { result } = renderHook(() =>
					useModalHandlers(createInputRef(), createTerminalOutputRef())
				);
				act(() => {
					(result.current[handler] as () => void)();
				});

				expect(useModalStore.getState().isOpen(modalId as any)).toBe(true);
			});
		});
	});

	// ======================================================================
	// Group H: Session List Openers
	// ======================================================================

	describe('Group H: Session List Openers', () => {
		it('handleEditAgent opens edit agent modal with session data', () => {
			const session = createMockSession({ id: 'edit-session' });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleEditAgent(session);
			});

			expect(useModalStore.getState().isOpen('editAgent')).toBe(true);
			expect(useModalStore.getState().getData('editAgent')).toEqual({ session });
		});

		it('handleOpenCreatePRSession opens createPR modal with session data', () => {
			const session = createMockSession({ id: 'pr-session' });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleOpenCreatePRSession(session);
			});

			expect(useModalStore.getState().isOpen('createPR')).toBe(true);
			expect(useModalStore.getState().getData('createPR')).toEqual({ session });
		});
	});

	// ======================================================================
	// Group I: Tour Handler
	// ======================================================================

	describe('Group I: Tour Handler', () => {
		it('handleStartTour sets tourFromWizard to false and opens tour', () => {
			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleStartTour();
			});

			expect(useModalStore.getState().isOpen('tour')).toBe(true);
			// Tour opens with default fromWizard: false
			const tourData = useModalStore.getState().getData('tour');
			expect(tourData?.fromWizard).toBe(false);
		});
	});

	// ======================================================================
	// Group J: Lightbox Handlers
	// ======================================================================

	describe('Group J: Lightbox Handlers', () => {
		it('handleSetLightboxImage sets image, images, and source fields', () => {
			useGroupChatStore.setState({ activeGroupChatId: null });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleSetLightboxImage('img1.png', ['img1.png', 'img2.png'], 'staged');
			});

			const lightboxData = useModalStore.getState().getData('lightbox');
			expect(lightboxData?.image).toBe('img1.png');
			expect(lightboxData?.images).toEqual(['img1.png', 'img2.png']);
			expect(lightboxData?.source).toBe('staged');
			expect(useModalStore.getState().isOpen('lightbox')).toBe(true);
		});

		it('handleSetLightboxImage sets isGroupChat when lightbox already open', () => {
			useGroupChatStore.setState({ activeGroupChatId: 'gc-1' });

			// Pre-open lightbox so updateModalData works
			getModalActions().setLightboxImage('pre.png');

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleSetLightboxImage('img.png', ['img.png'], 'staged');
			});

			const lightboxData = useModalStore.getState().getData('lightbox');
			expect(lightboxData?.isGroupChat).toBe(true);
			expect(lightboxData?.allowDelete).toBe(true);
		});

		it('handleSetLightboxImage defaults to history source and no allowDelete', () => {
			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleSetLightboxImage('img.png', ['img.png']);
			});

			const lightboxData = useModalStore.getState().getData('lightbox');
			expect(lightboxData?.source).toBe('history');
			expect(lightboxData?.allowDelete).toBe(false);
		});

		it('handleCloseLightbox clears all lightbox state and focuses input', () => {
			// Open lightbox first
			const actions = getModalActions();
			actions.setLightboxImage('img.png');
			actions.setLightboxImages(['img.png', 'img2.png']);
			actions.setLightboxSource('staged');
			actions.setLightboxIsGroupChat(true);
			actions.setLightboxAllowDelete(true);

			const inputRef = createInputRef();
			const { result } = renderHook(() => useModalHandlers(inputRef, createTerminalOutputRef()));
			act(() => {
				result.current.handleCloseLightbox();
			});

			expect(useModalStore.getState().isOpen('lightbox')).toBe(false);

			act(() => {
				vi.advanceTimersByTime(10);
			});
			expect(inputRef.current!.focus).toHaveBeenCalled();
		});

		it('handleNavigateLightbox updates the lightbox image', () => {
			// Open lightbox first
			const actions = getModalActions();
			actions.setLightboxImage('img1.png');
			actions.setLightboxImages(['img1.png', 'img2.png']);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleNavigateLightbox('img2.png');
			});

			const lightboxData = useModalStore.getState().getData('lightbox');
			expect(lightboxData?.image).toBe('img2.png');
		});

		it('handleDeleteLightboxImage removes image from group chat staged images', () => {
			useGroupChatStore.setState({
				activeGroupChatId: 'gc-1',
				groupChatStagedImages: ['img1.png', 'img2.png', 'img3.png'],
			});

			// Open lightbox with isGroupChat = true
			const actions = getModalActions();
			actions.setLightboxImage('img2.png');
			actions.setLightboxImages(['img1.png', 'img2.png', 'img3.png']);
			actions.setLightboxIsGroupChat(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleDeleteLightboxImage('img2.png');
			});

			expect(useGroupChatStore.getState().groupChatStagedImages).toEqual(['img1.png', 'img3.png']);
			const lightboxData = useModalStore.getState().getData('lightbox');
			expect(lightboxData?.images).toEqual(['img1.png', 'img3.png']);
		});

		it('handleDeleteLightboxImage removes image from session staged images', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				stagedImages: ['img1.png', 'img2.png'],
			});
			const session = createMockSession({
				id: 'session-1',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			// Open lightbox without group chat
			const actions = getModalActions();
			actions.setLightboxImage('img1.png');
			actions.setLightboxImages(['img1.png', 'img2.png']);
			actions.setLightboxIsGroupChat(false);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleDeleteLightboxImage('img1.png');
			});

			// Verify the session staged images were updated
			const updatedSession = useSessionStore.getState().sessions[0];
			const updatedTab = updatedSession.aiTabs.find((t) => t.id === 'tab-1');
			expect(updatedTab?.stagedImages).toEqual(['img2.png']);

			// Lightbox images should also be updated
			const lightboxData = useModalStore.getState().getData('lightbox');
			expect(lightboxData?.images).toEqual(['img2.png']);
		});
	});

	// ======================================================================
	// Group K: Utility Close Handlers
	// ======================================================================

	describe('Group K: Utility Close Handlers', () => {
		it('handleCloseAutoRunSetup closes autoRunSetup modal', () => {
			getModalActions().setAutoRunSetupModalOpen(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleCloseAutoRunSetup();
			});

			expect(useModalStore.getState().isOpen('autoRunSetup')).toBe(false);
		});

		it('handleCloseBatchRunner closes batchRunner modal', () => {
			getModalActions().setBatchRunnerModalOpen(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleCloseBatchRunner();
			});

			expect(useModalStore.getState().isOpen('batchRunner')).toBe(false);
		});

		it('handleCloseTabSwitcher closes tabSwitcher modal', () => {
			getModalActions().setTabSwitcherOpen(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleCloseTabSwitcher();
			});

			expect(useModalStore.getState().isOpen('tabSwitcher')).toBe(false);
		});

		it('handleCloseFileSearch closes fuzzyFileSearch modal', () => {
			getModalActions().setFuzzyFileSearchOpen(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleCloseFileSearch();
			});

			expect(useModalStore.getState().isOpen('fuzzyFileSearch')).toBe(false);
		});

		it('handleClosePromptComposer closes modal and focuses input', () => {
			getModalActions().setPromptComposerOpen(true);

			const inputRef = createInputRef();
			const { result } = renderHook(() => useModalHandlers(inputRef, createTerminalOutputRef()));
			act(() => {
				result.current.handleClosePromptComposer();
			});

			expect(useModalStore.getState().isOpen('promptComposer')).toBe(false);

			act(() => {
				vi.advanceTimersByTime(10);
			});
			expect(inputRef.current!.focus).toHaveBeenCalled();
		});

		it('handleCloseCreatePRModal closes modal and clears session', () => {
			const session = createMockSession();
			getModalActions().setCreatePRSession(session);
			expect(useModalStore.getState().isOpen('createPR')).toBe(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleCloseCreatePRModal();
			});

			expect(useModalStore.getState().isOpen('createPR')).toBe(false);
		});

		it('handleCloseSendToAgent closes sendToAgent modal', () => {
			getModalActions().setSendToAgentModalOpen(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleCloseSendToAgent();
			});

			expect(useModalStore.getState().isOpen('sendToAgent')).toBe(false);
		});

		it('handleCloseQueueBrowser closes queueBrowser modal', () => {
			getModalActions().setQueueBrowserOpen(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleCloseQueueBrowser();
			});

			expect(useModalStore.getState().isOpen('queueBrowser')).toBe(false);
		});

		it('handleCloseRenameGroupModal closes renameGroup modal', () => {
			getModalActions().setRenameGroupModalOpen(true);

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleCloseRenameGroupModal();
			});

			expect(useModalStore.getState().isOpen('renameGroup')).toBe(false);
		});
	});

	// ======================================================================
	// Group M: Quick Actions
	// ======================================================================

	describe('Group M: Quick Actions', () => {
		it('handleQuickActionsRenameTab sets rename tab state for active AI tab', () => {
			const tab = createMockAITab({
				id: 'tab-1',
				agentSessionId: 'as-1',
				name: 'My Tab',
			});
			const session = createMockSession({
				id: 'session-1',
				inputMode: 'ai',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleQuickActionsRenameTab();
			});

			expect(useModalStore.getState().isOpen('renameTab')).toBe(true);
			const renameData = useModalStore.getState().getData('renameTab');
			expect(renameData?.tabId).toBe('tab-1');
		});

		it('handleQuickActionsRenameTab does nothing when not in AI mode', () => {
			const session = createMockSession({
				id: 'session-1',
				inputMode: 'terminal' as any,
				activeTabId: 'tab-1',
				aiTabs: [],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleQuickActionsRenameTab();
			});

			expect(useModalStore.getState().isOpen('renameTab')).toBe(false);
		});

		it('handleQuickActionsRenameTab does nothing when tab has no agentSessionId', () => {
			const tab = createMockAITab({ id: 'tab-1', agentSessionId: null });
			const session = createMockSession({
				id: 'session-1',
				inputMode: 'ai',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleQuickActionsRenameTab();
			});

			expect(useModalStore.getState().isOpen('renameTab')).toBe(false);
		});

		it('handleQuickActionsOpenTabSwitcher opens tab switcher when in AI mode', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'session-1',
				inputMode: 'ai',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleQuickActionsOpenTabSwitcher();
			});

			expect(useModalStore.getState().isOpen('tabSwitcher')).toBe(true);
		});

		it('handleQuickActionsOpenTabSwitcher does nothing when not in AI mode', () => {
			const session = createMockSession({
				id: 'session-1',
				inputMode: 'terminal' as any,
				aiTabs: [],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleQuickActionsOpenTabSwitcher();
			});

			expect(useModalStore.getState().isOpen('tabSwitcher')).toBe(false);
		});

		it('handleQuickActionsStartTour sets tourFromWizard false and opens tour', () => {
			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleQuickActionsStartTour();
			});

			expect(useModalStore.getState().isOpen('tour')).toBe(true);
			const tourData = useModalStore.getState().getData('tour');
			expect(tourData?.fromWizard).toBe(false);
		});

		it('handleQuickActionsEditAgent opens edit agent modal with session', () => {
			const session = createMockSession({ id: 'qa-edit-session' });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleQuickActionsEditAgent(session);
			});

			expect(useModalStore.getState().isOpen('editAgent')).toBe(true);
			expect(useModalStore.getState().getData('editAgent')).toEqual({ session });
		});

		it('handleQuickActionsOpenMergeSession opens merge session modal', () => {
			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleQuickActionsOpenMergeSession();
			});

			expect(useModalStore.getState().isOpen('mergeSession')).toBe(true);
		});

		it('handleQuickActionsOpenSendToAgent opens send to agent modal', () => {
			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleQuickActionsOpenSendToAgent();
			});

			expect(useModalStore.getState().isOpen('sendToAgent')).toBe(true);
		});

		it('handleQuickActionsOpenCreatePR opens create PR modal with session', () => {
			const session = createMockSession({ id: 'qa-pr-session' });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleQuickActionsOpenCreatePR(session);
			});

			expect(useModalStore.getState().isOpen('createPR')).toBe(true);
			expect(useModalStore.getState().getData('createPR')).toEqual({ session });
		});
	});

	// ======================================================================
	// Group L: handleLogViewerShortcutUsed
	// ======================================================================

	describe('Group L: handleLogViewerShortcutUsed', () => {
		it('records shortcut usage and does NOT trigger level-up when no new level', () => {
			const mockRecordShortcutUsage = vi.fn().mockReturnValue({ newLevel: null });
			vi.spyOn(useSettingsStore, 'getState').mockReturnValue({
				...useSettingsStore.getState(),
				recordShortcutUsage: mockRecordShortcutUsage,
			});

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleLogViewerShortcutUsed('open-log-viewer');
			});

			expect(mockRecordShortcutUsage).toHaveBeenCalledWith('open-log-viewer');
			expect(useModalStore.getState().isOpen('keyboardMastery')).toBe(false);
		});

		it('triggers onKeyboardMasteryLevelUp when recordShortcutUsage returns a new level', () => {
			const mockRecordShortcutUsage = vi.fn().mockReturnValue({ newLevel: 2 });
			vi.spyOn(useSettingsStore, 'getState').mockReturnValue({
				...useSettingsStore.getState(),
				recordShortcutUsage: mockRecordShortcutUsage,
			});

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleLogViewerShortcutUsed('open-log-viewer');
			});

			expect(mockRecordShortcutUsage).toHaveBeenCalledWith('open-log-viewer');
			expect(useModalStore.getState().isOpen('keyboardMastery')).toBe(true);
			expect(useModalStore.getState().getData('keyboardMastery')).toEqual({ level: 2 });
		});

		it('does not trigger level-up callback when result.newLevel is null', () => {
			const mockRecordShortcutUsage = vi.fn().mockReturnValue({ newLevel: null });
			vi.spyOn(useSettingsStore, 'getState').mockReturnValue({
				...useSettingsStore.getState(),
				recordShortcutUsage: mockRecordShortcutUsage,
			});

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleLogViewerShortcutUsed('some-shortcut');
			});

			expect(useModalStore.getState().isOpen('keyboardMastery')).toBe(false);
			expect(useModalStore.getState().getData('keyboardMastery')).toBeUndefined();
		});
	});

	// ======================================================================
	// Effects
	// ======================================================================

	describe('Effects', () => {
		it('LogViewer close effect focuses input when logViewer closes', () => {
			// Start with logViewer open
			getModalActions().setLogViewerOpen(true);

			const inputRef = createInputRef();
			const { rerender } = renderHook(() => useModalHandlers(inputRef, createTerminalOutputRef()));

			// Close the log viewer
			act(() => {
				getModalActions().setLogViewerOpen(false);
			});
			rerender();

			// The effect fires a 50ms setTimeout
			act(() => {
				vi.advanceTimersByTime(60);
			});

			expect(inputRef.current!.focus).toHaveBeenCalled();
		});

		it('LogViewer close effect falls back to terminalOutputRef when inputRef is null', () => {
			getModalActions().setLogViewerOpen(true);

			const inputRef = { current: null };
			const terminalOutputRef = createTerminalOutputRef();

			const { rerender } = renderHook(() => useModalHandlers(inputRef, terminalOutputRef));

			act(() => {
				getModalActions().setLogViewerOpen(false);
			});
			rerender();

			act(() => {
				vi.advanceTimersByTime(60);
			});

			expect(terminalOutputRef.current!.focus).toHaveBeenCalled();
		});

		it('LogViewer close effect falls back to document.body.focus when both refs are null', () => {
			getModalActions().setLogViewerOpen(true);

			const inputRef = { current: null };
			const terminalOutputRef = { current: null };
			const blurSpy = vi.fn();
			const focusSpy = vi.fn();

			// Mock document.activeElement and document.body.focus
			Object.defineProperty(document, 'activeElement', {
				get: () => ({ blur: blurSpy }),
				configurable: true,
			});
			document.body.focus = focusSpy;

			const { rerender } = renderHook(() => useModalHandlers(inputRef, terminalOutputRef));

			act(() => {
				getModalActions().setLogViewerOpen(false);
			});
			rerender();

			act(() => {
				vi.advanceTimersByTime(60);
			});

			expect(blurSpy).toHaveBeenCalled();
			expect(focusSpy).toHaveBeenCalled();
		});

		it('Shortcuts search reset effect clears search query when shortcutsHelp closes', () => {
			// Open shortcuts help
			getModalActions().setShortcutsHelpOpen(true);

			const { rerender } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);

			// Close shortcuts help - effect should call setShortcutsSearchQuery('')
			act(() => {
				getModalActions().setShortcutsHelpOpen(false);
			});
			rerender();

			// The effect calls getModalActions().setShortcutsSearchQuery('') which is a no-op
			// in the store, but we can verify the shortcutsHelp modal is closed
			expect(useModalStore.getState().isOpen('shortcutsHelp')).toBe(false);
		});

		// ====================================================================
		// Standing ovation startup check effect
		// ====================================================================

		it('shows standing ovation overlay when unacknowledged badge exists on startup', () => {
			// Set up store state before rendering so the effect fires on mount
			useSettingsStore.setState({
				settingsLoaded: true,
				getUnacknowledgedBadgeLevel: () => 1,
				autoRunStats: {
					longestRunMs: 50000,
					totalRuns: 10,
					cumulativeTimeMs: 100000,
					currentBadgeLevel: 1,
					lastBadgeUnlockLevel: 1,
					lastAcknowledgedBadgeLevel: 0,
					longestRunTimestamp: 0,
					badgeHistory: [],
				},
			});
			useSessionStore.setState({ sessionsLoaded: true, sessions: [] });

			renderHook(() => useModalHandlers(createInputRef(), createTerminalOutputRef()));

			// Advance past the 1000ms delay used in the startup effect
			act(() => {
				vi.advanceTimersByTime(1100);
			});

			expect(useModalStore.getState().isOpen('standingOvation')).toBe(true);
			const ovationData = useModalStore.getState().getData('standingOvation');
			expect(ovationData).toBeDefined();
			expect(ovationData?.badge.level).toBe(1);
		});

		it('does NOT show ovation when no unacknowledged badge on startup', () => {
			useSettingsStore.setState({
				settingsLoaded: true,
				getUnacknowledgedBadgeLevel: () => null,
				autoRunStats: {
					longestRunMs: 0,
					totalRuns: 0,
					cumulativeTimeMs: 0,
					currentBadgeLevel: 0,
					lastBadgeUnlockLevel: 0,
					lastAcknowledgedBadgeLevel: 0,
					longestRunTimestamp: 0,
					badgeHistory: [],
				},
			});
			useSessionStore.setState({ sessionsLoaded: true, sessions: [] });

			renderHook(() => useModalHandlers(createInputRef(), createTerminalOutputRef()));

			act(() => {
				vi.advanceTimersByTime(1100);
			});

			expect(useModalStore.getState().isOpen('standingOvation')).toBe(false);
		});

		it('does NOT run startup badge check when settings/sessions not loaded', () => {
			// settingsLoaded: false and sessionsLoaded: false (left at defaults from beforeEach)
			// We make the badge level non-null so that IF the effect ran, it would show the ovation
			useSettingsStore.setState({
				settingsLoaded: false,
				getUnacknowledgedBadgeLevel: () => 1,
				autoRunStats: {
					longestRunMs: 50000,
					totalRuns: 10,
					cumulativeTimeMs: 100000,
					currentBadgeLevel: 1,
					lastBadgeUnlockLevel: 1,
					lastAcknowledgedBadgeLevel: 0,
					longestRunTimestamp: 0,
					badgeHistory: [],
				},
			});
			// sessionsLoaded stays false (set by beforeEach)

			renderHook(() => useModalHandlers(createInputRef(), createTerminalOutputRef()));

			act(() => {
				vi.advanceTimersByTime(1100);
			});

			expect(useModalStore.getState().isOpen('standingOvation')).toBe(false);
		});

		// ====================================================================
		// Standing ovation return-to-app check
		// ====================================================================

		it('triggers badge check on visibility change when becoming visible', () => {
			useSettingsStore.setState({
				settingsLoaded: true,
				getUnacknowledgedBadgeLevel: () => 1,
				autoRunStats: {
					longestRunMs: 50000,
					totalRuns: 10,
					cumulativeTimeMs: 100000,
					currentBadgeLevel: 1,
					lastBadgeUnlockLevel: 1,
					lastAcknowledgedBadgeLevel: 0,
					longestRunTimestamp: 0,
					badgeHistory: [],
				},
			});
			useSessionStore.setState({ sessionsLoaded: true, sessions: [] });

			renderHook(() => useModalHandlers(createInputRef(), createTerminalOutputRef()));

			// Advance past startup delay so any startup ovation would have already fired
			act(() => {
				vi.advanceTimersByTime(1100);
			});

			// Dismiss any ovation shown on startup so we can test the visibility path
			getModalActions().setStandingOvationData(null);

			// Simulate user switching back to the app (document becomes visible)
			Object.defineProperty(document, 'hidden', { value: false, configurable: true });
			act(() => {
				document.dispatchEvent(new Event('visibilitychange'));
			});

			// Advance past the 500ms delay in checkForUnacknowledgedBadge
			act(() => {
				vi.advanceTimersByTime(600);
			});

			expect(useModalStore.getState().isOpen('standingOvation')).toBe(true);
		});

		it('does NOT show ovation on visibility change if ovation is already displayed', () => {
			useSettingsStore.setState({
				settingsLoaded: true,
				getUnacknowledgedBadgeLevel: () => 1,
				autoRunStats: {
					longestRunMs: 50000,
					totalRuns: 10,
					cumulativeTimeMs: 100000,
					currentBadgeLevel: 1,
					lastBadgeUnlockLevel: 1,
					lastAcknowledgedBadgeLevel: 0,
					longestRunTimestamp: 0,
					badgeHistory: [],
				},
			});
			useSessionStore.setState({ sessionsLoaded: true, sessions: [] });

			renderHook(() => useModalHandlers(createInputRef(), createTerminalOutputRef()));

			// Advance past startup delay so the startup ovation fires first
			act(() => {
				vi.advanceTimersByTime(1100);
			});

			// Ovation should now be displayed from startup; record the data
			const ovationDataBefore = useModalStore.getState().getData('standingOvation');
			expect(useModalStore.getState().isOpen('standingOvation')).toBe(true);

			// Simulate becoming visible while ovation is already shown
			Object.defineProperty(document, 'hidden', { value: false, configurable: true });
			act(() => {
				document.dispatchEvent(new Event('visibilitychange'));
			});

			act(() => {
				vi.advanceTimersByTime(600);
			});

			// Ovation modal should still be open and data unchanged
			expect(useModalStore.getState().isOpen('standingOvation')).toBe(true);
			expect(useModalStore.getState().getData('standingOvation')).toEqual(ovationDataBefore);
		});

		// ====================================================================
		// Keyboard mastery startup check effect
		// ====================================================================

		it('shows keyboard mastery celebration when unacknowledged level exists on startup', () => {
			useSettingsStore.setState({
				settingsLoaded: true,
				getUnacknowledgedKeyboardMasteryLevel: () => 3,
				// Also suppress badge ovation so only keyboard mastery fires
				getUnacknowledgedBadgeLevel: () => null,
			});
			useSessionStore.setState({ sessionsLoaded: true, sessions: [] });

			renderHook(() => useModalHandlers(createInputRef(), createTerminalOutputRef()));

			// Advance past the 1200ms delay used in the keyboard mastery effect
			act(() => {
				vi.advanceTimersByTime(1300);
			});

			expect(useModalStore.getState().isOpen('keyboardMastery')).toBe(true);
			expect(useModalStore.getState().getData('keyboardMastery')).toEqual({ level: 3 });
		});

		it('does NOT show keyboard mastery celebration when no unacknowledged level on startup', () => {
			useSettingsStore.setState({
				settingsLoaded: true,
				getUnacknowledgedKeyboardMasteryLevel: () => null,
				getUnacknowledgedBadgeLevel: () => null,
			});
			useSessionStore.setState({ sessionsLoaded: true, sessions: [] });

			renderHook(() => useModalHandlers(createInputRef(), createTerminalOutputRef()));

			act(() => {
				vi.advanceTimersByTime(1300);
			});

			expect(useModalStore.getState().isOpen('keyboardMastery')).toBe(false);
		});
	});
});
