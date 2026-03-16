import React, { memo, useState, useEffect, useRef, useCallback } from 'react';
import { Search } from 'lucide-react';
import type { Session, Group, Theme, Shortcut, RightPanelTab, SettingsTab } from '../types';
import type { GroupChat } from '../../shared/group-chat-types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { notifyToast } from '../stores/notificationStore';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { gitService } from '../services/git';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { safeClipboardWrite } from '../utils/clipboard';
import type { WizardStep } from './Wizard/WizardContext';
import { useListNavigation } from '../hooks';
import { useUIStore } from '../stores/uiStore';
import { useFileExplorerStore } from '../stores/fileExplorerStore';
import { useTranslation } from 'react-i18next';

interface QuickAction {
	id: string;
	label: string;
	action: () => void;
	subtext?: string;
	shortcut?: Shortcut;
}

interface QuickActionsModalProps {
	theme: Theme;
	sessions: Session[];
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	activeSessionId: string;
	groups: Group[];
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
	shortcuts: Record<string, Shortcut>;
	initialMode?: 'main' | 'move-to-group';
	setQuickActionOpen: (open: boolean) => void;
	setActiveSessionId: (id: string) => void;
	setRenameInstanceModalOpen: (open: boolean) => void;
	setRenameInstanceValue: (value: string) => void;
	setRenameGroupModalOpen: (open: boolean) => void;
	setRenameGroupId: (id: string) => void;
	setRenameGroupValue: (value: string) => void;
	setRenameGroupEmoji: (emoji: string) => void;
	setCreateGroupModalOpen: (open: boolean) => void;
	setLeftSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	setRightPanelOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
	setActiveRightTab: (tab: RightPanelTab) => void;
	toggleInputMode: () => void;
	deleteSession: (id: string) => void;
	addNewSession: () => void;
	setSettingsModalOpen: (open: boolean) => void;
	setSettingsTab: (tab: SettingsTab) => void;
	setShortcutsHelpOpen: (open: boolean) => void;
	setAboutModalOpen: (open: boolean) => void;
	setLogViewerOpen: (open: boolean) => void;
	setProcessMonitorOpen: (open: boolean) => void;
	setUsageDashboardOpen: (open: boolean) => void;
	setAgentSessionsOpen: (open: boolean) => void;
	setActiveAgentSessionId: (id: string | null) => void;
	setGitDiffPreview: (diff: string | null) => void;
	setGitLogOpen: (open: boolean) => void;
	onRenameTab?: () => void;
	onToggleReadOnlyMode?: () => void;
	onToggleTabShowThinking?: () => void;
	onOpenTabSwitcher?: () => void;
	tabShortcuts?: Record<string, Shortcut>;
	isAiMode?: boolean;
	setPlaygroundOpen?: (open: boolean) => void;
	onRefreshGitFileState?: () => Promise<void>;
	onDebugReleaseQueuedItem?: () => void;
	markdownEditMode?: boolean;
	onToggleMarkdownEditMode?: () => void;
	setUpdateCheckModalOpen?: (open: boolean) => void;
	openWizard?: () => void;
	wizardGoToStep?: (step: WizardStep) => void;
	setDebugWizardModalOpen?: (open: boolean) => void;
	setDebugPackageModalOpen?: (open: boolean) => void;
	startTour?: () => void;
	setFuzzyFileSearchOpen?: (open: boolean) => void;
	onEditAgent?: (session: Session) => void;
	// Group Chat
	groupChats?: GroupChat[];
	onNewGroupChat?: () => void;
	onOpenGroupChat?: (id: string) => void;
	onCloseGroupChat?: () => void;
	onDeleteGroupChat?: (id: string) => void;
	activeGroupChatId?: string | null;
	hasActiveSessionCapability?: (
		capability: 'supportsSessionStorage' | 'supportsSlashCommands' | 'supportsContextMerge'
	) => boolean;
	// Merge session
	onOpenMergeSession?: () => void;
	// Send to agent
	onOpenSendToAgent?: () => void;
	// Remote control
	onToggleRemoteControl?: () => void;
	// Worktree PR creation
	onOpenCreatePR?: (session: Session) => void;
	// Summarize and continue
	onSummarizeAndContinue?: () => void;
	canSummarizeActiveTab?: boolean;
	// Auto Run reset tasks
	autoRunSelectedDocument?: string | null;
	autoRunCompletedTaskCount?: number;
	onAutoRunResetTasks?: () => void;
	// Tab close operations
	onCloseAllTabs?: () => void;
	onCloseOtherTabs?: () => void;
	onCloseTabsLeft?: () => void;
	onCloseTabsRight?: () => void;
	// Gist publishing
	isFilePreviewOpen?: boolean;
	ghCliAvailable?: boolean;
	onPublishGist?: () => void;
	// Playbook Exchange
	onOpenPlaybookExchange?: () => void;
	// Document Graph - quick re-open last graph
	lastGraphFocusFile?: string;
	onOpenLastDocumentGraph?: () => void;
	// Symphony
	onOpenSymphony?: () => void;
	// Director's Notes
	onOpenDirectorNotes?: () => void;
	// Auto-scroll
	autoScrollAiMode?: boolean;
	setAutoScrollAiMode?: (value: boolean) => void;
}

export const QuickActionsModal = memo(function QuickActionsModal(props: QuickActionsModalProps) {
	const {
		theme,
		sessions,
		setSessions,
		activeSessionId,
		groups,
		setGroups,
		shortcuts,
		initialMode = 'main',
		setQuickActionOpen,
		setActiveSessionId,
		setRenameInstanceModalOpen,
		setRenameInstanceValue,
		setRenameGroupModalOpen,
		setRenameGroupId,
		setRenameGroupValue,
		setRenameGroupEmoji,
		setCreateGroupModalOpen,
		setLeftSidebarOpen,
		setRightPanelOpen,
		setActiveRightTab,
		toggleInputMode,
		deleteSession,
		addNewSession,
		setSettingsModalOpen,
		setSettingsTab,
		setShortcutsHelpOpen,
		setAboutModalOpen,
		setLogViewerOpen,
		setProcessMonitorOpen,
		setUsageDashboardOpen,
		setAgentSessionsOpen,
		setActiveAgentSessionId,
		setGitDiffPreview,
		setGitLogOpen,
		onRenameTab,
		onToggleReadOnlyMode,
		onToggleTabShowThinking,
		onOpenTabSwitcher,
		tabShortcuts,
		isAiMode,
		setPlaygroundOpen,
		onRefreshGitFileState,
		onDebugReleaseQueuedItem,
		markdownEditMode,
		onToggleMarkdownEditMode,
		setUpdateCheckModalOpen,
		openWizard,
		wizardGoToStep: _wizardGoToStep,
		setDebugWizardModalOpen,
		setDebugPackageModalOpen,
		startTour,
		setFuzzyFileSearchOpen,
		onEditAgent,
		groupChats,
		onNewGroupChat,
		onOpenGroupChat,
		onCloseGroupChat,
		onDeleteGroupChat,
		activeGroupChatId,
		hasActiveSessionCapability,
		onOpenMergeSession,
		onOpenSendToAgent,
		onOpenCreatePR,
		onSummarizeAndContinue,
		canSummarizeActiveTab,
		autoRunSelectedDocument,
		autoRunCompletedTaskCount,
		onAutoRunResetTasks,
		onCloseAllTabs,
		onCloseOtherTabs,
		onCloseTabsLeft,
		onCloseTabsRight,
		isFilePreviewOpen,
		ghCliAvailable,
		onPublishGist,
		onOpenPlaybookExchange,
		lastGraphFocusFile,
		onOpenLastDocumentGraph,
		onOpenSymphony,
		onOpenDirectorNotes,
		autoScrollAiMode,
		setAutoScrollAiMode,
	} = props;

	const { t: _t, i18n } = useTranslation(['menus', 'common']);
	const { t: tA } = useTranslation('accessibility');

	// Dual-index search: wrap t() to build a map of translated → English labels.
	// When the UI is non-English, users can search commands in either language.
	const englishLabelMap = new Map<string, string>();
	const t = (key: string, opts?: Record<string, unknown>): string => {
		const translated = _t(key, opts as any) as string;
		if (i18n.language !== 'en') {
			const english = _t(key, { ...opts, lng: 'en' } as any) as string;
			if (translated !== english) {
				englishLabelMap.set(translated, english);
			}
		}
		return translated;
	};

	// UI store actions for search commands (avoid threading more props through 3-layer chain)
	const setActiveFocus = useUIStore((s) => s.setActiveFocus);
	const storeSetSessionFilterOpen = useUIStore((s) => s.setSessionFilterOpen);
	const storeSetOutputSearchOpen = useUIStore((s) => s.setOutputSearchOpen);
	const storeSetFileTreeFilterOpen = useFileExplorerStore((s) => s.setFileTreeFilterOpen);
	const storeSetHistorySearchFilterOpen = useUIStore((s) => s.setHistorySearchFilterOpen);

	const [search, setSearch] = useState('');
	const [mode, setMode] = useState<'main' | 'move-to-group'>(initialMode);
	const [renamingSession, setRenamingSession] = useState(false);
	const [renameValue, setRenameValue] = useState('');
	const [firstVisibleIndex, setFirstVisibleIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const selectedItemRef = useRef<HTMLButtonElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const layerIdRef = useRef<string>();
	const modalRef = useRef<HTMLDivElement>(null);

	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const activeSession = sessions.find((s) => s.id === activeSessionId);

	// Register layer on mount (handler will be updated by separate effect)
	useEffect(() => {
		layerIdRef.current = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.QUICK_ACTION,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'Quick Actions',
			onEscape: () => setQuickActionOpen(false), // Initial handler, updated below
		});

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [registerLayer, unregisterLayer, setQuickActionOpen]);

	// Update handler when mode changes - use a ref-based approach to avoid stale closure
	const handleEscapeRef = useRef<() => void>(() => setQuickActionOpen(false));
	useEffect(() => {
		handleEscapeRef.current = () => {
			// Handle escape based on current mode
			if (mode === 'move-to-group') {
				setMode('main');
				// Note: Selection will be reset by the search/mode change useEffect
			} else {
				setQuickActionOpen(false);
			}
		};
	}, [mode, setQuickActionOpen]);

	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, () => handleEscapeRef.current());
		}
	}, [updateLayerHandler]);

	// Focus input on mount
	useEffect(() => {
		// Small delay to ensure DOM is ready and layer is registered
		const timer = setTimeout(() => inputRef.current?.focus(), 50);
		return () => clearTimeout(timer);
	}, []);

	// Track scroll position to determine which items are visible
	const handleScroll = () => {
		if (scrollContainerRef.current) {
			const scrollTop = scrollContainerRef.current.scrollTop;
			const itemHeight = 52; // Approximate height of each item (py-3 = 12px top + 12px bottom + content)
			const visibleIndex = Math.floor(scrollTop / itemHeight);
			setFirstVisibleIndex(visibleIndex);
		}
	};

	const handleRenameSession = () => {
		if (renameValue.trim()) {
			const updatedSessions = sessions.map((s) =>
				s.id === activeSessionId ? { ...s, name: renameValue.trim() } : s
			);
			setSessions(updatedSessions);
			setQuickActionOpen(false);
		}
	};

	const handleMoveToGroup = (groupId: string) => {
		const updatedSessions = sessions.map((s) => (s.id === activeSessionId ? { ...s, groupId } : s));
		setSessions(updatedSessions);
		setQuickActionOpen(false);
	};

	const handleCreateGroup = () => {
		setCreateGroupModalOpen(true);
		setQuickActionOpen(false);
	};

	const sessionActions: QuickAction[] = sessions.map((s) => {
		// For worktree subagents, format as "Jump to $PARENT subagent: $NAME"
		let label: string;
		if (s.parentSessionId) {
			const parentSession = sessions.find((p) => p.id === s.parentSessionId);
			const parentName = parentSession?.name || 'Unknown';
			label = t('commands.jump_to_subagent', { parent: parentName, name: s.name });
		} else {
			label = t('commands.jump_to', { name: s.name });
		}

		return {
			id: `jump-${s.id}`,
			label,
			action: () => {
				setActiveSessionId(s.id);
				// Auto-expand group if it's collapsed
				if (s.groupId) {
					setGroups((prev) =>
						prev.map((g) => (g.id === s.groupId && g.collapsed ? { ...g, collapsed: false } : g))
					);
				}
			},
			subtext: s.state.toUpperCase(),
		};
	});

	// Group chat jump actions
	const groupChatActions: QuickAction[] =
		groupChats && onOpenGroupChat
			? groupChats.map((gc) => ({
					id: `groupchat-${gc.id}`,
					label: t('commands.group_chat_name', { name: gc.name }),
					action: () => {
						onOpenGroupChat(gc.id);
						setQuickActionOpen(false);
					},
					subtext: t('commands.participants', { count: gc.participants.length }),
				}))
			: [];

	const mainActions: QuickAction[] = [
		...sessionActions,
		...groupChatActions,
		{
			id: 'new',
			label: t('commands.create_new_agent'),
			shortcut: shortcuts.newInstance,
			action: addNewSession,
		},
		...(openWizard
			? [
					{
						id: 'wizard',
						label: t('commands.new_agent_wizard'),
						shortcut: shortcuts.openWizard,
						action: () => {
							openWizard();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession
			? [
					{
						id: 'rename',
						label: t('commands.rename_agent', { name: activeSession.name }),
						action: () => {
							setRenameInstanceValue(activeSession.name);
							setRenameInstanceModalOpen(true);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession && onEditAgent
			? [
					{
						id: 'editAgent',
						label: t('commands.edit_agent', { name: activeSession.name }),
						shortcut: shortcuts.agentSettings,
						action: () => {
							onEditAgent(activeSession);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession
			? [
					{
						id: 'toggleBookmark',
						label: activeSession.bookmarked
							? t('commands.unbookmark', { name: activeSession.name })
							: t('commands.bookmark', { name: activeSession.name }),
						action: () => {
							setSessions((prev) =>
								prev.map((s) =>
									s.id === activeSessionId ? { ...s, bookmarked: !s.bookmarked } : s
								)
							);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession?.groupId
			? [
					{
						id: 'renameGroup',
						label: t('commands.rename_group'),
						action: () => {
							const group = groups.find((g) => g.id === activeSession.groupId);
							if (group) {
								setRenameGroupId(group.id);
								setRenameGroupValue(group.name);
								setRenameGroupEmoji(group.emoji);
								setRenameGroupModalOpen(true);
								setQuickActionOpen(false);
							}
						},
					},
				]
			: []),
		...(activeSession
			? [
					{
						id: 'moveToGroup',
						label: t('commands.move_to_group'),
						action: () => {
							setMode('move-to-group');
							setSelectedIndex(0);
						},
					},
				]
			: []),
		{ id: 'createGroup', label: t('commands.create_new_group'), action: handleCreateGroup },
		{
			id: 'toggleSidebar',
			label: t('commands.toggle_sidebar'),
			shortcut: shortcuts.toggleSidebar,
			action: () => setLeftSidebarOpen((p) => !p),
		},
		{
			id: 'toggleRight',
			label: t('commands.toggle_right_panel'),
			shortcut: shortcuts.toggleRightPanel,
			action: () => setRightPanelOpen((p) => !p),
		},
		...(activeSession
			? [
					{
						id: 'switchMode',
						label: t('commands.switch_mode'),
						shortcut: shortcuts.toggleMode,
						action: toggleInputMode,
					},
				]
			: []),
		...(isAiMode && onOpenTabSwitcher
			? [
					{
						id: 'tabSwitcher',
						label: t('commands.tab_switcher'),
						shortcut: tabShortcuts?.tabSwitcher,
						action: () => {
							onOpenTabSwitcher();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(isAiMode && onRenameTab
			? [
					{
						id: 'renameTab',
						label: t('commands.rename_tab'),
						shortcut: tabShortcuts?.renameTab,
						action: () => {
							onRenameTab();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(isAiMode && onToggleReadOnlyMode
			? [
					{
						id: 'toggleReadOnly',
						label: t('commands.toggle_read_only'),
						shortcut: tabShortcuts?.toggleReadOnlyMode,
						action: () => {
							onToggleReadOnlyMode();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(isAiMode && onToggleTabShowThinking
			? [
					{
						id: 'toggleShowThinking',
						label: t('commands.toggle_show_thinking'),
						shortcut: tabShortcuts?.toggleShowThinking,
						action: () => {
							onToggleTabShowThinking();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(isAiMode && onToggleMarkdownEditMode
			? [
					{
						id: 'toggleMarkdown',
						label: t('commands.toggle_edit_preview'),
						shortcut: shortcuts.toggleMarkdownMode,
						subtext: markdownEditMode
							? t('commands.currently_edit_mode')
							: t('commands.currently_preview_mode'),
						action: () => {
							onToggleMarkdownEditMode();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Tab close operations
		...(isAiMode && activeSession?.aiTabs && activeSession.aiTabs.length > 0 && onCloseAllTabs
			? [
					{
						id: 'closeAllTabs',
						label: t('commands.close_all_tabs'),
						shortcut: tabShortcuts?.closeAllTabs,
						subtext: t('commands.close_all_tabs_desc', { count: activeSession.aiTabs.length }),
						action: () => {
							onCloseAllTabs();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(isAiMode && activeSession?.aiTabs && activeSession.aiTabs.length > 1 && onCloseOtherTabs
			? [
					{
						id: 'closeOtherTabs',
						label: t('commands.close_other_tabs'),
						shortcut: tabShortcuts?.closeOtherTabs,
						subtext: t('commands.close_other_tabs_desc', {
							count: activeSession.aiTabs.length - 1,
						}),
						action: () => {
							onCloseOtherTabs();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(isAiMode &&
		activeSession &&
		(() => {
			const activeTabIndex = activeSession.aiTabs.findIndex(
				(t) => t.id === activeSession.activeTabId
			);
			return activeTabIndex > 0;
		})() &&
		onCloseTabsLeft
			? [
					{
						id: 'closeTabsLeft',
						label: t('commands.close_tabs_left'),
						shortcut: tabShortcuts?.closeTabsLeft,
						action: () => {
							onCloseTabsLeft();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(isAiMode &&
		activeSession &&
		(() => {
			const activeTabIndex = activeSession.aiTabs.findIndex(
				(t) => t.id === activeSession.activeTabId
			);
			return activeTabIndex < activeSession.aiTabs.length - 1;
		})() &&
		onCloseTabsRight
			? [
					{
						id: 'closeTabsRight',
						label: t('commands.close_tabs_right'),
						shortcut: tabShortcuts?.closeTabsRight,
						action: () => {
							onCloseTabsRight();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession
			? [
					{
						id: 'clearTerminal',
						label: t('commands.clear_terminal'),
						action: () => {
							setSessions((prev) =>
								prev.map((s) => (s.id === activeSessionId ? { ...s, shellLogs: [] } : s))
							);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession
			? [
					{
						id: 'kill',
						label: t('commands.remove_agent', { name: activeSession.name }),
						shortcut: shortcuts.killInstance,
						action: () => deleteSession(activeSessionId),
					},
				]
			: []),
		{
			id: 'settings',
			label: t('commands.settings'),
			shortcut: shortcuts.settings,
			action: () => {
				setSettingsModalOpen(true);
				setQuickActionOpen(false);
			},
		},
		{
			id: 'theme',
			label: t('commands.change_theme'),
			action: () => {
				setSettingsModalOpen(true);
				setSettingsTab('theme');
				setQuickActionOpen(false);
			},
		},
		{
			id: 'configureEnvVars',
			label: t('commands.configure_env_vars'),
			action: () => {
				setSettingsModalOpen(true);
				setSettingsTab('general');
				setQuickActionOpen(false);
			},
		},
		{
			id: 'shortcuts',
			label: t('commands.view_shortcuts'),
			shortcut: shortcuts.help,
			action: () => {
				setShortcutsHelpOpen(true);
				setQuickActionOpen(false);
			},
		},
		...(startTour
			? [
					{
						id: 'tour',
						label: t('commands.start_tour'),
						subtext: t('commands.start_tour_desc'),
						action: () => {
							startTour();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		{
			id: 'logs',
			label: t('commands.view_system_logs'),
			shortcut: shortcuts.systemLogs,
			action: () => {
				setLogViewerOpen(true);
				setQuickActionOpen(false);
			},
		},
		{
			id: 'processes',
			label: t('commands.view_system_processes'),
			shortcut: shortcuts.processMonitor,
			action: () => {
				setProcessMonitorOpen(true);
				setQuickActionOpen(false);
			},
		},
		{
			id: 'usageDashboard',
			label: t('commands.usage_dashboard'),
			shortcut: shortcuts.usageDashboard,
			action: () => {
				setUsageDashboardOpen(true);
				setQuickActionOpen(false);
			},
		},
		...(activeSession && hasActiveSessionCapability?.('supportsSessionStorage')
			? [
					{
						id: 'agentSessions',
						label: t('commands.view_agent_sessions', { name: activeSession.name }),
						shortcut: shortcuts.agentSessions,
						action: () => {
							setActiveAgentSessionId(null);
							setAgentSessionsOpen(true);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(isAiMode && canSummarizeActiveTab && onSummarizeAndContinue
			? [
					{
						id: 'summarizeAndContinue',
						label: t('commands.context_compact'),
						shortcut: tabShortcuts?.summarizeAndContinue,
						subtext: t('commands.context_compact_desc'),
						action: () => {
							onSummarizeAndContinue();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession && hasActiveSessionCapability?.('supportsContextMerge') && onOpenMergeSession
			? [
					{
						id: 'mergeSession',
						label: t('commands.context_merge'),
						shortcut: shortcuts.mergeSession,
						subtext: t('commands.context_merge_desc'),
						action: () => {
							onOpenMergeSession();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession && hasActiveSessionCapability?.('supportsContextMerge') && onOpenSendToAgent
			? [
					{
						id: 'sendToAgent',
						label: t('commands.context_send'),
						shortcut: shortcuts.sendToAgent,
						subtext: t('commands.context_send_desc'),
						action: () => {
							onOpenSendToAgent();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession?.isGitRepo
			? [
					{
						id: 'gitDiff',
						label: t('commands.view_git_diff'),
						shortcut: shortcuts.viewGitDiff,
						action: async () => {
							const cwd =
								activeSession.inputMode === 'terminal'
									? activeSession.shellCwd || activeSession.cwd
									: activeSession.cwd;
							const sshRemoteId =
								activeSession.sshRemoteId ||
								(activeSession.sessionSshRemoteConfig?.enabled
									? activeSession.sessionSshRemoteConfig.remoteId
									: undefined) ||
								undefined;
							const diff = await gitService.getDiff(cwd, undefined, sshRemoteId);
							if (diff.diff) {
								setGitDiffPreview(diff.diff);
							}
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession?.isGitRepo
			? [
					{
						id: 'gitLog',
						label: t('commands.view_git_log'),
						shortcut: shortcuts.viewGitLog,
						action: () => {
							setGitLogOpen(true);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession?.isGitRepo
			? [
					{
						id: 'openRepo',
						label: t('commands.open_repo_browser'),
						action: async () => {
							const cwd =
								activeSession.inputMode === 'terminal'
									? activeSession.shellCwd || activeSession.cwd
									: activeSession.cwd;
							try {
								const browserUrl = await gitService.getRemoteBrowserUrl(cwd);
								if (browserUrl) {
									await window.maestro.shell.openExternal(browserUrl);
								} else {
									notifyToast({
										type: 'error',
										title: t('commands.no_remote_url'),
										message: t('commands.no_remote_url_desc'),
									});
								}
							} catch (error) {
								console.error('Failed to open repository in browser:', error);
								notifyToast({
									type: 'error',
									title: t('common:error'),
									message: error instanceof Error ? error.message : t('commands.failed_open_repo'),
								});
							}
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Create PR - only for worktree child sessions
		...(activeSession &&
		activeSession.parentSessionId &&
		activeSession.worktreeBranch &&
		onOpenCreatePR
			? [
					{
						id: 'createPR',
						label: t('commands.create_pr', { branch: activeSession.worktreeBranch }),
						subtext: t('commands.create_pr_desc'),
						action: () => {
							onOpenCreatePR(activeSession);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession && onRefreshGitFileState
			? [
					{
						id: 'refreshGitFileState',
						label: t('commands.refresh_files'),
						subtext: t('commands.refresh_files_desc'),
						action: async () => {
							await onRefreshGitFileState();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		{
			id: 'devtools',
			label: t('commands.toggle_devtools'),
			action: () => {
				window.maestro.devtools.toggle();
				setQuickActionOpen(false);
			},
		},
		{
			id: 'about',
			label: t('commands.about_maestro'),
			action: () => {
				setAboutModalOpen(true);
				setQuickActionOpen(false);
			},
		},
		{
			id: 'website',
			label: t('commands.maestro_website'),
			subtext: t('commands.maestro_website_desc'),
			action: () => {
				window.maestro.shell.openExternal('https://runmaestro.ai/');
				setQuickActionOpen(false);
			},
		},
		{
			id: 'docs',
			label: t('commands.documentation'),
			subtext: t('commands.documentation_desc'),
			action: () => {
				window.maestro.shell.openExternal('https://docs.runmaestro.ai/');
				setQuickActionOpen(false);
			},
		},
		{
			id: 'discord',
			label: t('commands.join_discord'),
			subtext: t('commands.join_discord_desc'),
			action: () => {
				window.maestro.shell.openExternal('https://runmaestro.ai/discord');
				setQuickActionOpen(false);
			},
		},
		...(setUpdateCheckModalOpen
			? [
					{
						id: 'updateCheck',
						label: t('commands.check_updates'),
						action: () => {
							setUpdateCheckModalOpen(true);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		{
			id: 'createDebugPackage',
			label: t('commands.create_debug_package'),
			subtext: t('commands.create_debug_package_desc'),
			action: () => {
				setQuickActionOpen(false);
				if (setDebugPackageModalOpen) {
					setDebugPackageModalOpen(true);
				} else {
					// Fallback to direct API call if modal not available
					notifyToast({
						type: 'info',
						title: t('commands.debug_package'),
						message: t('commands.debug_package_creating'),
					});
					window.maestro.debug
						.createPackage()
						.then((result) => {
							if (result.success && result.path) {
								notifyToast({
									type: 'success',
									title: t('commands.debug_package_created'),
									message: t('commands.debug_package_saved', { path: result.path }),
								});
							} else if (result.error !== 'Cancelled by user') {
								notifyToast({
									type: 'error',
									title: t('commands.debug_package_failed'),
									message: result.error || t('commands.unknown_error'),
								});
							}
						})
						.catch((error) => {
							notifyToast({
								type: 'error',
								title: t('commands.debug_package_failed'),
								message: error instanceof Error ? error.message : t('commands.unknown_error'),
							});
						});
				}
			},
		},
		{
			id: 'goToFiles',
			label: t('commands.go_to_files'),
			shortcut: shortcuts.goToFiles,
			action: () => {
				setRightPanelOpen(true);
				setActiveRightTab('files');
				setQuickActionOpen(false);
			},
		},
		{
			id: 'goToHistory',
			label: t('commands.go_to_history'),
			shortcut: shortcuts.goToHistory,
			action: () => {
				setRightPanelOpen(true);
				setActiveRightTab('history');
				setQuickActionOpen(false);
			},
		},
		{
			id: 'goToAutoRun',
			label: t('commands.go_to_autorun'),
			shortcut: shortcuts.goToAutoRun,
			action: () => {
				setRightPanelOpen(true);
				setActiveRightTab('autorun');
				setQuickActionOpen(false);
			},
		},
		// Playbook Exchange - browse and import community playbooks
		...(onOpenPlaybookExchange
			? [
					{
						id: 'openPlaybookExchange',
						label: t('commands.playbook_exchange'),
						subtext: t('commands.playbook_exchange_desc'),
						action: () => {
							onOpenPlaybookExchange();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Symphony - contribute to open source projects
		...(onOpenSymphony
			? [
					{
						id: 'openSymphony',
						label: t('commands.symphony'),
						shortcut: shortcuts.openSymphony,
						subtext: t('commands.symphony_desc'),
						action: () => {
							onOpenSymphony();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Director's Notes - unified history and AI synopsis
		...(onOpenDirectorNotes
			? [
					{
						id: 'directorNotes',
						label: t('commands.director_notes'),
						shortcut: shortcuts.directorNotes,
						subtext: t('commands.director_notes_desc'),
						action: () => {
							onOpenDirectorNotes();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Auto-scroll toggle
		...(setAutoScrollAiMode
			? [
					{
						id: 'toggleAutoScroll',
						label: autoScrollAiMode
							? t('commands.disable_auto_scroll')
							: t('commands.enable_auto_scroll'),
						shortcut: shortcuts.toggleAutoScroll,
						action: () => {
							setAutoScrollAiMode(!autoScrollAiMode);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Last Document Graph - quick re-open (only when a graph has been opened before)
		...(lastGraphFocusFile && onOpenLastDocumentGraph
			? [
					{
						id: 'lastDocumentGraph',
						label: t('commands.open_last_graph'),
						subtext: t('commands.open_last_graph_desc', { file: lastGraphFocusFile }),
						action: () => {
							onOpenLastDocumentGraph();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Auto Run reset tasks - only show when there are completed tasks in the selected document
		...(autoRunSelectedDocument &&
		autoRunCompletedTaskCount &&
		autoRunCompletedTaskCount > 0 &&
		onAutoRunResetTasks
			? [
					{
						id: 'resetAutoRunTasks',
						label: t('commands.reset_auto_run_tasks', { document: autoRunSelectedDocument }),
						subtext: t('commands.reset_auto_run_tasks_desc', { count: autoRunCompletedTaskCount }),
						action: () => {
							onAutoRunResetTasks();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(setFuzzyFileSearchOpen
			? [
					{
						id: 'fuzzyFileSearch',
						label: t('commands.fuzzy_file_search'),
						shortcut: shortcuts.fuzzyFileSearch,
						action: () => {
							setFuzzyFileSearchOpen(true);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Search actions - focus search inputs in various panels
		{
			id: 'searchAgents',
			label: t('commands.search_agents'),
			subtext: t('commands.search_agents_desc'),
			action: () => {
				setQuickActionOpen(false);
				setLeftSidebarOpen(true);
				setActiveFocus('sidebar');
				setTimeout(() => storeSetSessionFilterOpen(true), 50);
			},
		},
		{
			id: 'searchMessages',
			label: t('commands.search_messages'),
			subtext: t('commands.search_messages_desc'),
			action: () => {
				setQuickActionOpen(false);
				setActiveFocus('main');
				setTimeout(() => storeSetOutputSearchOpen(true), 50);
			},
		},
		{
			id: 'searchFiles',
			label: t('commands.search_files'),
			subtext: t('commands.search_files_desc'),
			action: () => {
				setQuickActionOpen(false);
				setRightPanelOpen(true);
				setActiveRightTab('files');
				setActiveFocus('right');
				setTimeout(() => storeSetFileTreeFilterOpen(true), 50);
			},
		},
		{
			id: 'searchHistory',
			label: t('commands.search_history'),
			subtext: t('commands.search_history_desc'),
			action: () => {
				setQuickActionOpen(false);
				setRightPanelOpen(true);
				setActiveRightTab('history');
				setActiveFocus('right');
				setTimeout(() => storeSetHistorySearchFilterOpen(true), 50);
			},
		},
		// Publish document as GitHub Gist - only when file preview is open, gh CLI is available, and not in edit mode
		...(isFilePreviewOpen && ghCliAvailable && onPublishGist && !markdownEditMode
			? [
					{
						id: 'publishGist',
						label: t('commands.publish_gist'),
						subtext: t('commands.publish_gist_desc'),
						action: () => {
							onPublishGist();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Group Chat commands - only show when at least 2 AI agents exist
		...(onNewGroupChat && sessions.filter((s) => s.toolType !== 'terminal').length >= 2
			? [
					{
						id: 'newGroupChat',
						label: t('commands.new_group_chat'),
						action: () => {
							onNewGroupChat();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeGroupChatId && onCloseGroupChat
			? [
					{
						id: 'closeGroupChat',
						label: t('commands.close_group_chat'),
						action: () => {
							onCloseGroupChat();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeGroupChatId && onDeleteGroupChat && groupChats
			? [
					{
						id: 'deleteGroupChat',
						label: t('commands.remove_group_chat', {
							name: groupChats.find((c) => c.id === activeGroupChatId)?.name || 'Group Chat',
						}),
						shortcut: shortcuts.killInstance,
						action: () => {
							onDeleteGroupChat(activeGroupChatId);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Debug commands - only visible when user types "debug"
		{
			id: 'debugResetBusy',
			label: t('commands.debug_reset_busy'),
			subtext: t('commands.debug_reset_busy_desc'),
			action: () => {
				// Reset all sessions and tabs to idle state
				setSessions((prev) =>
					prev.map((s) => ({
						...s,
						state: 'idle' as const,
						busySource: undefined,
						thinkingStartTime: undefined,
						currentCycleTokens: undefined,
						currentCycleBytes: undefined,
						aiTabs: s.aiTabs?.map((tab) => ({
							...tab,
							state: 'idle' as const,
							thinkingStartTime: undefined,
						})),
					}))
				);
				console.log('[Debug] Reset busy state for all sessions');
				setQuickActionOpen(false);
			},
		},
		...(activeSession
			? [
					{
						id: 'debugResetSession',
						label: t('commands.debug_reset_session'),
						subtext: t('commands.debug_reset_session_desc', { name: activeSession.name }),
						action: () => {
							setSessions((prev) =>
								prev.map((s) => {
									if (s.id !== activeSessionId) return s;
									return {
										...s,
										state: 'idle' as const,
										busySource: undefined,
										thinkingStartTime: undefined,
										currentCycleTokens: undefined,
										currentCycleBytes: undefined,
										aiTabs: s.aiTabs?.map((tab) => ({
											...tab,
											state: 'idle' as const,
											thinkingStartTime: undefined,
										})),
									};
								})
							);
							console.log('[Debug] Reset busy state for session:', activeSessionId);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		{
			id: 'debugLogSessions',
			label: t('commands.debug_log_session'),
			subtext: t('commands.debug_log_session_desc'),
			action: () => {
				console.log(
					'[Debug] All sessions:',
					sessions.map((s) => ({
						id: s.id,
						name: s.name,
						state: s.state,
						busySource: s.busySource,
						thinkingStartTime: s.thinkingStartTime,
						tabs: s.aiTabs?.map((t) => ({
							id: t.id.substring(0, 8),
							name: t.name,
							state: t.state,
							thinkingStartTime: t.thinkingStartTime,
						})),
					}))
				);
				setQuickActionOpen(false);
			},
		},
		...(setPlaygroundOpen
			? [
					{
						id: 'debugPlayground',
						label: t('commands.debug_playground'),
						subtext: t('commands.debug_playground_desc'),
						action: () => {
							setPlaygroundOpen(true);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession && activeSession.executionQueue?.length > 0 && onDebugReleaseQueuedItem
			? [
					{
						id: 'debugReleaseQueued',
						label: t('commands.debug_release_queued'),
						subtext: t('commands.debug_release_queued_desc', {
							count: activeSession.executionQueue.length,
						}),
						action: () => {
							onDebugReleaseQueuedItem();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(setDebugWizardModalOpen
			? [
					{
						id: 'debugWizardPhaseReview',
						label: t('commands.debug_wizard_review'),
						subtext: t('commands.debug_wizard_review_desc'),
						action: () => {
							setDebugWizardModalOpen(true);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		{
			id: 'debugCopyInstallGuid',
			label: t('commands.debug_copy_guid'),
			subtext: t('commands.debug_copy_guid_desc'),
			action: async () => {
				try {
					const installationId = await window.maestro.leaderboard.getInstallationId();
					if (installationId) {
						await safeClipboardWrite(installationId);
						notifyToast({
							type: 'success',
							title: t('commands.install_guid_copied'),
							message: installationId,
						});
						console.log('[Debug] Installation GUID copied to clipboard:', installationId);
					} else {
						notifyToast({
							type: 'error',
							title: t('common:error'),
							message: t('commands.no_guid_found'),
						});
						console.warn('[Debug] No installation GUID found');
					}
				} catch (err) {
					notifyToast({
						type: 'error',
						title: t('common:error'),
						message: t('commands.failed_copy_guid'),
					});
					console.error('[Debug] Failed to copy installation GUID:', err);
				}
				setQuickActionOpen(false);
			},
		},
	];

	const groupActions: QuickAction[] = [
		{
			id: 'back',
			label: t('commands.back_to_main'),
			action: () => {
				setMode('main');
				setSelectedIndex(0);
			},
		},
		{ id: 'no-group', label: t('commands.no_group_root'), action: () => handleMoveToGroup('') },
		...groups.map((g) => ({
			id: `group-${g.id}`,
			label: `${g.emoji} ${g.name}`,
			action: () => handleMoveToGroup(g.id),
		})),
		{ id: 'create-new', label: t('commands.create_new_group_option'), action: handleCreateGroup },
	];

	const actions = mode === 'main' ? mainActions : groupActions;

	// Filter actions - hide "Debug:" prefixed commands unless user explicitly types "debug"
	const searchLower = search.toLowerCase();
	const showDebugCommands = searchLower.includes('debug');

	const filtered = actions
		.filter((a) => {
			const isDebugCommand = a.label.toLowerCase().startsWith('debug:');
			// Hide debug commands unless user is searching for them
			if (isDebugCommand && !showDebugCommands) {
				return false;
			}
			// Match against translated label
			if (a.label.toLowerCase().includes(searchLower)) return true;
			// Dual-index: also match against English fallback for non-English locales
			const englishLabel = englishLabelMap.get(a.label);
			return englishLabel ? englishLabel.toLowerCase().includes(searchLower) : false;
		})
		.sort((a, b) => a.label.localeCompare(b.label));

	// Use a ref for filtered actions so the onSelect callback stays stable
	const filteredRef = useRef(filtered);
	filteredRef.current = filtered;

	// Callback for when an item is selected (by Enter key or number hotkey)
	const handleSelectByIndex = useCallback(
		(index: number) => {
			const selectedAction = filteredRef.current[index];
			if (!selectedAction) return;

			// Don't close modal if action switches modes
			const switchesModes = selectedAction.id === 'moveToGroup' || selectedAction.id === 'back';
			selectedAction.action();
			if (!renamingSession && mode === 'main' && !switchesModes) {
				setQuickActionOpen(false);
			}
		},
		[renamingSession, mode, setQuickActionOpen]
	);

	// Use hook for list navigation (arrow keys, number hotkeys, Enter)
	const {
		selectedIndex,
		setSelectedIndex,
		handleKeyDown: listHandleKeyDown,
		resetSelection,
	} = useListNavigation({
		listLength: filtered.length,
		onSelect: handleSelectByIndex,
		enableNumberHotkeys: true,
		firstVisibleIndex,
		enabled: !renamingSession, // Disable navigation when renaming
	});

	// Scroll selected item into view
	useEffect(() => {
		selectedItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}, [selectedIndex]);

	// Reset selection when search or mode changes.
	// resetSelection is intentionally excluded from deps — it changes when filtered.length
	// changes, but we only want to reset on user-driven search/mode changes, not on every
	// list length fluctuation from parent re-renders (which causes infinite update loops).
	useEffect(() => {
		resetSelection();
		setFirstVisibleIndex(0);
	}, [search, mode]);

	// Clear search when switching to move-to-group mode
	useEffect(() => {
		if (mode === 'move-to-group') {
			setSearch('');
		}
	}, [mode]);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		// Handle rename mode separately
		if (renamingSession) {
			if (e.key === 'Enter') {
				e.preventDefault();
				handleRenameSession();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				setRenamingSession(false);
			}
			return;
		}

		// Delegate to list navigation hook
		listHandleKeyDown(e);

		// Add stopPropagation for Enter to prevent event bubbling
		if (e.key === 'Enter') {
			e.stopPropagation();
		}
	};

	return (
		<div className="fixed inset-0 modal-overlay flex items-start justify-center pt-32 z-[9999] animate-in fade-in duration-100">
			<div
				ref={modalRef}
				role="dialog"
				aria-modal="true"
				aria-label={tA('modal.quick_actions')}
				tabIndex={-1}
				className="w-[600px] rounded-xl shadow-2xl border overflow-hidden flex flex-col max-h-[550px] outline-none"
				style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
			>
				<div
					className="p-4 border-b flex items-center gap-3"
					style={{ borderColor: theme.colors.border }}
				>
					<Search className="w-5 h-5" style={{ color: theme.colors.textDim }} />
					{renamingSession ? (
						<input
							ref={inputRef}
							className="flex-1 bg-transparent outline-none text-lg"
							placeholder={t('commands.rename_placeholder')}
							style={{ color: theme.colors.textMain }}
							value={renameValue}
							onChange={(e) => setRenameValue(e.target.value)}
							onKeyDown={handleKeyDown}
							autoFocus
						/>
					) : (
						<input
							ref={inputRef}
							className="flex-1 bg-transparent outline-none text-lg placeholder-opacity-50"
							placeholder={
								mode === 'move-to-group'
									? t('commands.search_placeholder_move', {
											name: activeSession?.name || 'session',
										})
									: t('commands.search_placeholder')
							}
							style={{ color: theme.colors.textMain }}
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							onKeyDown={handleKeyDown}
						/>
					)}
					<div
						className="px-2 py-0.5 rounded text-xs font-bold"
						style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
					>
						ESC
					</div>
				</div>
				{!renamingSession && (
					<div
						className="overflow-y-auto py-2 scrollbar-thin"
						ref={scrollContainerRef}
						onScroll={handleScroll}
					>
						{filtered.map((a, i) => {
							// Calculate dynamic number badge (1-9, 0) based on first visible item
							// Cap firstVisibleIndex so we always show 10 numbered items when near the end
							const maxFirstIndex = Math.max(0, filtered.length - 10);
							const effectiveFirstIndex = Math.min(firstVisibleIndex, maxFirstIndex);
							const distanceFromFirstVisible = i - effectiveFirstIndex;
							const showNumber = distanceFromFirstVisible >= 0 && distanceFromFirstVisible < 10;
							// 1-9 for positions 1-9, 0 for position 10
							const numberBadge = distanceFromFirstVisible === 9 ? 0 : distanceFromFirstVisible + 1;

							return (
								<button
									key={a.id}
									ref={i === selectedIndex ? selectedItemRef : null}
									onClick={() => {
										const switchesModes = a.id === 'moveToGroup' || a.id === 'back';
										a.action();
										if (mode === 'main' && !switchesModes) setQuickActionOpen(false);
									}}
									className={`w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-opacity-10 ${i === selectedIndex ? 'bg-opacity-10' : ''}`}
									style={{
										backgroundColor: i === selectedIndex ? theme.colors.accent : 'transparent',
										color:
											i === selectedIndex ? theme.colors.accentForeground : theme.colors.textMain,
									}}
								>
									{showNumber ? (
										<div
											className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-xs font-bold"
											style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
										>
											{numberBadge}
										</div>
									) : (
										<div className="flex-shrink-0 w-5 h-5" />
									)}
									<div className="flex flex-col flex-1">
										<span className="font-medium">{a.label}</span>
										{a.subtext && <span className="text-[10px] opacity-50">{a.subtext}</span>}
									</div>
									{a.shortcut && (
										<span className="text-xs font-mono opacity-60">
											{formatShortcutKeys(a.shortcut.keys)}
										</span>
									)}
								</button>
							);
						})}
						{filtered.length === 0 && (
							<div className="px-4 py-4 text-center opacity-50 text-sm">
								{t('commands.no_actions_found')}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
});
