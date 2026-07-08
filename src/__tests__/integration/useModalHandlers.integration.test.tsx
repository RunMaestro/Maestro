import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModalHandlers } from '../../renderer/hooks/modal/useModalHandlers';
import { useAgentStore } from '../../renderer/stores/agentStore';
import { useGroupChatStore } from '../../renderer/stores/groupChatStore';
import { getModalActions, useModalStore } from '../../renderer/stores/modalStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { useCenterFlashStore } from '../../renderer/stores/centerFlashStore';
import type { AITab, Session } from '../../renderer/types';
import type { AgentError } from '../../shared/types';

const mockRefreshGitStatus = vi.hoisted(() => vi.fn());

vi.mock('../../renderer/contexts/GitStatusContext', () => ({
	useGitDetail: () => ({
		refreshGitStatus: mockRefreshGitStatus,
	}),
}));

let originalGitDiff: typeof window.maestro.git.diff;
let originalAgentError: typeof window.maestro.agentError | undefined;
let originalProcessKill: typeof window.maestro.process.kill;

function aiTab(overrides: Partial<AITab> = {}): AITab {
	const id = overrides.id ?? 'ai-tab';
	return {
		id,
		agentSessionId: 'agent-session-1',
		name: 'Planning tab',
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 1000,
		state: 'idle',
		hasUnread: false,
		isAtBottom: true,
		saveToHistory: true,
		showThinking: 'off',
		...overrides,
	};
}

function session(overrides: Partial<Session> = {}): Session {
	const aiTabs = overrides.aiTabs ?? [aiTab({ id: 'ai-a' })];
	return {
		id: overrides.id ?? 'session-a',
		name: 'Modal Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo',
		fullPath: '/repo',
		projectRoot: '/repo',
		createdAt: 1000,
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
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs,
		activeTabId: overrides.activeTabId ?? aiTabs[0]?.id ?? '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: aiTabs.map((tab) => ({ type: 'ai' as const, id: tab.id })),
		unifiedClosedTabHistory: [],
		...overrides,
	};
}

function activeSession(): Session {
	const state = useSessionStore.getState();
	return state.sessions.find((item) => item.id === state.activeSessionId)!;
}

function renderHandlers(
	options: {
		inputRef?: React.RefObject<HTMLTextAreaElement | null>;
		terminalRef?: React.RefObject<HTMLDivElement | null>;
		resumeRef?: React.MutableRefObject<((agentSessionId: string) => void) | null>;
	} = {}
) {
	const input = document.createElement('textarea');
	input.focus = vi.fn();
	const terminal = document.createElement('div');
	terminal.focus = vi.fn();
	const inputRef = options.inputRef ?? { current: input };
	const terminalRef = options.terminalRef ?? { current: terminal };
	const resumeRef = options.resumeRef ?? { current: vi.fn() };
	const hook = renderHook(() => useModalHandlers(inputRef, terminalRef, resumeRef));
	return { hook, input, terminal, resumeRef };
}

describe('useModalHandlers integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		originalGitDiff = window.maestro.git.diff;
		originalAgentError = window.maestro.agentError;
		originalProcessKill = window.maestro.process.kill;
		useModalStore.setState({ modals: new Map() });
		useCenterFlashStore.getState().setActive(null);
		useSessionStore.setState({
			sessions: [],
			activeSessionId: '',
			groups: [],
			sessionsLoaded: true,
			initialLoadComplete: true,
			removedWorktreePaths: new Set(),
			cyclePosition: -1,
		});
		useGroupChatStore.setState({
			activeGroupChatId: null,
			groupChatStagedImages: [],
		});
		useSettingsStore.setState({
			settingsLoaded: true,
			defaultSaveToHistory: true,
			defaultShowThinking: 'off',
			leaderboardRegistration: null,
			autoRunStats: {
				...useSettingsStore.getState().autoRunStats,
				longestRunMs: 1234,
			},
		});
		useAgentStore.setState({ availableAgents: [], agentsDetected: false });
		window.maestro.git.diff = vi.fn().mockResolvedValue({ stdout: 'diff --git a/file b/file' });
		window.maestro.agentError =
			window.maestro.agentError ?? ({} as typeof window.maestro.agentError);
		window.maestro.agentError.clearError = vi.fn().mockResolvedValue(undefined);
		window.maestro.process.kill = vi.fn().mockResolvedValue(true);
	});

	afterEach(() => {
		window.maestro.git.diff = originalGitDiff;
		window.maestro.agentError = originalAgentError;
		window.maestro.process.kill = originalProcessKill;
		vi.restoreAllMocks();
		vi.clearAllTimers();
		vi.useRealTimers();
		cleanup();
	});

	it('opens and closes modal state through real modal actions and app quit bridge', () => {
		const { hook } = renderHandlers();

		act(() => {
			hook.result.current.handleOpenQueueBrowser();
			hook.result.current.handleOpenTabSearch();
			hook.result.current.handleOpenPromptComposer();
			hook.result.current.handleOpenFuzzySearch();
			hook.result.current.handleOpenCreatePR();
			hook.result.current.handleOpenAboutModal();
			hook.result.current.handleOpenBatchRunner();
			hook.result.current.handleOpenMarketplace();
		});

		const modalState = useModalStore.getState();
		expect(modalState.isOpen('queueBrowser')).toBe(true);
		expect(modalState.isOpen('tabSwitcher')).toBe(true);
		expect(modalState.isOpen('promptComposer')).toBe(true);
		expect(modalState.isOpen('fuzzyFileSearch')).toBe(true);
		expect(modalState.isOpen('createPR')).toBe(true);
		expect(modalState.isOpen('about')).toBe(true);
		expect(modalState.isOpen('batchRunner')).toBe(true);
		expect(modalState.isOpen('marketplace')).toBe(true);

		act(() => {
			hook.result.current.handleCloseQueueBrowser();
			hook.result.current.handleCloseTabSwitcher();
			hook.result.current.handleClosePromptComposer();
			hook.result.current.handleCloseFileSearch();
			hook.result.current.handleCloseCreatePRModal();
			hook.result.current.handleCloseAboutModal();
			hook.result.current.handleCloseBatchRunner();
			hook.result.current.handleConfirmQuit();
			hook.result.current.handleCancelQuit();
		});

		expect(useModalStore.getState().isOpen('queueBrowser')).toBe(false);
		expect(useModalStore.getState().isOpen('tabSwitcher')).toBe(false);
		expect(useModalStore.getState().isOpen('promptComposer')).toBe(false);
		expect(useModalStore.getState().isOpen('fuzzyFileSearch')).toBe(false);
		expect(useModalStore.getState().isOpen('createPR')).toBe(false);
		expect(useModalStore.getState().isOpen('about')).toBe(false);
		expect(useModalStore.getState().isOpen('batchRunner')).toBe(false);
		expect(window.maestro.app.confirmQuit).toHaveBeenCalled();
		expect(window.maestro.app.cancelQuit).toHaveBeenCalled();
	});

	it('cleans up simple, session, and lightbox close paths while restoring focus', () => {
		const firstTab = aiTab({
			id: 'ai-a',
			agentSessionId: 'agent-session-1',
			name: 'Implement login',
			stagedImages: ['img-a.png', 'img-b.png'],
		});
		const inactiveTab = aiTab({ id: 'ai-b', stagedImages: ['img-c.png'] });
		const currentSession = session({ aiTabs: [firstTab, inactiveTab] });
		const otherSession = session({
			id: 'other-session',
			aiTabs: [aiTab({ id: 'other-ai', stagedImages: ['other.png'] })],
		});
		useSessionStore.setState({
			sessions: [otherSession, currentSession],
			activeSessionId: currentSession.id,
		});
		const { hook, input } = renderHandlers();
		const actions = getModalActions();

		act(() => {
			actions.setGitDiffPreview('diff --git a/file b/file');
			actions.setGitLogOpen(true);
			actions.setSettingsModalOpen(true);
			actions.setDebugPackageModalOpen(true);
			actions.setShortcutsHelpOpen(true);
			actions.setUpdateCheckModalOpen(true);
			actions.setProcessMonitorOpen(true);
			actions.setLogViewerOpen(true);
			actions.setConfirmModalOpen(true);
			actions.setDeleteAgentSession(currentSession);
			actions.setNewInstanceModalOpen(true);
			actions.setDuplicatingSessionId(currentSession.id);
			actions.setEditAgentSession(currentSession);
			actions.setRenameInstanceModalOpen(true);
			actions.setRenameInstanceSessionId(currentSession.id);
			actions.setRenameTabModalOpen(true);
			actions.setRenameTabId(firstTab.id);
			hook.result.current.handleSetLightboxImage('img-a.png', ['img-a.png', 'img-b.png'], 'staged');
		});

		act(() => {
			hook.result.current.handleCloseGitDiff();
			hook.result.current.handleCloseGitLog();
			hook.result.current.handleCloseSettings();
			hook.result.current.handleCloseDebugPackage();
			hook.result.current.handleCloseShortcutsHelp();
			hook.result.current.handleCloseUpdateCheckModal();
			hook.result.current.handleCloseProcessMonitor();
			hook.result.current.handleCloseLogViewer();
			hook.result.current.handleCloseConfirmModal();
			hook.result.current.handleCloseDeleteAgentModal();
			hook.result.current.handleCloseNewInstanceModal();
			hook.result.current.handleCloseEditAgentModal();
			hook.result.current.handleCloseRenameSessionModal();
			hook.result.current.handleCloseRenameTabModal();
			hook.result.current.handleNavigateLightbox('img-b.png');
			hook.result.current.handleCloseLightbox();
			vi.runOnlyPendingTimers();
		});

		const modalState = useModalStore.getState();
		expect(modalState.getData('gitDiff')).toBeUndefined();
		expect(modalState.isOpen('gitLog')).toBe(false);
		expect(modalState.isOpen('settings')).toBe(false);
		expect(modalState.isOpen('debugPackage')).toBe(false);
		expect(modalState.isOpen('shortcutsHelp')).toBe(false);
		expect(modalState.isOpen('updateCheck')).toBe(false);
		expect(modalState.isOpen('processMonitor')).toBe(false);
		expect(modalState.isOpen('logViewer')).toBe(false);
		expect(modalState.isOpen('confirm')).toBe(false);
		expect(modalState.getData('deleteAgent')).toBeUndefined();
		expect(modalState.getData('editAgent')).toBeUndefined();
		expect(modalState.getData('renameInstance')).toBeUndefined();
		expect(modalState.getData('renameTab')).toBeUndefined();
		expect(modalState.getData('lightbox')).toBeUndefined();
		expect(input.focus).toHaveBeenCalled();
	});

	it('updates quick actions, lightbox data, and staged images across real stores', () => {
		const firstTab = aiTab({
			id: 'ai-a',
			agentSessionId: 'agent-session-1',
			name: 'Implement login',
			stagedImages: ['img-a.png', 'img-b.png'],
		});
		const inactiveTab = aiTab({ id: 'ai-b', stagedImages: ['img-c.png'] });
		const currentSession = session({ aiTabs: [firstTab, inactiveTab] });
		const otherSession = session({
			id: 'other-session',
			aiTabs: [aiTab({ id: 'other-ai', stagedImages: ['other.png'] })],
		});
		useSessionStore.setState({
			sessions: [otherSession, currentSession],
			activeSessionId: currentSession.id,
		});
		const { hook } = renderHandlers();

		act(() => {
			hook.result.current.handleQuickActionsRenameTab();
			hook.result.current.handleQuickActionsOpenTabSwitcher();
			hook.result.current.handleQuickActionsStartTour();
			hook.result.current.handleQuickActionsEditAgent(currentSession);
			hook.result.current.handleQuickActionsOpenMergeSession();
			hook.result.current.handleQuickActionsOpenSendToAgent();
			hook.result.current.handleQuickActionsOpenCreatePR(currentSession);
		});

		expect(useModalStore.getState().getData('renameTab')).toMatchObject({
			tabId: 'ai-a',
			initialName: 'Implement login',
		});
		expect(useModalStore.getState().isOpen('tabSwitcher')).toBe(true);
		expect(useModalStore.getState().isOpen('tour')).toBe(true);
		expect(useModalStore.getState().getData('editAgent')).toEqual({ session: currentSession });
		expect(useModalStore.getState().isOpen('mergeSession')).toBe(true);
		expect(useModalStore.getState().isOpen('sendToAgent')).toBe(true);
		expect(useModalStore.getState().getData('createPR')).toEqual({ session: currentSession });

		act(() => {
			hook.result.current.handleSetLightboxImage('img-a.png', ['img-a.png', 'img-b.png'], 'staged');
			hook.result.current.handleDeleteLightboxImage('img-a.png');
		});
		expect(activeSession().aiTabs[0].stagedImages).toEqual(['img-b.png']);
		expect(activeSession().aiTabs[1].stagedImages).toEqual(['img-c.png']);
		expect(useSessionStore.getState().sessions[0].aiTabs[0].stagedImages).toEqual(['other.png']);
		expect(useModalStore.getState().getData('lightbox')).toMatchObject({
			image: 'img-a.png',
			images: ['img-b.png'],
			allowDelete: true,
			source: 'staged',
		});

		act(() => {
			useGroupChatStore.setState({
				activeGroupChatId: 'group-1',
				groupChatStagedImages: ['group-a.png', 'group-b.png'],
			});
			hook.result.current.handleSetLightboxImage(
				'group-a.png',
				['group-a.png', 'group-b.png'],
				'staged'
			);
			hook.result.current.handleDeleteLightboxImage('group-a.png');
		});

		expect(useGroupChatStore.getState().groupChatStagedImages).toEqual(['group-b.png']);
		expect(useModalStore.getState().getData('lightbox')).toMatchObject({
			images: ['group-b.png'],
			isGroupChat: true,
		});
	});

	it('handles celebrations, leaderboard registration, and agent-error recovery actions', async () => {
		const agentError: AgentError = {
			type: 'network_error',
			message: 'Network failed',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: 'agent-session-1',
			timestamp: 1000,
		};
		const firstTab = aiTab({ id: 'ai-a', agentError });
		const currentSession = session({
			aiTabs: [firstTab],
			agentError,
			agentErrorTabId: 'ai-a',
		});
		useSessionStore.setState({ sessions: [currentSession], activeSessionId: currentSession.id });
		getModalActions().setPendingKeyboardMasteryLevel(3);
		getModalActions().setStandingOvationData({
			badge: { level: 2, name: 'Runner', emoji: 'R', minRuns: 2 },
			isNewRecord: false,
			recordTimeMs: 1234,
		});
		const acknowledgeKeyboard = vi.spyOn(
			useSettingsStore.getState(),
			'acknowledgeKeyboardMasteryLevel'
		);
		const acknowledgeBadge = vi.spyOn(useSettingsStore.getState(), 'acknowledgeBadge');
		const { hook, input } = renderHandlers();

		act(() => {
			hook.result.current.handleShowAgentErrorModal();
		});
		expect(hook.result.current.effectiveAgentError).toMatchObject({ message: 'Network failed' });
		expect(useModalStore.getState().getData('agentError')).toMatchObject({
			sessionId: currentSession.id,
		});

		act(() => {
			hook.result.current.handleKeyboardMasteryCelebrationClose();
			hook.result.current.handleStandingOvationClose();
			hook.result.current.handleFirstRunCelebrationClose();
			hook.result.current.handleOpenLeaderboardRegistration();
			hook.result.current.handleOpenLeaderboardRegistrationFromAbout();
			hook.result.current.handleSaveLeaderboardRegistration({
				displayName: 'Tester',
				shareStats: true,
			});
			hook.result.current.handleLeaderboardOptOut();
		});

		expect(acknowledgeKeyboard).toHaveBeenCalledWith(3);
		expect(acknowledgeBadge).toHaveBeenCalledWith(2);
		expect(useModalStore.getState().isOpen('leaderboard')).toBe(true);
		expect(useSettingsStore.getState().leaderboardRegistration).toBeNull();

		act(() => {
			hook.result.current.handleStartNewSessionAfterError(currentSession.id);
			vi.runOnlyPendingTimers();
		});
		expect(input.focus).toHaveBeenCalled();
		expect(activeSession().aiTabs.length).toBeGreaterThan(1);

		act(() => {
			hook.result.current.handleAuthenticateAfterError(currentSession.id);
			vi.runOnlyPendingTimers();
		});
		expect(activeSession().inputMode).toBe('terminal');

		await act(async () => {
			await hook.result.current.handleRestartAgentAfterError(currentSession.id);
			vi.runOnlyPendingTimers();
		});
		expect(window.maestro.process.kill).toHaveBeenCalledWith(`${currentSession.id}-ai`);

		act(() => {
			hook.result.current.handleShowAgentErrorModal({
				...agentError,
				message: 'Historical failure',
			});
		});
		expect(hook.result.current.effectiveAgentError).toMatchObject({
			message: 'Historical failure',
		});
		expect(hook.result.current.recoveryActions).toEqual([]);
	});

	it('covers agent-error no-op, clear, retry, and focus recovery paths', () => {
		const clearSpy = vi
			.spyOn(useAgentStore.getState(), 'clearAgentError')
			.mockImplementation(vi.fn());
		const retrySpy = vi
			.spyOn(useAgentStore.getState(), 'retryAfterError')
			.mockImplementation(vi.fn());
		const currentSession = session({ aiTabs: [aiTab({ id: 'ai-a', agentError: undefined })] });
		useSessionStore.setState({ sessions: [currentSession], activeSessionId: currentSession.id });
		const { hook, input } = renderHandlers();

		act(() => {
			hook.result.current.handleShowAgentErrorModal();
		});
		expect(useModalStore.getState().getData('agentError')).toBeUndefined();

		act(() => {
			hook.result.current.handleClearAgentError(currentSession.id, 'ai-a');
			hook.result.current.handleRetryAfterError(currentSession.id);
			vi.runOnlyPendingTimers();
		});

		expect(clearSpy).toHaveBeenCalledWith(currentSession.id, 'ai-a');
		expect(retrySpy).toHaveBeenCalledWith(currentSession.id);
		expect(input.focus).toHaveBeenCalled();
	});

	it('runs startup badge effects, shortcut reset, and log-viewer focus fallbacks', () => {
		const terminalRef = { current: document.createElement('div') };
		terminalRef.current.focus = vi.fn();
		useSettingsStore.setState({
			getUnacknowledgedBadgeLevel: vi.fn(() => 2),
			getUnacknowledgedKeyboardMasteryLevel: vi.fn(() => 4),
			autoRunStats: {
				...useSettingsStore.getState().autoRunStats,
				longestRunMs: 9876,
			},
		});
		getModalActions().setShortcutsHelpOpen(true);
		getModalActions().setShortcutsSearchQuery('theme');
		getModalActions().setShortcutsHelpOpen(false);

		renderHandlers({ inputRef: { current: null }, terminalRef });

		act(() => {
			vi.advanceTimersByTime(50);
		});
		expect(terminalRef.current.focus).toHaveBeenCalled();
		expect(useModalStore.getState().getData('shortcutsHelp')).toBeUndefined();

		act(() => {
			vi.advanceTimersByTime(950);
		});
		expect(useModalStore.getState().getData('standingOvation')).toMatchObject({
			isNewRecord: false,
			recordTimeMs: 9876,
		});

		act(() => {
			vi.advanceTimersByTime(200);
		});
		expect(useModalStore.getState().getData('keyboardMastery')).toMatchObject({
			level: 4,
		});
	});

	it('checks missed badges on app-return events without duplicating active ovations', () => {
		const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
		useSettingsStore.setState({
			getUnacknowledgedBadgeLevel: vi.fn(() => 3),
			getUnacknowledgedKeyboardMasteryLevel: vi.fn(() => null),
			autoRunStats: {
				...useSettingsStore.getState().autoRunStats,
				longestRunMs: 2222,
			},
		});
		renderHandlers();

		act(() => {
			window.dispatchEvent(new Event('focus'));
			window.dispatchEvent(new Event('focus'));
			vi.advanceTimersByTime(500);
		});
		expect(useModalStore.getState().getData('standingOvation')).toMatchObject({
			recordTimeMs: 2222,
		});

		act(() => {
			document.dispatchEvent(new Event('visibilitychange'));
			document.dispatchEvent(new MouseEvent('mousemove'));
			vi.advanceTimersByTime(500);
		});
		expect(useModalStore.getState().getData('standingOvation')).toMatchObject({
			recordTimeMs: 2222,
		});
		hiddenSpy.mockRestore();
	});

	it('guards agent-error and app-return effects when state is unavailable', () => {
		useSettingsStore.setState({
			settingsLoaded: false,
			getUnacknowledgedBadgeLevel: vi.fn(() => 2),
			getUnacknowledgedKeyboardMasteryLevel: vi.fn(() => 4),
		});
		useSessionStore.setState({ sessions: [], activeSessionId: '', sessionsLoaded: true });
		const { hook } = renderHandlers();

		act(() => {
			hook.result.current.handleShowAgentErrorModal();
			window.dispatchEvent(new Event('focus'));
			vi.advanceTimersByTime(1200);
		});

		expect(useModalStore.getState().getData('agentError')).toBeUndefined();
		expect(useModalStore.getState().getData('standingOvation')).toBeUndefined();
		expect(useModalStore.getState().getData('keyboardMastery')).toBeUndefined();
	});

	it('runs git diff and Director Notes resume flows against real session state', async () => {
		const resume = vi.fn();
		const resumeRef = { current: resume };
		const sourceSession = session({ id: 'source-session', cwd: '/repo/source' });
		const targetSession = session({
			id: 'target-session',
			cwd: '/repo/target',
			sshRemoteId: 'remote-1',
		});
		useSessionStore.setState({
			sessions: [sourceSession, targetSession],
			activeSessionId: targetSession.id,
		});
		const { hook } = renderHandlers({ resumeRef });

		await act(async () => {
			await hook.result.current.handleViewGitDiff();
		});
		expect(window.maestro.git.diff).toHaveBeenCalledWith('/repo/target', undefined, 'remote-1');
		expect(useModalStore.getState().getData('gitDiff')).toEqual({
			diff: 'diff --git a/file b/file',
		});

		act(() => {
			hook.result.current.handleDirectorNotesResumeSession(
				targetSession.id,
				'agent-session-direct'
			);
		});
		expect(resume).toHaveBeenCalledWith('agent-session-direct');

		act(() => {
			hook.result.current.handleDirectorNotesResumeSession(
				sourceSession.id,
				'agent-session-source'
			);
		});
		expect(useSessionStore.getState().activeSessionId).toBe(sourceSession.id);

		hook.rerender();
		expect(resume).toHaveBeenCalledWith('agent-session-source');
	});

	it('handles git diff guard, terminal cwd, and empty diff results', async () => {
		const nonRepoSession = session({ id: 'plain-session', isGitRepo: false });
		useSessionStore.setState({
			sessions: [nonRepoSession],
			activeSessionId: nonRepoSession.id,
		});
		const { hook } = renderHandlers();

		await act(async () => {
			await hook.result.current.handleViewGitDiff();
		});
		expect(window.maestro.git.diff).not.toHaveBeenCalled();

		const terminalSession = session({
			id: 'terminal-session',
			inputMode: 'terminal',
			cwd: '/repo/default',
			shellCwd: '/repo/shell',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-from-config',
			} as Session['sessionSshRemoteConfig'],
		});
		act(() => {
			useSessionStore.setState({
				sessions: [terminalSession],
				activeSessionId: terminalSession.id,
			});
			hook.rerender();
		});
		window.maestro.git.diff = vi.fn().mockResolvedValue({ stdout: '' });

		await act(async () => {
			await hook.result.current.handleViewGitDiff();
		});
		expect(window.maestro.git.diff).toHaveBeenCalledWith(
			'/repo/shell',
			undefined,
			'remote-from-config'
		);
		expect(useModalStore.getState().getData('gitDiff')).toBeUndefined();
		expect(useCenterFlashStore.getState().active).toMatchObject({
			message: 'No diff to examine',
			color: 'theme',
		});
		expect(mockRefreshGitStatus).toHaveBeenCalledTimes(1);
	});

	it('invokes live recovery action callbacks from generated recovery actions', async () => {
		const authError: AgentError = {
			type: 'auth_expired',
			message: 'Login expired',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: 'agent-session-1',
			timestamp: 1000,
		};
		const currentSession = session({
			aiTabs: [aiTab({ id: 'ai-a', agentError: authError })],
			agentError: authError,
			agentErrorTabId: 'ai-a',
		});
		const startSpy = vi
			.spyOn(useAgentStore.getState(), 'startNewSessionAfterError')
			.mockImplementation(vi.fn());
		const authenticateSpy = vi
			.spyOn(useAgentStore.getState(), 'authenticateAfterError')
			.mockImplementation(vi.fn());
		const restartSpy = vi
			.spyOn(useAgentStore.getState(), 'restartAgentAfterError')
			.mockResolvedValue(undefined);
		useSessionStore.setState({ sessions: [currentSession], activeSessionId: currentSession.id });
		const { hook, input } = renderHandlers();

		act(() => {
			hook.result.current.handleShowAgentErrorModal();
		});

		act(() => {
			hook.result.current.recoveryActions.find((action) => action.id === 'authenticate')?.onClick();
			hook.result.current.recoveryActions.find((action) => action.id === 'new-session')?.onClick();
			vi.runOnlyPendingTimers();
		});

		expect(authenticateSpy).toHaveBeenCalledWith(currentSession.id);
		expect(startSpy).toHaveBeenCalledWith(currentSession.id, {
			saveToHistory: true,
			showThinking: 'off',
		});
		expect(input.focus).toHaveBeenCalled();

		const crashError: AgentError = {
			...authError,
			type: 'agent_crashed',
			message: 'Agent crashed',
		};
		const crashedSession = session({
			id: 'crashed-session',
			aiTabs: [aiTab({ id: 'ai-crashed', agentError: crashError })],
			activeTabId: 'ai-crashed',
			agentError: crashError,
			agentErrorTabId: 'ai-crashed',
		});
		act(() => {
			useSessionStore.setState({
				sessions: [crashedSession],
				activeSessionId: crashedSession.id,
			});
			hook.rerender();
			hook.result.current.handleShowAgentErrorModal();
		});

		await act(async () => {
			await hook.result.current.recoveryActions
				.find((action) => action.id === 'restart-agent')
				?.onClick();
			vi.runOnlyPendingTimers();
		});

		expect(restartSpy).toHaveBeenCalledWith(crashedSession.id);

		const retrySpy = vi
			.spyOn(useAgentStore.getState(), 'retryAfterError')
			.mockImplementation(vi.fn());
		const retryError: AgentError = {
			...authError,
			type: 'network_error',
			message: 'Network failed',
		};
		const retrySession = session({
			id: 'retry-session',
			aiTabs: [aiTab({ id: 'ai-retry', agentError: retryError })],
			activeTabId: 'ai-retry',
			agentError: retryError,
			agentErrorTabId: 'ai-retry',
		});
		act(() => {
			useSessionStore.setState({
				sessions: [retrySession],
				activeSessionId: retrySession.id,
			});
			hook.rerender();
			hook.result.current.handleShowAgentErrorModal();
		});
		const retryAction = hook.result.current.recoveryActions.find((action) => action.id === 'retry');
		expect(retryAction).toBeDefined();

		act(() => {
			retryAction?.onClick();
			vi.runOnlyPendingTimers();
		});

		expect(retrySpy).toHaveBeenCalledWith(retrySession.id);
	});

	it('covers utility close handlers, list openers, and no-op celebration branches', () => {
		const currentSession = session();
		useSessionStore.setState({ sessions: [currentSession], activeSessionId: currentSession.id });
		const recordShortcutUsage = vi
			.spyOn(useSettingsStore.getState(), 'recordShortcutUsage')
			.mockReturnValueOnce({ newLevel: 6 })
			.mockReturnValueOnce({ newLevel: null });
		const acknowledgeKeyboard = vi.spyOn(
			useSettingsStore.getState(),
			'acknowledgeKeyboardMasteryLevel'
		);
		const acknowledgeBadge = vi.spyOn(useSettingsStore.getState(), 'acknowledgeBadge');
		const { hook, input } = renderHandlers();
		const actions = getModalActions();

		act(() => {
			hook.result.current.onKeyboardMasteryLevelUp(5);
			hook.result.current.handleKeyboardMasteryCelebrationClose();
			hook.result.current.handleKeyboardMasteryCelebrationClose();
			hook.result.current.handleStandingOvationClose();
			hook.result.current.handleLogViewerShortcutUsed('shortcut-one');
			hook.result.current.handleLogViewerShortcutUsed('shortcut-two');
			hook.result.current.handleCloseLeaderboardRegistration();
			actions.setAgentErrorModalSessionId(currentSession.id);
			hook.result.current.handleCloseAgentErrorModal();
		});

		expect(acknowledgeKeyboard).toHaveBeenCalledTimes(1);
		expect(acknowledgeKeyboard).toHaveBeenCalledWith(5);
		expect(acknowledgeBadge).not.toHaveBeenCalled();
		expect(recordShortcutUsage).toHaveBeenCalledWith('shortcut-one');
		expect(recordShortcutUsage).toHaveBeenCalledWith('shortcut-two');
		expect(useModalStore.getState().getData('keyboardMastery')).toEqual({ level: 6 });
		expect(useModalStore.getState().getData('agentError')).toBeUndefined();

		act(() => {
			hook.result.current.handleEditAgent(currentSession);
			hook.result.current.handleOpenCreatePRSession(currentSession);
			hook.result.current.handleStartTour();
			actions.setAutoRunSetupModalOpen(true);
			actions.setBatchRunnerModalOpen(true);
			actions.setTabSwitcherOpen(true);
			actions.setFuzzyFileSearchOpen(true);
			actions.setPromptComposerOpen(true);
			actions.setCreatePRSession(currentSession);
			actions.setSendToAgentModalOpen(true);
			actions.setQueueBrowserOpen(true);
			actions.setRenameGroupModalOpen(true);
			hook.result.current.handleCloseAutoRunSetup();
			hook.result.current.handleCloseBatchRunner();
			hook.result.current.handleCloseTabSwitcher();
			hook.result.current.handleCloseFileSearch();
			hook.result.current.handleClosePromptComposer();
			hook.result.current.handleCloseCreatePRModal();
			hook.result.current.handleCloseSendToAgent();
			hook.result.current.handleCloseQueueBrowser();
			hook.result.current.handleCloseRenameGroupModal();
			vi.runOnlyPendingTimers();
		});

		expect(useModalStore.getState().getData('editAgent')).toEqual({ session: currentSession });
		expect(useModalStore.getState().getData('createPR')).toBeUndefined();
		expect(useModalStore.getState().isOpen('tour')).toBe(true);
		expect(useModalStore.getState().isOpen('autoRunSetup')).toBe(false);
		expect(useModalStore.getState().isOpen('sendToAgent')).toBe(false);
		expect(useModalStore.getState().isOpen('renameGroup')).toBe(false);
		expect(input.focus).toHaveBeenCalled();
	});

	it('guards rename without an active AI agent, opens tab switcher for AI tabs, and falls back to body focus', () => {
		const bodyFocus = vi.spyOn(document.body, 'focus').mockImplementation(vi.fn());
		const { hook } = renderHandlers({
			inputRef: { current: null },
			terminalRef: { current: null },
		});

		act(() => {
			vi.advanceTimersByTime(50);
		});
		expect(bodyFocus).toHaveBeenCalled();

		const inactiveSession = session({
			id: 'terminal-no-ai',
			inputMode: 'terminal',
			aiTabs: [aiTab({ id: 'ai-without-session', agentSessionId: null })],
			activeTabId: 'ai-without-session',
		});
		act(() => {
			useSessionStore.setState({
				sessions: [inactiveSession],
				activeSessionId: inactiveSession.id,
			});
			hook.rerender();
			hook.result.current.handleQuickActionsRenameTab();
			hook.result.current.handleQuickActionsOpenTabSwitcher();
		});

		expect(useModalStore.getState().getData('renameTab')).toBeUndefined();
		expect(useModalStore.getState().isOpen('tabSwitcher')).toBe(true);
	});
});
