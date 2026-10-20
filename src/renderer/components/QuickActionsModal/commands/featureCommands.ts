import type { Session } from '../../../types';
import type { ActiveTabInfo, QuickAction } from '../types';
import { editClipboardImage } from '../../ImageAnnotator/editClipboardImage';
import { requestEditLastQueuedMessage } from '../../../services/editQueuedMessage';
import { requestSteerSend } from '../../../services/chatSteering';
import {
	keyboardModeToggleShadow,
	nextKeyboardMode,
	switchKeyboardMode,
} from '../../../services/keyboardMode';
import { useGroupChatStore } from '../../../stores/groupChatStore';
import { useUIStore } from '../../../stores/uiStore';
import { afterPaletteCloses } from '../utils/afterPaletteCloses';
import { DECK_MODE_CANCEL, DECK_MODE_KEYS } from '../../../constants/deckMode';
import { FIXED_SHORTCUTS } from '../../../constants/shortcuts';
import { KEYBOARD_MODE_LABELS, type KeyboardMode } from '../../../../shared/shortcut-types';

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
	/** Present only when Computer History can be opened here (Encore on, desktop). */
	onOpenComputerHistory?: () => void;
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
	/** Which keyboard binding set is live, so the entry can name the other one. */
	keyboardMode: KeyboardMode;
	shortcuts: {
		deckMode?: QuickAction['shortcut'];
		usageDashboard?: QuickAction['shortcut'];
		agentSessions?: QuickAction['shortcut'];
		openMemoryViewer?: QuickAction['shortcut'];
		executionQueue?: QuickAction['shortcut'];
		editLastQueuedMessage?: QuickAction['shortcut'];
		steerSend?: QuickAction['shortcut'];
		openSymphony?: QuickAction['shortcut'];
		directorNotes?: QuickAction['shortcut'];
		openCue?: QuickAction['shortcut'];
		computerHistory?: QuickAction['shortcut'];
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
	onOpenComputerHistory,
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
	keyboardMode,
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
			id: 'toggleKeyboardMode',
			label: `Switch to ${KEYBOARD_MODE_LABELS[nextKeyboardMode(keyboardMode)]} Keyboard Mode`,
			subtext: `Keyboard mode: ${KEYBOARD_MODE_LABELS[keyboardMode]}. Only one mode's bindings are live, and each keeps its own customizations.`,
			// The chord is hidden when another action's own binding has taken it:
			// the handler stands down in that case, so a badge here would promise a
			// key that does nothing. Settings > Shortcuts names the action instead.
			shortcut: keyboardModeToggleShadow() ? undefined : FIXED_SHORTCUTS.toggleKeyboardMode,
			action: () => {
				switchKeyboardMode();
				setQuickActionOpen(false);
			},
		},
		{
			// DECK MODE's only non-keyboard route in, and in default mode its only
			// route at all: the leader ships unassigned there (see its entry in the
			// default shortcut table), so without this the mode would exist for Vim
			// mode alone. Offered in every context, like the mode switch above,
			// because arming is about what the NEXT keystroke means rather than
			// about what currently has focus.
			id: 'deckMode',
			// Carries the leader's own wording, so searching "deck" or "leader"
			// finds it and the palette agrees with Settings > Shortcuts about what
			// this action is called. "Arm" is the verb because that is all it does:
			// the keystroke after it is what fires something.
			label: 'Arm Deck Mode (Leader Key)',
			// Counted from the table rather than listing the keys. A hand-written
			// list here would drift the first time a Deck key moves, and the user
			// would be reading a key that no longer fires - the table is on screen
			// the moment the mode arms, which is where the keys belong.
			subtext: `The next single key fires one of ${DECK_MODE_KEYS.length} actions, even from the composer. ${DECK_MODE_CANCEL.keys[0]} cancels.`,
			shortcut: shortcuts.deckMode,
			action: () => {
				setQuickActionOpen(false);
				// Armed AFTER the palette is gone, not inside the keystroke that
				// picked this row. A number hotkey (Cmd+3) reaches the window
				// handler after this action returns, and an already-armed mode
				// treats a chord as "the user meant something else" and disarms -
				// so arming synchronously would cancel the mode with the very
				// keypress that asked for it. The deferral also starts the one-shot
				// window when the user can actually use it rather than while the
				// palette still has focus. See `afterPaletteCloses`.
				afterPaletteCloses(() => useUIStore.getState().armDeckMode());
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

	if (activeSession) {
		// Listed even with an empty queue, and deliberately not hidden: a command a
		// user goes hunting for by name has to be findable, and the service says
		// which empty it hit ("Nothing queued to edit" vs "Only commands are
		// queued") rather than the palette guessing here.
		const editableQueuedCount = (activeSession.executionQueue ?? []).filter(
			(item) => item.type !== 'command'
		).length;
		commands.push({
			id: 'editLastQueuedMessage',
			label: 'Edit Last Queued Message',
			subtext:
				editableQueuedCount > 0
					? `Edit the newest of ${editableQueuedCount} queued message${
							editableQueuedCount === 1 ? '' : 's'
						}`
					: 'Nothing is queued on this agent',
			shortcut: shortcuts.editLastQueuedMessage,
			action: () => {
				setQuickActionOpen(false);
				requestEditLastQueuedMessage();
			},
		});
		// Listed for every AI-mode agent rather than only a steerable one, for the
		// same reason as the entry above: the service says why a steer cannot run
		// (wrong transport, nothing queued), which a hidden entry never could.
		// Not offered over a group chat, which covers the agent this would act on.
		if (activeSession.inputMode === 'ai' && !useGroupChatStore.getState().activeGroupChatId) {
			commands.push({
				id: 'steerSend',
				label: 'Steer Running Turn',
				subtext: 'Send the draft, or the newest queued message, into the turn in progress',
				shortcut: shortcuts.steerSend,
				action: () => {
					setQuickActionOpen(false);
					requestSteerSend();
				},
			});
		}
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

	if (onOpenComputerHistory) {
		commands.push({
			id: 'computer-history',
			label: 'Computer History',
			shortcut: shortcuts.computerHistory,
			subtext: 'Browse and search what you saw and typed across apps',
			action: () => {
				onOpenComputerHistory();
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
			// No chord. This used to advertise Cmd+Shift+G, which belongs to View
			// Git Log - the File Preview handled the key itself, so the graph
			// silently won whenever a markdown preview had focus. The key was in no
			// registry, so it could not be seen in Settings or rebound out of the
			// way. The graph keeps its toolbar button and this entry.
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
