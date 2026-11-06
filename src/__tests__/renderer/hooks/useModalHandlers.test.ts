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

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getDiff: vi.fn().mockResolvedValue({ diff: '' }),
	},
}));

const refreshGitStatusMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../renderer/contexts/GitStatusContext', () => ({
	useGitDetail: () => ({
		getFileDetails: () => undefined,
		refreshGitStatus: refreshGitStatusMock,
	}),
}));

import type { UseAgentSessionManagementReturn } from '../../../renderer/hooks/agent/useAgentSessionManagement';
import { useModalHandlers } from '../../../renderer/hooks/modal/useModalHandlers';
import { useModalStore, getModalActions } from '../../../renderer/stores/modalStore';
import { useAuthOutageStore } from '../../../renderer/stores/authOutageStore';
import { useCenterFlashStore } from '../../../renderer/stores/centerFlashStore';
import { useSessionStore, updateSessionWith } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useAgentStore } from '../../../renderer/stores/agentStore';
import { useAgentErrorRecovery } from '../../../renderer/hooks/agent/useAgentErrorRecovery';
import { gitService } from '../../../renderer/services/git';
import type { Session, AITab } from '../../../renderer/types';
import { createMockAITab as createBaseMockAITab, createMockFileTab } from '../../helpers/mockTab';
import { createMockSession } from '../../helpers/mockSession';
import { resetStores } from '../../helpers/resetStores';
import {
	aiTabFocusFields,
	fileTabFocusFields,
	browserTabFocusFields,
	terminalTabFocusFields,
	focusAiTabInSession,
} from '../../../renderer/utils/tabHelpers';
import {
	createGroupFromTabRefs,
	findLeafByTabRef,
	focusPaneInSession,
	resolveActiveTabRef,
} from '../../../renderer/utils/panelLayout';

// ============================================================================
// Helpers
// ============================================================================

const createInputRef = () => ({
	current: { focus: vi.fn() } as unknown as HTMLTextAreaElement,
});

const createTerminalOutputRef = () => ({
	current: { focus: vi.fn() } as unknown as HTMLDivElement,
});

function createMockAITab(overrides: Partial<AITab> = {}): AITab {
	return createBaseMockAITab({
		hasUnread: false,
		isAtBottom: true,
		...overrides,
	});
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();

	// Reset stores
	useModalStore.setState({ modals: new Map() });
	// Auth outages are provider-scoped and deliberately deduplicate, so a
	// leftover outage would stop the next test's prompt from opening.
	useAuthOutageStore.setState({ outages: {} });
	useSessionStore.setState({
		sessions: [],
		activeSessionId: '',
		sessionsLoaded: false,
		initialLoadComplete: false,
	});
	useGroupChatStore.setState({
		activeGroupChatId: null,
		groupChatStagedImagesById: {},
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

		it('handleShowAgentErrorModal opens modal with historical error when passed an AgentError', () => {
			const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'as-1' });
			const session = createMockSession({
				id: 'session-1',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const historicalError = {
				message: 'historical error from chat log',
				type: 'agent_crashed' as const,
				recoverable: false,
				agentId: 'claude-code',
				timestamp: Date.now(),
				parsedJson: { detail: 'some parsed data' },
			};

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleShowAgentErrorModal(historicalError);
			});

			expect(useModalStore.getState().isOpen('agentError')).toBe(true);
			expect(useModalStore.getState().getData('agentError')).toEqual({
				sessionId: 'session-1',
				historicalError,
			});
		});

		it('effectiveAgentError prefers historical error over live error when both present', () => {
			const liveError = {
				message: 'live session error',
				type: 'agent_crashed' as const,
				recoverable: true,
				agentId: 'claude-code',
				timestamp: Date.now(),
			};
			const historicalError = {
				message: 'historical error from chat log',
				type: 'agent_crashed' as const,
				recoverable: false,
				agentId: 'claude-code',
				timestamp: Date.now() - 60000,
				parsedJson: { detail: 'old crash' },
			};

			const tab = createMockAITab({ id: 'tab-1', agentSessionId: 'as-1', agentError: liveError });
			const session = createMockSession({
				id: 'session-1',
				activeTabId: 'tab-1',
				aiTabs: [tab],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			// Open the modal with a historical error (simulates clicking Details on a chat log entry)
			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleShowAgentErrorModal(historicalError);
			});

			// Historical error should win over the live one
			expect(result.current.effectiveAgentError).toEqual(historicalError);
			// Recovery actions should be empty for historical errors
			expect(result.current.recoveryActions).toEqual([]);
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

		it('handleAuthenticateAfterError calls agent store and swaps in the reauth modal', () => {
			const mockAuth = vi.fn();
			vi.spyOn(useAgentStore, 'getState').mockReturnValue({
				...useAgentStore.getState(),
				authenticateAfterError: mockAuth,
			});
			// The provider is resolved from the agent, so it has to exist.
			useSessionStore.setState({
				sessions: [createMockSession({ id: 'session-1', toolType: 'claude-code' })],
			});
			getModalActions().setAgentErrorModalSessionId('session-1');

			const inputRef = createInputRef();
			const { result } = renderHook(() => useModalHandlers(inputRef, createTerminalOutputRef()));
			act(() => {
				result.current.handleAuthenticateAfterError('session-1');
			});

			expect(mockAuth).toHaveBeenCalledWith('session-1');
			expect(useModalStore.getState().isOpen('agentError')).toBe(false);
			// The login now happens inside Maestro, so the error modal hands off to the
			// re-authentication terminal instead of returning focus to the composer.
			expect(useModalStore.getState().isOpen('reauth')).toBe(true);
			expect(useModalStore.getState().getData('reauth')).toMatchObject({
				providerKey: 'claude-code',
			});
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
				groupChatStagedImagesById: { 'gc-1': ['img1.png', 'img2.png', 'img3.png'] },
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

			expect(useGroupChatStore.getState().groupChatStagedImagesById['gc-1']).toEqual([
				'img1.png',
				'img3.png',
			]);
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

		it('handleClosePromptComposer focuses the group chat input while a room is open', () => {
			useGroupChatStore.setState({ activeGroupChatId: 'chat-1' });
			getModalActions().setPromptComposerOpen(true);

			const inputRef = createInputRef();
			const groupChatInputRef = createInputRef();
			const { result } = renderHook(() =>
				useModalHandlers(inputRef, createTerminalOutputRef(), undefined, groupChatInputRef)
			);
			act(() => {
				result.current.handleClosePromptComposer();
			});

			act(() => {
				vi.advanceTimersByTime(10);
			});
			// The agent composer isn't on screen in a room, so focusing it would
			// drop the caret on the document instead of the room's input.
			expect(groupChatInputRef.current!.focus).toHaveBeenCalled();
			expect(inputRef.current!.focus).not.toHaveBeenCalled();
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

		it('handleQuickActionsRenameTab works even when tab has no agentSessionId', () => {
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

			expect(useModalStore.getState().isOpen('renameTab')).toBe(true);
		});

		it('handleQuickActionsRenameTab targets the active file tab, pre-filling its custom name', () => {
			const fileTab = createMockFileTab({ id: 'file-1', name: 'notes', customName: 'My Notes' });
			const session = createMockSession({
				id: 'session-1',
				// File tabs keep inputMode 'ai' but set activeFileTabId; the handler
				// must target the visible file tab, not the hidden AI tab.
				inputMode: 'ai',
				activeTabId: 'tab-1',
				activeFileTabId: 'file-1',
				aiTabs: [createMockAITab({ id: 'tab-1' })],
				filePreviewTabs: [fileTab],
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
			expect(renameData?.tabId).toBe('file-1');
			expect(renameData?.initialName).toBe('My Notes');
		});

		it('handleQuickActionsRenameTab pre-fills empty when the file tab has no custom name', () => {
			const fileTab = createMockFileTab({ id: 'file-1', name: 'notes', customName: undefined });
			const session = createMockSession({
				id: 'session-1',
				inputMode: 'ai',
				activeFileTabId: 'file-1',
				filePreviewTabs: [fileTab],
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
			expect(renameData?.tabId).toBe('file-1');
			expect(renameData?.initialName).toBe('');
		});

		it('handleQuickActionsRenameTab targets the focused pane of an active tiled group', () => {
			const session = createMockSession({
				id: 'session-1',
				inputMode: 'ai',
				activeTabId: 'tab-1',
				aiTabs: [createMockAITab({ id: 'tab-1', name: 'My Tab' })],
				terminalTabs: [{ id: 'term-1', name: null } as any],
				activeGroupId: 'group-1',
				tabGroups: [
					{
						id: 'group-1',
						name: 'Group: Terminal 1',
						focusedPaneId: 'leaf-term',
						createdAt: 0,
						layout: {
							kind: 'split',
							id: 'split-1',
							direction: 'row',
							sizes: [0.5, 0.5],
							children: [
								{ kind: 'leaf', id: 'leaf-ai', tab: { type: 'ai', id: 'tab-1' } },
								{ kind: 'leaf', id: 'leaf-term', tab: { type: 'terminal', id: 'term-1' } },
							],
						},
					} as any,
				],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);
			act(() => {
				result.current.handleQuickActionsRenameTab();
			});

			const renameData = useModalStore.getState().getData('renameTab');
			expect(renameData?.tabId).toBe('term-1');
			expect(renameData?.initialName).toBe('');
		});

		it('handleQuickActionsOpenTabSwitcher opens tab switcher when session has aiTabs', () => {
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

		it('handleQuickActionsOpenTabSwitcher opens tab switcher in shell mode when aiTabs exist', () => {
			const tab = createMockAITab({ id: 'tab-1' });
			const session = createMockSession({
				id: 'session-1',
				inputMode: 'terminal' as any,
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
		it('cancels pending LogViewer focus restoration when unmounted or reopened', () => {
			const input = document.createElement('textarea');
			document.body.appendChild(input);
			const inputRef = { current: input };
			const terminalRef = { current: null };
			const { unmount } = renderHook(() => useModalHandlers(inputRef, terminalRef));
			try {
				act(() => getModalActions().setLogViewerOpen(true));
				act(() => vi.advanceTimersByTime(50));
				expect(document.activeElement).not.toBe(input);
				act(() => getModalActions().setLogViewerOpen(false));
				unmount();
				act(() => vi.advanceTimersByTime(50));
				expect(document.activeElement).not.toBe(input);
			} finally {
				unmount();
				input.remove();
			}
		});
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

	// ======================================================================
	// Tier 3C: handleViewGitDiff + handleDirectorNotesResumeSession
	// ======================================================================

	describe('handleViewGitDiff', () => {
		it('returns early when no active session', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);

			await act(async () => {
				await result.current.handleViewGitDiff();
			});

			expect(gitService.getDiff).not.toHaveBeenCalled();
		});

		it('returns early when session is not a git repo', async () => {
			const session = createMockSession({ isGitRepo: false });
			useSessionStore.setState({ sessions: [session], activeSessionId: session.id });

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);

			await act(async () => {
				await result.current.handleViewGitDiff();
			});

			expect(gitService.getDiff).not.toHaveBeenCalled();
		});

		it('fetches diff using cwd and sets preview when diff exists', async () => {
			const session = createMockSession({
				isGitRepo: true,
				cwd: '/projects/my-repo',
				inputMode: 'ai',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
			(gitService.getDiff as ReturnType<typeof vi.fn>).mockResolvedValue({
				diff: 'diff --git a/file.ts',
			});

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);

			await act(async () => {
				await result.current.handleViewGitDiff();
			});

			expect(gitService.getDiff).toHaveBeenCalledWith('/projects/my-repo', undefined, undefined);
			expect(useModalStore.getState().isOpen('gitDiff')).toBe(true);
			expect(useModalStore.getState().getData('gitDiff')?.diff).toBe('diff --git a/file.ts');
		});

		it('flashes a notification and re-polls git status when the diff is empty', async () => {
			const session = createMockSession({
				isGitRepo: true,
				cwd: '/projects/my-repo',
				inputMode: 'ai',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
			(gitService.getDiff as ReturnType<typeof vi.fn>).mockResolvedValue({ diff: '' });
			useCenterFlashStore.getState().setActive(null);
			refreshGitStatusMock.mockClear();

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);

			await act(async () => {
				await result.current.handleViewGitDiff();
			});

			expect(useModalStore.getState().isOpen('gitDiff')).toBe(false);
			expect(useCenterFlashStore.getState().active?.message).toBe('No diff to examine');
			expect(refreshGitStatusMock).toHaveBeenCalledTimes(1);
		});

		it('uses shellCwd when in terminal mode', async () => {
			const session = createMockSession({
				isGitRepo: true,
				cwd: '/projects/my-repo',
				shellCwd: '/projects/my-repo/subdir',
				inputMode: 'terminal',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
			(gitService.getDiff as ReturnType<typeof vi.fn>).mockResolvedValue({
				diff: 'some diff',
			});

			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef())
			);

			await act(async () => {
				await result.current.handleViewGitDiff();
			});

			expect(gitService.getDiff).toHaveBeenCalledWith(
				'/projects/my-repo/subdir',
				undefined,
				undefined
			);
		});
	});

	describe('handleDirectorNotesResumeSession', () => {
		beforeEach(() => {
			resetStores(useSessionStore, useGroupChatStore, useModalStore);
			getModalActions().setDirectorNotesOpen(true);
			useSessionStore.setState({
				sessions: ['session-1', 'session-2'].map((id) =>
					createMockSession({
						id,
						toolType: 'grok',
						activeTabId: 'tab-1',
						aiTabs: [createMockAITab()],
					})
				),
				activeSessionId: 'session-2',
			});
			useGroupChatStore.setState({ activeGroupChatId: 'gc-1' });
		});

		it.each([true, false, undefined, 'reject'] as const)(
			'waits for %s before changing agent, modal or Group Chat',
			async (outcome) => {
				let settle!: (value: boolean | undefined) => void;
				let reject!: (reason: Error) => void;
				const resumeRef = {
					current: vi.fn<UseAgentSessionManagementReturn['handleResumeSession']>(
						() =>
							new Promise<boolean>((resolve, fail) => {
								settle = resolve as typeof settle;
								reject = fail;
							})
					),
				};
				const binding = {
					version: 1,
					state: 'bound',
					provider: 'grok',
					nativeSessionId: 'native',
					accountRef: 'fixture-account',
					host: { kind: 'ssh', identity: 'fixture-host' },
					cwd: '/recorded',
				} as const;
				const { result } = renderHook(() =>
					useModalHandlers(createInputRef(), createTerminalOutputRef(), resumeRef)
				);
				let pending!: Promise<boolean>;
				act(() => {
					pending = result.current.handleDirectorNotesResumeSession(
						'session-1',
						'native',
						'Recorded',
						'/recorded',
						{ nativeSessionBinding: binding }
					);
				});
				expect(resumeRef.current).toHaveBeenCalledWith(
					'native',
					undefined,
					'Recorded',
					undefined,
					undefined,
					'/recorded',
					{
						targetSessionId: 'session-1',
						nativeSessionBinding: binding,
						canResume: expect.any(Function),
					}
				);
				expect(resumeRef.current.mock.calls[0][6]!.nativeSessionBinding).not.toBe(binding);
				expect(useSessionStore.getState().activeSessionId).toBe('session-2');
				expect(useGroupChatStore.getState().activeGroupChatId).toBe('gc-1');
				expect(useModalStore.getState().isOpen('directorNotes')).toBe(true);
				await act(async () => {
					if (outcome === 'reject') {
						const assertion = expect(pending).rejects.toThrow('fixture refusal');
						reject(new Error('fixture refusal'));
						await assertion;
					} else {
						settle(outcome);
						expect(await pending).toBe(outcome === true);
					}
				});
				expect(useSessionStore.getState().activeSessionId).toBe(
					outcome === true ? 'session-1' : 'session-2'
				);
				expect(useGroupChatStore.getState().activeGroupChatId).toBe(
					outcome === true ? null : 'gc-1'
				);
				expect(useModalStore.getState().isOpen('directorNotes')).toBe(outcome !== true);
			}
		);

		it('does not call resume when ref is null', async () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: session.id });

			const resumeRef = { current: null };
			const { result } = renderHook(() =>
				useModalHandlers(createInputRef(), createTerminalOutputRef(), resumeRef)
			);

			await act(async () => {
				expect(
					await result.current.handleDirectorNotesResumeSession('session-1', 'agent-sess-1')
				).toBe(false);
			});

			expect(useModalStore.getState().isOpen('directorNotes')).toBe(true);
		});

		describe('pending admission and navigation', () => {
			beforeEach(() => {
				for (const session of useSessionStore.getState().sessions) {
					updateSessionWith(session.id, (owner) => ({
						...owner,
						aiTabs: [
							createMockAITab({
								id: 'tab-1',
								logs: [{ id: 'kept', source: 'user', text: 'Retained', timestamp: 1 }],
							}),
							createMockAITab({ id: 'tab-2', agentSessionId: 'native' }),
						],
						filePreviewTabs: [createMockFileTab()],
						tabGroups: [
							createGroupFromTabRefs(
								[
									{ type: 'ai', id: 'tab-1' },
									{ type: 'ai', id: 'tab-2' },
								],
								'Retained group'
							),
						],
					}));
				}
				// Retain history data without opening a destination that closes Director Notes.
				useModalStore.setState((state) => ({
					modals: new Map(state.modals).set('agentSessions', {
						open: false,
						data: { activeAgentSessionId: 'kept-history' },
					}),
				}));
				expect(useModalStore.getState().isOpen('directorNotes')).toBe(true);
				expect(useModalStore.getState().isOpen('agentSessions')).toBe(false);
				expect(useModalStore.getState().getData('agentSessions')?.activeAgentSessionId).toBe(
					'kept-history'
				);
			});

			// Compare all retained tab/log/history data as well as the visible selection.
			const view = () => ({
				sessions: structuredClone(useSessionStore.getState().sessions),
				active: useSessionStore.getState().activeSessionId,
				history: useModalStore.getState().getData('agentSessions')?.activeAgentSessionId,
				groupChat: useGroupChatStore.getState().activeGroupChatId,
				directorNotes: useModalStore.getState().isOpen('directorNotes'),
			});

			function pendingResume(
				opts?: Parameters<UseAgentSessionManagementReturn['handleResumeSession']>[6],
				isCurrent?: () => boolean
			) {
				let settle!: (value: boolean) => void;
				const resume = vi.fn<UseAgentSessionManagementReturn['handleResumeSession']>(
					() =>
						new Promise<boolean>((resolve) => {
							settle = resolve;
						})
				);
				const hook = renderHook(() =>
					useModalHandlers(createInputRef(), createTerminalOutputRef(), { current: resume })
				);
				let pending!: Promise<boolean>;
				act(() => {
					pending = hook.result.current.handleDirectorNotesResumeSession(
						'session-1',
						'native',
						'Recorded',
						undefined,
						opts,
						isCurrent
					);
				});
				expect(resume).toHaveBeenCalledTimes(1);
				const canResume = resume.mock.calls[0][6]!.canResume!;
				expect(canResume()).toBe(true);
				return { ...hook, resume, pending, canResume, settle };
			}

			it.each([
				'empty owner',
				'missing owner',
				'empty native ID',
				'conflicting target',
				'stale caller',
				'caller refusal',
				'closed modal',
			])('refuses %s before dispatch or mutation', async (reason) => {
				if (reason === 'closed modal') getModalActions().setDirectorNotesOpen(false);
				const resume = vi
					.fn<UseAgentSessionManagementReturn['handleResumeSession']>()
					.mockResolvedValue(true);
				const { result } = renderHook(() =>
					useModalHandlers(createInputRef(), createTerminalOutputRef(), { current: resume })
				);
				const retained = view();
				await act(async () => {
					expect(
						await result.current.handleDirectorNotesResumeSession(
							reason === 'empty owner' ? '' : reason === 'missing owner' ? 'absent' : 'session-1',
							reason === 'empty native ID' ? '' : 'native',
							undefined,
							undefined,
							{
								targetSessionId: reason === 'conflicting target' ? 'session-2' : undefined,
								canResume: () => reason !== 'caller refusal',
							},
							() => reason !== 'stale caller'
						)
					).toBe(false);
				});
				expect(resume).not.toHaveBeenCalled();
				expect(view()).toEqual(retained);
			});

			it.each([
				['provider', { toolType: 'codex' }],
				['account', { customEnvVars: { GROK_HOME: '/fixture/other-account' } }],
				['environment', { customEnvVars: { FIXTURE: 'changed' } }],
				['SSH ID', { sshRemoteId: 'other-remote' }],
				['SSH config', { sessionSshRemoteConfig: { enabled: true, remoteId: 'other-remote' } }],
				['cwd', { cwd: '/other-project' }],
				['project root', { projectRoot: '/other-project' }],
				['remote cwd', { remoteCwd: '/other-remote-project' }],
				['binary', { customPath: '/fixture/grok' }],
				['arguments', { customArgs: '--fixture' }],
			] satisfies [string, Partial<Session>][])(
				'rejects pending owner %s changes before committing a candidate',
				async (_name, patch) => {
					const { canResume, pending, settle } = pendingResume();
					act(() => updateSessionWith('session-1', (owner) => ({ ...owner, ...patch })));
					const retained = view();
					expect(
						canResume(focusAiTabInSession(useSessionStore.getState().sessions[0], 'tab-2'))
					).toBe(false);
					await act(async () => {
						settle(true);
						expect(await pending).toBe(false);
					});
					expect(view()).toEqual(retained);
				}
			);

			it.each(['removed', 'rebound and restored'])(
				'rejects a pending owner that is %s',
				async (change) => {
					const original = useSessionStore.getState().sessions[0];
					const { canResume, pending, settle } = pendingResume();
					act(() => {
						useSessionStore.setState({ sessions: useSessionStore.getState().sessions.slice(1) });
						if (change === 'rebound and restored') {
							useSessionStore
								.getState()
								.setSessions((sessions) => [{ ...original, toolType: 'codex' }, ...sessions]);
							updateSessionWith(original.id, () => original);
						}
					});
					const retained = view();
					expect(canResume(original)).toBe(false);
					await act(async () => {
						settle(true);
						expect(await pending).toBe(false);
					});
					expect(view()).toEqual(retained);
				}
			);

			it.each(['owner', 'visible agent'] as const)(
				'fences %s tab/pane navigation, including away-and-back',
				async (target) => {
					// Separate requests keep every navigation mode independently observable.
					for (const kind of ['ai', 'file', 'browser', 'terminal', 'group', 'pane'] as const) {
						for (const returnBack of [false, true]) {
							const id = target === 'owner' ? 'session-1' : 'session-2';
							if (target === 'owner') useSessionStore.setState({ activeSessionId: id });
							const initial = useSessionStore.getState().sessions.find((s) => s.id === id)!;
							const group = initial.tabGroups[0];
							let baseline = {
								...initial,
								...aiTabFocusFields('tab-1'),
								activeGroupId: kind === 'pane' ? group.id : null,
							};
							if (kind === 'pane')
								baseline = focusPaneInSession(
									baseline,
									group.id,
									findLeafByTabRef(group.layout, { type: 'ai', id: 'tab-1' })!.id
								);
							act(() => updateSessionWith(id, () => baseline));
							const { canResume, pending, settle, unmount } = pendingResume();
							const patches = {
								ai: aiTabFocusFields('tab-2'),
								file: fileTabFocusFields('file-tab-1'),
								browser: browserTabFocusFields('browser-1'),
								terminal: terminalTabFocusFields('terminal-1'),
								group: { activeGroupId: group.id },
							};
							const next =
								kind === 'pane'
									? focusPaneInSession(
											baseline,
											group.id,
											findLeafByTabRef(group.layout, { type: 'ai', id: 'tab-2' })!.id
										)
									: { ...baseline, ...patches[kind] };
							act(() => {
								updateSessionWith(id, () => next);
								if (returnBack) updateSessionWith(id, () => baseline);
							});
							const retained = view();
							expect(
								canResume(useSessionStore.getState().sessions[0]),
								`${kind}, return=${returnBack}`
							).toBe(false);
							await act(async () => {
								settle(true);
								expect(await pending).toBe(false);
							});
							expect(view()).toEqual(retained);
							unmount();
						}
					}
				}
			);

			it.each(['agent', 'Group Chat', 'modal', 'caller', 'predicate', 'unmount'])(
				'rejects late true after %s invalidation without overwriting newer history',
				async (kind) => {
					let current = true;
					const caller = vi.fn(() => current);
					const { canResume, pending, settle, unmount } = pendingResume(
						kind === 'predicate' ? { canResume: caller } : undefined,
						kind === 'caller' ? caller : undefined
					);
					act(() => {
						if (kind === 'agent') {
							useSessionStore.setState({ activeSessionId: 'session-1' });
							useSessionStore.setState({ activeSessionId: 'session-2' });
						} else if (kind === 'Group Chat') {
							useGroupChatStore.setState({ activeGroupChatId: 'gc-2' });
							useGroupChatStore.setState({ activeGroupChatId: 'gc-1' });
						} else if (kind === 'modal') {
							getModalActions().setDirectorNotesOpen(false);
							getModalActions().setDirectorNotesOpen(true);
						} else if (kind === 'unmount') unmount();
						else current = false;
						getModalActions().setActiveAgentSessionId('newer-history');
						updateSessionWith('session-1', (owner) => ({
							...owner,
							aiTabs: [
								...owner.aiTabs,
								createMockAITab({
									id: 'newer-tab',
									logs: [
										{ id: 'newer-log', source: 'user', text: 'Newer conversation', timestamp: 2 },
									],
								}),
							],
						}));
					});
					const retained = view();
					expect(canResume()).toBe(false);
					expect(canResume(useSessionStore.getState().sessions[0])).toBe(false);
					await act(async () => {
						settle(true);
						expect(await pending).toBe(false);
					});
					expect(view()).toEqual(retained);
				}
			);

			it('composes caller admission for the exact proposed focus object', async () => {
				const owner = useSessionStore.getState().sessions[0];
				const candidate = focusAiTabInSession(owner, 'tab-2');
				const caller = vi.fn((next?: Session) => next !== candidate);
				const { canResume, pending, settle } = pendingResume({ canResume: caller });
				const retained = view();
				expect(canResume(candidate)).toBe(false);
				expect(caller).toHaveBeenLastCalledWith(candidate);
				await act(async () => {
					settle(false);
					expect(await pending).toBe(false);
				});
				expect(view()).toEqual(retained);
			});

			it('leaves unknown native scope absent for canonical refusal', async () => {
				const { resume, pending, settle } = pendingResume();
				const retained = view();
				expect(resume.mock.calls[0][5]).toBeUndefined();
				expect(resume.mock.calls[0][6]).toEqual({
					targetSessionId: 'session-1',
					nativeSessionBinding: undefined,
					canResume: expect.any(Function),
				});
				await act(async () => {
					settle(false);
					expect(await pending).toBe(false);
				});
				expect(view()).toEqual(retained);
			});

			it.each(['grok', 'claude-code'] as const)(
				'accepts exact existing/tiled %s focus and ordinary metadata updates',
				async (toolType) => {
					for (const tiled of [false, true]) {
						getModalActions().setDirectorNotesOpen(true);
						useGroupChatStore.setState({ activeGroupChatId: 'gc-1' });
						useSessionStore.setState({ activeSessionId: 'session-1' });
						updateSessionWith('session-1', (owner) => ({
							...owner,
							...fileTabFocusFields('file-tab-1'),
							toolType,
							tabGroups: tiled
								? [
										createGroupFromTabRefs(
											[
												{ type: 'ai', id: 'tab-1' },
												{ type: 'ai', id: 'tab-2' },
											],
											'Resume group'
										),
									]
								: [],
						}));
						const { canResume, pending, settle, unmount } = pendingResume();
						const next = focusAiTabInSession(useSessionStore.getState().sessions[0], 'tab-2');
						expect(resolveActiveTabRef(next)).toEqual({ type: 'ai', id: 'tab-2' });
						expect(!!next.activeGroupId).toBe(tiled);
						expect(canResume(next)).toBe(true);
						act(() => updateSessionWith('session-1', () => next));
						expect(canResume()).toBe(true);
						act(() =>
							updateSessionWith('session-1', (owner) => ({
								...owner,
								name: 'Renamed while loading',
								contextUsage: 42,
							}))
						);
						expect(canResume()).toBe(true);
						await act(async () => {
							settle(true);
							expect(await pending).toBe(true);
						});
						expect(useSessionStore.getState().sessions[0]).toEqual({
							...next,
							name: 'Renamed while loading',
							contextUsage: 42,
						});
						expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();
						expect(useModalStore.getState().isOpen('directorNotes')).toBe(false);
						unmount();
					}
				}
			);

			it('rejects a different object committing the admitted focus', async () => {
				const { canResume, pending, settle } = pendingResume();
				const next = focusAiTabInSession(useSessionStore.getState().sessions[0], 'tab-2');
				expect(canResume(next)).toBe(true);
				act(() => updateSessionWith('session-1', () => ({ ...next })));
				const retained = view();
				expect(canResume()).toBe(false);
				await act(async () => {
					settle(true);
					expect(await pending).toBe(false);
				});
				expect(view()).toEqual(retained);
			});

			it.each(['settle', 'success', 'reject', 'replace', 'unmount'])(
				'cleans synchronous subscriptions after %s',
				async (kind) => {
					const { resume, result, pending, settle, canResume, unmount } = pendingResume();
					// React's subscriptions are already attached. Track only the next request.
					const subscriptions = [useSessionStore, useGroupChatStore, useModalStore].map((store) => {
						const original = store.subscribe;
						const releases: ReturnType<typeof vi.fn>[] = [];
						vi.spyOn(store, 'subscribe').mockImplementation(
							(listener: Parameters<typeof store.subscribe>[0]) => {
								const unsubscribe = original(listener as never);
								const release = vi.fn(unsubscribe);
								releases.push(release);
								return release;
							}
						);
						return releases;
					});
					let finish!: (value: boolean) => void;
					let fail!: (error: Error) => void;
					resume.mockImplementationOnce(
						() =>
							new Promise<boolean>((resolve, reject) => {
								finish = resolve;
								fail = reject;
							})
					);
					let second!: Promise<boolean>;
					act(() => {
						second = result.current.handleDirectorNotesResumeSession('session-1', 'new-native');
					});
					const secondGuard = resume.mock.calls[1][6]!.canResume!;
					expect(canResume(useSessionStore.getState().sessions[0])).toBe(false);
					expect(secondGuard()).toBe(true);
					const retained = view();
					await act(async () => {
						settle(true);
						expect(await pending).toBe(false);
					});
					expect(view()).toEqual(retained);
					for (const releases of subscriptions) {
						expect(releases).toHaveLength(1);
						expect(releases[0]).not.toHaveBeenCalled();
					}
					expect(secondGuard()).toBe(true);
					if (kind === 'replace') {
						resume.mockResolvedValueOnce(false);
						await act(async () => {
							expect(
								await result.current.handleDirectorNotesResumeSession('session-1', 'latest-native')
							).toBe(false);
						});
					} else if (kind === 'unmount') unmount();
					if (kind === 'replace' || kind === 'unmount') {
						expect(secondGuard()).toBe(false);
						for (const releases of subscriptions) expect(releases[0]).toHaveBeenCalled();
					}
					await act(async () => {
						if (kind === 'reject') {
							const assertion = expect(second).rejects.toThrow('inert refusal');
							fail(new Error('inert refusal'));
							await assertion;
						} else {
							finish(kind !== 'settle');
							expect(await second).toBe(kind === 'success');
						}
					});
					for (const releases of subscriptions)
						for (const release of releases) expect(release).toHaveBeenCalled();
					expect(view()).toEqual(
						kind === 'success'
							? { ...retained, active: 'session-1', groupChat: null, directorNotes: false }
							: retained
					);
				}
			);
		});

		it.each(['grok', 'claude-code'] as const)(
			'accepts only its own focus commit for the already active %s owner',
			async (toolType) => {
				const owner = createMockSession({
					id: 'session-1',
					toolType,
					aiTabs: [createMockAITab()],
					activeTabId: 'tab-1',
				});
				useSessionStore.setState({ sessions: [owner], activeSessionId: owner.id });
				const next = {
					...owner,
					activeTabId: 'resumed',
					aiTabs: [...owner.aiTabs, createMockAITab({ id: 'resumed', agentSessionId: 'native' })],
				};
				const resume = vi
					.fn<UseAgentSessionManagementReturn['handleResumeSession']>()
					.mockImplementation(async (...args) => {
						expect(args[6]!.nativeSessionBinding).toBeUndefined();
						expect(args[6]!.canResume!(next)).toBe(true);
						useSessionStore.setState({ sessions: [next] });
						expect(args[6]!.canResume!()).toBe(true);
						return true;
					});
				const { result } = renderHook(() =>
					useModalHandlers(createInputRef(), createTerminalOutputRef(), { current: resume })
				);
				await act(async () => {
					expect(await result.current.handleDirectorNotesResumeSession('session-1', 'native')).toBe(
						true
					);
				});
				expect(useSessionStore.getState().sessions[0]).toBe(next);
				expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();
				expect(useModalStore.getState().isOpen('directorNotes')).toBe(false);
			}
		);
	});
});
