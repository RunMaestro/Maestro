import React, { memo, useState, useEffect, useRef, useCallback } from 'react';
import { Search } from 'lucide-react';
import type {
	Session,
	SessionState,
	Group,
	Theme,
	Shortcut,
	RightPanelTab,
	SettingsTab,
} from '../types';
import type { GroupChat } from '../../shared/group-chat-types';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { notifyToast } from '../stores/notificationStore';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import { useModalStore } from '../stores/modalStore';
import { QUICK_ACTION_PROMPTS } from '../../shared/promptDefinitions';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { gitService } from '../services/git';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { findNextUnreadSession, getTabDisplayName } from '../utils/tabHelpers';
import { formatElapsedTime } from '../../shared/formatters';
import { getStatusColor } from '../utils/theme';
import { safeClipboardWrite } from '../utils/clipboard';
import { getOpenInLabel } from '../utils/platformUtils';
import type { WizardStep } from './Wizard/WizardContext';
import { useListNavigation } from '../hooks';
import { useUIStore } from '../stores/uiStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useFileExplorerStore } from '../stores/fileExplorerStore';
import { useFeedbackDraftStore } from '../stores/feedbackDraftStore';
import { buildMaestroUrl } from '../utils/buildMaestroUrl';
import { buildSessionDeepLink } from '../../shared/deep-link-urls';
import { openUrl } from '../utils/openUrl';
import { logger } from '../utils/logger';

// Strip leading emojis (and the whitespace/zero-width joiners that follow them)
// so a name like "🚀 Atlas" sorts under "A" rather than at the top of the list.
// We only strip emojis — leading ASCII punctuation like "[wip] Bravo" is left
// alone so it sorts where the user typed it.
function alphabetizeKey(label: string): string {
	const stripped = label.replace(
		/^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|[\u{FE00}-\u{FE0F}\u{200D}\s])+/u,
		''
	);
	return (stripped || label).toLocaleLowerCase();
}

interface RunningAgentSubtextProps {
	info: NonNullable<QuickAction['runningInfo']>;
	now: number;
	theme: Theme;
	isSelected: boolean;
}

const RunningAgentSubtext = memo(function RunningAgentSubtext({
	info,
	now,
	theme,
	isSelected,
}: RunningAgentSubtextProps) {
	const elapsedMs =
		info.thinkingStartTime !== undefined ? Math.max(0, now - info.thinkingStartTime) : null;
	const parts: string[] = [];
	parts.push(elapsedMs !== null ? formatElapsedTime(elapsedMs) : info.state.toUpperCase());
	if (info.busyTabName) parts.push(info.busyTabName);
	if (info.queueCount > 0) {
		parts.push(`${info.queueCount} queued`);
	}
	return (
		<span
			className="text-[10px] truncate"
			style={{
				color: isSelected ? theme.colors.accentForeground : getStatusColor(info.state, theme),
			}}
		>
			{parts.join(' · ')}
		</span>
	);
});

interface SectionHeaderProps {
	label: string;
	color: string;
}

const SectionHeader = memo(function SectionHeader({ label, color }: SectionHeaderProps) {
	return (
		<div className="px-4 pt-3 pb-1 flex items-center gap-2 select-none" aria-hidden="true">
			<span className="text-[10px] font-bold tracking-[0.15em]" style={{ color }}>
				{label}
			</span>
			<div className="flex-1 border-t-2" style={{ borderColor: color, opacity: 0.4 }} />
		</div>
	);
});

interface QuickAction {
	id: string;
	label: string;
	action: () => void;
	subtext?: string;
	shortcut?: Shortcut;
	// Agents-mode only: marks an agent whose state is not 'idle' so we can
	// bucket "active" agents at the top with a divider beneath them.
	isRunningAgent?: boolean;
	// Agents-mode only: data needed to render rich live status for running agents.
	// `thinkingStartTime` is recomputed against the modal's tick clock so the elapsed
	// time updates while the modal stays open.
	runningInfo?: {
		state: SessionState;
		thinkingStartTime?: number;
		busyTabName?: string;
		queueCount: number;
	};
	// Jump-to-agent actions only: the underlying session's bookmark flag and a
	// stable key derived from the bare agent name. When two jump entries share
	// the same agentSortKey (e.g. a top-level "rc" and a "Maestro subagent: rc"
	// worktree child), the bookmarked one wins the tiebreaker so it gets the
	// default highlight and Enter-to-jump.
	bookmarked?: boolean;
	agentSortKey?: string;
}

interface QuickActionsModalProps {
	theme: Theme;
	sessions: Session[];
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	activeSessionId: string;
	groups: Group[];
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
	shortcuts: Record<string, Shortcut>;
	initialMode?: 'main' | 'move-to-group' | 'agents';
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
	setFeedbackModalOpen: (open: boolean) => void;
	setLogViewerOpen: (open: boolean) => void;
	setProcessMonitorOpen: (open: boolean) => void;
	setUsageDashboardOpen?: (open: boolean) => void;
	setAgentSessionsOpen: (open: boolean) => void;
	setMemoryViewerOpen?: (open: boolean) => void;
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
	setDebugApplicationStatsOpen?: (open: boolean) => void;
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
		capability:
			| 'supportsSessionStorage'
			| 'supportsSlashCommands'
			| 'supportsContextMerge'
			| 'supportsProjectMemory'
	) => boolean;
	// Merge session
	onOpenMergeSession?: () => void;
	// Send to agent
	onOpenSendToAgent?: () => void;
	// Remote control
	onToggleRemoteControl?: () => void;
	// Worktree creation (from command palette)
	onQuickCreateWorktree?: (session: Session) => void;
	// Worktree PR creation
	onOpenCreatePR?: (session: Session) => void;
	// Summarize and continue
	onSummarizeAndContinue?: () => void;
	canSummarizeActiveTab?: boolean;
	// Auto Run reset tasks
	autoRunSelectedDocument?: string | null;
	autoRunCompletedTaskCount?: number;
	onAutoRunResetTasks?: () => void;
	onClearActiveTerminal?: () => void;
	// Tab close operations
	onCloseAllTabs?: () => void;
	onCloseOtherTabs?: () => void;
	onCloseTabsLeft?: () => void;
	onCloseTabsRight?: () => void;
	// Tab-level actions (for active tab)
	onCloseCurrentTab?: () => void;
	onMoveTabToFirst?: () => void;
	onMoveTabToLast?: () => void;
	onCopyTabContext?: (tabId: string) => void;
	onExportTabHtml?: (tabId: string) => void;
	onPublishTabGist?: (tabId: string) => void;
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
	// Maestro Cue
	onOpenMaestroCue?: () => void;
	onConfigureCue?: (session: Session) => void;
	// Agent Dispatch
	onOpenAgentDispatch?: () => void;
	// Delivery Planner
	onOpenDeliveryPlanner?: () => void;
	// Planning Pipeline
	onOpenPlanningPipeline?: () => void;
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
		setFeedbackModalOpen,
		setLogViewerOpen,
		setProcessMonitorOpen,
		setUsageDashboardOpen,
		setAgentSessionsOpen,
		setMemoryViewerOpen,
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
		setDebugApplicationStatsOpen,
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
		onQuickCreateWorktree,
		onOpenCreatePR,
		onSummarizeAndContinue,
		canSummarizeActiveTab,
		autoRunSelectedDocument,
		autoRunCompletedTaskCount,
		onAutoRunResetTasks,
		onClearActiveTerminal,
		onCloseAllTabs,
		onCloseOtherTabs,
		onCloseTabsLeft,
		onCloseTabsRight,
		onCloseCurrentTab,
		onMoveTabToFirst,
		onMoveTabToLast,
		onCopyTabContext,
		onExportTabHtml,
		onPublishTabGist,
		isFilePreviewOpen,
		ghCliAvailable,
		onPublishGist,
		onOpenPlaybookExchange,
		lastGraphFocusFile,
		onOpenLastDocumentGraph,
		onOpenSymphony,
		onOpenDirectorNotes,
		onOpenMaestroCue,
		onConfigureCue,
		onOpenAgentDispatch,
		onOpenDeliveryPlanner,
		onOpenPlanningPipeline,
	} = props;

	// UI store actions for search commands (avoid threading more props through 3-layer chain)
	const setActiveFocus = useUIStore((s) => s.setActiveFocus);
	const storeSetSessionFilterOpen = useUIStore((s) => s.setSessionFilterOpen);
	const storeSetOutputSearchOpen = useUIStore((s) => s.setOutputSearchOpen);
	const storeSetFileTreeFilterOpen = useFileExplorerStore((s) => s.setFileTreeFilterOpen);
	const audioFeedbackEnabled = useSettingsStore((s) => s.audioFeedbackEnabled);
	const setAudioFeedbackEnabled = useSettingsStore((s) => s.setAudioFeedbackEnabled);
	const idleNotificationEnabled = useSettingsStore((s) => s.idleNotificationEnabled);
	const setIdleNotificationEnabled = useSettingsStore((s) => s.setIdleNotificationEnabled);
	const bionifyReadingMode = useSettingsStore((s) => s.bionifyReadingMode);
	const setBionifyReadingMode = useSettingsStore((s) => s.setBionifyReadingMode);
	const storeSetHistorySearchFilterOpen = useUIStore((s) => s.setHistorySearchFilterOpen);
	const setSuccessFlashNotification = useUIStore((s) => s.setSuccessFlashNotification);
	const bookmarksCollapsed = useUIStore((s) => s.bookmarksCollapsed);
	const setBookmarksCollapsed = useUIStore((s) => s.setBookmarksCollapsed);

	const [search, setSearch] = useState('');
	const [mode, setMode] = useState<'main' | 'move-to-group' | 'agents'>(initialMode);
	const [renamingSession, setRenamingSession] = useState(false);
	const [renameValue, setRenameValue] = useState('');
	const [firstVisibleIndex, setFirstVisibleIndex] = useState(0);
	// Re-render once a second while the agent jumper has running agents so the
	// elapsed-time labels tick in place. We only run the interval when needed.
	const [now, setNow] = useState(() => Date.now());
	const hasRunningAgent = mode === 'agents' && sessions.some((s) => s.state !== 'idle');
	useEffect(() => {
		if (!hasRunningAgent) return;
		setNow(Date.now());
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [hasRunningAgent]);
	const inputRef = useRef<HTMLInputElement>(null);
	const selectedItemRef = useRef<HTMLButtonElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const modalRef = useRef<HTMLDivElement>(null);
	const activeSession = sessions.find((s) => s.id === activeSessionId);

	// Compute the active tab's position in the unified tab order for command palette conditions.
	// This works for AI, file, terminal, and browser tabs.
	const isTerminalMode = activeSession?.inputMode === 'terminal';
	const hasActiveTab = !!(
		isAiMode ||
		isTerminalMode ||
		activeSession?.activeFileTabId ||
		activeSession?.activeBrowserTabId
	);
	const activeUnifiedIndex = (() => {
		if (!activeSession) return -1;
		let type: 'ai' | 'file' | 'terminal' | 'browser';
		let id: string | undefined;
		if (activeSession.activeBrowserTabId) {
			type = 'browser';
			id = activeSession.activeBrowserTabId;
		} else if (isTerminalMode && activeSession.activeTerminalTabId) {
			type = 'terminal';
			id = activeSession.activeTerminalTabId;
		} else if (activeSession.activeFileTabId) {
			type = 'file';
			id = activeSession.activeFileTabId;
		} else {
			type = 'ai';
			id = activeSession.activeTabId;
		}
		if (!id) return -1;
		return (activeSession.unifiedTabOrder ?? []).findIndex(
			(ref) => ref.type === type && ref.id === id
		);
	})();
	const unifiedTabCount = activeSession?.unifiedTabOrder?.length ?? 0;

	// Register layer on mount - escape behavior depends on current mode
	useModalLayer(MODAL_PRIORITIES.QUICK_ACTION, 'Quick Actions', () => {
		if (mode === 'move-to-group') {
			setMode('main');
			// Note: Selection will be reset by the search/mode change useEffect
		} else {
			setQuickActionOpen(false);
		}
	});

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
		const normalizedGroupId = groupId || undefined;
		const updatedSessions = sessions.map((s) => {
			if (s.id === activeSessionId) return { ...s, groupId: normalizedGroupId };
			// Also update worktree children to keep groupId in sync
			if (s.parentSessionId === activeSessionId) return { ...s, groupId: normalizedGroupId };
			return s;
		});
		setSessions(updatedSessions);
		setQuickActionOpen(false);
	};

	const handleCreateGroup = () => {
		setCreateGroupModalOpen(true);
		setQuickActionOpen(false);
	};

	// Reveal a jumped-to agent without unnecessarily expanding sections.
	// - Not bookmarked: expand the parent group if collapsed (existing behavior).
	// - Bookmarked: prefer whichever section the agent is already visible in. If
	//   neither bookmarks nor the parent group is open, expand bookmarks (the
	//   pinned bookmark row is the lighter-weight reveal of the two).
	const revealJumpTarget = (s: Session) => {
		if (!s.bookmarked) {
			if (s.groupId) {
				setGroups((prev) =>
					prev.map((g) => (g.id === s.groupId && g.collapsed ? { ...g, collapsed: false } : g))
				);
			}
			return;
		}
		const groupOpen = s.groupId ? !groups.find((g) => g.id === s.groupId)?.collapsed : false;
		if (bookmarksCollapsed && !groupOpen) {
			setBookmarksCollapsed(false);
		}
	};

	const sessionActions: QuickAction[] = sessions.map((s) => {
		// For worktree subagents, format as "Jump to $PARENT subagent: $NAME"
		let label: string;
		if (s.parentSessionId) {
			const parentSession = sessions.find((p) => p.id === s.parentSessionId);
			const parentName = parentSession?.name || 'Unknown';
			label = `Jump to ${parentName} subagent: ${s.name}`;
		} else {
			label = `Jump to: ${s.name}`;
		}

		return {
			id: `jump-${s.id}`,
			label,
			action: () => {
				setActiveSessionId(s.id);
				revealJumpTarget(s);
			},
			subtext: s.state.toUpperCase(),
			bookmarked: !!s.bookmarked,
			agentSortKey: alphabetizeKey(s.name),
		};
	});

	// Group chat jump actions
	const groupChatActions: QuickAction[] =
		groupChats && onOpenGroupChat
			? groupChats.map((gc) => ({
					id: `groupchat-${gc.id}`,
					label: `Group Chat: ${gc.name}`,
					action: () => {
						onOpenGroupChat(gc.id);
						setQuickActionOpen(false);
					},
					subtext: `${gc.participants.length} participant${gc.participants.length !== 1 ? 's' : ''}`,
				}))
			: [];

	const mainActions: QuickAction[] = [
		...sessionActions,
		...groupChatActions,
		{
			id: 'new',
			label: 'Create New Agent',
			shortcut: shortcuts.newInstance,
			action: addNewSession,
		},
		...(openWizard
			? [
					{
						id: 'wizard',
						label: 'New Agent Wizard',
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
						label: `Rename Agent: ${activeSession.name}`,
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
						label: `Edit Agent: ${activeSession.name}`,
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
							? `Unbookmark: ${activeSession.name}`
							: `Bookmark: ${activeSession.name}`,
						shortcut: shortcuts.toggleBookmark,
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
						label: 'Rename Group',
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
						label: 'Move to Group...',
						shortcut: shortcuts.moveToGroup,
						action: () => {
							setMode('move-to-group');
							setSelectedIndex(0);
						},
					},
				]
			: []),
		{ id: 'createGroup', label: 'Create New Group', action: handleCreateGroup },
		{
			id: 'toggleSidebar',
			label: 'Toggle Sidebar',
			shortcut: shortcuts.toggleSidebar,
			action: () => setLeftSidebarOpen((p) => !p),
		},
		{
			id: 'toggleRight',
			label: 'Toggle Right Panel',
			shortcut: shortcuts.toggleRightPanel,
			action: () => setRightPanelOpen((p) => !p),
		},
		{
			id: 'nextUnreadTab',
			label: 'Next Unread / Draft Tab',
			shortcut: shortcuts.nextUnreadTab,
			action: () => {
				const result = findNextUnreadSession(sessions, activeSessionId);

				if (result.clearedCurrent) {
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== activeSessionId) return s;
							return {
								...s,
								aiTabs: s.aiTabs.map((t) => (t.hasUnread ? { ...t, hasUnread: false } : t)),
							};
						})
					);
				}

				if (result.jumped && result.targetSessionId) {
					setActiveSessionId(result.targetSessionId);
					const targetTabId = result.targetTabId;
					if (targetTabId) {
						setSessions((prev) =>
							prev.map((s) => {
								if (s.id !== result.targetSessionId) return s;
								return { ...s, activeTabId: targetTabId };
							})
						);
					}
				} else {
					setSuccessFlashNotification('No unread or draft tabs');
					setTimeout(() => setSuccessFlashNotification(null), 2000);
				}
				setQuickActionOpen(false);
			},
		},
		...(activeSession
			? [
					{
						id: 'switchMode',
						label: 'Switch AI/Shell Mode',
						shortcut: shortcuts.toggleMode,
						action: toggleInputMode,
					},
				]
			: []),
		...(isAiMode && onOpenTabSwitcher
			? [
					{
						id: 'tabSwitcher',
						label: 'Tab Switcher',
						shortcut: tabShortcuts?.tabSwitcher,
						action: () => {
							onOpenTabSwitcher();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(hasActiveTab && onRenameTab
			? [
					{
						id: 'renameTab',
						label: 'Rename Tab',
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
						label: 'Toggle Read-Only Mode',
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
						label: 'Toggle Show Thinking',
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
						label: 'Toggle Edit/Preview',
						shortcut: shortcuts.toggleMarkdownMode,
						subtext: markdownEditMode ? 'Currently in edit mode' : 'Currently in preview mode',
						action: () => {
							onToggleMarkdownEditMode();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		{
			id: 'toggleBionifyReadingMode',
			label: bionifyReadingMode ? 'Turn Off Bionify Emphasis' : 'Turn On Bionify Emphasis',
			subtext: `Bionify emphasis: ${bionifyReadingMode ? 'enabled' : 'disabled'}`,
			action: () => {
				const newState = !bionifyReadingMode;
				setBionifyReadingMode(newState);
				setSuccessFlashNotification(newState ? 'Bionify: ON' : 'Bionify: OFF');
				setTimeout(() => setSuccessFlashNotification(null), 2000);
				setQuickActionOpen(false);
			},
		},
		{
			id: 'toggleCustomNotification',
			label: audioFeedbackEnabled
				? 'Turn Off Custom Notifications'
				: 'Turn On Custom Notifications',
			subtext: `Custom notifications: ${audioFeedbackEnabled ? 'enabled' : 'disabled'}`,
			action: () => {
				const newState = !audioFeedbackEnabled;
				setAudioFeedbackEnabled(newState);
				setSuccessFlashNotification(
					newState ? 'Custom Notifications: ON' : 'Custom Notifications: OFF'
				);
				setTimeout(() => setSuccessFlashNotification(null), 2000);
				setQuickActionOpen(false);
			},
		},
		{
			id: 'toggleIdleNotification',
			label: idleNotificationEnabled ? 'Turn Off Idle Notifications' : 'Turn On Idle Notifications',
			subtext: `Idle notifications: ${idleNotificationEnabled ? 'enabled' : 'disabled'}`,
			action: () => {
				const newState = !idleNotificationEnabled;
				setIdleNotificationEnabled(newState);
				setSuccessFlashNotification(
					newState ? 'Idle Notifications: ON' : 'Idle Notifications: OFF'
				);
				setTimeout(() => setSuccessFlashNotification(null), 2000);
				setQuickActionOpen(false);
			},
		},
		// Tab close operations
		...(isAiMode && activeSession?.aiTabs && activeSession.aiTabs.length > 0 && onCloseAllTabs
			? [
					{
						id: 'closeAllTabs',
						label: 'Close All Tabs',
						shortcut: tabShortcuts?.closeAllTabs,
						subtext: `Close all ${activeSession.aiTabs.length} tabs (creates new tab)`,
						action: () => {
							onCloseAllTabs();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(hasActiveTab && unifiedTabCount > 1 && onCloseOtherTabs
			? [
					{
						id: 'closeOtherTabs',
						label: 'Close Other Tabs',
						shortcut: tabShortcuts?.closeOtherTabs,
						subtext: `Keep only current tab, close ${unifiedTabCount - 1} others`,
						action: () => {
							onCloseOtherTabs();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(hasActiveTab && activeUnifiedIndex > 0 && onCloseTabsLeft
			? [
					{
						id: 'closeTabsLeft',
						label: 'Close Tabs to Left',
						shortcut: tabShortcuts?.closeTabsLeft,
						action: () => {
							onCloseTabsLeft();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(hasActiveTab &&
		activeUnifiedIndex >= 0 &&
		activeUnifiedIndex < unifiedTabCount - 1 &&
		onCloseTabsRight
			? [
					{
						id: 'closeTabsRight',
						label: 'Close Tabs to Right',
						shortcut: tabShortcuts?.closeTabsRight,
						action: () => {
							onCloseTabsRight();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Close current tab
		...(hasActiveTab && unifiedTabCount > 1 && onCloseCurrentTab
			? [
					{
						id: 'closeCurrentTab',
						label: 'Close Tab',
						shortcut: tabShortcuts?.closeTab,
						action: () => {
							onCloseCurrentTab();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Move tab to first/last position
		...(hasActiveTab && activeUnifiedIndex > 0 && onMoveTabToFirst
			? [
					{
						id: 'moveTabToFirst',
						label: 'Move to First Position',
						action: () => {
							onMoveTabToFirst();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(hasActiveTab &&
		activeUnifiedIndex >= 0 &&
		activeUnifiedIndex < unifiedTabCount - 1 &&
		onMoveTabToLast
			? [
					{
						id: 'moveTabToLast',
						label: 'Move to Last Position',
						action: () => {
							onMoveTabToLast();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Copy Session ID (for active tab)
		...(isAiMode && activeSession
			? (() => {
					const activeTab = activeSession.aiTabs.find((t) => t.id === activeSession.activeTabId);
					if (!activeTab?.agentSessionId) return [];
					return [
						{
							id: 'copySessionId',
							label: 'Copy Session ID',
							subtext: activeTab.agentSessionId,
							action: async () => {
								if (await safeClipboardWrite(activeTab.agentSessionId!)) {
									flashCopiedToClipboard(activeTab.agentSessionId!, 'Session ID Copied');
								}
								setQuickActionOpen(false);
							},
						},
					];
				})()
			: []),
		// Copy Deep Link (for active tab)
		...(isAiMode && activeSession
			? (() => {
					const activeTab = activeSession.aiTabs.find((t) => t.id === activeSession.activeTabId);
					if (!activeTab?.agentSessionId) return [];
					return [
						{
							id: 'copyDeepLink',
							label: 'Copy Deep Link',
							action: async () => {
								const deepLink = buildSessionDeepLink(activeSession.id, activeTab.id);
								if (await safeClipboardWrite(deepLink)) {
									flashCopiedToClipboard(deepLink, 'Deep Link Copied');
								}
								setQuickActionOpen(false);
							},
						},
					];
				})()
			: []),
		// Star/Unstar Session (for active tab)
		...(isAiMode && activeSession
			? (() => {
					const activeTab = activeSession.aiTabs.find((t) => t.id === activeSession.activeTabId);
					if (!activeTab?.agentSessionId) return [];
					return [
						{
							id: 'toggleStarTab',
							label: activeTab.starred ? 'Unstar Session' : 'Star Session',
							shortcut: shortcuts.toggleTabStar,
							action: () => {
								setSessions((prev) =>
									prev.map((s) => {
										if (s.id !== activeSessionId) return s;
										return {
											...s,
											aiTabs: s.aiTabs.map((t) =>
												t.id === activeTab.id ? { ...t, starred: !t.starred } : t
											),
										};
									})
								);
								setQuickActionOpen(false);
							},
						},
					];
				})()
			: []),
		// Mark as Unread (for active tab)
		...(isAiMode && activeSession
			? (() => {
					const activeTab = activeSession.aiTabs.find((t) => t.id === activeSession.activeTabId);
					if (!activeTab?.agentSessionId) return [];
					return [
						{
							id: 'markTabUnread',
							label: 'Mark as Unread',
							shortcut: tabShortcuts?.toggleTabUnread,
							action: () => {
								setSessions((prev) =>
									prev.map((s) => {
										if (s.id !== activeSessionId) return s;
										return {
											...s,
											aiTabs: s.aiTabs.map((t) =>
												t.id === activeTab.id ? { ...t, hasUnread: true } : t
											),
										};
									})
								);
								setQuickActionOpen(false);
							},
						},
					];
				})()
			: []),
		// Export as HTML (for active tab)
		...(isAiMode && activeSession && onExportTabHtml
			? (() => {
					const activeTab = activeSession.aiTabs.find((t) => t.id === activeSession.activeTabId);
					if (!activeTab || (activeTab.logs?.length ?? 0) < 1) return [];
					return [
						{
							id: 'exportTabHtml',
							label: 'Export as HTML',
							action: () => {
								onExportTabHtml(activeTab.id);
								setQuickActionOpen(false);
							},
						},
					];
				})()
			: []),
		// Context: Copy to Clipboard (for active tab)
		...(isAiMode && activeSession && onCopyTabContext
			? (() => {
					const activeTab = activeSession.aiTabs.find((t) => t.id === activeSession.activeTabId);
					if (!activeTab || (activeTab.logs?.length ?? 0) < 1) return [];
					return [
						{
							id: 'copyTabContext',
							label: 'Context: Copy to Clipboard',
							action: () => {
								onCopyTabContext(activeTab.id);
								setQuickActionOpen(false);
							},
						},
					];
				})()
			: []),
		// Context: Publish as GitHub Gist (for active tab)
		...(isAiMode && activeSession && ghCliAvailable && onPublishTabGist
			? (() => {
					const activeTab = activeSession.aiTabs.find((t) => t.id === activeSession.activeTabId);
					if (!activeTab || (activeTab.logs?.length ?? 0) < 1) return [];
					return [
						{
							id: 'publishTabGist',
							label: 'Context: Publish as GitHub Gist',
							action: () => {
								onPublishTabGist(activeTab.id);
								setQuickActionOpen(false);
							},
						},
					];
				})()
			: []),
		...(activeSession && activeSession.inputMode === 'terminal' && onClearActiveTerminal
			? [
					{
						id: 'clearTerminal',
						label: 'Clear Terminal History',
						shortcut: shortcuts.clearTerminal,
						action: () => {
							onClearActiveTerminal();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession && !activeSession.sshRemote
			? [
					{
						id: 'openWorkingDirectory',
						label: `${getOpenInLabel(window.maestro?.platform || 'darwin')}: Working Directory`,
						subtext: activeSession.projectRoot,
						action: () => {
							window.maestro?.shell?.openPath(activeSession.fullPath || activeSession.projectRoot);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession
			? [
					{
						id: 'kill',
						label: `Remove Agent: ${activeSession.name}`,
						shortcut: shortcuts.killInstance,
						action: () => deleteSession(activeSessionId),
					},
				]
			: []),
		{
			id: 'settings',
			label: 'Settings',
			shortcut: shortcuts.settings,
			action: () => {
				setSettingsModalOpen(true);
				setQuickActionOpen(false);
			},
		},
		{
			id: 'theme',
			label: 'Change Theme',
			action: () => {
				setSettingsModalOpen(true);
				setSettingsTab('theme');
				setQuickActionOpen(false);
			},
		},
		{
			id: 'configureEnvVars',
			label: 'Configure Global Environment Variables',
			action: () => {
				setSettingsModalOpen(true);
				setSettingsTab('general');
				setQuickActionOpen(false);
			},
		},
		...QUICK_ACTION_PROMPTS.map((p) => ({
			id: `edit-prompt-${p.id}`,
			label: `Edit Prompt: ${p.label}`,
			action: () => {
				useModalStore.getState().openModal('settings', { tab: 'prompts', promptId: p.id });
				setQuickActionOpen(false);
			},
		})),
		{
			id: 'shortcuts',
			label: 'View Shortcuts',
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
						label: 'Start Introductory Tour',
						subtext: 'Take a guided tour of the interface',
						action: () => {
							startTour();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		{
			id: 'logs',
			label: 'View System Logs',
			shortcut: shortcuts.systemLogs,
			action: () => {
				setLogViewerOpen(true);
				setQuickActionOpen(false);
			},
		},
		{
			id: 'processes',
			label: 'View System Processes',
			shortcut: shortcuts.processMonitor,
			action: () => {
				setProcessMonitorOpen(true);
				setQuickActionOpen(false);
			},
		},
		...(setUsageDashboardOpen
			? [
					{
						id: 'usageDashboard',
						label: 'Usage Dashboard',
						shortcut: shortcuts.usageDashboard,
						action: () => {
							setUsageDashboardOpen(true);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession && hasActiveSessionCapability?.('supportsSessionStorage')
			? [
					{
						id: 'agentSessions',
						label: `View Agent Sessions for ${activeSession.name}`,
						shortcut: shortcuts.agentSessions,
						action: () => {
							setActiveAgentSessionId(null);
							setAgentSessionsOpen(true);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession &&
		setMemoryViewerOpen &&
		hasActiveSessionCapability?.('supportsProjectMemory')
			? [
					{
						id: 'openMemoryViewer',
						label: `View Agent Memories for ${activeSession.name}`,
						shortcut: shortcuts.openMemoryViewer,
						action: () => {
							setMemoryViewerOpen(true);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(isAiMode && canSummarizeActiveTab && onSummarizeAndContinue
			? [
					{
						id: 'summarizeAndContinue',
						label: 'Context: Compact',
						shortcut: tabShortcuts?.summarizeAndContinue,
						subtext: 'Compact context into a fresh tab',
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
						label: 'Context: Merge Into',
						shortcut: shortcuts.mergeSession,
						subtext: 'Merge current context into another session',
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
						label: 'Context: Send to Agent',
						shortcut: shortcuts.sendToAgent,
						subtext: 'Transfer context to a different AI agent',
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
						label: 'View Git Diff',
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
						label: 'View Git Log',
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
						label: 'Open Repository in Browser',
						action: async () => {
							const cwd =
								activeSession.inputMode === 'terminal'
									? activeSession.shellCwd || activeSession.cwd
									: activeSession.cwd;
							try {
								const browserUrl = await gitService.getRemoteBrowserUrl(cwd);
								if (browserUrl) {
									openUrl(browserUrl);
								} else {
									notifyToast({
										type: 'error',
										title: 'No Remote URL',
										message: 'Could not find a remote URL for this repository',
									});
								}
							} catch (error) {
								logger.error('Failed to open repository in browser:', undefined, error);
								notifyToast({
									type: 'error',
									title: 'Error',
									message:
										error instanceof Error ? error.message : 'Failed to open repository in browser',
								});
							}
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Create Worktree - for git repos (resolves parent if already in a worktree)
		...(activeSession && activeSession.isGitRepo && onQuickCreateWorktree
			? [
					{
						id: 'createWorktree',
						label: 'Create Worktree',
						subtext: activeSession.parentSessionId
							? `New worktree under ${sessions.find((s) => s.id === activeSession.parentSessionId)?.name || 'parent'}`
							: 'Create a new git worktree branch',
						action: () => {
							// If in a worktree child, resolve to parent session
							const targetSession = activeSession.parentSessionId
								? sessions.find((s) => s.id === activeSession.parentSessionId) || activeSession
								: activeSession;
							onQuickCreateWorktree(targetSession);
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
						label: `Create Pull Request: ${activeSession.worktreeBranch}`,
						subtext: 'Open PR from this worktree branch',
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
						label: 'Refresh Files, Git, History',
						subtext: 'Reload file tree, git status, and history',
						action: async () => {
							await onRefreshGitFileState();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		{
			id: 'devtools',
			label: 'Toggle JavaScript Console',
			action: () => {
				window.maestro.devtools.toggle();
				setQuickActionOpen(false);
			},
		},
		{
			id: 'about',
			label: 'About Maestro',
			action: () => {
				setAboutModalOpen(true);
				setQuickActionOpen(false);
			},
		},
		{
			id: 'feedback',
			label: 'Send Feedback',
			subtext: 'Report a bug or suggest a feature via GitHub',
			action: () => {
				const draft = useFeedbackDraftStore.getState();
				if (draft.isMinimized) {
					draft.setMinimized(false);
				} else {
					setFeedbackModalOpen(true);
				}
				setQuickActionOpen(false);
			},
		},
		{
			id: 'website',
			label: 'Maestro Website',
			subtext: 'Open the Maestro website',
			action: () => {
				openUrl(buildMaestroUrl('https://runmaestro.ai/'));
				setQuickActionOpen(false);
			},
		},
		{
			id: 'docs',
			label: 'Documentation and User Guide',
			subtext: 'Open the Maestro documentation',
			action: () => {
				openUrl(buildMaestroUrl('https://docs.runmaestro.ai/'));
				setQuickActionOpen(false);
			},
		},
		{
			id: 'discord',
			label: 'Join Discord',
			subtext: 'Join the Maestro community',
			action: () => {
				openUrl(buildMaestroUrl('https://runmaestro.ai/discord'));
				setQuickActionOpen(false);
			},
		},
		...(setUpdateCheckModalOpen
			? [
					{
						id: 'updateCheck',
						label: 'Check for Updates',
						action: () => {
							setUpdateCheckModalOpen(true);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		{
			id: 'createDebugPackage',
			label: 'Create Debug Package',
			subtext: 'Generate a support bundle for bug reporting',
			action: () => {
				setQuickActionOpen(false);
				if (setDebugPackageModalOpen) {
					setDebugPackageModalOpen(true);
				} else {
					// Fallback to direct API call if modal not available
					notifyToast({
						type: 'info',
						title: 'Debug Package',
						message: 'Creating debug package...',
					});
					window.maestro.debug
						.createPackage()
						.then((result) => {
							if (result.success && result.path) {
								notifyToast({
									type: 'success',
									title: 'Debug Package Created',
									message: `Saved to ${result.path}`,
								});
							} else if (result.error !== 'Cancelled by user') {
								notifyToast({
									type: 'error',
									title: 'Debug Package Failed',
									message: result.error || 'Unknown error',
								});
							}
						})
						.catch((error) => {
							notifyToast({
								type: 'error',
								title: 'Debug Package Failed',
								message: error instanceof Error ? error.message : 'Unknown error',
							});
						});
				}
			},
		},
		{
			id: 'goToFiles',
			label: 'Go to Files Tab',
			shortcut: shortcuts.goToFiles,
			action: () => {
				setRightPanelOpen(true);
				setActiveRightTab('files');
				setQuickActionOpen(false);
			},
		},
		{
			id: 'goToHistory',
			label: 'Go to History Tab',
			shortcut: shortcuts.goToHistory,
			action: () => {
				setRightPanelOpen(true);
				setActiveRightTab('history');
				setQuickActionOpen(false);
			},
		},
		...(useSettingsStore.getState().autoRunDisabled
			? []
			: [
					{
						id: 'goToAutoRun',
						label: 'Go to Auto Run Tab',
						shortcut: shortcuts.goToAutoRun,
						action: () => {
							setRightPanelOpen(true);
							setActiveRightTab('autorun');
							setQuickActionOpen(false);
						},
					},
				]),
		// Playbook Exchange - browse and import community playbooks
		...(onOpenPlaybookExchange
			? [
					{
						id: 'openPlaybookExchange',
						label: 'Playbook Exchange',
						subtext: 'Browse and import community playbooks',
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
						label: 'Maestro Symphony',
						shortcut: shortcuts.openSymphony,
						subtext: 'Contribute to open source projects',
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
						label: "Director's Notes",
						shortcut: shortcuts.directorNotes,
						subtext: 'View unified history and AI synopsis across all sessions',
						action: () => {
							onOpenDirectorNotes();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Maestro Cue - event-driven automation dashboard
		...(onOpenMaestroCue
			? [
					{
						id: 'maestro-cue',
						label: 'Maestro Cue',
						shortcut: shortcuts.maestroCue,
						subtext: 'Event-driven automation dashboard',
						action: () => {
							onOpenMaestroCue();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Configure Maestro Cue YAML for active agent
		...(onConfigureCue && activeSession
			? [
					{
						id: 'configure-cue',
						label: `Configure Maestro Cue: ${activeSession.name}`,
						subtext: 'Open YAML editor for event-driven automation',
						action: () => {
							onConfigureCue(activeSession);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Agent Dispatch - fleet and work board
		...(onOpenAgentDispatch
			? [
					{
						id: 'agentDispatch',
						label: 'Agent Dispatch',
						shortcut: shortcuts.openAgentDispatch,
						subtext: 'View fleet and work item board',
						action: () => {
							onOpenAgentDispatch();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Delivery Planner
		...(onOpenDeliveryPlanner
			? [
					{
						id: 'deliveryPlanner',
						label: 'Delivery Planner',
						shortcut: shortcuts.openDeliveryPlanner,
						subtext: 'Manage PRDs, epics, and GitHub sync',
						action: () => {
							onOpenDeliveryPlanner();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Planning Pipeline
		...(onOpenPlanningPipeline
			? [
					{
						id: 'planningPipeline',
						label: 'Planning Pipeline',
						shortcut: shortcuts.openPlanningPipeline,
						subtext: 'View planning stage pipeline dashboard',
						action: () => {
							onOpenPlanningPipeline();
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
						label: 'Open Last Document Graph',
						subtext: `Re-open: ${lastGraphFocusFile}`,
						action: () => {
							onOpenLastDocumentGraph();
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		// Auto Run reset tasks - only show when there are completed tasks in the selected document
		...(!useSettingsStore.getState().autoRunDisabled &&
		autoRunSelectedDocument &&
		autoRunCompletedTaskCount &&
		autoRunCompletedTaskCount > 0 &&
		onAutoRunResetTasks
			? [
					{
						id: 'resetAutoRunTasks',
						label: `Reset Finished Tasks in ${autoRunSelectedDocument}`,
						subtext: `Uncheck ${autoRunCompletedTaskCount} completed task${autoRunCompletedTaskCount !== 1 ? 's' : ''}`,
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
						label: 'Fuzzy File Search',
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
			label: 'Search: Agents',
			subtext: 'Filter agents in the sidebar',
			action: () => {
				setQuickActionOpen(false);
				setLeftSidebarOpen(true);
				setActiveFocus('sidebar');
				setTimeout(() => storeSetSessionFilterOpen(true), 50);
			},
		},
		{
			id: 'searchMessages',
			label: 'Search: Message History',
			subtext: 'Search messages in the current conversation',
			action: () => {
				setQuickActionOpen(false);
				setActiveFocus('main');
				setTimeout(() => storeSetOutputSearchOpen(true), 50);
			},
		},
		{
			id: 'searchFiles',
			label: 'Search: Files',
			subtext: 'Filter files in the file explorer',
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
			label: 'Search: History',
			subtext: 'Search in the history panel',
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
						label: 'Publish Document as GitHub Gist',
						subtext: 'Share current file as a public or secret gist',
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
						label: 'New Group Chat',
						shortcut: shortcuts.newGroupChat,
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
						label: 'Close Group Chat',
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
						label: `Remove Group Chat: ${groupChats.find((c) => c.id === activeGroupChatId)?.name || 'Group Chat'}`,
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
			label: 'Debug: Reset Busy State',
			subtext: 'Clear stuck thinking/busy state for all sessions',
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
				logger.info('[Debug] Reset busy state for all sessions');
				setQuickActionOpen(false);
			},
		},
		...(activeSession
			? [
					{
						id: 'debugResetSession',
						label: 'Debug: Reset Current Session',
						subtext: `Clear busy state for ${activeSession.name}`,
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
							logger.info('[Debug] Reset busy state for session:', undefined, activeSessionId);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		{
			id: 'debugLogSessions',
			label: 'Debug: Log Session State',
			subtext: 'Print session state to DevTools console',
			action: () => {
				// console.log (not logger.info) so output lands in the renderer DevTools
				// console where objects are expandable, not the main process log file.
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
						label: 'Debug: Playground',
						subtext: 'Open the developer playground',
						action: () => {
							setPlaygroundOpen(true);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(setDebugApplicationStatsOpen
			? [
					{
						id: 'debugApplicationStats',
						label: 'Debug: View Application Stats',
						subtext: 'Memory and data footprint per loaded agent',
						action: () => {
							setDebugApplicationStatsOpen(true);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		...(activeSession && activeSession.executionQueue?.length > 0 && onDebugReleaseQueuedItem
			? [
					{
						id: 'debugReleaseQueued',
						label: 'Debug: Release Next Queued Item',
						subtext: `Process next item from queue (${activeSession.executionQueue.length} queued)`,
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
						label: 'Debug: Wizard → Review Playbooks',
						subtext: 'Jump directly to Phase Review step (requires existing Auto Run docs)',
						action: () => {
							setDebugWizardModalOpen(true);
							setQuickActionOpen(false);
						},
					},
				]
			: []),
		{
			id: 'debugCopyInstallGuid',
			label: 'Debug: Copy Install GUID to Clipboard',
			subtext: 'Copy your unique installation identifier',
			action: async () => {
				try {
					const installationId = await window.maestro.leaderboard.getInstallationId();
					if (installationId) {
						await safeClipboardWrite(installationId);
						flashCopiedToClipboard(installationId, 'Install GUID Copied');
						logger.info(
							'[Debug] Installation GUID copied to clipboard:',
							undefined,
							installationId
						);
					} else {
						notifyToast({ type: 'error', title: 'Error', message: 'No installation GUID found' });
						logger.warn('[Debug] No installation GUID found');
					}
				} catch (err) {
					notifyToast({
						type: 'error',
						title: 'Error',
						message: 'Failed to copy installation GUID',
					});
					logger.error('[Debug] Failed to copy installation GUID:', undefined, err);
				}
				setQuickActionOpen(false);
			},
		},
	];

	const groupActions: QuickAction[] = [
		...(initialMode === 'main'
			? [
					{
						id: 'back',
						label: '← Back to main menu',
						action: () => {
							setMode('main');
							setSelectedIndex(0);
						},
					},
				]
			: []),
		{ id: 'no-group', label: '📁 No Group (Root)', action: () => handleMoveToGroup('') },
		...groups.map((g) => ({
			id: `group-${g.id}`,
			label: `${g.emoji} ${g.name}`,
			action: () => handleMoveToGroup(g.id),
		})),
		{ id: 'create-new', label: '+ Create New Group', action: handleCreateGroup },
	];

	// Agent switcher mode: clean names only, no "Jump to:" prefix.
	// Group chats are intentionally excluded — this modal is the agent jumper.
	const agentActions: QuickAction[] = sessions.map((s) => {
		const isRunning = s.state !== 'idle';
		// Find the AI tab that's currently working. Falls back to the active tab so
		// the row still has a tab label when the session-level state diverges from
		// per-tab state (e.g. connecting/error states).
		const busyTab = isRunning
			? (s.aiTabs?.find((t) => t.state === 'busy') ?? s.aiTabs?.find((t) => t.id === s.activeTabId))
			: undefined;
		const runningInfo = isRunning
			? {
					state: s.state,
					// Prefer the busy tab's start time; fall back to the session-level timer.
					thinkingStartTime: busyTab?.thinkingStartTime ?? s.thinkingStartTime,
					busyTabName: busyTab ? getTabDisplayName(busyTab) : undefined,
					queueCount: s.executionQueue?.length ?? 0,
				}
			: undefined;
		return {
			id: `jump-${s.id}`,
			label: s.name,
			action: () => {
				setActiveSessionId(s.id);
				revealJumpTarget(s);
			},
			// State (IDLE / running) is conveyed by the LIVE/IDLE section headers in
			// the agents-mode list, so we leave the per-row subtext empty here. Running
			// agents render rich live status via `runningInfo` instead.
			subtext: undefined,
			isRunningAgent: isRunning,
			runningInfo,
			bookmarked: !!s.bookmarked,
			agentSortKey: alphabetizeKey(s.name),
		};
	});

	const actions = mode === 'agents' ? agentActions : mode === 'main' ? mainActions : groupActions;

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
			return a.label.toLowerCase().includes(searchLower);
		})
		.sort((a, b) => {
			// When two jump-to-agent entries refer to the same agent name (e.g. a
			// top-level "rc" and a "Maestro subagent: rc" worktree child), prefer the
			// bookmarked one so it lands on selectedIndex 0 and gets the default
			// highlight + Enter-to-jump.
			const sameAgent =
				a.agentSortKey !== undefined &&
				b.agentSortKey !== undefined &&
				a.agentSortKey === b.agentSortKey;
			if (sameAgent && !!a.bookmarked !== !!b.bookmarked) {
				return a.bookmarked ? -1 : 1;
			}
			// In agents mode, bucket running agents above idle ones; alphabetize within
			// each bucket while skipping any leading emoji or punctuation so that
			// "🚀 Atlas" sorts next to "Atlas" rather than at the top of the list.
			if (mode === 'agents') {
				const aRunning = a.isRunningAgent ? 1 : 0;
				const bRunning = b.isRunningAgent ? 1 : 0;
				if (aRunning !== bRunning) return bRunning - aRunning;
				return alphabetizeKey(a.label).localeCompare(alphabetizeKey(b.label));
			}
			return a.label.localeCompare(b.label);
		});

	// Use a ref for filtered actions so the onSelect callback stays stable
	const filteredRef = useRef(filtered);
	filteredRef.current = filtered;

	// LIVE/IDLE bucket headers only earn their pixels in agents mode when both
	// buckets are present — a single-bucket list doesn't need a label above it.
	const showBucketHeaders =
		mode === 'agents' &&
		filtered.some((a) => a.isRunningAgent === true) &&
		filtered.some((a) => a.isRunningAgent === false);

	// Callback for when an item is selected (by Enter key or number hotkey)
	const handleSelectByIndex = useCallback(
		(index: number) => {
			const selectedAction = filteredRef.current[index];
			if (!selectedAction) return;

			// Don't close modal if action switches modes
			const switchesModes = selectedAction.id === 'moveToGroup' || selectedAction.id === 'back';
			selectedAction.action();
			if (!renamingSession && (mode === 'main' || mode === 'agents') && !switchesModes) {
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
		<div
			className="fixed inset-0 modal-overlay flex items-start justify-center pt-32 z-[9999] animate-in fade-in duration-100"
			onMouseDown={(e) => {
				// Dismiss when clicking outside the modal content (backdrop only).
				if (e.target === e.currentTarget && !renamingSession) {
					setQuickActionOpen(false);
				}
			}}
		>
			<div
				ref={modalRef}
				role="dialog"
				aria-modal="true"
				aria-label={mode === 'agents' ? 'Switch Agent' : 'Quick Actions'}
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
							placeholder="Enter new name..."
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
									? `Move ${activeSession?.name || 'session'} to...`
									: mode === 'agents'
										? 'Jump to agent...'
										: 'Type a command or jump to agent...'
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

							// In agents mode, show LIVE / IDLE section headers above the first running
							// and first idle rows so the two buckets are easy to tell apart at a glance.
							// Only render when both buckets exist (see `showBucketHeaders` above).
							const prev = i > 0 ? filtered[i - 1] : null;
							const isFirstRunning =
								showBucketHeaders && a.isRunningAgent === true && prev?.isRunningAgent !== true;
							const isFirstIdle =
								showBucketHeaders && a.isRunningAgent === false && prev?.isRunningAgent !== false;

							return (
								<React.Fragment key={a.id}>
									{isFirstRunning && (
										<SectionHeader label="LIVE" color={getStatusColor('busy', theme)} />
									)}
									{isFirstIdle && <SectionHeader label="IDLE" color={theme.colors.textDim} />}
									<button
										ref={i === selectedIndex ? selectedItemRef : null}
										onClick={() => {
											const switchesModes = a.id === 'moveToGroup' || a.id === 'back';
											a.action();
											if ((mode === 'main' || mode === 'agents') && !switchesModes)
												setQuickActionOpen(false);
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
												style={{
													backgroundColor: theme.colors.bgMain,
													color: theme.colors.textDim,
												}}
											>
												{numberBadge}
											</div>
										) : (
											<div className="flex-shrink-0 w-5 h-5" />
										)}
										<div className="flex flex-col flex-1 min-w-0">
											<div className="flex items-center gap-2 min-w-0">
												{a.runningInfo && (
													<span
														className="flex-shrink-0 inline-block w-2 h-2 rounded-full animate-pulse"
														style={{
															backgroundColor: getStatusColor(a.runningInfo.state, theme),
														}}
														aria-hidden="true"
													/>
												)}
												<span className="font-medium truncate">{a.label}</span>
											</div>
											{a.runningInfo ? (
												<RunningAgentSubtext
													info={a.runningInfo}
													now={now}
													theme={theme}
													isSelected={i === selectedIndex}
												/>
											) : (
												a.subtext && <span className="text-[10px] opacity-50">{a.subtext}</span>
											)}
										</div>
										{a.shortcut && (
											<span className="text-xs font-mono opacity-60">
												{formatShortcutKeys(a.shortcut.keys)}
											</span>
										)}
									</button>
								</React.Fragment>
							);
						})}
						{filtered.length === 0 && (
							<div className="px-4 py-4 text-center opacity-50 text-sm">No actions found</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
});
