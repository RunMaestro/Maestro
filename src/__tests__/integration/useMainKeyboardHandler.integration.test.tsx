import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../renderer/types';
import {
	type KeyboardHandlerContext,
	useMainKeyboardHandler,
} from '../../renderer/hooks/keyboard/useMainKeyboardHandler';
import { useModalStore } from '../../renderer/stores/modalStore';
import { useSettingsStore } from '../../renderer/stores/settingsStore';

type ShortcutEvent = KeyboardEvent & {
	shortcutId?: string;
	tabShortcutId?: string;
};

const createSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'session-1',
		name: 'Keyboard Session',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/repo',
		projectRoot: '/repo',
		aiPid: 0,
		terminalPid: 0,
		aiLogs: [],
		shellLogs: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		messageQueue: [],
		activeTabId: 'tab-1',
		aiTabs: [
			{
				id: 'tab-1',
				title: 'Main',
				logs: [
					{ id: 'log-1', source: 'thinking', text: 'thinking' },
					{ id: 'log-2', source: 'stdout', text: 'answer' },
				],
				showThinking: 'off',
				saveToHistory: true,
				agentSessionId: 'agent-session-1',
			},
			{
				id: 'tab-2',
				title: 'Second',
				logs: [],
				showThinking: 'on',
				saveToHistory: true,
			},
		],
		...overrides,
	}) as Session;

function createKeyboardEvent(
	init: KeyboardEventInit & { shortcutId?: string; tabShortcutId?: string }
): ShortcutEvent {
	const event = new KeyboardEvent('keydown', {
		key: 'x',
		bubbles: true,
		cancelable: true,
		...init,
	}) as ShortcutEvent;

	if (init.shortcutId) {
		Object.defineProperty(event, 'shortcutId', { value: init.shortcutId });
	}
	if (init.tabShortcutId) {
		Object.defineProperty(event, 'tabShortcutId', { value: init.tabShortcutId });
	}

	return event;
}

function dispatchKey(init: KeyboardEventInit & { shortcutId?: string; tabShortcutId?: string }) {
	const event = createKeyboardEvent(init);
	const preventDefault = vi.spyOn(event, 'preventDefault');

	act(() => {
		window.dispatchEvent(event);
	});

	return { event, preventDefault };
}

function createContext(overrides: Partial<KeyboardHandlerContext> = {}): KeyboardHandlerContext {
	const session = createSession();
	const input = document.createElement('textarea');
	const groupInput = document.createElement('textarea');
	const terminalOutput = document.createElement('div');
	const sidebar = document.createElement('div');
	const scrollContainer = document.createElement('div');
	const logsEnd = document.createElement('div');
	scrollContainer.appendChild(logsEnd);
	document.body.append(input, groupInput, terminalOutput, sidebar, scrollContainer);

	const context: KeyboardHandlerContext = {
		hasOpenLayers: vi.fn(() => false),
		hasOpenModal: vi.fn(() => false),
		editingSessionId: null,
		editingGroupId: null,
		handleSidebarNavigation: vi.fn(() => false),
		handleEnterToActivate: vi.fn(() => false),
		handleTabNavigation: vi.fn(() => false),
		handleEscapeInMain: vi.fn(() => false),
		isShortcut: (event: ShortcutEvent, id: string) => event.shortcutId === id,
		isTabShortcut: (event: ShortcutEvent, id: string) => event.tabShortcutId === id,
		sessions: [session],
		visibleSessions: [session, createSession({ id: 'session-2', name: 'Second' })],
		activeSession: session,
		activeSessionId: session.id,
		activeGroupChatId: null,
		activeFocus: 'main',
		activeRightTab: 'history',
		leftSidebarOpen: true,
		autoScrollAiMode: false,
		chatRawTextMode: false,
		defaultSaveToHistory: true,
		defaultShowThinking: 'off',
		showUnreadOnly: false,
		stagedImages: ['image-a.png', 'image-b.png'],
		groupChatStagedImages: ['group-image.png'],
		encoreFeatures: { directorNotes: true, symphony: true, usageStats: true },
		activeBatchRunState: null,
		inputRef: { current: input },
		groupChatInputRef: { current: groupInput },
		terminalOutputRef: { current: terminalOutput },
		sidebarContainerRef: { current: sidebar },
		logsEndRef: { current: logsEnd },
		rightPanelRef: { current: { toggleAutoRunExpanded: vi.fn() } },
		setLeftSidebarOpen: vi.fn(),
		setRightPanelOpen: vi.fn(),
		addNewSession: vi.fn(),
		setShowNewGroupChatModal: vi.fn(),
		deleteGroupChatWithConfirmation: vi.fn(),
		deleteSession: vi.fn(),
		setQuickActionInitialMode: vi.fn(),
		setQuickActionOpen: vi.fn(),
		cycleSession: vi.fn(),
		handleNavBack: vi.fn(),
		handleNavForward: vi.fn(),
		toggleInputMode: vi.fn(),
		handleOpenTerminalTab: vi.fn(),
		setActiveFocus: vi.fn(),
		setShortcutsHelpOpen: vi.fn(),
		setSettingsModalOpen: vi.fn(),
		setSettingsTab: vi.fn(),
		setEditAgentSession: vi.fn(),
		handleSetActiveRightTab: vi.fn(),
		setGroupChatRightTab: vi.fn(),
		setFuzzyFileSearchOpen: vi.fn(),
		toggleBookmark: vi.fn(),
		handleSetLightboxImage: vi.fn(),
		toggleTabStar: vi.fn(),
		setPromptComposerOpen: vi.fn(),
		openWizardModal: vi.fn(),
		handleViewGitDiff: vi.fn(),
		setGitLogOpen: vi.fn(),
		hasActiveSessionCapability: vi.fn(() => true),
		setActiveAgentSessionId: vi.fn(),
		setAgentSessionsOpen: vi.fn(),
		setLogViewerOpen: vi.fn(),
		setProcessMonitorOpen: vi.fn(),
		setUsageDashboardOpen: vi.fn(),
		setSymphonyModalOpen: vi.fn(),
		setAutoScrollAiMode: vi.fn(),
		setDirectorNotesOpen: vi.fn(),
		setChatRawTextMode: vi.fn(),
		setActiveSessionId: vi.fn(),
		recordShortcutUsage: vi.fn(() => ({ newLevel: null })),
		onKeyboardMasteryLevelUp: vi.fn(),
		setTabSwitcherOpen: vi.fn(),
		createTab: vi.fn(() => ({
			session: createSession({
				aiTabs: [...session.aiTabs, { id: 'tab-3', title: 'New', logs: [] }],
				activeTabId: 'tab-3',
			}),
		})),
		setSessions: vi.fn((updater: (sessions: Session[]) => Session[]) => updater([session])),
		handleCloseCurrentTab: vi.fn(() => ({ type: 'none' })),
		performTabClose: vi.fn(),
		handleCloseAllTabs: vi.fn(),
		handleCloseOtherTabs: vi.fn(),
		handleCloseTabsLeft: vi.fn(),
		handleCloseTabsRight: vi.fn(),
		reopenUnifiedClosedTab: vi.fn(() => ({ session })),
		getActiveTab: vi.fn(() => session.aiTabs[0]),
		setRenameTabId: vi.fn(),
		setRenameTabInitialName: vi.fn(),
		setRenameTabModalOpen: vi.fn(),
		toggleUnreadFilter: vi.fn(),
		toggleTabUnread: vi.fn(),
		navigateToNextUnifiedTab: vi.fn(() => ({ session })),
		navigateToPrevUnifiedTab: vi.fn(() => ({ session })),
		navigateToUnifiedTabByIndex: vi.fn(() => ({ session })),
		navigateToLastUnifiedTab: vi.fn(() => ({ session })),
		setFileTreeFilterOpen: vi.fn(),
		...overrides,
	};

	return context;
}

describe('useMainKeyboardHandler integration', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		useModalStore.getState().closeAll();
		useSettingsStore.setState({ fontSize: 14 });
		vi.useFakeTimers();
	});

	afterEach(() => {
		cleanup();
		act(() => {
			vi.runOnlyPendingTimers();
		});
		vi.useRealTimers();
		useModalStore.getState().closeAll();
		document.body.innerHTML = '';
		vi.restoreAllMocks();
	});

	it('routes App-level shortcuts through the current ref context', () => {
		const { result } = renderHook(() => useMainKeyboardHandler());
		const recordShortcutUsage = vi.fn((id: string) => ({
			newLevel: id === 'help' ? 3 : null,
		}));
		const context = createContext({
			recordShortcutUsage,
			activeGroupChatId: 'group-chat-1',
		});
		result.current.keyboardHandlerRef.current = context;

		dispatchKey({ shortcutId: 'toggleSidebar' });
		dispatchKey({ shortcutId: 'toggleRightPanel' });
		dispatchKey({ shortcutId: 'newInstance' });
		dispatchKey({ shortcutId: 'newGroupChat' });
		dispatchKey({ shortcutId: 'killInstance' });
		dispatchKey({ shortcutId: 'moveToGroup' });
		dispatchKey({ shortcutId: 'cyclePrev' });
		dispatchKey({ shortcutId: 'cycleNext' });
		dispatchKey({ shortcutId: 'navBack' });
		dispatchKey({ shortcutId: 'navForward' });
		dispatchKey({ shortcutId: 'toggleMode' });
		dispatchKey({ shortcutId: 'quickAction' });
		dispatchKey({ shortcutId: 'help' });
		dispatchKey({ shortcutId: 'settings' });
		dispatchKey({ shortcutId: 'agentSettings' });
		dispatchKey({ shortcutId: 'goToFiles' });
		dispatchKey({ shortcutId: 'goToHistory' });
		dispatchKey({ shortcutId: 'goToAutoRun' });
		dispatchKey({ shortcutId: 'fuzzyFileSearch' });
		dispatchKey({ shortcutId: 'toggleBookmark' });
		dispatchKey({ shortcutId: 'openImageCarousel' });
		dispatchKey({ shortcutId: 'toggleTabStar' });
		dispatchKey({ shortcutId: 'openPromptComposer' });
		dispatchKey({ shortcutId: 'openWizard' });
		dispatchKey({ shortcutId: 'focusInput' });
		dispatchKey({ shortcutId: 'focusSidebar' });
		dispatchKey({ shortcutId: 'viewGitDiff' });
		dispatchKey({ shortcutId: 'viewGitLog' });
		dispatchKey({ shortcutId: 'agentSessions' });
		dispatchKey({ shortcutId: 'systemLogs' });
		dispatchKey({ shortcutId: 'processMonitor' });
		dispatchKey({ shortcutId: 'usageDashboard' });
		dispatchKey({ shortcutId: 'openSymphony' });
		dispatchKey({ shortcutId: 'directorNotes' });
		dispatchKey({ shortcutId: 'jumpToBottom' });
		dispatchKey({ shortcutId: 'toggleMarkdownMode' });
		dispatchKey({ shortcutId: 'toggleAutoRunExpanded' });

		act(() => {
			vi.runOnlyPendingTimers();
		});

		expect(context.setLeftSidebarOpen).toHaveBeenCalled();
		expect(context.setRightPanelOpen).toHaveBeenCalled();
		expect(useModalStore.getState().isOpen('newInstance')).toBe(true);
		expect(context.setShowNewGroupChatModal).toHaveBeenCalledWith(true);
		expect(context.deleteGroupChatWithConfirmation).toHaveBeenCalledWith('group-chat-1');
		expect(context.cycleSession).toHaveBeenCalledWith('prev');
		expect(context.cycleSession).toHaveBeenCalledWith('next');
		expect(context.handleNavBack).toHaveBeenCalled();
		expect(context.handleNavForward).toHaveBeenCalled();
		expect(context.handleOpenTerminalTab).toHaveBeenCalled();
		expect(context.setShortcutsHelpOpen).toHaveBeenCalledWith(true);
		expect(context.onKeyboardMasteryLevelUp).toHaveBeenCalledWith(3);
		expect(context.setSettingsModalOpen).toHaveBeenCalledWith(true);
		// With an active group chat, agentSettings opens the moderator's settings
		// for that chat rather than the per-session agent settings.
		expect(useModalStore.getState().isOpen('editGroupChat')).toBe(true);
		expect(context.setEditAgentSession).not.toHaveBeenCalled();
		expect(context.setGroupChatRightTab).toHaveBeenCalledWith('participants');
		expect(context.handleSetActiveRightTab).toHaveBeenCalledWith('autorun');
		expect(context.setFuzzyFileSearchOpen).toHaveBeenCalledWith(true);
		expect(context.toggleBookmark).toHaveBeenCalledWith('session-1');
		expect(context.handleSetLightboxImage).toHaveBeenCalledWith(
			'group-image.png',
			['group-image.png'],
			'staged'
		);
		expect(useModalStore.getState().isOpen('promptComposer')).toBe(true);
		expect(context.openWizardModal).toHaveBeenCalled();
		expect(context.setAgentSessionsOpen).toHaveBeenCalledWith(true);
		expect(context.setLogViewerOpen).toHaveBeenCalledWith(true);
		expect(context.setProcessMonitorOpen).toHaveBeenCalledWith(true);
		expect(context.setUsageDashboardOpen).toHaveBeenCalledWith(true);
		expect(context.setSymphonyModalOpen).toHaveBeenCalledWith(true);
		expect(context.setDirectorNotesOpen).toHaveBeenCalledWith(true);
		expect(context.setChatRawTextMode).toHaveBeenCalledWith(true);
		expect(context.rightPanelRef.current.toggleAutoRunExpanded).toHaveBeenCalled();
		expect(recordShortcutUsage).toHaveBeenCalledWith('toggleAutoRunExpanded');
	});

	it('integrates modal and settings stores for tab and font-size shortcuts', () => {
		const { result } = renderHook(() => useMainKeyboardHandler());
		const context = createContext({
			handleCloseCurrentTab: vi.fn(() => ({
				type: 'ai',
				tabId: 'tab-1',
				isWizardTab: true,
				hasWizardUserInteraction: true,
				hasDraft: false,
			})),
		});
		const initialActiveSession = context.activeSession;
		result.current.keyboardHandlerRef.current = context;

		dispatchKey({ key: '=', metaKey: true });
		expect(useSettingsStore.getState().fontSize).toBe(16);

		dispatchKey({ key: '-', metaKey: true });
		expect(useSettingsStore.getState().fontSize).toBe(14);

		useSettingsStore.setState({ fontSize: 20 });
		dispatchKey({ shortcutId: 'fontSizeReset' });
		expect(useSettingsStore.getState().fontSize).toBe(14);

		dispatchKey({ tabShortcutId: 'tabSwitcher' });
		dispatchKey({ tabShortcutId: 'newTab' });
		dispatchKey({ tabShortcutId: 'closeTab' });
		dispatchKey({ tabShortcutId: 'closeAllTabs' });
		dispatchKey({ tabShortcutId: 'closeOtherTabs' });
		dispatchKey({ tabShortcutId: 'closeTabsRight' });
		context.activeSession = createSession({ activeTabId: 'tab-2' });
		dispatchKey({ tabShortcutId: 'closeTabsLeft' });
		dispatchKey({ tabShortcutId: 'reopenClosedTab' });
		dispatchKey({ tabShortcutId: 'renameTab' });
		dispatchKey({ tabShortcutId: 'toggleReadOnlyMode' });
		dispatchKey({ tabShortcutId: 'toggleSaveToHistory' });
		dispatchKey({ tabShortcutId: 'toggleShowThinking' });
		dispatchKey({ tabShortcutId: 'filterUnreadTabs' });
		dispatchKey({ tabShortcutId: 'toggleTabUnread' });
		dispatchKey({ tabShortcutId: 'nextTab' });
		dispatchKey({ tabShortcutId: 'prevTab' });
		dispatchKey({ tabShortcutId: 'goToTab2' });
		dispatchKey({ tabShortcutId: 'goToLastTab' });

		const confirmData = useModalStore.getState().getData('confirm');
		expect(useModalStore.getState().isOpen('confirm')).toBe(true);
		expect(confirmData?.message).toBe(
			'Close this wizard? Your progress will be lost and cannot be restored.'
		);
		act(() => confirmData?.onConfirm());

		expect(context.setTabSwitcherOpen).toHaveBeenCalledWith(true);
		expect(context.createTab).toHaveBeenCalledWith(initialActiveSession, {
			saveToHistory: true,
			showThinking: 'off',
		});
		expect(context.performTabClose).toHaveBeenCalledWith('tab-1');
		expect(context.handleCloseAllTabs).toHaveBeenCalled();
		expect(context.handleCloseOtherTabs).toHaveBeenCalled();
		expect(context.handleCloseTabsLeft).toHaveBeenCalled();
		expect(context.handleCloseTabsRight).toHaveBeenCalled();
		expect(context.reopenUnifiedClosedTab).toHaveBeenCalledWith(context.activeSession);
		expect(context.setRenameTabId).toHaveBeenCalledWith('tab-1');
		expect(context.setRenameTabModalOpen).toHaveBeenCalledWith(true);
		expect(context.toggleUnreadFilter).toHaveBeenCalled();
		expect(context.toggleTabUnread).toHaveBeenCalled();
		expect(context.navigateToNextUnifiedTab).toHaveBeenCalled();
		expect(context.navigateToPrevUnifiedTab).toHaveBeenCalled();
		expect(context.navigateToUnifiedTabByIndex).toHaveBeenCalledWith(
			initialActiveSession,
			1,
			false
		);
		expect(context.navigateToLastUnifiedTab).toHaveBeenCalledWith(initialActiveSession, false);
	});

	it('honors layer gating, browser-refresh blocking, session jumps, and badge visibility', () => {
		const { result } = renderHook(() => useMainKeyboardHandler());
		const blockedContext = createContext({
			hasOpenLayers: vi.fn(() => true),
			hasOpenModal: vi.fn(() => true),
		});
		result.current.keyboardHandlerRef.current = blockedContext;

		dispatchKey({ shortcutId: 'newInstance' });
		expect(blockedContext.addNewSession).not.toHaveBeenCalled();

		dispatchKey({ shortcutId: 'systemLogs', altKey: true, metaKey: true, code: 'KeyL' });
		expect(blockedContext.setLogViewerOpen).toHaveBeenCalledWith(true);

		const refresh = dispatchKey({ key: 'r', metaKey: true });
		expect(refresh.preventDefault).toHaveBeenCalled();

		const jumpContext = createContext({ leftSidebarOpen: false });
		result.current.keyboardHandlerRef.current = jumpContext;
		dispatchKey({ key: '2', code: 'Digit2', altKey: true, metaKey: true });
		expect(jumpContext.setActiveSessionId).toHaveBeenCalledWith('session-2');
		expect(jumpContext.setLeftSidebarOpen).toHaveBeenCalledWith(true);

		expect(result.current.showSessionJumpNumbers).toBe(true);
		act(() => {
			window.dispatchEvent(
				new KeyboardEvent('keyup', {
					key: 'Meta',
					altKey: true,
					metaKey: false,
					bubbles: true,
				})
			);
		});
		expect(result.current.showSessionJumpNumbers).toBe(false);

		act(() => {
			window.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Alt',
					altKey: true,
					metaKey: true,
					bubbles: true,
				})
			);
		});
		expect(result.current.showSessionJumpNumbers).toBe(true);

		act(() => {
			window.dispatchEvent(new Event('blur'));
		});
		expect(result.current.showSessionJumpNumbers).toBe(false);
	});

	it('honors missing context, overlay allowances, modal blocking, and sidebar editing guards', () => {
		const { result } = renderHook(() => useMainKeyboardHandler());

		const refreshWithoutContext = dispatchKey({ key: 'r', metaKey: true });
		expect(refreshWithoutContext.preventDefault).toHaveBeenCalled();

		const overlayContext = createContext({
			hasOpenLayers: vi.fn(() => true),
			hasOpenModal: vi.fn(() => false),
		});
		result.current.keyboardHandlerRef.current = overlayContext;
		dispatchKey({ shortcutId: 'goToFiles', key: 'f', metaKey: true, shiftKey: true });
		expect(overlayContext.handleSetActiveRightTab).toHaveBeenCalledWith('files');

		const modalContext = createContext({
			hasOpenLayers: vi.fn(() => true),
			hasOpenModal: vi.fn(() => true),
		});
		result.current.keyboardHandlerRef.current = modalContext;
		dispatchKey({ shortcutId: 'goToFiles', key: 'f', metaKey: true, shiftKey: true });
		expect(modalContext.handleSetActiveRightTab).not.toHaveBeenCalled();

		const editingContext = createContext({ editingSessionId: 'session-1' });
		result.current.keyboardHandlerRef.current = editingContext;
		dispatchKey({ shortcutId: 'newInstance' });
		expect(editingContext.addNewSession).not.toHaveBeenCalled();

		const navigationContext = createContext({
			handleSidebarNavigation: vi.fn(() => true),
		});
		result.current.keyboardHandlerRef.current = navigationContext;
		dispatchKey({ shortcutId: 'newInstance' });
		expect(navigationContext.handleSidebarNavigation).toHaveBeenCalled();
		expect(navigationContext.addNewSession).not.toHaveBeenCalled();
	});

	it('routes non-group shortcuts and suppresses guarded actions when context is missing', () => {
		const { result } = renderHook(() => useMainKeyboardHandler());
		const context = createContext({
			activeGroupChatId: null,
		});
		result.current.keyboardHandlerRef.current = context;

		dispatchKey({ shortcutId: 'killInstance' });
		dispatchKey({ shortcutId: 'goToFiles' });
		dispatchKey({ shortcutId: 'goToHistory' });
		dispatchKey({ shortcutId: 'openImageCarousel' });
		dispatchKey({ shortcutId: 'viewGitDiff' });
		dispatchKey({ shortcutId: 'viewGitLog' });

		expect(context.deleteSession).toHaveBeenCalledWith('session-1');
		expect(context.handleSetActiveRightTab).toHaveBeenCalledWith('files');
		expect(context.handleSetActiveRightTab).toHaveBeenCalledWith('history');
		expect(context.handleSetLightboxImage).toHaveBeenCalledWith(
			'image-a.png',
			['image-a.png', 'image-b.png'],
			'staged'
		);
		expect(context.handleViewGitDiff).toHaveBeenCalled();
		expect(context.setGitLogOpen).toHaveBeenCalledWith(true);

		const guardedContext = createContext({
			sessions: [],
			leftSidebarOpen: true,
			activeSession: null,
			activeSessionId: null,
			stagedImages: [],
			hasActiveSessionCapability: vi.fn(() => false),
		});
		result.current.keyboardHandlerRef.current = guardedContext;
		dispatchKey({ shortcutId: 'toggleSidebar' });
		dispatchKey({ shortcutId: 'quickAction' });
		dispatchKey({ shortcutId: 'agentSettings' });
		dispatchKey({ shortcutId: 'fuzzyFileSearch' });
		dispatchKey({ shortcutId: 'toggleBookmark' });
		dispatchKey({ shortcutId: 'openImageCarousel' });
		dispatchKey({ shortcutId: 'agentSessions' });

		expect(guardedContext.setLeftSidebarOpen).not.toHaveBeenCalled();
		expect(guardedContext.setQuickActionOpen).not.toHaveBeenCalled();
		expect(guardedContext.setEditAgentSession).not.toHaveBeenCalled();
		expect(guardedContext.setFuzzyFileSearchOpen).not.toHaveBeenCalled();
		expect(guardedContext.toggleBookmark).not.toHaveBeenCalled();
		expect(guardedContext.handleSetLightboxImage).not.toHaveBeenCalled();
		expect(guardedContext.setAgentSessionsOpen).not.toHaveBeenCalled();
	});

	it('handles focus toggles, scroll-to-bottom, and markdown-mode guard rails', () => {
		const { result } = renderHook(() => useMainKeyboardHandler());
		const context = createContext();
		const inputBlur = vi.spyOn(context.inputRef.current!, 'blur');
		const terminalFocus = vi.spyOn(context.terminalOutputRef.current!, 'focus');
		const scrollContainer = context.logsEndRef.current!.parentElement as HTMLDivElement & {
			scrollTo: ReturnType<typeof vi.fn>;
		};
		scrollContainer.scrollTo = vi.fn();
		Object.defineProperty(scrollContainer, 'scrollHeight', { configurable: true, value: 480 });
		result.current.keyboardHandlerRef.current = context;

		context.inputRef.current!.focus();
		dispatchKey({ shortcutId: 'focusInput' });
		expect(inputBlur).toHaveBeenCalled();
		expect(terminalFocus).toHaveBeenCalled();

		dispatchKey({ shortcutId: 'jumpToBottom' });
		expect(scrollContainer.scrollTo).toHaveBeenCalledWith({ top: 480, behavior: 'instant' });

		const groupContext = createContext({ activeGroupChatId: 'group-1' });
		const groupFocus = vi.spyOn(groupContext.groupChatInputRef.current!, 'focus');
		result.current.keyboardHandlerRef.current = groupContext;
		dispatchKey({ shortcutId: 'focusInput' });
		act(() => {
			vi.runOnlyPendingTimers();
		});
		expect(groupFocus).toHaveBeenCalled();

		const autoRunPanelContext = createContext({
			activeFocus: 'right',
			activeRightTab: 'autorun',
		});
		result.current.keyboardHandlerRef.current = autoRunPanelContext;
		dispatchKey({ shortcutId: 'toggleMarkdownMode' });
		expect(autoRunPanelContext.setChatRawTextMode).not.toHaveBeenCalled();

		const lockedBatchContext = createContext({
			activeBatchRunState: { isRunning: true, worktreeActive: false },
		});
		result.current.keyboardHandlerRef.current = lockedBatchContext;
		dispatchKey({ shortcutId: 'toggleMarkdownMode' });
		expect(lockedBatchContext.setChatRawTextMode).not.toHaveBeenCalled();
	});

	it('covers tab close variants and no-op tab management fallbacks', () => {
		const { result } = renderHook(() => useMainKeyboardHandler());
		const context = createContext();
		result.current.keyboardHandlerRef.current = context;

		context.handleCloseCurrentTab = vi.fn(() => ({ type: 'file' }));
		dispatchKey({ tabShortcutId: 'closeTab' });
		expect(context.performTabClose).not.toHaveBeenCalled();

		context.handleCloseCurrentTab = vi.fn(() => ({
			type: 'ai',
			tabId: 'draft-tab',
			hasDraft: true,
			isWizardTab: false,
		}));
		dispatchKey({ tabShortcutId: 'closeTab' });
		let confirmData = useModalStore.getState().getData('confirm');
		expect(confirmData?.message).toBe(
			'This tab has an unsent draft. Are you sure you want to close it?'
		);
		act(() => confirmData?.onConfirm());
		expect(context.performTabClose).toHaveBeenCalledWith('draft-tab');
		useModalStore.getState().closeAll();

		context.handleCloseCurrentTab = vi.fn(() => ({
			type: 'ai',
			tabId: 'regular-tab',
			hasDraft: false,
			isWizardTab: false,
		}));
		dispatchKey({ tabShortcutId: 'closeTab' });
		expect(context.performTabClose).toHaveBeenCalledWith('regular-tab');

		context.createTab = vi.fn(() => null);
		dispatchKey({ tabShortcutId: 'newTab' });
		expect(context.createTab).toHaveBeenCalled();

		const singleTab = createSession({
			aiTabs: [{ id: 'only-tab', title: 'Only', logs: [] }],
			activeTabId: 'only-tab',
		});
		const fallbackContext = createContext({
			activeSession: singleTab,
			handleCloseOtherTabs: vi.fn(),
			handleCloseTabsLeft: vi.fn(),
			handleCloseTabsRight: vi.fn(),
			reopenUnifiedClosedTab: vi.fn(() => null),
			getActiveTab: vi.fn(() => null),
		});
		result.current.keyboardHandlerRef.current = fallbackContext;
		dispatchKey({ tabShortcutId: 'closeOtherTabs' });
		dispatchKey({ tabShortcutId: 'closeTabsLeft' });
		dispatchKey({ tabShortcutId: 'closeTabsRight' });
		dispatchKey({ tabShortcutId: 'reopenClosedTab' });
		dispatchKey({ tabShortcutId: 'renameTab' });

		expect(fallbackContext.handleCloseOtherTabs).not.toHaveBeenCalled();
		expect(fallbackContext.handleCloseTabsLeft).not.toHaveBeenCalled();
		expect(fallbackContext.handleCloseTabsRight).not.toHaveBeenCalled();
		expect(fallbackContext.setSessions).not.toHaveBeenCalled();
		expect(fallbackContext.setRenameTabModalOpen).not.toHaveBeenCalled();
	});

	it('applies tab setting updates for wizard and regular thinking modes', () => {
		const { result } = renderHook(() => useMainKeyboardHandler());
		const wizardSession = createSession({
			aiTabs: [
				{
					id: 'wizard-tab',
					title: 'Wizard',
					logs: [],
					wizardState: {
						isActive: true,
						showWizardThinking: false,
						thinkingContent: 'draft thinking',
					},
				},
			],
			activeTabId: 'wizard-tab',
		});
		let updatedSessions: Session[] = [];
		const wizardContext = createContext({
			activeSession: wizardSession,
			activeSessionId: wizardSession.id,
			setSessions: vi.fn((updater: (sessions: Session[]) => Session[]) => {
				updatedSessions = updater([wizardSession]);
				return updatedSessions;
			}),
		});
		result.current.keyboardHandlerRef.current = wizardContext;
		dispatchKey({ tabShortcutId: 'toggleShowThinking' });
		expect(updatedSessions[0].aiTabs[0].wizardState).toMatchObject({
			showWizardThinking: true,
			thinkingContent: '',
		});

		const regularSession = createSession({
			aiTabs: [
				{
					id: 'regular-tab',
					title: 'Regular',
					showThinking: 'sticky',
					logs: [
						{ id: 'thinking', source: 'thinking', text: 'thinking' },
						{ id: 'tool', source: 'tool', text: 'tool' },
						{ id: 'stdout', source: 'stdout', text: 'answer' },
					],
				},
			],
			activeTabId: 'regular-tab',
		});
		const regularContext = createContext({
			activeSession: regularSession,
			activeSessionId: regularSession.id,
			setSessions: vi.fn((updater: (sessions: Session[]) => Session[]) => {
				updatedSessions = updater([regularSession]);
				return updatedSessions;
			}),
		});
		result.current.keyboardHandlerRef.current = regularContext;
		dispatchKey({ tabShortcutId: 'toggleShowThinking' });
		expect(updatedSessions[0].aiTabs[0]).toMatchObject({
			showThinking: 'off',
			logs: [{ id: 'stdout', source: 'stdout', text: 'answer' }],
		});
	});

	it('covers layer-gated allowances and keyboard navigation early returns', () => {
		const { result } = renderHook(() => useMainKeyboardHandler());

		const tabContext = createContext({
			hasOpenLayers: vi.fn(() => true),
			hasOpenModal: vi.fn(() => true),
			handleSidebarNavigation: vi.fn(() => false),
		});
		result.current.keyboardHandlerRef.current = tabContext;
		dispatchKey({ key: 'Tab' });
		expect(tabContext.handleSidebarNavigation).not.toHaveBeenCalled();

		const blockedOverlayContext = createContext({
			hasOpenLayers: vi.fn(() => true),
			hasOpenModal: vi.fn(() => false),
		});
		result.current.keyboardHandlerRef.current = blockedOverlayContext;
		dispatchKey({ shortcutId: 'newInstance', key: 'x' });
		expect(blockedOverlayContext.addNewSession).not.toHaveBeenCalled();

		const modalAllowanceContext = createContext({
			hasOpenLayers: vi.fn(() => true),
			hasOpenModal: vi.fn(() => true),
		});
		result.current.keyboardHandlerRef.current = modalAllowanceContext;
		dispatchKey({
			shortcutId: 'toggleRightPanel',
			key: 'ArrowRight',
			code: 'ArrowRight',
			altKey: true,
			metaKey: true,
		});
		dispatchKey({
			shortcutId: 'processMonitor',
			key: 'p',
			code: 'KeyP',
			altKey: true,
			metaKey: true,
		});
		dispatchKey({
			shortcutId: 'usageDashboard',
			key: 'u',
			code: 'KeyU',
			altKey: true,
			metaKey: true,
		});
		dispatchKey({ key: '=', metaKey: true });
		expect(modalAllowanceContext.setRightPanelOpen).toHaveBeenCalled();
		expect(modalAllowanceContext.setProcessMonitorOpen).toHaveBeenCalledWith(true);
		expect(modalAllowanceContext.setUsageDashboardOpen).toHaveBeenCalledWith(true);
		expect(useSettingsStore.getState().fontSize).toBe(16);

		const overlayAllowanceContext = createContext({
			hasOpenLayers: vi.fn(() => true),
			hasOpenModal: vi.fn(() => false),
		});
		result.current.keyboardHandlerRef.current = overlayAllowanceContext;
		dispatchKey({ shortcutId: 'goToHistory', key: 'h', metaKey: true, shiftKey: true });
		dispatchKey({ shortcutId: 'goToAutoRun', key: 's', metaKey: true, shiftKey: true });
		dispatchKey({
			tabShortcutId: 'tabSwitcher',
			key: 't',
			code: 'KeyT',
			altKey: true,
			metaKey: true,
		});
		dispatchKey({ shortcutId: 'toggleMode', key: 'j', metaKey: true });
		expect(overlayAllowanceContext.handleSetActiveRightTab).toHaveBeenCalledWith('history');
		expect(overlayAllowanceContext.handleSetActiveRightTab).toHaveBeenCalledWith('autorun');
		expect(overlayAllowanceContext.setTabSwitcherOpen).toHaveBeenCalledWith(true);
		expect(overlayAllowanceContext.handleOpenTerminalTab).toHaveBeenCalled();

		const enterContext = createContext({ handleEnterToActivate: vi.fn(() => true) });
		result.current.keyboardHandlerRef.current = enterContext;
		dispatchKey({ shortcutId: 'newInstance' });
		expect(enterContext.addNewSession).not.toHaveBeenCalled();

		const tabNavigationContext = createContext({ handleTabNavigation: vi.fn(() => true) });
		result.current.keyboardHandlerRef.current = tabNavigationContext;
		dispatchKey({ shortcutId: 'newInstance' });
		expect(tabNavigationContext.addNewSession).not.toHaveBeenCalled();

		const escapeContext = createContext({ handleEscapeInMain: vi.fn(() => true) });
		result.current.keyboardHandlerRef.current = escapeContext;
		dispatchKey({ shortcutId: 'newInstance' });
		expect(escapeContext.addNewSession).not.toHaveBeenCalled();
	});

	it('executes updater callbacks and guarded focus or mode paths', () => {
		const { result } = renderHook(() => useMainKeyboardHandler());
		let leftSidebarOpen = false;
		let rightPanelOpen = true;
		const setLeftSidebarOpen = vi.fn((updater: boolean | ((value: boolean) => boolean)) => {
			leftSidebarOpen = typeof updater === 'function' ? updater(leftSidebarOpen) : updater;
		});
		const setRightPanelOpen = vi.fn((updater: boolean | ((value: boolean) => boolean)) => {
			rightPanelOpen = typeof updater === 'function' ? updater(rightPanelOpen) : updater;
		});
		const context = createContext({
			sessions: [],
			leftSidebarOpen: false,
			setLeftSidebarOpen,
			setRightPanelOpen,
		});
		result.current.keyboardHandlerRef.current = context;

		dispatchKey({ shortcutId: 'toggleSidebar' });
		dispatchKey({ shortcutId: 'toggleRightPanel' });
		expect(leftSidebarOpen).toBe(true);
		expect(rightPanelOpen).toBe(false);

		const wizardSession = createSession({
			aiTabs: [
				{
					id: 'wizard-tab',
					title: 'Wizard',
					logs: [],
					wizardState: { isActive: true },
				},
			],
			activeTabId: 'wizard-tab',
		});
		const wizardContext = createContext({
			activeSession: wizardSession,
			activeSessionId: wizardSession.id,
		});
		result.current.keyboardHandlerRef.current = wizardContext;
		dispatchKey({ shortcutId: 'toggleMode' });
		expect(wizardContext.toggleInputMode).not.toHaveBeenCalled();

		const collapsedSidebarContext = createContext({ leftSidebarOpen: false });
		result.current.keyboardHandlerRef.current = collapsedSidebarContext;
		dispatchKey({ shortcutId: 'focusSidebar' });
		expect(collapsedSidebarContext.setLeftSidebarOpen).toHaveBeenCalledWith(true);

		const terminalSession = createSession({ inputMode: 'terminal' });
		const terminalContext = createContext({
			activeSession: terminalSession,
			activeSessionId: terminalSession.id,
		});
		result.current.keyboardHandlerRef.current = terminalContext;
		dispatchKey({ shortcutId: 'openPromptComposer' });
		expect(terminalContext.setPromptComposerOpen).not.toHaveBeenCalled();
	});

	it('preserves non-active sessions and covers tab navigation fallbacks', () => {
		const { result } = renderHook(() => useMainKeyboardHandler());
		const otherSession = createSession({ id: 'session-other', name: 'Other' });
		const activeSession = createSession({
			aiTabs: [
				{
					id: 'tab-1',
					title: 'Main',
					logs: [],
					readOnlyMode: false,
					saveToHistory: true,
					showThinking: 'on',
				},
				{ id: 'tab-2', title: 'Second', logs: [], showThinking: 'off' },
			],
			activeTabId: 'tab-1',
		});
		let updatedSessions: Session[] = [];
		const settingsContext = createContext({
			activeSession,
			activeSessionId: activeSession.id,
			setSessions: vi.fn((updater: (sessions: Session[]) => Session[]) => {
				updatedSessions = updater([otherSession, activeSession]);
				return updatedSessions;
			}),
		});
		result.current.keyboardHandlerRef.current = settingsContext;

		dispatchKey({ tabShortcutId: 'toggleReadOnlyMode' });
		expect(updatedSessions[0]).toBe(otherSession);
		expect(updatedSessions[1].aiTabs[0].readOnlyMode).toBe(true);

		dispatchKey({ tabShortcutId: 'toggleSaveToHistory' });
		expect(updatedSessions[0]).toBe(otherSession);
		expect(updatedSessions[1].aiTabs[0].saveToHistory).toBe(false);

		dispatchKey({ tabShortcutId: 'toggleShowThinking' });
		expect(updatedSessions[0]).toBe(otherSession);
		expect(updatedSessions[1].aiTabs[0].showThinking).toBe('sticky');

		const assertNavigationFallback = (
			tabShortcutId: string,
			overrides: Partial<KeyboardHandlerContext>,
			sessions: Session[]
		) => {
			const fallbackContext = createContext({
				activeSession,
				activeSessionId: activeSession.id,
				setSessions: vi.fn((updater: (prev: Session[]) => Session[]) => updater(sessions)),
				...overrides,
			});
			result.current.keyboardHandlerRef.current = fallbackContext;
			dispatchKey({ tabShortcutId });
			expect(fallbackContext.setSessions).toHaveBeenCalled();
			return fallbackContext;
		};

		assertNavigationFallback('nextTab', { activeSessionId: 'missing-session' }, [activeSession]);
		assertNavigationFallback('nextTab', { navigateToNextUnifiedTab: vi.fn(() => null) }, [
			activeSession,
		]);
		assertNavigationFallback('prevTab', { activeSessionId: 'missing-session' }, [activeSession]);
		assertNavigationFallback('prevTab', { navigateToPrevUnifiedTab: vi.fn(() => null) }, [
			activeSession,
		]);
		assertNavigationFallback('goToTab3', { activeSessionId: 'missing-session' }, [activeSession]);
		assertNavigationFallback('goToTab3', { navigateToUnifiedTabByIndex: vi.fn(() => null) }, [
			activeSession,
		]);
		assertNavigationFallback('goToLastTab', { activeSessionId: 'missing-session' }, [
			activeSession,
		]);
		assertNavigationFallback('goToLastTab', { navigateToLastUnifiedTab: vi.fn(() => null) }, [
			activeSession,
		]);
	});

	it('tracks contextual Cmd+F and keeps number badges visible while modifiers remain held', () => {
		const { result } = renderHook(() => useMainKeyboardHandler());
		const recordShortcutUsage = vi.fn(() => ({ newLevel: null }));

		const filesContext = createContext({
			activeFocus: 'right',
			activeRightTab: 'files',
			recordShortcutUsage,
		});
		result.current.keyboardHandlerRef.current = filesContext;
		dispatchKey({ key: 'f', metaKey: true });
		expect(filesContext.setFileTreeFilterOpen).toHaveBeenCalledWith(true);

		const sidebarContext = createContext({ activeFocus: 'sidebar', recordShortcutUsage });
		result.current.keyboardHandlerRef.current = sidebarContext;
		dispatchKey({ key: 'f', metaKey: true });

		const historyContext = createContext({
			activeFocus: 'right',
			activeRightTab: 'history',
			recordShortcutUsage,
		});
		result.current.keyboardHandlerRef.current = historyContext;
		dispatchKey({ key: 'f', metaKey: true });

		const mainContext = createContext({ activeFocus: 'main', recordShortcutUsage });
		result.current.keyboardHandlerRef.current = mainContext;
		dispatchKey({ key: 'f', metaKey: true });

		expect(recordShortcutUsage).toHaveBeenCalledWith('filterFiles');
		expect(recordShortcutUsage).toHaveBeenCalledWith('filterSessions');
		expect(recordShortcutUsage).toHaveBeenCalledWith('filterHistory');
		expect(recordShortcutUsage).toHaveBeenCalledWith('searchOutput');

		act(() => {
			window.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Meta',
					altKey: true,
					metaKey: true,
					bubbles: true,
				})
			);
		});
		expect(result.current.showSessionJumpNumbers).toBe(true);

		act(() => {
			window.dispatchEvent(
				new KeyboardEvent('keyup', {
					key: 'Alt',
					altKey: true,
					metaKey: true,
					bubbles: true,
				})
			);
		});
		expect(result.current.showSessionJumpNumbers).toBe(true);

		act(() => {
			window.dispatchEvent(
				new KeyboardEvent('keyup', {
					key: 'Alt',
					altKey: false,
					metaKey: true,
					bubbles: true,
				})
			);
		});
		expect(result.current.showSessionJumpNumbers).toBe(false);
	});

	it('covers branch-only shortcut fallbacks and alternate modifier combinations', () => {
		const { result } = renderHook(() => useMainKeyboardHandler());

		const overlayContext = createContext({
			hasOpenLayers: vi.fn(() => true),
			hasOpenModal: vi.fn(() => false),
		});
		result.current.keyboardHandlerRef.current = overlayContext;
		dispatchKey({
			shortcutId: 'toggleSidebar',
			key: 'ArrowLeft',
			code: 'ArrowLeft',
			altKey: true,
			ctrlKey: true,
		});
		dispatchKey({ shortcutId: 'systemLogs', key: 'l', code: 'KeyL', altKey: true, ctrlKey: true });
		overlayContext.handleCloseCurrentTab = vi.fn(() => ({ type: 'none' }));
		dispatchKey({ tabShortcutId: 'closeTab', key: 'w', metaKey: true });
		dispatchKey({ tabShortcutId: 'reopenClosedTab', key: 't', metaKey: true, shiftKey: true });
		dispatchKey({
			tabShortcutId: 'tabSwitcher',
			key: 't',
			code: 'KeyT',
			altKey: true,
			ctrlKey: true,
		});
		expect(overlayContext.setLeftSidebarOpen).toHaveBeenCalled();
		expect(overlayContext.setLogViewerOpen).toHaveBeenCalledWith(true);
		expect(overlayContext.handleCloseCurrentTab).toHaveBeenCalled();
		expect(overlayContext.reopenUnifiedClosedTab).toHaveBeenCalled();
		expect(overlayContext.setTabSwitcherOpen).toHaveBeenCalledWith(true);

		const noCodeLayerContext = createContext({
			hasOpenLayers: vi.fn(() => true),
			hasOpenModal: vi.fn(() => true),
		});
		result.current.keyboardHandlerRef.current = noCodeLayerContext;
		dispatchKey({ key: '1', altKey: true, metaKey: true });
		expect(noCodeLayerContext.setActiveSessionId).not.toHaveBeenCalled();

		const noTrackerContext = createContext({ recordShortcutUsage: undefined });
		result.current.keyboardHandlerRef.current = noTrackerContext;
		dispatchKey({ shortcutId: 'help' });
		expect(noTrackerContext.setShortcutsHelpOpen).toHaveBeenCalledWith(true);

		const noActiveContext = createContext({
			activeGroupChatId: null,
			activeSession: null,
			activeSessionId: null,
		});
		result.current.keyboardHandlerRef.current = noActiveContext;
		dispatchKey({ shortcutId: 'killInstance' });
		dispatchKey({ shortcutId: 'moveToGroup' });
		expect(noActiveContext.deleteSession).not.toHaveBeenCalled();
		expect(noActiveContext.setQuickActionOpen).not.toHaveBeenCalled();

		const nonRepoSession = createSession({ isGitRepo: false });
		const nonRepoContext = createContext({
			activeSession: nonRepoSession,
			activeSessionId: nonRepoSession.id,
		});
		result.current.keyboardHandlerRef.current = nonRepoContext;
		dispatchKey({ shortcutId: 'viewGitLog' });
		expect(nonRepoContext.setGitLogOpen).not.toHaveBeenCalled();

		const detachedLogsEnd = document.createElement('div');
		const noScrollContext = createContext({ logsEndRef: { current: detachedLogsEnd } });
		result.current.keyboardHandlerRef.current = noScrollContext;
		expect(() => dispatchKey({ shortcutId: 'jumpToBottom' })).not.toThrow();

		const digitZeroSessions = Array.from({ length: 10 }, (_, index) =>
			createSession({ id: `session-${index + 1}`, name: `Session ${index + 1}` })
		);
		const digitContext = createContext({
			visibleSessions: digitZeroSessions,
			leftSidebarOpen: true,
		});
		result.current.keyboardHandlerRef.current = digitContext;
		dispatchKey({ key: '0', code: 'Digit0', altKey: true, ctrlKey: true });
		expect(digitContext.setActiveSessionId).toHaveBeenCalledWith('session-10');
		expect(digitContext.setLeftSidebarOpen).not.toHaveBeenCalled();
		const outOfRangeDigitContext = createContext({
			visibleSessions: [createSession()],
		});
		result.current.keyboardHandlerRef.current = outOfRangeDigitContext;
		dispatchKey({ key: '9', code: 'Digit9', altKey: true, metaKey: true });
		expect(outOfRangeDigitContext.setActiveSessionId).not.toHaveBeenCalled();

		useSettingsStore.setState({ fontSize: 24 });
		dispatchKey({ key: '=', metaKey: true });
		expect(useSettingsStore.getState().fontSize).toBe(24);
		useSettingsStore.setState({ fontSize: 10 });
		dispatchKey({ key: '-', metaKey: true });
		expect(useSettingsStore.getState().fontSize).toBe(10);
		useSettingsStore.setState({ fontSize: 14 });
		dispatchKey({ shortcutId: 'fontSizeReset' });
		expect(useSettingsStore.getState().fontSize).toBe(14);

		const otherSession = createSession({ id: 'session-other', name: 'Other' });
		const activeSession = createSession();
		let updatedSessions: Session[] = [];
		const tabContext = createContext({
			activeSession,
			activeSessionId: activeSession.id,
			setSessions: vi.fn((updater: (sessions: Session[]) => Session[]) => {
				updatedSessions = updater([otherSession, activeSession]);
				return updatedSessions;
			}),
		});
		result.current.keyboardHandlerRef.current = tabContext;
		dispatchKey({ tabShortcutId: 'newTab' });
		expect(updatedSessions[0]).toBe(otherSession);
		tabContext.handleCloseCurrentTab = vi.fn(() => ({ type: 'none' }));
		dispatchKey({ tabShortcutId: 'closeTab' });
		expect(tabContext.performTabClose).not.toHaveBeenCalled();
		dispatchKey({ tabShortcutId: 'reopenClosedTab' });
		expect(updatedSessions[0]).toBe(otherSession);
		dispatchKey({ tabShortcutId: 'nextTab' });
		expect(updatedSessions[0]).toBe(otherSession);
		dispatchKey({ tabShortcutId: 'prevTab' });
		expect(updatedSessions[0]).toBe(otherSession);
		dispatchKey({ tabShortcutId: 'goToTab1' });
		expect(updatedSessions[0]).toBe(otherSession);
		dispatchKey({ tabShortcutId: 'goToLastTab' });
		expect(updatedSessions[0]).toBe(otherSession);

		const wizardSession = createSession({
			aiTabs: [
				{
					id: 'wizard-tab',
					title: 'Wizard',
					logs: [],
					wizardState: {
						isActive: true,
						showWizardThinking: true,
						thinkingContent: 'kept thinking',
					},
				},
			],
			activeTabId: 'wizard-tab',
		});
		const wizardContext = createContext({
			activeSession: wizardSession,
			activeSessionId: wizardSession.id,
			setSessions: vi.fn((updater: (sessions: Session[]) => Session[]) => {
				updatedSessions = updater([wizardSession]);
				return updatedSessions;
			}),
		});
		result.current.keyboardHandlerRef.current = wizardContext;
		dispatchKey({ tabShortcutId: 'toggleShowThinking' });
		expect(updatedSessions[0].aiTabs[0].wizardState?.thinkingContent).toBe('kept thinking');

		const unreadOnlyContext = createContext({ showUnreadOnly: true });
		result.current.keyboardHandlerRef.current = unreadOnlyContext;
		dispatchKey({ tabShortcutId: 'goToTab1' });
		dispatchKey({ tabShortcutId: 'goToLastTab' });
		expect(unreadOnlyContext.navigateToUnifiedTabByIndex).toHaveBeenCalledWith(
			unreadOnlyContext.activeSession,
			0,
			true
		);
		expect(unreadOnlyContext.navigateToLastUnifiedTab).toHaveBeenCalledWith(
			unreadOnlyContext.activeSession,
			true
		);

		const unmatchedSearchContext = createContext({
			activeFocus: 'right',
			activeRightTab: 'autorun',
		});
		result.current.keyboardHandlerRef.current = unmatchedSearchContext;
		dispatchKey({ key: 'f', ctrlKey: true });
		expect(unmatchedSearchContext.setFileTreeFilterOpen).not.toHaveBeenCalled();

		act(() => {
			window.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Control',
					altKey: true,
					ctrlKey: true,
					bubbles: true,
				})
			);
			window.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Control',
					altKey: true,
					ctrlKey: true,
					bubbles: true,
				})
			);
		});
		expect(result.current.showSessionJumpNumbers).toBe(true);
	});
});
