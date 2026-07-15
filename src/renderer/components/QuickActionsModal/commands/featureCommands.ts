import type { Session } from '../../../types';
import type { ActiveTabInfo, QuickAction } from '../types';
import { editClipboardImage } from '../../ImageAnnotator/editClipboardImage';

interface BuildFeatureCommandsArgs {
	activeSession: Session | undefined;
	/** Resolved active tab type; AI-context commands only apply when this is 'ai'. */
	activeTabType?: ActiveTabInfo['activeTabType'];
	canSummarizeActiveTab?: boolean;
	markdownEditMode?: boolean;
	isFilePreviewOpen?: boolean;
	ghCliAvailable?: boolean;
	lastGraphFocusFile?: string;
	/** Name of the active markdown file, set only when one is open in the preview. */
	currentGraphFile?: string;
	hasActiveSessionCapability?: (
		capability:
			| 'supportsSessionStorage'
			| 'supportsSlashCommands'
			| 'supportsContextMerge'
			| 'supportsProjectMemory'
	) => boolean;
	setQuickActionOpen: (open: boolean) => void;
	setSuccessFlashNotification: (message: string | null) => void;
	setAgentSessionsOpen: (open: boolean) => void;
	setActiveAgentSessionId: (id: string | null) => void;
	setMemoryViewerOpen?: (open: boolean) => void;
	setFuzzyFileSearchOpen?: (open: boolean) => void;
	setUsageDashboardOpen?: (open: boolean) => void;
	setAgentRunDashboardOpen?: (open: boolean) => void;
	onSummarizeAndContinue?: () => void;
	onOpenMergeSession?: () => void;
	onOpenSendToAgent?: () => void;
	onOpenQueueBrowser?: () => void;
	onOpenPlaybookExchange?: () => void;
	onOpenSymphony?: () => void;
	onOpenDirectorNotes?: () => void;
	onOpenMaestroCue?: () => void;
	onOpenPianola?: () => void;
	onConfigureCue?: (session: Session) => void;
	onOpenLastDocumentGraph?: () => void;
	onOpenCurrentFileInGraph?: () => void;
	onPublishGist?: () => void;
	bionifyReadingMode: boolean;
	setBionifyReadingMode: (enabled: boolean) => void;
	audioFeedbackEnabled: boolean;
	setAudioFeedbackEnabled: (enabled: boolean) => void;
	idleNotificationEnabled: boolean;
	setIdleNotificationEnabled: (enabled: boolean) => void;
	showStarredSessionsSection: boolean;
	setShowStarredSessionsSection: (enabled: boolean) => void;
	shortcuts: {
		usageDashboard?: QuickAction['shortcut'];
		agentSessions?: QuickAction['shortcut'];
		openMemoryViewer?: QuickAction['shortcut'];
		executionQueue?: QuickAction['shortcut'];
		openSymphony?: QuickAction['shortcut'];
		directorNotes?: QuickAction['shortcut'];
		openCue?: QuickAction['shortcut'];
		fuzzyFileSearch?: QuickAction['shortcut'];
		editClipboardImage?: QuickAction['shortcut'];
	};
}

function flash(
	setSuccessFlashNotification: (message: string | null) => void,
	message: string
): void {
	setSuccessFlashNotification(message);
	setTimeout(() => setSuccessFlashNotification(null), 2000);
}

export function buildFeatureCommands({
	activeSession,
	activeTabType,
	canSummarizeActiveTab,
	markdownEditMode,
	isFilePreviewOpen,
	ghCliAvailable,
	lastGraphFocusFile,
	currentGraphFile,
	hasActiveSessionCapability,
	setQuickActionOpen,
	setSuccessFlashNotification,
	setAgentSessionsOpen,
	setActiveAgentSessionId,
	setMemoryViewerOpen,
	setFuzzyFileSearchOpen,
	setUsageDashboardOpen,
	setAgentRunDashboardOpen,
	onSummarizeAndContinue,
	onOpenMergeSession,
	onOpenSendToAgent,
	onOpenQueueBrowser,
	onOpenPlaybookExchange,
	onOpenSymphony,
	onOpenDirectorNotes,
	onOpenMaestroCue,
	onOpenPianola,
	onConfigureCue,
	onOpenLastDocumentGraph,
	onOpenCurrentFileInGraph,
	onPublishGist,
	bionifyReadingMode,
	setBionifyReadingMode,
	audioFeedbackEnabled,
	setAudioFeedbackEnabled,
	idleNotificationEnabled,
	setIdleNotificationEnabled,
	showStarredSessionsSection,
	setShowStarredSessionsSection,
	shortcuts,
}: BuildFeatureCommandsArgs): QuickAction[] {
	const commands: QuickAction[] = [
		{
			id: 'editClipboardImage',
			label: 'Edit Image from Clipboard',
			subtext: 'Open the image annotator on the current clipboard image',
			shortcut: shortcuts.editClipboardImage,
			action: () => {
				setQuickActionOpen(false);
				void editClipboardImage();
			},
		},
		{
			id: 'toggleBionifyReadingMode',
			label: bionifyReadingMode ? 'Turn Off Bionify Emphasis' : 'Turn On Bionify Emphasis',
			subtext: `Bionify emphasis: ${bionifyReadingMode ? 'enabled' : 'disabled'}`,
			action: () => {
				const newState = !bionifyReadingMode;
				setBionifyReadingMode(newState);
				flash(setSuccessFlashNotification, newState ? 'Bionify: ON' : 'Bionify: OFF');
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
				flash(
					setSuccessFlashNotification,
					newState ? 'Custom Notifications: ON' : 'Custom Notifications: OFF'
				);
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
				flash(
					setSuccessFlashNotification,
					newState ? 'Idle Notifications: ON' : 'Idle Notifications: OFF'
				);
				setQuickActionOpen(false);
			},
		},
		{
			id: 'toggleStarredSessionsSection',
			label: showStarredSessionsSection
				? 'Hide Starred Sessions Section'
				: 'Show Starred Sessions Section',
			subtext: `Starred Sessions section: ${showStarredSessionsSection ? 'visible' : 'hidden'}`,
			action: () => {
				const newState = !showStarredSessionsSection;
				setShowStarredSessionsSection(newState);
				flash(
					setSuccessFlashNotification,
					newState ? 'Starred Sessions: SHOWN' : 'Starred Sessions: HIDDEN'
				);
				setQuickActionOpen(false);
			},
		},
	];

	if (onOpenQueueBrowser) {
		commands.push({
			id: 'executionQueue',
			label: 'View Execution Queue',
			shortcut: shortcuts.executionQueue,
			subtext: 'Browse and manage queued prompts across agents',
			action: () => {
				onOpenQueueBrowser();
				setQuickActionOpen(false);
			},
		});
	}

	if (setUsageDashboardOpen) {
		commands.push({
			id: 'usageDashboard',
			label: 'Usage Dashboard',
			shortcut: shortcuts.usageDashboard,
			action: () => {
				setUsageDashboardOpen(true);
				setQuickActionOpen(false);
			},
		});
	}

	if (activeSession && hasActiveSessionCapability?.('supportsSessionStorage')) {
		commands.push({
			id: 'agentSessions',
			label: `View Agent Sessions for ${activeSession.name}`,
			shortcut: shortcuts.agentSessions,
			action: () => {
				setActiveAgentSessionId(null);
				setAgentSessionsOpen(true);
				setQuickActionOpen(false);
			},
		});
	}

	if (
		activeSession &&
		setMemoryViewerOpen &&
		hasActiveSessionCapability?.('supportsProjectMemory')
	) {
		commands.push({
			id: 'openMemoryViewer',
			label: `View Agent Memories for ${activeSession.name}`,
			shortcut: shortcuts.openMemoryViewer,
			action: () => {
				setMemoryViewerOpen(true);
				setQuickActionOpen(false);
			},
		});
	}

	if (activeTabType === 'ai' && canSummarizeActiveTab && onSummarizeAndContinue) {
		commands.push({
			id: 'summarizeAndContinue',
			label: 'Context: Compact',
			subtext: 'Compact context into a fresh tab',
			action: () => {
				onSummarizeAndContinue();
				setQuickActionOpen(false);
			},
		});
	}

	if (
		activeTabType === 'ai' &&
		activeSession &&
		hasActiveSessionCapability?.('supportsContextMerge') &&
		onOpenMergeSession
	) {
		commands.push({
			id: 'mergeSession',
			label: 'Context: Merge Into',
			subtext: 'Merge current context into another session',
			action: () => {
				onOpenMergeSession();
				setQuickActionOpen(false);
			},
		});
	}

	if (
		activeTabType === 'ai' &&
		activeSession &&
		hasActiveSessionCapability?.('supportsContextMerge') &&
		onOpenSendToAgent
	) {
		commands.push({
			id: 'sendToAgent',
			label: 'Context: Send to Agent',
			subtext: 'Transfer context to a different AI agent',
			action: () => {
				onOpenSendToAgent();
				setQuickActionOpen(false);
			},
		});
	}

	if (onOpenPlaybookExchange) {
		commands.push({
			id: 'openPlaybookExchange',
			label: 'Playbook Exchange',
			subtext: 'Browse and import community playbooks',
			action: () => {
				onOpenPlaybookExchange();
				setQuickActionOpen(false);
			},
		});
	}

	if (onOpenSymphony) {
		commands.push({
			id: 'openSymphony',
			label: 'Maestro Symphony',
			shortcut: shortcuts.openSymphony,
			subtext: 'Contribute to open source projects',
			action: () => {
				onOpenSymphony();
				setQuickActionOpen(false);
			},
		});
	}

	if (onOpenDirectorNotes) {
		commands.push({
			id: 'directorNotes',
			label: "Director's Notes",
			shortcut: shortcuts.directorNotes,
			subtext: 'View unified history and AI synopsis across all sessions',
			action: () => {
				onOpenDirectorNotes();
				setQuickActionOpen(false);
			},
		});
	}

	if (onOpenMaestroCue) {
		commands.push({
			id: 'maestro-cue',
			label: 'Maestro Cue',
			shortcut: shortcuts.openCue,
			subtext: 'Event-driven automation dashboard',
			action: () => {
				onOpenMaestroCue();
				setQuickActionOpen(false);
			},
		});
	}

	if (setAgentRunDashboardOpen) {
		commands.push({
			id: 'agent-run-dashboard',
			label: 'AgentRun Dashboard',
			subtext: 'Inspect agent runs, campaigns, events, reviews, and Pianola-linked work',
			action: () => {
				setAgentRunDashboardOpen(true);
				setQuickActionOpen(false);
			},
		});
	}

	if (onOpenPianola) {
		commands.push({
			id: 'pianola',
			label: 'Pianola',
			subtext: 'Autonomous manager: rules and decision log',
			action: () => {
				onOpenPianola();
				setQuickActionOpen(false);
			},
		});
	}

	if (onConfigureCue && activeSession) {
		commands.push({
			id: 'configure-cue',
			label: `Configure Maestro Cue: ${activeSession.name}`,
			subtext: 'Open YAML editor for event-driven automation',
			action: () => {
				onConfigureCue(activeSession);
				setQuickActionOpen(false);
			},
		});
	}

	if (currentGraphFile && onOpenCurrentFileInGraph) {
		commands.push({
			id: 'viewInDocumentGraph',
			label: 'View in Document Graph',
			subtext: `Focus the graph on ${currentGraphFile}`,
			shortcut: {
				id: 'viewInDocumentGraph',
				label: 'View in Document Graph',
				keys: ['Meta', 'Shift', 'g'],
			},
			action: () => {
				onOpenCurrentFileInGraph();
				setQuickActionOpen(false);
			},
		});
	}

	if (lastGraphFocusFile && onOpenLastDocumentGraph) {
		commands.push({
			id: 'lastDocumentGraph',
			label: 'Open Last Document Graph',
			subtext: `Re-open: ${lastGraphFocusFile}`,
			action: () => {
				onOpenLastDocumentGraph();
				setQuickActionOpen(false);
			},
		});
	}

	if (setFuzzyFileSearchOpen) {
		commands.push({
			id: 'fuzzyFileSearch',
			label: 'Fuzzy File Search',
			shortcut: shortcuts.fuzzyFileSearch,
			action: () => {
				setFuzzyFileSearchOpen(true);
				setQuickActionOpen(false);
			},
		});
	}

	if (isFilePreviewOpen && ghCliAvailable && onPublishGist && !markdownEditMode) {
		commands.push({
			id: 'publishGist',
			label: 'Publish Document as GitHub Gist',
			subtext: 'Share current file as a public or secret gist',
			action: () => {
				onPublishGist();
				setQuickActionOpen(false);
			},
		});
	}

	return commands;
}
