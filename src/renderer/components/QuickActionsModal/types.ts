import type React from 'react';
import type { GroupChat } from '../../../shared/group-chat-types';
import type {
	Group,
	RightPanelTab,
	Session,
	SessionState,
	SettingsTab,
	Shortcut,
	Theme,
} from '../../types';
import type { WizardStep } from '../Wizard/WizardContext';

export type QuickActionMode = 'main' | 'move-to-group' | 'agents';

export interface QuickAction {
	id: string;
	label: string;
	action: () => void | Promise<void>;
	subtext?: string;
	shortcut?: Shortcut;
	// Agents-mode only: marks an agent whose state is not 'idle' so we can
	// bucket "active" agents at the top with a divider beneath them. Also true
	// for agents in an active Auto Run batch.
	isRunningAgent?: boolean;
	// Agents-mode only: session is in an active (non-paused) Auto Run batch.
	isInBatch?: boolean;
	// Agents-mode only: data needed to render rich live status for running agents.
	runningInfo?: {
		state: SessionState;
		thinkingStartTime?: number;
		busyTabName?: string;
		queueCount: number;
	};
	// Jump-to-agent actions only: bookmark state and stable sort key.
	bookmarked?: boolean;
	agentSortKey?: string;
}

export interface ActiveTabInfo {
	isTerminalMode: boolean;
	hasActiveTab: boolean;
	activeUnifiedIndex: number;
	unifiedTabCount: number;
}

export interface QuickActionsModalProps {
	theme: Theme;
	sessions: Session[];
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	activeSessionId: string;
	groups: Group[];
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
	shortcuts: Record<string, Shortcut>;
	initialMode?: QuickActionMode;
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
	onToggleTabEnterToSend?: () => void;
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
	onOpenMergeSession?: () => void;
	onOpenSendToAgent?: () => void;
	onToggleRemoteControl?: () => void;
	onQuickCreateWorktree?: (session: Session) => void;
	onOpenCreatePR?: (session: Session) => void;
	onSummarizeAndContinue?: () => void;
	canSummarizeActiveTab?: boolean;
	autoRunSelectedDocument?: string | null;
	autoRunCompletedTaskCount?: number;
	onAutoRunResetTasks?: () => void;
	onToggleAutoRunExpanded?: () => void;
	onClearActiveTerminal?: () => void;
	onCloseAllTabs?: () => void;
	onCloseOtherTabs?: () => void;
	onCloseTabsLeft?: () => void;
	onCloseTabsRight?: () => void;
	onCloseCurrentTab?: () => void;
	onMoveTabToFirst?: () => void;
	onMoveTabToLast?: () => void;
	onFocusActiveTab?: () => void;
	onCopyTabContext?: (tabId: string) => void;
	onExportTabHtml?: (tabId: string) => void;
	onPublishTabGist?: (tabId: string) => void;
	isFilePreviewOpen?: boolean;
	ghCliAvailable?: boolean;
	onPublishGist?: () => void;
	onOpenPlaybookExchange?: () => void;
	lastGraphFocusFile?: string;
	onOpenLastDocumentGraph?: () => void;
	onOpenSymphony?: () => void;
	onOpenDirectorNotes?: () => void;
	onOpenMaestroCue?: () => void;
	onConfigureCue?: (session: Session) => void;
	onOpenQueueBrowser?: () => void;
	onNewTab?: () => void;
	onNewFileTab?: () => void;
	onNewBrowserTab?: () => void;
	onNewTerminalTab?: () => void;
}
