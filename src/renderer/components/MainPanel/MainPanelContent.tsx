import React from 'react';

import { Spinner } from '../ui/Spinner';
import { TerminalOutput } from '../TerminalOutput';
import {
	TerminalView,
	createTabStateChangeHandler,
	createTabPidChangeHandler,
} from '../TerminalView';
import { InputArea } from '../InputArea';
import type { FilePreviewHandle } from '../FilePreview';
import { WizardConversationView, DocumentGenerationView } from '../InlineWizard';
import { BrowserTabView, type BrowserTabViewHandle } from './BrowserTabView';
import { TiledLayout, type PaneTabActions } from './TiledLayout';
import { PaneDropZones } from './PaneDropZones';
import { PaneDragOverlay } from './PaneDragOverlay';
import {
	findLeafById,
	findLeafByTabRef,
	focusPaneInSession,
	normalizeTabGroups,
	resolveTabRefTitle,
	splitPaneRectsByKind,
} from '../../utils/panelLayout';
import { updateSessionWith } from '../../stores/sessionStore';
import { useBrowserTabMounting } from '../../hooks/browser/useBrowserTabMounting';
import { useUIStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { withMonoFallback } from '../../../shared/fontStack';
import { useTabStore } from '../../stores/tabStore';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { outputSearchKeyFor } from '../../utils/outputSearch';
import type {
	Session,
	Theme,
	AITab,
	BatchRunState,
	BrowserTab,
	FilePreviewTab,
	ThinkingItem,
	QueuedItem,
	UnifiedTabRef,
	PaneRects,
} from '../../types';
import type { SlashCommand } from './types';
import type { TabCompletionSuggestion, TabCompletionFilter } from '../../hooks';
import type { FileNode } from '../../types/fileTree';
import type {
	SummarizeProgress,
	SummarizeResult,
	GroomingProgress,
	MergeResult,
} from '../../types/contextMerge';

// Lazy-loaded: FilePreview is the single aggregation point that pulls mermaid,
// react-syntax-highlighter, and the full react-markdown/remark/rehype stack into
// the bundle. None of it is needed until the user actually opens a file-preview
// tab (never on a fresh launch landing on an AI tab), so we code-split it behind
// first open to cut cold-start cost and idle memory. React.lazy preserves ref
// forwarding through FilePreview's memo()+forwardRef wrapper, so filePreviewRef
// keeps working once the chunk has mounted.
const FilePreview = React.lazy(() =>
	import('../FilePreview').then((m) => ({ default: m.FilePreview }))
);

export interface MainPanelContentProps {
	// Core state (guaranteed by parent guard)
	activeSession: Session;
	activeTab: AITab | null;
	theme: Theme;

	// File preview props (from useFilePreviewHandlers)
	activeFileTabId?: string | null;
	activeFileTab?: FilePreviewTab | null;
	activeBrowserTabId?: string | null;
	memoizedFilePreviewFile: { name: string; path: string; content: string } | null;
	filePreviewCwd: string;
	filePreviewSshRemoteId: string | undefined;
	filePreviewContainerRef: React.RefObject<HTMLDivElement>;
	filePreviewRef: React.RefObject<FilePreviewHandle>;
	handleFilePreviewClose: () => void;
	handleFilePreviewEditModeChange: (editMode: boolean) => void;
	handleFilePreviewSave: (path: string, content: string) => Promise<boolean | void>;
	handleFilePreviewEditContentChange: (content: string) => void;
	handleFilePreviewScrollPositionChange: (scrollTop: number) => void;
	handleFilePreviewSearchQueryChange: (searchQuery: string) => void;
	handleFilePreviewReload: () => void;
	handleBrowserTabUpdate?: (sessionId: string, tabId: string, updates: Partial<BrowserTab>) => void;
	/** Ref to the active (visible) BrowserTabView handle - used to extract the active tab's content. */
	browserViewRef?: React.MutableRefObject<BrowserTabViewHandle | null>;
	/** Per-tab BrowserTabView handle map for ALL mounted browser tabs of the active
	 *  agent. Lifted from MainPanel so the coworking browser responder can reach a
	 *  mounted (possibly hidden) tab's handle without stealing focus. */
	browserViewRefs?: React.MutableRefObject<Map<string, BrowserTabViewHandle>>;

	// Terminal mounting props
	terminalViewRefs: React.MutableRefObject<
		Map<string, { clearActiveTerminal: () => void; focusActiveTerminal: () => void }>
	>;
	mountedTerminalSessionIds: string[];
	mountedTerminalSessionsRef: React.MutableRefObject<Map<string, Session>>;
	terminalSearchOpen: boolean;
	setTerminalSearchOpen: (open: boolean) => void;
	/** Copy a highlighted terminal selection to the clipboard (right-click menu handler). */
	onTerminalCopySelection?: (text: string) => void;
	/** Send a highlighted terminal selection to another agent (right-click menu handler). */
	onTerminalSendSelectionToAgent?: (tabId: string, text: string) => void;

	// Layout
	isMobileLandscape: boolean;

	// Context warnings
	activeTabContextUsage: number;
	contextWarningsEnabled: boolean;
	contextWarningYellowThreshold: number;
	contextWarningRedThreshold: number;

	// Callbacks
	handleInputFocus: () => void;
	handleSessionClick: (sessionId: string, tabId?: string) => void;

	// Auto mode
	isCurrentSessionAutoMode: boolean;
	currentSessionBatchState?: BatchRunState | null;

	// hasCapability function
	hasCapability: (
		cap: keyof import('../../hooks/agent/useAgentCapabilities').AgentCapabilities
	) => boolean;

	// Pass-through props from MainPanelProps
	// (grouped to avoid enumerating every single prop)
	setInputValue: (value: string) => void;
	stagedImages: string[];
	setStagedImages: React.Dispatch<React.SetStateAction<string[]>>;
	setLightboxImage: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
	commandHistoryOpen: boolean;
	setCommandHistoryOpen: (open: boolean) => void;
	commandHistoryFilter: string;
	setCommandHistoryFilter: (filter: string) => void;
	commandHistorySelectedIndex: number;
	setCommandHistorySelectedIndex: (index: number) => void;
	slashCommandOpen: boolean;
	setSlashCommandOpen: (open: boolean) => void;
	slashCommands: SlashCommand[];
	selectedSlashCommandIndex: number;
	setSelectedSlashCommandIndex: (index: number) => void;
	tabCompletionOpen?: boolean;
	setTabCompletionOpen?: (open: boolean) => void;
	tabCompletionSuggestions?: TabCompletionSuggestion[];
	selectedTabCompletionIndex?: number;
	setSelectedTabCompletionIndex?: (index: number) => void;
	tabCompletionFilter?: TabCompletionFilter;
	setTabCompletionFilter?: (filter: import('../../hooks').TabCompletionFilter) => void;
	atMentionOpen?: boolean;
	setAtMentionOpen?: (open: boolean) => void;
	atMentionFilter?: string;
	setAtMentionFilter?: (filter: string) => void;
	atMentionStartIndex?: number;
	setAtMentionStartIndex?: (index: number) => void;
	atMentionItems?: import('../../hooks/input/useMentionPicker').MentionPickerItem[];
	atMentionCounts?: Record<import('../../hooks/input/useMentionPicker').MentionCategory, number>;
	atMentionCategory?: import('../../hooks/input/useMentionPicker').MentionCategory;
	setAtMentionCategory?: (
		category: import('../../hooks/input/useMentionPicker').MentionCategory
	) => void;
	selectedAtMentionIndex?: number;
	setSelectedAtMentionIndex?: (index: number) => void;
	inputRef: React.RefObject<HTMLTextAreaElement>;
	logsEndRef: React.RefObject<HTMLDivElement>;
	terminalOutputRef: React.RefObject<HTMLDivElement>;
	toggleInputMode: () => void;
	processInput: () => void;
	handleInterrupt: () => void;
	handleInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	handleDrop: (e: React.DragEvent<HTMLElement>) => void;
	thinkingItems: ThinkingItem[];
	onStopBatchRun?: (sessionId?: string) => void;
	onRemoveQueuedItem?: (itemId: string) => void;
	onTogglePauseQueuedItem?: (itemId: string) => void;
	onEditQueuedItem?: (itemId: string, patch: { text: string; images: string[] }) => void;
	onReorderQueuedItem?: (fromIndex: number, toIndex: number, tabId?: string) => void;
	onForceSendQueuedItem?: (itemId: string) => void;
	forcedParallelEnabled?: boolean;
	getForceSendContext?: (
		item: QueuedItem
	) => { targetTabBusy: boolean; otherBusyTabs: { id: string; displayName: string }[] } | null;
	onOpenQueueBrowser?: () => void;
	showFlashNotification?: (message: string) => void;

	// Summarization progress props
	summarizeProgress?: SummarizeProgress | null;
	summarizeResult?: SummarizeResult | null;
	summarizeStartTime?: number;
	isSummarizing?: boolean;
	onCancelSummarize?: () => void;
	onSummarizeAndContinue?: (tabId: string) => void;

	// Merge progress props
	mergeProgress?: GroomingProgress | null;
	mergeResult?: MergeResult | null;
	mergeStartTime?: number;
	isMerging?: boolean;
	mergeSourceName?: string;
	mergeTargetName?: string;
	onCancelMerge?: () => void;

	// Inline wizard exit handler
	onExitWizard?: () => void;

	// Per-kind action handlers for a tiled pane's chevron dropdown (bundled in
	// MainPanel where the same handlers already feed the TabBar). Forwarded to
	// TiledLayout so a hidden tiled tab still exposes its full menu.
	paneTabActions?: PaneTabActions;

	// Props forwarded to child components (from MainPanelProps)
	onDeleteLog?: (logId: string) => number | null;
	onScrollPositionChange?: (scrollTop: number) => void;
	onAtBottomChange?: (isAtBottom: boolean) => void;
	onInputBlur?: () => void;
	onOpenPromptComposer?: () => void;
	onReplayMessage?: (text: string, images?: string[]) => void;
	onForkConversation?: (logId: string) => void;
	onSessionRecover?: (opts: {
		sessionId: string;
		tabId: string;
		lastUserPrompt: string;
		groomContext: boolean;
	}) => void;
	isRecoveringSession?: boolean;
	sessionRecoveryError?: string | null;
	fileTree?: FileNode[];
	onFileClick?: (relativePath: string, options?: { openInNewTab?: boolean }) => void;
	refreshFileTree?: (
		sessionId: string
	) => Promise<import('../../utils/fileExplorer').FileTreeChanges | undefined>;
	onOpenSavedFileInTab?: (file: {
		path: string;
		name: string;
		content: string;
		sshRemoteId?: string;
	}) => void;
	onShowAgentErrorModal?: (error?: import('../../types').AgentError) => void;
	canGoBack?: boolean;
	canGoForward?: boolean;
	onNavigateBack?: () => void;
	onNavigateForward?: () => void;
	backHistory?: { name: string; path: string; scrollTop?: number }[];
	forwardHistory?: { name: string; path: string; scrollTop?: number }[];
	currentHistoryIndex?: number;
	onNavigateToIndex?: (index: number) => void;
	onOpenFuzzySearch?: () => void;
	onShortcutUsed?: (shortcutId: string) => void;
	ghCliAvailable?: boolean;
	onPublishGist?: () => void;
	hasGist?: boolean;
	onOpenInGraph?: () => void;
	/** Open the currently previewed file in a new Maestro browser tab. */
	onOpenInBrowser?: () => void;
	onPublishMessageGist?: (text: string, messageId?: string) => void;
	onToggleTabReadOnlyMode?: () => void;
	onToggleTabSaveToHistory?: () => void;
	onToggleTabShowThinking?: () => void;
	onToggleTabEnterToSend?: () => void;

	// Wizard callbacks
	onWizardComplete?: () => void;
	onWizardCompleteAndStartAutoRun?: () => void;
	onWizardDocumentSelect?: (index: number) => void;
	onWizardContentChange?: (content: string, docIndex: number) => void;
	onWizardLetsGo?: () => void;
	onWizardRetry?: () => void;
	onWizardClearError?: () => void;
	onToggleWizardShowThinking?: () => void;
	onWizardCancelGeneration?: () => void;

	// Model/Effort quick-change pills
	currentModel?: string;
	currentEffort?: string;
	availableModels?: string[];
	availableEfforts?: string[];
	onModelChange?: (model: string) => void;
	onEffortChange?: (effort: string) => void;
}

export const MainPanelContent = React.memo(function MainPanelContent(props: MainPanelContentProps) {
	const {
		activeSession,
		activeTab,
		theme,
		activeFileTabId,
		activeFileTab,
		activeBrowserTabId,
		memoizedFilePreviewFile,
		filePreviewCwd,
		filePreviewSshRemoteId,
		filePreviewContainerRef,
		filePreviewRef,
		handleFilePreviewClose,
		handleFilePreviewEditModeChange,
		handleFilePreviewSave,
		handleFilePreviewEditContentChange,
		handleFilePreviewScrollPositionChange,
		handleFilePreviewSearchQueryChange,
		handleFilePreviewReload,
		handleBrowserTabUpdate,
		browserViewRef,
		browserViewRefs: browserViewRefsProp,
		terminalViewRefs,
		mountedTerminalSessionIds,
		mountedTerminalSessionsRef,
		terminalSearchOpen,
		setTerminalSearchOpen,
		onTerminalCopySelection,
		onTerminalSendSelectionToAgent,
		isMobileLandscape,
		activeTabContextUsage,
		contextWarningsEnabled,
		contextWarningYellowThreshold,
		contextWarningRedThreshold,
		handleInputFocus,
		handleSessionClick,
		isCurrentSessionAutoMode,
		currentSessionBatchState,
		hasCapability,
		setInputValue,
		stagedImages,
		setStagedImages,
		setLightboxImage,
		commandHistoryOpen,
		setCommandHistoryOpen,
		commandHistoryFilter,
		setCommandHistoryFilter,
		commandHistorySelectedIndex,
		setCommandHistorySelectedIndex,
		slashCommandOpen,
		setSlashCommandOpen,
		slashCommands,
		selectedSlashCommandIndex,
		setSelectedSlashCommandIndex,
		tabCompletionOpen,
		setTabCompletionOpen,
		tabCompletionSuggestions,
		selectedTabCompletionIndex,
		setSelectedTabCompletionIndex,
		tabCompletionFilter,
		setTabCompletionFilter,
		atMentionOpen,
		setAtMentionOpen,
		atMentionFilter,
		setAtMentionFilter,
		atMentionStartIndex,
		setAtMentionStartIndex,
		atMentionItems,
		atMentionCounts,
		atMentionCategory,
		setAtMentionCategory,
		selectedAtMentionIndex,
		setSelectedAtMentionIndex,
		inputRef,
		logsEndRef,
		terminalOutputRef,
		toggleInputMode,
		processInput,
		handleInterrupt,
		handleInputKeyDown,
		handlePaste,
		handleDrop,
		thinkingItems,
		onStopBatchRun,
		onRemoveQueuedItem,
		onTogglePauseQueuedItem,
		onEditQueuedItem,
		onReorderQueuedItem,
		onForceSendQueuedItem,
		forcedParallelEnabled,
		getForceSendContext,
		onOpenQueueBrowser,
		showFlashNotification,
		summarizeProgress,
		summarizeResult,
		summarizeStartTime = 0,
		isSummarizing = false,
		onCancelSummarize,
		onSummarizeAndContinue,
		mergeProgress,
		mergeResult,
		mergeStartTime = 0,
		isMerging = false,
		mergeSourceName,
		mergeTargetName,
		onCancelMerge,
		onExitWizard,
		paneTabActions,
		onDeleteLog,
		onScrollPositionChange,
		onAtBottomChange,
		onInputBlur,
		onOpenPromptComposer,
		onReplayMessage,
		onForkConversation,
		onSessionRecover,
		isRecoveringSession,
		sessionRecoveryError,
		fileTree,
		onFileClick,
		refreshFileTree,
		onOpenSavedFileInTab,
		onShowAgentErrorModal,
		canGoBack,
		canGoForward,
		onNavigateBack,
		onNavigateForward,
		backHistory,
		forwardHistory,
		currentHistoryIndex,
		onNavigateToIndex,
		onOpenFuzzySearch,
		onShortcutUsed,
		ghCliAvailable,
		onPublishGist,
		hasGist,
		onOpenInGraph,
		onOpenInBrowser,
		onPublishMessageGist,
		onToggleTabReadOnlyMode,
		onToggleTabSaveToHistory,
		onToggleTabShowThinking,
		onToggleTabEnterToSend,
		onWizardComplete,
		onWizardCompleteAndStartAutoRun,
		onWizardDocumentSelect,
		onWizardContentChange,
		onWizardLetsGo,
		onWizardRetry,
		onWizardClearError,
		onToggleWizardShowThinking,
		onWizardCancelGeneration,
		// Model/Effort quick-change pills
		currentModel,
		currentEffort,
		availableModels,
		availableEfforts,
		onModelChange,
		onEffortChange,
	} = props;

	// Keep the selected tab state urgent while moving the expensive transcript
	// remount behind a guaranteed paint. Two animation frames let the tab bar and
	// pending surface reach the screen before React parses and mounts the next
	// conversation. Rapid tab changes cancel the stale target.
	const [renderedAiTarget, setRenderedAiTarget] = React.useState(() => ({
		sessionId: activeSession.id,
		tabId: activeSession.activeTabId,
	}));
	React.useEffect(() => {
		const nextTarget = {
			sessionId: activeSession.id,
			tabId: activeSession.activeTabId,
		};
		if (renderedAiTarget.sessionId !== activeSession.id) {
			setRenderedAiTarget(nextTarget);
			return;
		}
		if (renderedAiTarget.tabId === activeSession.activeTabId) return;

		let contentFrame = 0;
		const paintFrame = requestAnimationFrame(() => {
			contentFrame = requestAnimationFrame(() => setRenderedAiTarget(nextTarget));
		});
		return () => {
			cancelAnimationFrame(paintFrame);
			if (contentFrame) cancelAnimationFrame(contentFrame);
		};
	}, [
		activeSession.id,
		activeSession.activeTabId,
		renderedAiTarget.sessionId,
		renderedAiTarget.tabId,
	]);

	const renderedAiTabId =
		renderedAiTarget.sessionId === activeSession.id &&
		activeSession.aiTabs?.some((tab) => tab.id === renderedAiTarget.tabId)
			? renderedAiTarget.tabId
			: activeSession.activeTabId;
	const renderedActiveTab =
		activeSession.aiTabs?.find((tab) => tab.id === renderedAiTabId) ?? activeTab;
	// Preserve the exact session object while the selected tab is pending so the
	// memoized TerminalOutput does not repeat its expensive render behind the
	// loading surface. Once the deferred target commits, hand it the current
	// session object and let the keyed remount render the selected transcript.
	const renderedTranscriptSessionRef = React.useRef(activeSession);
	if (
		renderedTranscriptSessionRef.current.id !== activeSession.id ||
		renderedAiTabId === activeSession.activeTabId
	) {
		renderedTranscriptSessionRef.current = activeSession;
	}
	const renderedTranscriptSession = renderedTranscriptSessionRef.current;
	const isAiTabContentPending =
		activeSession.inputMode === 'ai' &&
		!activeFileTabId &&
		!activeBrowserTabId &&
		renderedAiTabId !== activeSession.activeTabId;

	// Self-sourced from settingsStore. withMonoFallback guarantees the AI-output
	// and terminal surfaces degrade to monospace instead of the browser's serif
	// default when the stored font (a bare name from the picker) isn't installed.
	const fontFamily = useSettingsStore((s) => withMonoFallback(s.fontFamily));
	const defaultShell = useSettingsStore((s) => s.defaultShell);
	const fontSize = useSettingsStore((s) => s.fontSize);
	const enterToSendAI = useSettingsStore((s) => s.enterToSendAI);
	const chatRawTextMode = useSettingsStore((s) => s.chatRawTextMode);
	const userMessageAlignment = useSettingsStore((s) => s.userMessageAlignment);
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const maxOutputLines = useSettingsStore((s) => s.maxOutputLines);
	// Self-sourced from uiStore
	const activeFocus = useUIStore((s) => s.activeFocus);
	// Output ("Find") search is scoped per agent+AI-tab. Read this window's slot
	// by its key so the Find bar doesn't follow the user to other agents/tabs.
	const outputSearchKey = outputSearchKeyFor(activeSession.id, activeSession.activeTabId);
	const outputSearchSlot = useUIStore((s) => s.outputSearchByKey?.[outputSearchKey]);
	const outputSearchOpen = outputSearchSlot?.open ?? false;
	const outputSearchQuery = outputSearchSlot?.query ?? '';
	const outputSearchRegex = outputSearchSlot?.regex ?? false;
	const setOutputSearchOpen = React.useCallback(
		(v: boolean | ((prev: boolean) => boolean)) =>
			useUIStore.getState().setOutputSearchOpen(outputSearchKey, v),
		[outputSearchKey]
	);
	const setOutputSearchQuery = React.useCallback(
		(v: string | ((prev: string) => string)) =>
			useUIStore.getState().setOutputSearchQuery(outputSearchKey, v),
		[outputSearchKey]
	);
	const setOutputSearchRegex = React.useCallback(
		(v: boolean | ((prev: boolean) => boolean)) =>
			useUIStore.getState().setOutputSearchRegex(outputSearchKey, v),
		[outputSearchKey]
	);

	// Browser tab keep-alive: which of this agent's browser tabs stay mounted.
	// Under the default 'off' policy this is just the active browser tab (mount-only-active,
	// original behavior); 'recent'/'all' keep extra webviews mounted but hidden so their
	// page state survives switching away. All mounted tabs render through the persistent
	// overlay block below (mirroring the terminal keep-alive overlay).
	const mountedBrowserTabIds = useBrowserTabMounting(activeSession);

	// Self-heal tiled groups when a member tab is closed. Closing a tab removes it
	// from aiTabs/filePreviewTabs/etc. but the per-kind close paths don't touch group
	// layouts, so the pane's leaf is left referencing a now-dead tab (rendering the
	// "no longer available" fallback or an empty webview). normalizeTabGroups prunes
	// the dangling leaf, collapses the split, and dissolves the group if it drops
	// below two panes - the same cleanup it does on restore. It is idempotent by
	// reference (returns the same session when nothing dangles), so this only commits
	// when a group actually needs healing, and never loops. Covers EVERY close path
	// (single, close-all, bulk, pane-menu) in one place instead of patching each.
	// useLayoutEffect (not useEffect) so the prune commits before paint - otherwise
	// the dead pane flashes "no longer available" for one frame before healing.
	React.useLayoutEffect(() => {
		if (!activeSession.tabGroups?.length) return;
		if (normalizeTabGroups(activeSession) === activeSession) return;
		updateSessionWith(activeSession.id, (s) => normalizeTabGroups(s));
	}, [
		activeSession.id,
		activeSession.tabGroups,
		activeSession.aiTabs,
		activeSession.filePreviewTabs,
		activeSession.terminalTabs,
		activeSession.browserTabs,
	]);

	// Tab tiling (split panes): when a tab group is active, it takes over the
	// panel and renders its tiled layout instead of the single-view content. This
	// branch is ahead of the file/terminal/browser routing below so the group wins.
	const activeGroup =
		activeSession.activeGroupId != null
			? activeSession.tabGroups?.find((g) => g.id === activeSession.activeGroupId)
			: undefined;
	// Current single-view tab ref (used only when no group is active): a tab drop
	// onto the panel then pairs this tab with the dragged one into a new group. The
	// precedence mirrors the single-view routing below (terminal mode -> terminal;
	// else file, else browser, else the AI tab). Null when nothing tileable is
	// showing (an empty agent) so a drop is a no-op.
	const singleViewRef: UnifiedTabRef | null = React.useMemo(() => {
		if (activeSession.inputMode === 'terminal' && activeSession.activeTerminalTabId) {
			return { type: 'terminal', id: activeSession.activeTerminalTabId };
		}
		if (activeFileTabId) return { type: 'file', id: activeFileTabId };
		if (activeBrowserTabId) return { type: 'browser', id: activeBrowserTabId };
		if (activeTab) return { type: 'ai', id: activeTab.id };
		return null;
	}, [
		activeSession.inputMode,
		activeSession.activeTerminalTabId,
		activeFileTabId,
		activeBrowserTabId,
		activeTab,
	]);
	// Title of the single-view tab (the first tab placed into a new group), resolved
	// across all four kinds via the shared resolver so auto-naming a group off a
	// terminal/browser view uses its real title, not a generic "Tabs".
	const singleViewTitle = singleViewRef ? resolveTabRefTitle(activeSession, singleViewRef) : 'Tabs';
	// Transient maximize/zoom (Ctrl+Cmd+Z): id of the pane rendered full-panel.
	const zoomedPaneId = useUIStore((s) => s.zoomedPaneId);
	// When a group is active, input routes to the tab its focused pane references
	// (the focus handlers keep activeTabId in sync). A non-AI focused pane hides
	// the AI input, matching how single-view suppresses it for non-AI tabs.
	const groupFocusedLeaf =
		activeGroup && activeGroup.focusedPaneId
			? findLeafById(activeGroup.layout, activeGroup.focusedPaneId)
			: null;
	const groupFocusedIsNonAi =
		!!groupFocusedLeaf && groupFocusedLeaf.kind === 'leaf' && groupFocusedLeaf.tab.type !== 'ai';
	// The browser tab id of the group's focused pane (if the focused pane is a
	// browser), so only that tiled webview holds Chromium keyboard input.
	const groupFocusedBrowserTabId =
		groupFocusedLeaf && groupFocusedLeaf.kind === 'leaf' && groupFocusedLeaf.tab.type === 'browser'
			? groupFocusedLeaf.tab.id
			: null;
	// Tiling geometry published by TiledLayout: pane content-box rects keyed by
	// `tabRefKey` (e.g. `terminal:<id>` / `browser:<id>`) relative to this panel.
	// The keep-alive terminal/browser overlays below reposition onto these rects
	// so those guests tile without unmount/remount. Empty when no group / no such
	// leaves; TiledLayout clears it on unmount so no stale geometry lingers.
	const [paneRects, setPaneRects] = React.useState<PaneRects>(() => new Map());
	// Split the published rects by kind (bare tab id keys) so each overlay can look
	// its tab up directly. Recomputed only when the map changes.
	const { terminals: terminalPaneRects, browsers: browserPaneRects } = React.useMemo(
		() => splitPaneRectsByKind(paneRects),
		[paneRects]
	);
	// Click-to-focus for tiled terminal/browser panes: their live overlay sits on
	// top of the transparent PaneFrame slot, so a click lands on the overlay (not
	// the frame's own onMouseDown). This routes the click back to the owning leaf
	// so focusedPaneId updates and the focus ring / AI-input suppression follow.
	const focusTiledPaneByTab = React.useCallback(
		(ref: UnifiedTabRef) => {
			if (!activeGroup) return;
			const leaf = findLeafByTabRef(activeGroup.layout, ref);
			if (!leaf || leaf.kind !== 'leaf') return;
			if (activeGroup.focusedPaneId === leaf.id) return;
			const groupId = activeGroup.id;
			const leafId = leaf.id;
			updateSessionWith(activeSession.id, (s) => focusPaneInSession(s, groupId, leafId));
		},
		[activeGroup, activeSession.id]
	);
	// Number of open modal/overlay layers. When any layer is open over a browser
	// tab (e.g. the Tab Switcher), the guest <webview> must release Chromium input
	// focus so keyboard navigation lands in the modal instead of the page. Driving
	// isActive off this re-blurs the webview the moment a layer opens.
	const { layerCount } = useLayerStack();
	// Per-tab BrowserTabView handles. The single browserViewRef passed from MainPanel must
	// point at the active (visible) tab's handle so resolveBrowserContent reads that webview.
	const fallbackBrowserViewRefs = React.useRef<Map<string, BrowserTabViewHandle>>(new Map());
	const browserViewRefs = browserViewRefsProp ?? fallbackBrowserViewRefs;
	React.useEffect(() => {
		if (!browserViewRef) return;
		const activeId = activeSession.activeBrowserTabId;
		browserViewRef.current =
			activeSession.inputMode === 'ai' && activeId
				? (browserViewRefs.current.get(activeId) ?? null)
				: null;
	}, [
		browserViewRef,
		activeSession.inputMode,
		activeSession.activeBrowserTabId,
		mountedBrowserTabIds,
	]);

	// The shared AI input renders exactly once, below whichever content the panel is
	// showing - the single-view routing OR a tiled group. It targets
	// activeSession.activeTabId, which focusPaneInSession keeps synced to a tiled
	// group's focused AI pane, so inside a group it drives that pane's conversation.
	// Hidden: mobile landscape, wizard doc generation, terminal mode (xterm owns
	// input), and when a group's focused pane is a non-AI tab. In single view it also
	// hides while a browser or file tab owns the panel (those have no AI input); a
	// group ignores those stale single-view ids.
	const shouldShowInputArea =
		!isMobileLandscape &&
		!activeTab?.wizardState?.isGeneratingDocs &&
		!groupFocusedIsNonAi &&
		activeSession.inputMode !== 'terminal' &&
		(!!activeGroup || (!activeBrowserTabId && !activeFileTabId));

	return (
		/* Content area: Show FilePreview when file tab is active, otherwise show terminal output */
		/* Content wrapper: always-rendered relative container so terminal overlay covers
		     only the content area. Terminal sessions are mounted here regardless of whether
		     file preview, AI output, or terminal is active. */
		<div className="flex-1 min-h-0 overflow-hidden relative flex flex-col">
			{/* Tiling drop-zone overlay: inert (click-through) until a tab drag begins,
			    then hit-tests the panel to tile the dropped tab. Sits above the content
			    (z-30) and below modal layers. Reads/writes only the tiling dataTransfer
			    channel, so it never disturbs tab-bar reorder or multi-window drag-out. */}
			<PaneDropZones
				session={activeSession}
				activeGroup={activeGroup ?? null}
				activeStandaloneRef={singleViewRef}
				activeStandaloneTitle={singleViewTitle}
				theme={theme}
			/>
			{/* Pointer-driven pane REARRANGE highlight (swap/move/pop-out). Separate from
			    PaneDropZones, which handles the native-DnD tab-bar -> panel tiling. */}
			<PaneDragOverlay theme={theme} />
			{/* Tab tiling: an active tab group takes over the panel (ahead of the
			    file/terminal/browser routing). The keep-alive terminal/browser overlays
			    below still mount so their guests survive; they stay hidden while a group
			    is active because no terminal/browser tab is the active single view. */}
			{activeGroup ? (
				<TiledLayout
					group={activeGroup}
					session={activeSession}
					theme={theme}
					zoomedPaneId={zoomedPaneId}
					onPaneRectsChange={setPaneRects}
					paneTabActions={paneTabActions}
				/>
			) : /* Browser tabs render through the persistent keep-alive overlay block below (not
			    inline) so their <webview> never remounts when switching tabs. Skip rendering
			    inline content when loading a remote file - loading state takes over the area. */
			activeSession.inputMode === 'ai' && activeFileTab?.isLoading ? (
				<div
					className="flex-1 flex items-center justify-center"
					style={{ backgroundColor: theme.colors.bgMain }}
				>
					<div className="flex flex-col items-center gap-3">
						<Spinner size={32} color={theme.colors.accent} />
						<div className="text-center">
							<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Loading {activeFileTab.name}
								{activeFileTab.extension}
							</div>
							<div className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
								Fetching from remote server...
							</div>
						</div>
					</div>
				</div>
			) : activeSession.inputMode === 'ai' &&
			  activeFileTabId &&
			  activeFileTab &&
			  memoizedFilePreviewFile ? (
				// New file tab system - FilePreview rendered as tab content (no close button, tab handles closing)
				// Note: All props are memoized to prevent unnecessary re-renders that cause image flickering
				<div
					ref={filePreviewContainerRef}
					tabIndex={-1}
					className="flex-1 overflow-hidden outline-none"
				>
					<React.Suspense fallback={null}>
						<FilePreview
							ref={filePreviewRef}
							file={memoizedFilePreviewFile}
							onClose={handleFilePreviewClose}
							isTabMode={true}
							theme={theme}
							markdownEditMode={activeFileTab.editMode}
							setMarkdownEditMode={handleFilePreviewEditModeChange}
							onSave={handleFilePreviewSave}
							shortcuts={shortcuts}
							fileTree={fileTree}
							cwd={filePreviewCwd}
							onFileClick={onFileClick}
							// Per-tab navigation history for breadcrumb navigation
							canGoBack={canGoBack}
							canGoForward={canGoForward}
							onNavigateBack={onNavigateBack}
							onNavigateForward={onNavigateForward}
							backHistory={backHistory}
							forwardHistory={forwardHistory}
							currentHistoryIndex={currentHistoryIndex}
							onNavigateToIndex={onNavigateToIndex}
							onOpenFuzzySearch={onOpenFuzzySearch}
							onShortcutUsed={onShortcutUsed}
							ghCliAvailable={ghCliAvailable}
							onPublishGist={onPublishGist}
							hasGist={hasGist}
							onOpenInGraph={onOpenInGraph}
							onOpenInBrowser={onOpenInBrowser}
							sshRemoteId={filePreviewSshRemoteId}
							// Pass external edit content for persistence across tab switches
							externalEditContent={activeFileTab.editContent}
							onEditContentChange={handleFilePreviewEditContentChange}
							// Pass scroll position props for persistence across tab switches
							initialScrollTop={activeFileTab.scrollTop}
							onScrollPositionChange={handleFilePreviewScrollPositionChange}
							// Pass search query props for persistence across tab switches
							initialSearchQuery={activeFileTab.searchQuery}
							onSearchQueryChange={handleFilePreviewSearchQueryChange}
							// File change detection
							lastModified={activeFileTab.lastModified}
							onReloadFile={handleFilePreviewReload}
							// Phase 2: per-tab preview tier override.
							previewTierOverride={activeFileTab.previewTierOverride}
							onPreviewTierChange={(tier) =>
								useTabStore.getState().setFileTabPreviewTier(activeFileTabId, tier)
							}
							// HTML render mode (per-tab, persists across tab switches).
							htmlRenderMode={activeFileTab.htmlRenderMode}
							onHtmlRenderModeChange={(value) =>
								useTabStore.getState().setFileTabHtmlRenderMode(activeFileTabId, value)
							}
							// Transient deep-link scroll target. FilePreview clears this
							// via onPendingScrollToLineConsumed once the editor has
							// jumped, so subsequent re-renders don't re-scroll.
							pendingScrollToLine={activeFileTab.pendingScrollToLine}
							onPendingScrollToLineConsumed={() =>
								useTabStore.getState().clearFileTabPendingScrollToLine(activeFileTabId)
							}
						/>
					</React.Suspense>
				</div>
			) : (
				<>
					{/* Logs Area - Show DocumentGenerationView while generating OR when docs exist (waiting for user to click Exit Wizard), WizardConversationView when wizard is active, otherwise show TerminalOutput */}
					{/* Note: wizardState is per-tab (stored on activeTab), not per-session */}
					{/* User clicks "Exit Wizard" button in DocumentGenerationView which calls onWizardComplete to convert tab to normal session */}
					<div className="flex-1 overflow-hidden flex flex-col relative" data-tour="main-terminal">
						{activeSession.inputMode === 'ai' &&
						(renderedActiveTab?.wizardState?.isGeneratingDocs ||
							(renderedActiveTab?.wizardState?.generatedDocuments?.length ?? 0) > 0) ? (
							<DocumentGenerationView
								key={`wizard-gen-${activeSession.id}-${renderedAiTabId}`}
								theme={theme}
								documents={renderedActiveTab?.wizardState?.generatedDocuments ?? []}
								currentDocumentIndex={renderedActiveTab?.wizardState?.currentDocumentIndex ?? 0}
								isGenerating={renderedActiveTab?.wizardState?.isGeneratingDocs ?? false}
								streamingContent={renderedActiveTab?.wizardState?.streamingContent}
								onComplete={onWizardComplete || (() => {})}
								onCompleteAndStartAutoRun={onWizardCompleteAndStartAutoRun}
								onDocumentSelect={onWizardDocumentSelect || (() => {})}
								folderPath={
									renderedActiveTab?.wizardState?.subfolderPath ??
									renderedActiveTab?.wizardState?.autoRunFolderPath
								}
								onContentChange={onWizardContentChange}
								progressMessage={renderedActiveTab?.wizardState?.progressMessage}
								currentGeneratingIndex={renderedActiveTab?.wizardState?.currentGeneratingIndex}
								totalDocuments={renderedActiveTab?.wizardState?.totalDocuments}
								onCancel={onWizardCancelGeneration}
								subfolderName={renderedActiveTab?.wizardState?.subfolderName}
								startedAt={renderedActiveTab?.wizardState?.docGenerationStartedAt}
							/>
						) : activeSession.inputMode === 'ai' && renderedActiveTab?.wizardState?.isActive ? (
							<WizardConversationView
								key={`wizard-${activeSession.id}-${renderedAiTabId}`}
								theme={theme}
								conversationHistory={renderedActiveTab.wizardState.conversationHistory}
								isLoading={renderedActiveTab.wizardState.isWaiting ?? false}
								agentName={activeSession.name}
								confidence={renderedActiveTab.wizardState.confidence}
								ready={renderedActiveTab.wizardState.ready}
								onLetsGo={onWizardLetsGo}
								error={renderedActiveTab.wizardState.error}
								onRetry={onWizardRetry}
								onClearError={onWizardClearError}
								showThinking={renderedActiveTab.wizardState.showWizardThinking ?? false}
								thinkingContent={renderedActiveTab.wizardState.thinkingContent ?? ''}
								toolExecutions={renderedActiveTab.wizardState.toolExecutions ?? []}
								hasStartedGenerating={
									renderedActiveTab.wizardState.isGeneratingDocs ||
									(renderedActiveTab.wizardState.generatedDocuments?.length ?? 0) > 0
								}
								setLightboxImage={setLightboxImage}
							/>
						) : (
							<TerminalOutput
								key={`${activeSession.id}-${renderedAiTabId}`}
								ref={terminalOutputRef}
								session={renderedTranscriptSession}
								theme={theme}
								fontFamily={fontFamily}
								activeFocus={activeFocus}
								outputSearchOpen={outputSearchOpen}
								outputSearchQuery={outputSearchQuery}
								outputSearchRegex={outputSearchRegex}
								setOutputSearchOpen={setOutputSearchOpen}
								setOutputSearchQuery={setOutputSearchQuery}
								setOutputSearchRegex={setOutputSearchRegex}
								setActiveFocus={useUIStore.getState().setActiveFocus}
								setLightboxImage={setLightboxImage}
								inputRef={inputRef}
								logsEndRef={logsEndRef}
								maxOutputLines={maxOutputLines}
								onDeleteLog={onDeleteLog}
								onRemoveQueuedItem={onRemoveQueuedItem}
								onTogglePauseQueuedItem={onTogglePauseQueuedItem}
								onEditQueuedItem={onEditQueuedItem}
								onReorderQueuedItem={onReorderQueuedItem}
								onForceSendQueuedItem={onForceSendQueuedItem}
								forcedParallelEnabled={forcedParallelEnabled}
								getForceSendContext={getForceSendContext}
								onInterrupt={handleInterrupt}
								onScrollPositionChange={onScrollPositionChange}
								onAtBottomChange={onAtBottomChange}
								initialScrollTop={renderedActiveTab?.scrollTop}
								markdownEditMode={chatRawTextMode}
								setMarkdownEditMode={useSettingsStore.getState().setChatRawTextMode}
								onReplayMessage={onReplayMessage}
								onForkConversation={onForkConversation}
								onSessionRecover={onSessionRecover}
								isRecoveringSession={isRecoveringSession}
								sessionRecoveryError={sessionRecoveryError}
								fileTree={fileTree}
								cwd={
									activeSession.cwd?.startsWith(activeSession.fullPath)
										? activeSession.cwd.slice(activeSession.fullPath.length + 1)
										: ''
								}
								projectRoot={activeSession.fullPath}
								onFileClick={onFileClick}
								onShowErrorDetails={onShowAgentErrorModal}
								onFileSaved={
									refreshFileTree ? () => refreshFileTree?.(activeSession.id) : undefined
								}
								userMessageAlignment={userMessageAlignment}
								onOpenInTab={onOpenSavedFileInTab}
								ghCliAvailable={ghCliAvailable}
								onPublishMessageGist={onPublishMessageGist}
							/>
						)}
						{isAiTabContentPending && (
							<div
								data-testid="tab-content-pending"
								role="status"
								aria-label="Loading selected tab"
								className="absolute inset-0 z-[2] flex items-center justify-center"
								style={{ backgroundColor: theme.colors.bgMain }}
							>
								<Spinner size={24} color={theme.colors.accent} />
							</div>
						)}
					</div>
				</>
			)}
			{/* Shared AI input: one bar below whichever content the panel shows - the
			    single-view routing above OR a tiled group - targeting the focused AI
			    tab. See shouldShowInputArea for the visibility rules.

			    `relative z-[3]` lifts the input above the terminal (z-1) and browser
			    (z-2) keep-alive overlays. Those overlays are `absolute inset-0` on this
			    panel, so they span over the input's area; during the reflow after focus
			    moves to an AI pane in a tiled group (the input appears, the tiled region
			    shrinks, but a positioned terminal/browser layer still holds its pre-shrink
			    rect for a frame), the layer would otherwise paint over the input. The
			    input's own opaque chrome, stacked above, hides that transient bleed. Stays
			    below the z-30 tiling drop overlay so drags still hit-test on top. */}
			{shouldShowInputArea && (
				<div data-tour="input-area" className="relative z-[3]">
					<InputArea
						session={activeSession}
						theme={theme}
						setInputValue={setInputValue}
						enterToSend={activeTab?.enterToSend ?? enterToSendAI}
						setEnterToSend={
							onToggleTabEnterToSend
								? () => onToggleTabEnterToSend()
								: useSettingsStore.getState().setEnterToSendAI
						}
						stagedImages={stagedImages}
						setStagedImages={setStagedImages}
						setLightboxImage={setLightboxImage}
						commandHistoryOpen={commandHistoryOpen}
						setCommandHistoryOpen={setCommandHistoryOpen}
						commandHistoryFilter={commandHistoryFilter}
						setCommandHistoryFilter={setCommandHistoryFilter}
						commandHistorySelectedIndex={commandHistorySelectedIndex}
						setCommandHistorySelectedIndex={setCommandHistorySelectedIndex}
						slashCommandOpen={slashCommandOpen}
						setSlashCommandOpen={setSlashCommandOpen}
						slashCommands={slashCommands}
						selectedSlashCommandIndex={selectedSlashCommandIndex}
						setSelectedSlashCommandIndex={setSelectedSlashCommandIndex}
						tabCompletionOpen={tabCompletionOpen}
						setTabCompletionOpen={setTabCompletionOpen}
						tabCompletionSuggestions={tabCompletionSuggestions}
						selectedTabCompletionIndex={selectedTabCompletionIndex}
						setSelectedTabCompletionIndex={setSelectedTabCompletionIndex}
						tabCompletionFilter={tabCompletionFilter}
						setTabCompletionFilter={setTabCompletionFilter}
						atMentionOpen={atMentionOpen}
						setAtMentionOpen={setAtMentionOpen}
						atMentionFilter={atMentionFilter}
						setAtMentionFilter={setAtMentionFilter}
						atMentionStartIndex={atMentionStartIndex}
						setAtMentionStartIndex={setAtMentionStartIndex}
						atMentionItems={atMentionItems}
						atMentionCounts={atMentionCounts}
						atMentionCategory={atMentionCategory}
						setAtMentionCategory={setAtMentionCategory}
						selectedAtMentionIndex={selectedAtMentionIndex}
						setSelectedAtMentionIndex={setSelectedAtMentionIndex}
						inputRef={inputRef}
						handleInputKeyDown={handleInputKeyDown}
						handlePaste={handlePaste}
						handleDrop={handleDrop}
						toggleInputMode={toggleInputMode}
						processInput={processInput}
						handleInterrupt={handleInterrupt}
						onInputFocus={handleInputFocus}
						onInputBlur={onInputBlur}
						isAutoModeActive={isCurrentSessionAutoMode}
						thinkingItems={thinkingItems}
						onSessionClick={handleSessionClick}
						autoRunState={currentSessionBatchState || undefined}
						onStopAutoRun={() => onStopBatchRun?.(activeSession.id)}
						onOpenQueueBrowser={onOpenQueueBrowser}
						tabReadOnlyMode={
							(activeTab?.readOnlyMode ?? false) || activeTab?.permissionMode === 'readonly'
						}
						onToggleTabReadOnlyMode={onToggleTabReadOnlyMode}
						tabSaveToHistory={activeTab?.saveToHistory ?? false}
						onToggleTabSaveToHistory={onToggleTabSaveToHistory}
						tabShowThinking={activeTab?.showThinking ?? 'off'}
						onToggleTabShowThinking={onToggleTabShowThinking}
						supportsThinking={hasCapability('supportsThinkingDisplay')}
						onOpenPromptComposer={onOpenPromptComposer}
						shortcuts={shortcuts}
						showFlashNotification={showFlashNotification}
						// Context warning sash props (Phase 6) - use tab-level context usage
						contextUsage={activeTabContextUsage}
						contextWarningsEnabled={contextWarningsEnabled}
						contextWarningYellowThreshold={contextWarningYellowThreshold}
						contextWarningRedThreshold={contextWarningRedThreshold}
						onSummarizeAndContinue={
							onSummarizeAndContinue
								? () => onSummarizeAndContinue(activeSession.activeTabId)
								: undefined
						}
						// Summarization progress props
						summarizeProgress={summarizeProgress}
						summarizeResult={summarizeResult}
						summarizeStartTime={summarizeStartTime}
						isSummarizing={isSummarizing}
						onCancelSummarize={onCancelSummarize}
						// Merge progress props
						mergeProgress={mergeProgress}
						mergeResult={mergeResult}
						mergeStartTime={mergeStartTime}
						isMerging={isMerging}
						mergeSourceName={mergeSourceName}
						mergeTargetName={mergeTargetName}
						onCancelMerge={onCancelMerge}
						// Inline wizard mode
						onExitWizard={onExitWizard}
						wizardShowThinking={activeTab?.wizardState?.showWizardThinking ?? false}
						onToggleWizardShowThinking={onToggleWizardShowThinking}
						// Model/Effort quick-change pills
						currentModel={currentModel}
						currentEffort={currentEffort}
						availableModels={availableModels}
						availableEfforts={availableEfforts}
						onModelChange={onModelChange}
						onEffortChange={onEffortChange}
					/>
				</div>
			)}
			{/* TerminalView is kept alive for every session that has terminal tabs so that
		     switching between sessions (or to AI mode) does not destroy the xterm.js
		     scrollback buffer. visibility:hidden (not display:none) keeps the canvas
		     at non-zero dimensions so the WebGL context is never lost or cleared. */}
			{mountedTerminalSessionIds.map((sessionId) => {
				const isCurrentSession = sessionId === activeSession.id;
				const session = isCurrentSession
					? activeSession
					: mountedTerminalSessionsRef.current.get(sessionId);
				if (!session) return null;
				// Tiling: this session has terminal tabs that are leaves in the active
				// group. Each such tab's layer is positioned onto its pane rect (below,
				// inside TerminalView), so the overlay must be shown even though inputMode
				// isn't 'terminal'. Only the current session can own the active group.
				const hasTerminalPanes = isCurrentSession && terminalPaneRects.size > 0;
				const isTerminalVisible = isCurrentSession && session.inputMode === 'terminal';
				// Overlay shows for standalone terminal mode OR when tiling terminal panes.
				// It always spans the full panel (inset-0) so the pane rects - which are
				// panel-relative - map straight onto the absolutely-positioned tab layers.
				const overlayShown = isTerminalVisible || hasTerminalPanes;
				return (
					<div
						key={sessionId}
						className={`absolute inset-0 flex flex-col${overlayShown ? '' : ' terminal-hidden'}`}
						style={{
							visibility: overlayShown ? 'visible' : 'hidden',
							// Standalone terminal captures input across the whole panel. The tiled
							// overlay wrapper is click-through (none) so clicks on other panes and
							// dividers land; its positioned pane layers re-enable pointerEvents:auto
							// over their own rects (set inside TerminalView).
							pointerEvents: isTerminalVisible ? 'auto' : 'none',
							zIndex: overlayShown ? 1 : -1,
						}}
					>
						<TerminalView
							ref={(handle) => {
								if (handle) terminalViewRefs.current.set(sessionId, handle);
								else terminalViewRefs.current.delete(sessionId);
							}}
							session={session}
							theme={theme}
							fontFamily={fontFamily}
							fontSize={Math.round(fontSize * 0.85)}
							defaultShell={defaultShell}
							onTabStateChange={createTabStateChangeHandler(sessionId)}
							onTabPidChange={createTabPidChangeHandler(sessionId)}
							searchOpen={isCurrentSession ? terminalSearchOpen : false}
							onSearchClose={isCurrentSession ? () => setTerminalSearchOpen(false) : undefined}
							paneRects={hasTerminalPanes ? terminalPaneRects : undefined}
							onPaneMouseDown={
								hasTerminalPanes
									? (tid) => focusTiledPaneByTab({ type: 'terminal', id: tid })
									: undefined
							}
							// Visible in standalone terminal mode OR when tiling terminal panes,
							// so XTerminal keeps its WebGL renderer alive and repaints on show.
							isVisible={isTerminalVisible || hasTerminalPanes}
							onCopySelection={onTerminalCopySelection}
							onSendSelectionToAgent={onTerminalSendSelectionToAgent}
						/>
					</div>
				);
			})}
			{/* Browser tabs are kept alive as persistent overlays so their <webview> guest
			    contents survive switching tabs. Which tabs stay mounted is decided by
			    useBrowserTabMounting (the browserTabKeepAlive setting); under 'off' only the
			    active tab is mounted, reproducing the original unload-on-switch behavior.
			    visibility:hidden (not unmount) preserves the guest's JS heap and DOM. */}
			{mountedBrowserTabIds.map((tabId) => {
				const browserTab = activeSession.browserTabs?.find((t) => t.id === tabId);
				if (!browserTab) return null;
				// Tiling: this browser tab is a leaf in the active group. Position its
				// overlay onto the published pane rect (multiple browsers visible at
				// once); BrowserTabView is untouched so the per-agent <webview> partition
				// isolation stays intact. Falls back to standalone when no rect.
				const browserPaneRect = browserPaneRects.get(tabId);
				const isBrowserTiled = browserPaneRect != null;
				// A tiled browser pane is only visible while the group is the active view
				// (inputMode 'ai'). Gating on inputMode is defensive: if a standalone
				// terminal is showing but pane rects haven't cleared yet, the tiled webview
				// (z-index 2) would otherwise bleed over the terminal overlay (z-index 1).
				const isBrowserVisible = isBrowserTiled
					? activeSession.inputMode === 'ai'
					: activeSession.inputMode === 'ai' && activeSession.activeBrowserTabId === tabId;
				// Hold keyboard focus only when no modal/overlay is layered above the
				// page. The tab stays visually rendered (visibility/zIndex below are
				// driven by isBrowserVisible), but the webview yields input focus to an
				// open layer so its keyboard navigation works (e.g. the Tab Switcher).
				// When tiled, only the group's focused browser pane holds webview input.
				const isBrowserFocusActive = isBrowserTiled
					? groupFocusedBrowserTabId === tabId && layerCount === 0
					: isBrowserVisible && layerCount === 0;
				return (
					<div
						key={tabId}
						className={`absolute flex flex-col${isBrowserTiled ? '' : ' inset-0'}`}
						// Tiling: pressing this browser pane focuses it (its overlay sits over
						// the transparent PaneFrame slot). Capture phase so focus lands before
						// the toolbar/webview handles the press.
						onMouseDownCapture={
							isBrowserTiled ? () => focusTiledPaneByTab({ type: 'browser', id: tabId }) : undefined
						}
						style={
							isBrowserTiled
								? {
										top: browserPaneRect.top,
										left: browserPaneRect.left,
										width: browserPaneRect.width,
										height: browserPaneRect.height,
										// Hidden (and click-through, sent behind) when the group isn't the
										// active view, so a stale pane rect can't bleed over a terminal.
										visibility: isBrowserVisible ? 'visible' : 'hidden',
										pointerEvents: isBrowserVisible ? 'auto' : 'none',
										zIndex: isBrowserVisible ? 2 : -1,
									}
								: {
										visibility: isBrowserVisible ? 'visible' : 'hidden',
										pointerEvents: isBrowserVisible ? 'auto' : 'none',
										zIndex: isBrowserVisible ? 2 : -1,
									}
						}
					>
						<BrowserTabView
							ref={(handle) => {
								if (handle) browserViewRefs.current.set(tabId, handle);
								else browserViewRefs.current.delete(tabId);
							}}
							tab={browserTab}
							theme={theme}
							isActive={isBrowserFocusActive}
							onUpdateTab={(tid, updates) =>
								handleBrowserTabUpdate?.(activeSession.id, tid, updates)
							}
						/>
					</div>
				);
			})}
		</div>
	);
});
