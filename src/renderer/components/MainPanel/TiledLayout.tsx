import React from 'react';
import { createPortal } from 'react-dom';
import {
	ChevronDown,
	Pencil,
	PanelsTopLeft,
	Ungroup,
	Copy,
	Link,
	Star,
	Mail,
	Download,
	Clipboard,
	Minimize2,
	GitMerge,
	ArrowRightCircle,
	Share2,
	Play,
	X,
	Maximize2,
	GripHorizontal,
	AlertCircle,
	Loader2,
} from 'lucide-react';

import { TerminalOutput, type TerminalOutputProps } from '../TerminalOutput';
import { WizardIndicator } from '../SessionList/WizardIndicator';
import { hasDraft } from '../../utils/tabHelpers';
import { useSettingsStore } from '../../stores/settingsStore';
import { useModalStore } from '../../stores/modalStore';
import { useUIStore } from '../../stores/uiStore';
import { updateSessionWith, useSessionStore } from '../../stores/sessionStore';
import {
	breakApartGroup,
	findLeafById,
	focusPaneInSession,
	promotePaneToStandalone,
	resolveTabRefRenameValue,
	resolveTabRefTitle,
	tabRefKey,
	updateGroupInSession,
	updateSplitSizes,
} from '../../utils/panelLayout';
import { filePaneAttrs } from '../../utils/paneFocus';
import { usePaneDrag } from '../../hooks/tabs/usePaneDrag';
import { usePointerDrag } from '../../hooks/utils/usePointerDrag';
import { safeClipboardWrite } from '../../utils/clipboard';
import { flashCopiedToClipboard } from '../../utils/flashCopiedToClipboard';
import { buildSessionDeepLink } from '../../../shared/deep-link-urls';
import { resolveSurfaceFont } from '../../../shared/fontStack';
import { useThrottledCallback } from '../../hooks/utils/useThrottle';
import { useTabStore } from '../../stores/tabStore';
import { useFilePreviewHandlers } from '../../hooks/mainPanel/useFilePreviewHandlers';
import { outputSearchKeyFor } from '../../utils/outputSearch';
import type { FileNode } from '../../types/fileTree';
import type {
	PaneRects,
	PanelLayoutNode,
	Session,
	TabGroup,
	Theme,
	UnifiedTabRef,
} from '../../types';

/**
 * Action handlers a tiled pane's dropdown can invoke, bundled into one prop so a
 * single object threads MainPanel -> MainPanelContent -> TiledLayout instead of ~15
 * separate props. Every handler is keyed by the pane's tab id and mirrors the same
 * action the tab's strip-chip hover menu offers; each is optional so the menu only
 * renders items whose handler is wired. Assembled in MainPanel (where all the tab
 * action handlers already live for the TabBar) and passed straight through.
 */
export interface PaneTabActions {
	// AI panes
	onStar?: (tabId: string, starred: boolean) => void;
	onMarkUnread?: (tabId: string) => void;
	onCopyContext?: (tabId: string) => void;
	onExportHtml?: (tabId: string) => void;
	onPublishGist?: (tabId: string) => void;
	onMergeWith?: (tabId: string) => void;
	onSendToAgent?: (tabId: string) => void;
	onSummarizeAndContinue?: (tabId: string) => void;
	// Terminal panes
	onCopyTerminalBuffer?: (tabId: string) => void;
	onSendTerminalBufferToAgent?: (tabId: string) => void;
	onPublishTerminalBufferGist?: (tabId: string) => void;
	onConfigureTerminalStartup?: (tabId: string) => void;
	// Browser panes
	onCopyBrowserContent?: (tabId: string) => void;
	onSendBrowserContentToAgent?: (tabId: string) => void;
	/** Close the tab this pane references (MainPanel dispatches to the per-kind close). */
	onCloseTab?: (ref: UnifiedTabRef) => void;
}

/**
 * The interactive half of an AI pane's chat view. A tiled AI pane renders the
 * SAME TerminalOutput the single view does, so without these handlers its
 * transcript is read-only: no Force Send / remove / pause / edit / reorder on
 * queued items, no delete-message, no replay, no fork, no session recovery, no
 * file links, no lightbox. Bundled as one object (and picked straight off
 * TerminalOutputProps so the shapes cannot drift) and published through
 * PaneViewContext, so it reaches every pane without threading a prop through
 * LayoutNode/PaneFrame.
 *
 * Every handler here is either addressed by id (queue item, log entry) or keyed
 * to the session's ACTIVE AI tab. That is safe from any pane: PaneFrame focuses
 * a pane on mousedown, and focusPaneInSession syncs `activeTabId` to the focused
 * AI pane - so by the time a click handler inside a pane runs, that pane's tab is
 * already the active one. Scroll-position persistence is deliberately NOT here:
 * a wheel scroll never focuses a pane, so a background pane would write its
 * scroll offset onto the focused pane's tab.
 */
export type PaneChatActions = Partial<
	Pick<
		TerminalOutputProps,
		| 'onDeleteLog'
		| 'onRemoveQueuedItem'
		| 'onTogglePauseQueuedItem'
		| 'onEditQueuedItem'
		| 'onReorderQueuedItem'
		| 'onForceSendQueuedItem'
		| 'forcedParallelEnabled'
		| 'getForceSendContext'
		| 'onInterrupt'
		| 'setLightboxImage'
		| 'setMarkdownEditMode'
		| 'onReplayMessage'
		| 'onForkConversation'
		| 'onSessionRecover'
		| 'isRecoveringSession'
		| 'sessionRecoveryError'
		| 'fileTree'
		| 'cwd'
		| 'onFileClick'
		| 'onFileSaved'
		| 'onShowErrorDetails'
		| 'userMessageAlignment'
		| 'ghCliAvailable'
		| 'onPublishMessageGist'
		| 'onOpenInTab'
	>
> & {
	/**
	 * The SHARED composer textarea (one per panel, targeting the focused pane) and
	 * the App-level transcript end marker. Both are singletons on purpose:
	 *   - inputRef: Escape inside a pane returns the caret to the composer, and the
	 *     composer is shared, so every pane gets the same ref.
	 *   - logsEndRef: the "Jump to Bottom" shortcut scrolls
	 *     `logsEndRef.current.parentElement`, so exactly ONE pane may claim it -
	 *     the focused one. Unfocused panes get their own local ref (see
	 *     PaneContent) or the shortcut would scroll whichever pane rendered last.
	 */
	inputRef?: TerminalOutputProps['inputRef'];
	logsEndRef?: TerminalOutputProps['logsEndRef'];
};

/**
 * View handlers for tiled FILE panes. The single view binds the app's tab-id-keyed
 * file-tab handlers to the ACTIVE file tab via useFilePreviewHandlers; a tiled file
 * pane runs that same hook against its OWN tab id, so it takes the UNBOUND handlers
 * plus the display props the preview needs (file links, fuzzy search). Without them
 * a tiled preview was a dead document: wiki/file links did nothing, scroll and find
 * state were forgotten on every switch, and breadcrumb navigation was inert.
 *
 * Deliberately absent: publish-gist, open-in-graph, and open-in-browser. Those
 * arrive already bound to the ACTIVE file tab (zero-arg), and focusing a file pane
 * does NOT set `activeFileTabId` - so from a pane they would act on the wrong file.
 * They need tab-id-addressable versions first.
 */
export interface PaneFileActions {
	onFileTabClose?: (tabId: string) => void;
	onFileTabEditModeChange?: (tabId: string, editMode: boolean) => void;
	onFileTabEditContentChange?: (
		tabId: string,
		editContent: string | undefined,
		savedContent?: string
	) => void;
	onFileTabScrollPositionChange?: (tabId: string, scrollTop: number) => void;
	onFileTabSearchQueryChange?: (tabId: string, searchQuery: string) => void;
	onReloadFileTab?: (tabId: string) => void;
	/** Breadcrumb history jump, addressed by tab id so a pane drives its own. */
	onFileTabNavigateToIndex?: (index: number, tabId?: string) => void;
	fileTree?: FileNode[];
	onFileClick?: (path: string) => void;
	onOpenFuzzySearch?: () => void;
	onShortcutUsed?: (shortcutId: string) => void;
}

/**
 * Carries the per-kind view handlers from the TiledLayout root down to each pane.
 * Null members mean "nothing wired" (tests, previews), in which case a pane falls
 * back to the read-only rendering it had before.
 */
interface PaneViewActions {
	chat: PaneChatActions | null;
	file: PaneFileActions | null;
}

const PaneViewContext = React.createContext<PaneViewActions>({ chat: null, file: null });

/**
 * Registry the recursive layout nodes use to report their transparent slot
 * elements up to the TiledLayout root, which measures them together and
 * publishes a PaneRects map. Terminal/browser leaves register their content
 * slot; the root's ResizeObserver + layout effect keep the rects current.
 */
interface PaneSlotRegistry {
	register: (key: string, el: HTMLElement | null) => void;
}
const PaneSlotContext = React.createContext<PaneSlotRegistry | null>(null);

// Lazy-loaded to match MainPanelContent: FilePreview pulls the full markdown /
// syntax-highlighting stack into the bundle, so it stays code-split behind first
// open here too.
const FilePreview = React.lazy(() =>
	import('../FilePreview').then((m) => ({ default: m.FilePreview }))
);

/**
 * Recursive renderer for a tiled TabGroup. Walks the group's layout tree and
 * renders each leaf's referenced tab side by side. Leaves reference existing
 * tabs (see PanelLayoutNode), so this component resolves each ref back to its
 * live tab in the session and reuses the same view components MainPanelContent
 * uses (TerminalOutput for AI, FilePreview for files). Terminal and browser
 * leaves render a transparent slot (title bar + focus ring only): their live
 * content is the keep-alive overlay MainPanelContent mounts, which this layout
 * repositions onto each slot's rect via `onPaneRectsChange` (Phase 04).
 *
 * Interactive (Phase 02): sibling panes have draggable dividers (direct-DOM
 * during drag, committed to the group's layout on mouseup, mirroring
 * useResizablePanel), clicking a pane focuses it, and the focused pane gets an
 * accent ring. A `zoomedPaneId` renders a single pane full-panel (a temporary,
 * non-persisted maximize handled by the caller).
 */
export interface TiledLayoutProps {
	group: TabGroup;
	session: Session;
	theme: Theme;
	/** When set, only this leaf renders (full-panel maximize/zoom). */
	zoomedPaneId?: string | null;
	/**
	 * Called whenever the terminal/browser leaf rectangles change (layout edits,
	 * container/pane resize, divider drags). MainPanelContent uses the published
	 * PaneRects to position the keep-alive terminal/browser overlays onto each
	 * pane instead of filling the whole panel. Empty map when no such leaves.
	 */
	onPaneRectsChange?: (rects: PaneRects) => void;
	/** Per-kind pane dropdown action handlers, threaded to each pane's chevron menu. */
	paneTabActions?: PaneTabActions;
	/**
	 * Chat interaction handlers for AI panes (queue actions incl. Force Send,
	 * delete/replay/fork, recovery, file links, lightbox). Published via context
	 * so every AI pane gets the same interactive chat the single view has.
	 */
	paneChatActions?: PaneChatActions;
	/**
	 * File-tab handlers for file panes (save, edit, scroll/find memory, reload,
	 * links, breadcrumb history). Same idea as paneChatActions, per-kind.
	 */
	paneFileActions?: PaneFileActions;
}

/**
 * Fallback shown when a leaf references a tab that no longer exists (e.g. the
 * underlying AI/file tab was closed while still in the layout). The layout
 * self-heals on the next edit; this keeps the pane from rendering blank.
 */
function PaneMissingTab({ theme }: { theme: Theme }) {
	return (
		<div
			className="flex-1 flex items-center justify-center select-none"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			<div
				className="text-xs text-center px-4 py-2 rounded"
				style={{
					color: theme.colors.textDim,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				This tab is no longer available
			</div>
		</div>
	);
}

/**
 * A tiled file-preview pane wired to behave IDENTICALLY to the single-view file tab.
 * The single view binds the app's tab-id-keyed file handlers to the ACTIVE file tab
 * through `useFilePreviewHandlers`; this pane runs that SAME hook against its own tab
 * id, so save (including the untitled / moved-on-disk prompts), edit-content
 * persistence, scroll memory, find-query memory, and reload all behave identically
 * without a second copy of that logic. Preview-tier and HTML-render mode go straight
 * to the tab-id-keyed store actions, as they already did.
 *
 * Reads its own tab reactively so edit-mode / content / scroll changes re-render just
 * this pane.
 */
function TiledFilePane({
	fileTabId,
	session,
	theme,
	actions,
}: {
	fileTabId: string;
	session: Session;
	theme: Theme;
	actions: PaneFileActions | null;
}) {
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	// Subscribe to THIS tab via the session store so edit-mode / edit-content / tier /
	// html-mode changes re-render the pane (the session prop is a snapshot that alone
	// wouldn't update). The tabStore setters below all mutate the ACTIVE session's file
	// tabs, and a tiled file pane's session IS the active session (its group is active).
	const fileTab = useSessionStore(
		(s) =>
			s.sessions
				.find((x) => x.id === session.id)
				?.filePreviewTabs?.find((t) => t.id === fileTabId) ?? null
	);
	const store = useTabStore.getState();

	// Same binding the single view uses, pointed at THIS pane's tab instead of the
	// active one. Gives the pane the identical file object, cwd, SSH id, and handlers.
	const {
		memoizedFilePreviewFile,
		filePreviewCwd,
		filePreviewSshRemoteId,
		handleFilePreviewEditModeChange,
		handleFilePreviewSave,
		handleFilePreviewEditContentChange,
		handleFilePreviewScrollPositionChange,
		handleFilePreviewSearchQueryChange,
		handleFilePreviewReload,
	} = useFilePreviewHandlers({
		activeSession: session,
		activeFileTabId: fileTabId,
		activeFileTab: fileTab,
		onFileTabEditModeChange: actions?.onFileTabEditModeChange,
		onFileTabEditContentChange: actions?.onFileTabEditContentChange,
		onFileTabScrollPositionChange: actions?.onFileTabScrollPositionChange,
		onFileTabSearchQueryChange: actions?.onFileTabSearchQueryChange,
		onReloadFileTab: actions?.onReloadFileTab,
	});

	// Breadcrumb history, derived from THIS tab (the single view derives the same
	// slices for the active tab in getTabDerivedState).
	const history = fileTab?.navigationHistory ?? [];
	const navIndex = fileTab?.navigationIndex ?? (history.length > 0 ? history.length - 1 : -1);
	const navigateToIndex = actions?.onFileTabNavigateToIndex;
	const goToIndex = React.useCallback(
		(index: number) => navigateToIndex?.(index, fileTabId),
		[navigateToIndex, fileTabId]
	);

	if (!fileTab || !memoizedFilePreviewFile) return <PaneMissingTab theme={theme} />;

	return (
		// Tagged with the tab id so the pane focus router can land the caret in THIS
		// pane's editor when several file panes are tiled at once (see utils/paneFocus).
		<div className="flex-1 overflow-hidden select-text" {...filePaneAttrs(fileTabId)}>
			<React.Suspense fallback={null}>
				<FilePreview
					file={memoizedFilePreviewFile}
					onClose={() => actions?.onFileTabClose?.(fileTabId)}
					isTabMode={true}
					theme={theme}
					shortcuts={shortcuts}
					markdownEditMode={fileTab.editMode ?? false}
					setMarkdownEditMode={handleFilePreviewEditModeChange}
					onSave={handleFilePreviewSave}
					externalEditContent={fileTab.editContent}
					onEditContentChange={handleFilePreviewEditContentChange}
					previewTierOverride={fileTab.previewTierOverride}
					onPreviewTierChange={(tier) => store.setFileTabPreviewTier(fileTabId, tier)}
					htmlRenderMode={fileTab.htmlRenderMode}
					onHtmlRenderModeChange={(value) => store.setFileTabHtmlRenderMode(fileTabId, value)}
					sshRemoteId={filePreviewSshRemoteId}
					// File/wiki links inside the document, resolved against the same tree
					// and proximity cwd the single view uses.
					fileTree={actions?.fileTree}
					cwd={filePreviewCwd}
					onFileClick={actions?.onFileClick}
					onOpenFuzzySearch={actions?.onOpenFuzzySearch}
					onShortcutUsed={actions?.onShortcutUsed}
					// Scroll + find-query memory, so switching away and back lands where
					// the user left off instead of jumping to the top with a cleared term.
					initialScrollTop={fileTab.scrollTop}
					onScrollPositionChange={handleFilePreviewScrollPositionChange}
					initialSearchQuery={fileTab.searchQuery}
					onSearchQueryChange={handleFilePreviewSearchQueryChange}
					// On-disk change detection + reload.
					lastModified={fileTab.lastModified}
					onReloadFile={handleFilePreviewReload}
					// Breadcrumb navigation across this tab's own visit history.
					canGoBack={navIndex > 0}
					canGoForward={navIndex < history.length - 1}
					onNavigateBack={navigateToIndex ? () => goToIndex(navIndex - 1) : undefined}
					onNavigateForward={navigateToIndex ? () => goToIndex(navIndex + 1) : undefined}
					backHistory={history.slice(0, navIndex)}
					forwardHistory={history.slice(navIndex + 1)}
					currentHistoryIndex={navIndex}
					onNavigateToIndex={navigateToIndex ? goToIndex : undefined}
					// Transient deep-link scroll target, cleared once consumed.
					pendingScrollToLine={fileTab.pendingScrollToLine}
					onPendingScrollToLineConsumed={() => store.clearFileTabPendingScrollToLine(fileTabId)}
				/>
			</React.Suspense>
		</div>
	);
}

/**
 * A tiled AI pane wired to behave IDENTICALLY to the single-view chat. Everything
 * the single view offers is present here: the queue controls (Force Send included),
 * message actions, session recovery, Find, transcript scroll memory, and the two
 * keyboard affordances that need real refs (Escape back to the composer, Jump to
 * Bottom).
 *
 * Two things must be per-PANE rather than per-panel, and both were previously inert:
 *   - Find (Cmd+F). Its state is already scoped per agent+AI-tab in uiStore, so the
 *     pane just reads its OWN slot key. Sharing the panel's slot would have made one
 *     Find bar open in every pane at once with a single shared term.
 *   - Scroll position + at-bottom (which also clears the unread badge). These CANNOT
 *     go through the active-tab handlers: scrolling with the wheel never focuses a
 *     pane, so a background pane would write its offset onto the focused pane's tab.
 *     They drive the tab-id-keyed store actions instead - the same ones the
 *     single-view handlers now delegate to.
 */
function TiledAiPane({
	aiTabId,
	session,
	theme,
	isFocused,
	actions,
}: {
	aiTabId: string;
	session: Session;
	theme: Theme;
	isFocused: boolean;
	actions: PaneChatActions | null;
}) {
	// Same chat font as the single-pane view (MainPanelContent) - a tiled pane
	// renders the same transcript, so it must not disagree about its typeface.
	const fontFamily = useSettingsStore((s) => resolveSurfaceFont(s.chatFontFamily, s.fontFamily));
	const maxOutputLines = useSettingsStore((s) => s.maxOutputLines);
	const chatRawTextMode = useSettingsStore((s) => s.chatRawTextMode);
	const activeFocus = useUIStore((s) => s.activeFocus);

	// This pane's own Find slot, keyed the same way MainPanelContent keys the
	// single view's - so a search survives tiling/untiling the tab.
	const searchKey = outputSearchKeyFor(session.id, aiTabId);
	const searchSlot = useUIStore((s) => s.outputSearchByKey?.[searchKey]);
	const setOutputSearchOpen = React.useCallback(
		(v: boolean | ((prev: boolean) => boolean)) =>
			useUIStore.getState().setOutputSearchOpen(searchKey, v),
		[searchKey]
	);
	const setOutputSearchQuery = React.useCallback(
		(v: string | ((prev: string) => string)) =>
			useUIStore.getState().setOutputSearchQuery(searchKey, v),
		[searchKey]
	);
	const setOutputSearchRegex = React.useCallback(
		(v: boolean | ((prev: boolean) => boolean)) =>
			useUIStore.getState().setOutputSearchRegex(searchKey, v),
		[searchKey]
	);

	const onScrollPositionChange = React.useCallback(
		(scrollTop: number) => useTabStore.getState().setAiTabScrollTop(aiTabId, scrollTop),
		[aiTabId]
	);
	const onAtBottomChange = React.useCallback(
		(isAtBottom: boolean) => useTabStore.getState().setAiTabAtBottom(aiTabId, isAtBottom),
		[aiTabId]
	);

	const outputRef = React.useRef<HTMLDivElement>(null);
	// Fallbacks for the shared singletons. The local logsEndRef is what UNFOCUSED
	// panes register, keeping the app-level one pointed at the focused transcript.
	const localInputRef = React.useRef<HTMLTextAreaElement>(null);
	const localLogsEndRef = React.useRef<HTMLDivElement>(null);
	const noop = React.useCallback(() => {}, []);

	const aiTab = session.aiTabs?.find((t) => t.id === aiTabId);
	if (!aiTab) return <PaneMissingTab theme={theme} />;

	// Scope the session to this pane's AI tab so TerminalOutput renders the
	// correct conversation (it reads logs off the active tab).
	const paneSession: Session = { ...session, activeTabId: aiTab.id, inputMode: 'ai' };

	return (
		<div className="flex-1 overflow-hidden flex flex-col select-text">
			<TerminalOutput
				ref={outputRef}
				session={paneSession}
				theme={theme}
				fontFamily={fontFamily}
				activeFocus={activeFocus}
				maxOutputLines={maxOutputLines}
				markdownEditMode={chatRawTextMode}
				{...actions}
				// Spread last: these either override a bundle value or supply the
				// required prop when no bundle is wired.
				setLightboxImage={actions?.setLightboxImage ?? noop}
				setMarkdownEditMode={actions?.setMarkdownEditMode ?? noop}
				setActiveFocus={useUIStore.getState().setActiveFocus}
				inputRef={actions?.inputRef ?? localInputRef}
				logsEndRef={isFocused && actions?.logsEndRef ? actions.logsEndRef : localLogsEndRef}
				outputSearchOpen={searchSlot?.open ?? false}
				outputSearchQuery={searchSlot?.query ?? ''}
				outputSearchRegex={searchSlot?.regex ?? false}
				setOutputSearchOpen={setOutputSearchOpen}
				setOutputSearchQuery={setOutputSearchQuery}
				setOutputSearchRegex={setOutputSearchRegex}
				onScrollPositionChange={onScrollPositionChange}
				onAtBottomChange={onAtBottomChange}
				initialScrollTop={aiTab.scrollTop}
				initialIsAtBottom={aiTab.isAtBottom}
				// Only the focused pane answers the global Force Send shortcut;
				// focusPaneInSession keeps activeTabId on the focused AI pane.
				forceSendShortcutEnabled={session.activeTabId === aiTab.id}
				projectRoot={session.fullPath}
			/>
		</div>
	);
}

/** Render a single leaf's tab content, reusing existing view components. */
function PaneContent({
	tab,
	session,
	theme,
	isFocused,
}: {
	tab: UnifiedTabRef;
	session: Session;
	theme: Theme;
	isFocused: boolean;
}) {
	// Per-kind view handlers published by the TiledLayout root.
	const { chat, file } = React.useContext(PaneViewContext);

	if (tab.type === 'ai') {
		return (
			<TiledAiPane
				aiTabId={tab.id}
				session={session}
				theme={theme}
				isFocused={isFocused}
				actions={chat}
			/>
		);
	}

	if (tab.type === 'file') {
		return <TiledFilePane fileTabId={tab.id} session={session} theme={theme} actions={file} />;
	}

	// Terminal and browser tabs are kept-alive overlays mounted at the panel level
	// (their PTY scrollback / <webview> DOM must survive tab switches), so a tiled
	// pane can't host their React tree inline. Instead we render a transparent slot
	// that reserves the pane's content box and reports its rect up via the registry;
	// MainPanelContent positions the matching overlay onto that rect.
	return <PaneOverlaySlot tab={tab} />;
}

/**
 * Transparent placeholder for terminal/browser leaves. Reserves the pane's
 * content box and registers its element so the TiledLayout root can measure it
 * and publish the rect. The live guest is the keep-alive overlay that sits on
 * top of this slot (positioned by MainPanelContent).
 */
function PaneOverlaySlot({ tab }: { tab: UnifiedTabRef }) {
	const registry = React.useContext(PaneSlotContext);
	const key = tabRefKey(tab);
	return <div className="flex-1 min-w-0 min-h-0" ref={(el) => registry?.register(key, el)} />;
}

/** A single row in the pane actions menu. Mirrors the AITab overlay menu styling. */
function PaneMenuItem({
	icon: Icon,
	label,
	onClick,
	theme,
}: {
	icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
	label: string;
	onClick: (e: React.MouseEvent) => void;
	theme: Theme;
}) {
	return (
		<button
			onClick={onClick}
			className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
			style={{ color: theme.colors.textMain }}
		>
			<Icon className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
			{label}
		</button>
	);
}

/** A thin divider between menu sections. */
function PaneMenuDivider({ theme }: { theme: Theme }) {
	return <div className="my-1 h-px" style={{ backgroundColor: theme.colors.border }} />;
}

/**
 * Per-pane actions menu, opened by the chevron in a pane's title bar. Because a
 * tiled tab is hidden from the tab strip (its group chip stands in for it), its
 * usual hover menu is unreachable - so this reproduces the FULL per-kind tab menu
 * for the pane, keyed on `node.tab.type`:
 *
 *   - AI: copy session id / deep link, star, rename, mark unread, export HTML,
 *     copy/compact/merge/send/publish context, move to own tab, break apart, close.
 *   - Terminal: rename, copy/send/publish buffer, configure startup, + common.
 *   - Browser: rename, copy/send content, + common.
 *   - File: copy deep link, + common (file tabs are named by their filename, no rename).
 *
 * Rename / move-to-own-tab / break-apart / copy-session-id / copy-deep-link are
 * local (modal store, panelLayout helpers, clipboard). The rest come from the
 * `actions` bundle threaded down from MainPanel. Items whose handler is absent are
 * omitted. Renders through a portal (the pane clips overflow) under the chevron.
 */
function PaneActionsMenu({
	node,
	group,
	session,
	theme,
	actions,
}: {
	node: Extract<PanelLayoutNode, { kind: 'leaf' }>;
	group: TabGroup;
	session: Session;
	theme: Theme;
	actions?: PaneTabActions;
}) {
	const [open, setOpen] = React.useState(false);
	const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);
	const buttonRef = React.useRef<HTMLButtonElement>(null);

	const toggle = React.useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		e.preventDefault();
		const rect = buttonRef.current?.getBoundingClientRect();
		if (rect) setPos({ top: rect.bottom + 2, left: rect.left });
		setOpen((v) => !v);
	}, []);

	const close = React.useCallback(() => setOpen(false), []);

	// Wrap a bundle handler so every menu click closes the menu first. Returns
	// undefined when the handler is absent so the caller can omit the item.
	const wrap = React.useCallback(
		(fn: ((id: string) => void) | undefined) =>
			fn
				? (e: React.MouseEvent) => {
						e.stopPropagation();
						close();
						fn(node.tab.id);
					}
				: undefined,
		[close, node.tab.id]
	);

	const handleRename = React.useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			close();
			// Seed with the user-assigned name only (empty when the pane still shows an
			// auto title), so hitting Rename on an untouched pane doesn't freeze its
			// generated label - "Terminal 2", the filename, the live page title - into
			// a custom name.
			const renameValue = resolveTabRefRenameValue(session, node.tab);
			if (renameValue === null) return;
			useModalStore.getState().openModal('renameTab', {
				tabId: node.tab.id,
				initialName: renameValue,
			});
		},
		[close, node.tab, session]
	);

	const handleMoveToOwnTab = React.useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			close();
			// Clear any zoom targeting this pane before it leaves the layout.
			useUIStore.getState().setZoomedPaneId(null);
			const groupId = group.id;
			const leafId = node.id;
			updateSessionWith(session.id, (s) =>
				promotePaneToStandalone(s, groupId, leafId, (s.unifiedTabOrder ?? []).length)
			);
		},
		[close, group.id, node.id, session.id]
	);

	const handleBreakApart = React.useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			close();
			const groupId = group.id;
			useModalStore.getState().openModal('confirm', {
				title: 'Break apart group?',
				message: `Break apart "${group.name}"? Its panes return to the tab bar as individual tabs. The tabs are not closed, and you can tile them again later.`,
				destructive: false,
				onConfirm: () => {
					// The whole group is going away; drop any zoom so it doesn't linger.
					useUIStore.getState().setZoomedPaneId(null);
					updateSessionWith(session.id, (s) => breakApartGroup(s, groupId));
				},
			});
		},
		[close, group.id, group.name, session.id]
	);

	const handleCopyDeepLink = React.useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			close();
			void safeClipboardWrite(buildSessionDeepLink(session.id, node.tab.id));
			flashCopiedToClipboard('Deep link');
		},
		[close, session.id, node.tab.id]
	);

	const kind = node.tab.type;
	const aiTab = kind === 'ai' ? session.aiTabs?.find((t) => t.id === node.tab.id) : undefined;

	const handleCopySessionId = React.useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			close();
			if (aiTab?.agentSessionId) {
				void safeClipboardWrite(aiTab.agentSessionId);
				flashCopiedToClipboard('Session ID');
			}
		},
		[close, aiTab?.agentSessionId]
	);

	const handleStar = React.useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			close();
			if (aiTab) actions?.onStar?.(node.tab.id, !aiTab.starred);
		},
		[close, actions, node.tab.id, aiTab]
	);

	const handleClose = wrap(actions?.onCloseTab ? () => actions.onCloseTab!(node.tab) : undefined);

	return (
		<>
			<button
				ref={buttonRef}
				onClick={toggle}
				onMouseDown={(e) => e.stopPropagation()}
				draggable={false}
				onDragStart={(e) => e.preventDefault()}
				className="shrink-0 rounded hover:bg-white/10 transition-colors -ml-0.5 mr-0.5 p-0.5 cursor-pointer"
				title="Pane actions"
				aria-label="Pane actions"
			>
				<ChevronDown className="w-3 h-3" style={{ color: 'currentColor' }} />
			</button>
			{open &&
				pos &&
				createPortal(
					<>
						{/* Click-away backdrop: any click outside the menu closes it. */}
						<div className="fixed inset-0 z-[99]" onClick={close} onContextMenu={close} />
						<div
							className="fixed z-[100] shadow-xl overflow-hidden whitespace-nowrap"
							style={{
								top: pos.top,
								left: pos.left,
								backgroundColor: theme.colors.bgSidebar,
								border: `1px solid ${theme.colors.border}`,
								borderRadius: '8px',
								minWidth: '12.5rem',
							}}
							onClick={(e) => e.stopPropagation()}
						>
							<div className="p-1">
								{/* --- Identity / naming --- */}
								{kind === 'ai' && aiTab?.agentSessionId && (
									<PaneMenuItem
										icon={Copy}
										label="Copy Session ID"
										onClick={handleCopySessionId}
										theme={theme}
									/>
								)}
								<PaneMenuItem
									icon={Link}
									label="Copy Deep Link"
									onClick={handleCopyDeepLink}
									theme={theme}
								/>
								{kind === 'ai' && actions?.onStar && (
									<PaneMenuItem
										icon={Star}
										label={aiTab?.starred ? 'Unstar Session' : 'Star Session'}
										onClick={handleStar}
										theme={theme}
									/>
								)}
								{/* File tabs are named by their filename; the rename modal only commits
								    ai / terminal / browser tabs, so omit Rename for a file pane. */}
								{kind !== 'file' && (
									<PaneMenuItem icon={Pencil} label="Rename" onClick={handleRename} theme={theme} />
								)}
								{kind === 'ai' && actions?.onMarkUnread && (
									<PaneMenuItem
										icon={Mail}
										label="Mark as Unread"
										onClick={wrap(actions.onMarkUnread)!}
										theme={theme}
									/>
								)}
								{kind === 'ai' && actions?.onExportHtml && (
									<PaneMenuItem
										icon={Download}
										label="Export as HTML"
										onClick={wrap(actions.onExportHtml)!}
										theme={theme}
									/>
								)}

								{/* --- Context / buffer actions (per kind) --- */}
								{kind === 'ai' &&
									(actions?.onCopyContext ||
										actions?.onSummarizeAndContinue ||
										actions?.onMergeWith ||
										actions?.onSendToAgent ||
										actions?.onPublishGist) && <PaneMenuDivider theme={theme} />}
								{kind === 'ai' && actions?.onCopyContext && (
									<PaneMenuItem
										icon={Clipboard}
										label="Context: Copy to Clipboard"
										onClick={wrap(actions.onCopyContext)!}
										theme={theme}
									/>
								)}
								{kind === 'ai' && actions?.onSummarizeAndContinue && (
									<PaneMenuItem
										icon={Minimize2}
										label="Context: Compact"
										onClick={wrap(actions.onSummarizeAndContinue)!}
										theme={theme}
									/>
								)}
								{kind === 'ai' && actions?.onMergeWith && (
									<PaneMenuItem
										icon={GitMerge}
										label="Context: Merge Into"
										onClick={wrap(actions.onMergeWith)!}
										theme={theme}
									/>
								)}
								{kind === 'ai' && actions?.onSendToAgent && (
									<PaneMenuItem
										icon={ArrowRightCircle}
										label="Context: Send to Agent"
										onClick={wrap(actions.onSendToAgent)!}
										theme={theme}
									/>
								)}
								{kind === 'ai' && actions?.onPublishGist && (
									<PaneMenuItem
										icon={Share2}
										label="Context: Publish as GitHub Gist"
										onClick={wrap(actions.onPublishGist)!}
										theme={theme}
									/>
								)}

								{/* Terminal buffer actions */}
								{kind === 'terminal' &&
									(actions?.onCopyTerminalBuffer ||
										actions?.onSendTerminalBufferToAgent ||
										actions?.onPublishTerminalBufferGist ||
										actions?.onConfigureTerminalStartup) && <PaneMenuDivider theme={theme} />}
								{kind === 'terminal' && actions?.onCopyTerminalBuffer && (
									<PaneMenuItem
										icon={Clipboard}
										label="Copy Buffer"
										onClick={wrap(actions.onCopyTerminalBuffer)!}
										theme={theme}
									/>
								)}
								{kind === 'terminal' && actions?.onSendTerminalBufferToAgent && (
									<PaneMenuItem
										icon={ArrowRightCircle}
										label="Send Buffer to Agent"
										onClick={wrap(actions.onSendTerminalBufferToAgent)!}
										theme={theme}
									/>
								)}
								{kind === 'terminal' && actions?.onPublishTerminalBufferGist && (
									<PaneMenuItem
										icon={Share2}
										label="Publish Buffer as GitHub Gist"
										onClick={wrap(actions.onPublishTerminalBufferGist)!}
										theme={theme}
									/>
								)}
								{kind === 'terminal' && actions?.onConfigureTerminalStartup && (
									<PaneMenuItem
										icon={Play}
										label="Configure Startup Command"
										onClick={wrap(actions.onConfigureTerminalStartup)!}
										theme={theme}
									/>
								)}

								{/* Browser content actions */}
								{kind === 'browser' &&
									(actions?.onCopyBrowserContent || actions?.onSendBrowserContentToAgent) && (
										<PaneMenuDivider theme={theme} />
									)}
								{kind === 'browser' && actions?.onCopyBrowserContent && (
									<PaneMenuItem
										icon={Clipboard}
										label="Copy Content"
										onClick={wrap(actions.onCopyBrowserContent)!}
										theme={theme}
									/>
								)}
								{kind === 'browser' && actions?.onSendBrowserContentToAgent && (
									<PaneMenuItem
										icon={ArrowRightCircle}
										label="Send Content to Agent"
										onClick={wrap(actions.onSendBrowserContentToAgent)!}
										theme={theme}
									/>
								)}

								{/* --- Layout / group actions (always available) --- */}
								<PaneMenuDivider theme={theme} />
								<PaneMenuItem
									icon={PanelsTopLeft}
									label="Move to own tab"
									onClick={handleMoveToOwnTab}
									theme={theme}
								/>
								<PaneMenuItem
									icon={Ungroup}
									label="Break apart group"
									onClick={handleBreakApart}
									theme={theme}
								/>
								{handleClose && (
									<>
										<PaneMenuDivider theme={theme} />
										<PaneMenuItem icon={X} label="Close Tab" onClick={handleClose} theme={theme} />
									</>
								)}
							</div>
						</div>
					</>,
					document.body
				)}
		</>
	);
}

/**
 * Status indicators for a pane's title bar. A tiled tab has no strip chip, so the
 * signals a chip would show (error, busy/thinking, generating-name spinner, wizard,
 * unread, draft) surface here instead - mirroring AITab's indicator set. Only AI
 * panes carry these states; file/terminal/browser panes render nothing.
 */
function PaneStatusIndicators({
	tab,
	session,
	theme,
}: {
	tab: UnifiedTabRef;
	session: Session;
	theme: Theme;
}) {
	if (tab.type !== 'ai') return null;
	const aiTab = session.aiTabs?.find((t) => t.id === tab.id);
	if (!aiTab) return null;
	const isWizard = !!(aiTab.wizardState?.isActive || aiTab.wizardState?.isGeneratingDocs);
	const draft = hasDraft(aiTab);
	return (
		<>
			{aiTab.agentError && (
				<span title={`Error: ${aiTab.agentError.message}`}>
					<AlertCircle className="w-3 h-3 shrink-0" style={{ color: theme.colors.error }} />
				</span>
			)}
			{aiTab.state === 'busy' && (
				<span
					className="w-2 h-2 rounded-full shrink-0 animate-pulse"
					style={{ backgroundColor: theme.colors.warning }}
					title="Thinking"
				/>
			)}
			<WizardIndicator active={isWizard} generatingDocs={!!aiTab.wizardState?.isGeneratingDocs} />
			{aiTab.isGeneratingName && (
				<span title="Generating tab name...">
					<Loader2
						className="w-3 h-3 shrink-0 animate-spin"
						style={{ color: theme.colors.textDim }}
					/>
				</span>
			)}
			{aiTab.state !== 'busy' && aiTab.hasUnread && (
				<span
					className="w-2 h-2 rounded-full shrink-0"
					style={{ backgroundColor: theme.colors.error }}
					title="New messages"
				/>
			)}
			{draft && (
				<span title="Has draft message">
					<Pencil className="w-3 h-3 shrink-0" style={{ color: theme.colors.warning }} />
				</span>
			)}
		</>
	);
}

/** A single leaf pane: a title bar (doubles as a drag handle) atop the content. */
function PaneFrame({
	node,
	group,
	session,
	theme,
	isFocused,
	paneTabActions,
}: {
	node: Extract<PanelLayoutNode, { kind: 'leaf' }>;
	group: TabGroup;
	session: Session;
	theme: Theme;
	isFocused: boolean;
	paneTabActions?: PaneTabActions;
}) {
	const title = resolveTabRefTitle(session, node.tab);
	// Zoom/maximize: a single pane can temporarily fill the whole panel. When any
	// pane is zoomed, `zoomedPaneId` is set (this pane is the maximized one iff it
	// matches). Transient UI-store state - not persisted, not part of the layout.
	const zoomedPaneId = useUIStore((s) => s.zoomedPaneId);
	const isZoomed = zoomedPaneId === node.id;
	// Clicking anywhere in the pane focuses it (matches single-view "click to
	// focus" and routes AI input to this pane). Cheap object-equality no-op when
	// this pane is already focused, so idle clicks don't churn the store.
	const focusThisPane = React.useCallback(() => {
		if (group.focusedPaneId === node.id) return;
		updateSessionWith(session.id, (s) => focusPaneInSession(s, group.id, node.id));
	}, [group.focusedPaneId, group.id, node.id, session.id]);

	// Toggle maximize for THIS pane: zoom it if not zoomed, restore otherwise. Also
	// focuses the pane so the maximized view routes input to it. Independent of the
	// Ctrl+Cmd+Z keyboard zoom, which targets the focused pane.
	const toggleZoom = React.useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			e.preventDefault();
			const { zoomedPaneId: current, setZoomedPaneId } = useUIStore.getState();
			if (current === node.id) {
				setZoomedPaneId(null);
			} else {
				setZoomedPaneId(node.id);
				if (group.focusedPaneId !== node.id) {
					updateSessionWith(session.id, (s) => focusPaneInSession(s, group.id, node.id));
				}
			}
		},
		[group.focusedPaneId, group.id, node.id, session.id]
	);

	// Rearrange this pane by dragging its title bar. Uses pointer events, NOT native
	// HTML5 DnD: inside a child Electron window on a scaled display the native macOS
	// drag session fires `dragstart` then dies before any `drag`/`dragover`/`drop`, so
	// a native pane drag silently no-ops. See usePaneDrag for the full rationale. Drop
	// on another tile's edge to move/re-split, its center to swap, or the tab strip to
	// pop the pane out.
	const onPaneDragPointerDown = usePaneDrag(session.id, group.id, node.id);

	return (
		<div
			className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
			onMouseDown={focusThisPane}
			// Tags this pane's box so the drop-zone overlay can hit-test a tab drag
			// against it (read via document.querySelectorAll in PaneDropZones).
			data-pane-leaf-id={node.id}
			style={{
				// Accent ring on the focused pane; a plain border otherwise. Same
				// accent token active/selected states use elsewhere - no hardcoded colors.
				border: `1px solid ${isFocused ? theme.colors.accent : theme.colors.border}`,
				boxShadow: isFocused ? `inset 0 0 0 1px ${theme.colors.accent}` : undefined,
			}}
		>
			{/* Title bar - brighter (accent text) when this pane holds focus. Also a
			    drag handle: drag it to the tab bar to promote this pane out. The
			    chevron opens the pane actions menu (rename / move to own tab / break
			    apart) since a tiled tab has no strip chip of its own. */}
			<div
				className="relative shrink-0 flex items-center gap-1 px-2 py-1 text-xs font-medium select-none cursor-grab active:cursor-grabbing"
				style={{
					backgroundColor: isFocused ? theme.colors.bgActivity : theme.colors.bgSidebar,
					color: isFocused ? theme.colors.accent : theme.colors.textMain,
					borderBottom: `1px solid ${isFocused ? theme.colors.accent : theme.colors.border}`,
				}}
				title="Drag to rearrange - drop on a tile's edge to move, its center to swap, or the tab bar to pop out"
				// Pointer-driven rearrange (not native draggable - see usePaneDrag). Press
				// starts drag tracking; a plain click without movement focuses the pane. The
				// parent's mousedown-focus is stopped so a grab stays a pure drag.
				onPointerDown={onPaneDragPointerDown}
				onMouseDown={(e) => e.stopPropagation()}
				onClick={focusThisPane}
			>
				{/* Grip texture centered in the header, marking the whole bar as the drag
				    handle for rearranging tiles. Decorative only (pointer-events-none): the
				    bar handles the pointer drag, so the grip just signals "grab here". */}
				<GripHorizontal
					className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none opacity-40"
					style={{ color: 'currentColor' }}
					aria-hidden
				/>
				<PaneActionsMenu
					node={node}
					group={group}
					session={session}
					theme={theme}
					actions={paneTabActions}
				/>
				<PaneStatusIndicators tab={node.tab} session={session} theme={theme} />
				<span className="truncate">{title}</span>
				{/* Maximize / restore: fills the panel with this pane (Minimize2 folds it
				    back into its quadrant). Pushed to the right edge with ml-auto. Not a
				    drag handle - stopPropagation keeps the title-bar drag from starting. */}
				<button
					onClick={toggleZoom}
					onMouseDown={(e) => e.stopPropagation()}
					draggable={false}
					onDragStart={(e) => e.preventDefault()}
					className="shrink-0 ml-auto rounded hover:bg-white/10 transition-colors p-0.5 cursor-pointer"
					title={isZoomed ? 'Restore pane' : 'Maximize pane'}
					aria-label={isZoomed ? 'Restore pane' : 'Maximize pane'}
				>
					{isZoomed ? (
						<Minimize2 className="w-3 h-3" style={{ color: 'currentColor' }} />
					) : (
						<Maximize2 className="w-3 h-3" style={{ color: 'currentColor' }} />
					)}
				</button>
			</div>
			<PaneContent tab={node.tab} session={session} theme={theme} isFocused={isFocused} />
		</div>
	);
}

/**
 * Draggable divider between two sibling panes in a split. During the drag it
 * writes flex-grow directly onto the two neighboring pane wrappers (no re-render
 * per frame), and on release it commits the final fractional sizes to the group's
 * layout via a single store update.
 *
 * Runs on usePointerDrag - the same pointer-capture primitive behind every other
 * drag in the app - rather than hand-rolled document mouse listeners, because the
 * hand-rolled version could get stuck mid-resize and never release:
 *   - It committed BEFORE removing its listeners, so a throw anywhere in the
 *     store update (which re-renders every pane synchronously) left `mousemove`
 *     attached and the divider kept following the pointer with no button held.
 *   - No pointer capture: a tiled browser pane is a <webview> overlay stacked
 *     above this layout (and a tiled terminal pane re-enables pointer events over
 *     its own rect), so a drag whose pointer crossed one could lose the event
 *     stream and never see its mouseup.
 *   - No `pointercancel` and no unmount cleanup, so a gesture the system took
 *     over, or a group/tab switch mid-drag, leaked the listeners permanently.
 */
function SplitDivider({
	direction,
	theme,
	onDrag,
	onCommit,
}: {
	direction: 'row' | 'column';
	theme: Theme;
	/** clientX/Y delta from drag start; returns nothing (caller applies to DOM). */
	onDrag: (delta: number) => void;
	onCommit: () => void;
}) {
	const [isDragging, setIsDragging] = React.useState(false);
	const startDrag = usePointerDrag();
	const isRow = direction === 'row';

	const onPointerDown = React.useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			// Left button only. A right-click on the divider used to arm a phantom
			// drag that nothing would ever release.
			if (e.button !== 0) return;
			setIsDragging(true);
			startDrag(e, (dx, dy) => onDrag(isRow ? dx : dy), {
				stopPropagation: true,
				onEnd: () => {
					setIsDragging(false);
					onCommit();
				},
			});
		},
		[isRow, onDrag, onCommit, startDrag]
	);

	return (
		<div
			onPointerDown={onPointerDown}
			className={`shrink-0 ${isRow ? 'cursor-col-resize' : 'cursor-row-resize'}`}
			style={{
				[isRow ? 'width' : 'height']: '4px',
				backgroundColor: isDragging ? theme.colors.accent : 'transparent',
				// Keep the browser from claiming the gesture as a scroll/pan on touch,
				// which would cancel the drag the moment it started.
				touchAction: 'none',
			}}
			// Wider transparent hit area is handled by the 4px band; keep the visual
			// subtle until hover/drag so the layout reads clean.
		/>
	);
}

/** Recursively render one layout node (leaf -> PaneFrame, split -> flex row/col). */
function LayoutNode({
	node,
	group,
	session,
	theme,
	paneTabActions,
}: {
	node: PanelLayoutNode;
	group: TabGroup;
	session: Session;
	theme: Theme;
	paneTabActions?: PaneTabActions;
}) {
	// Refs to each child wrapper so the divider drag can set flex-grow directly.
	const childRefs = React.useRef<(HTMLDivElement | null)[]>([]);
	// Live sizes during a drag (committed to the store on mouseup).
	const dragSizesRef = React.useRef<number[] | null>(null);

	if (node.kind === 'leaf') {
		return (
			<PaneFrame
				node={node}
				group={group}
				session={session}
				theme={theme}
				isFocused={group.focusedPaneId === node.id}
				paneTabActions={paneTabActions}
			/>
		);
	}

	const isRow = node.direction === 'row';

	// Resize between child i and child i+1: shift weight from one to the other,
	// clamped so neither collapses. Writes flex-grow straight onto the DOM for a
	// smooth drag; the committed value goes to the store on release.
	const applyDrag = (dividerIndex: number, delta: number) => {
		const container = childRefs.current[dividerIndex]?.parentElement;
		if (!container) return;
		const axisPx = isRow ? container.clientWidth : container.clientHeight;
		if (axisPx <= 0) return;
		const deltaFrac = delta / axisPx;
		const MIN = 0.05;
		const base = node.sizes;
		const a = base[dividerIndex];
		const b = base[dividerIndex + 1];
		// Constrain the shift so both neighbors stay at/above MIN.
		const shift = Math.max(-(a - MIN), Math.min(b - MIN, deltaFrac));
		const next = [...base];
		next[dividerIndex] = a + shift;
		next[dividerIndex + 1] = b - shift;
		dragSizesRef.current = next;
		const first = childRefs.current[dividerIndex];
		const second = childRefs.current[dividerIndex + 1];
		if (first) first.style.flexGrow = String(next[dividerIndex]);
		if (second) second.style.flexGrow = String(next[dividerIndex + 1]);
	};

	const commitDrag = () => {
		const sizes = dragSizesRef.current;
		dragSizesRef.current = null;
		if (!sizes) return;
		updateSessionWith(session.id, (s) =>
			updateGroupInSession(s, group.id, (g) => ({
				...g,
				layout: updateSplitSizes(g.layout, node.id, sizes),
			}))
		);
	};

	return (
		<div className={`flex flex-1 min-w-0 min-h-0 ${isRow ? 'flex-row' : 'flex-col'}`}>
			{node.children.map((child, index) => (
				<React.Fragment key={child.id}>
					{index > 0 && (
						<SplitDivider
							direction={node.direction}
							theme={theme}
							onDrag={(delta) => applyDrag(index - 1, delta)}
							onCommit={commitDrag}
						/>
					)}
					<div
						ref={(el) => {
							childRefs.current[index] = el;
						}}
						className="flex min-w-0 min-h-0 overflow-hidden"
						style={{ flexGrow: node.sizes[index], flexBasis: 0 }}
					>
						<LayoutNode
							node={child}
							group={group}
							session={session}
							theme={theme}
							paneTabActions={paneTabActions}
						/>
					</div>
				</React.Fragment>
			))}
		</div>
	);
}

export const TiledLayout = React.memo(function TiledLayout({
	group,
	session,
	theme,
	zoomedPaneId,
	onPaneRectsChange,
	paneTabActions,
	paneChatActions,
	paneFileActions,
}: TiledLayoutProps) {
	// Zoom/maximize: render only the focused (zoomed) leaf full-panel. Non-persisted
	// and controlled by the caller; fall back to the full layout if the id is stale.
	const zoomedLeaf = zoomedPaneId != null ? findLeafById(group.layout, zoomedPaneId) : null;

	// Root container the pane rects are measured against, and the live registry of
	// terminal/browser slot elements (populated by PaneOverlaySlot ref callbacks).
	const containerRef = React.useRef<HTMLDivElement>(null);
	const slotsRef = React.useRef<Map<string, HTMLElement>>(new Map());
	// One ResizeObserver watches the container + every registered slot; a resize on
	// any of them (divider drag, window resize, panel show/hide) re-measures.
	const observerRef = React.useRef<ResizeObserver | null>(null);
	// Latest published keys, so we can emit an empty map exactly once when the last
	// terminal/browser leaf goes away (avoids leaving a stale overlay positioned).
	const lastKeysRef = React.useRef<string>('');

	// Keep the callback in a ref so the throttled measurer has a stable identity
	// (the callback prop may change identity every render in the parent).
	const onChangeRef = React.useRef(onPaneRectsChange);
	onChangeRef.current = onPaneRectsChange;

	const measure = React.useCallback(() => {
		const container = containerRef.current;
		if (!container) return;
		const base = container.getBoundingClientRect();
		const rects: PaneRects = new Map();
		for (const [key, el] of slotsRef.current) {
			if (!el.isConnected) continue;
			const r = el.getBoundingClientRect();
			rects.set(key, {
				top: r.top - base.top,
				left: r.left - base.left,
				width: r.width,
				height: r.height,
			});
		}
		const keys = [...rects.keys()].sort().join(',');
		// Skip publishing when nothing is registered and nothing was before, so an
		// AI/file-only group never churns the parent with empty-map updates.
		if (rects.size === 0 && lastKeysRef.current === '') return;
		lastKeysRef.current = keys;
		onChangeRef.current?.(rects);
	}, []);

	// Throttle geometry publishes so a divider drag (many resize ticks) doesn't
	// thrash the parent's state or the overlay repositioning.
	const throttledMeasure = useThrottledCallback(measure, 16);

	// Slot registration is a DISCRETE mount/unmount event, not a high-frequency
	// resize stream, so it needs a GUARANTEED measure - not the throttled one. The
	// throttle (kept for the ResizeObserver drag-storm path) can silently swallow a
	// registration: on a re-render that re-registers slots, React fires each inline
	// ref as cleanup(null) then set(el); the throttle's leading edge can publish
	// mid-transition (a slot momentarily deleted), and its single trailing edge can
	// be consumed before the re-add - so a just-(re)mounted terminal/browser slot
	// sits in slotsRef, connected and sized, yet never reaches paneRects until an
	// unrelated resize (this was the live-diagnosed "browser tile renders blank until
	// you expand/contract it" bug - only the zoom toggle's DIRECT measure recovered
	// it). A deduped rAF runs exactly one measure after the commit settles, reading
	// the final slot set, so registration always publishes.
	const measureRafRef = React.useRef<number | null>(null);
	const scheduleMeasure = React.useCallback(() => {
		if (measureRafRef.current != null) return;
		measureRafRef.current = requestAnimationFrame(() => {
			measureRafRef.current = null;
			measure();
		});
	}, [measure]);

	const registry = React.useMemo<PaneSlotRegistry>(
		() => ({
			register(key, el) {
				const observer = observerRef.current;
				const prev = slotsRef.current.get(key);
				if (prev && prev !== el && observer) observer.unobserve(prev);
				if (el) {
					slotsRef.current.set(key, el);
					if (observer) observer.observe(el);
				} else {
					slotsRef.current.delete(key);
				}
				// Slot mount/unmount changes the set of panes; schedule a guaranteed
				// post-commit re-measure so the new set is always published.
				scheduleMeasure();
			},
		}),
		[scheduleMeasure]
	);

	// Set up the ResizeObserver against the container + already-registered slots,
	// and re-measure on every layout change (group.layout / zoom identity shift).
	React.useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const observer = new ResizeObserver(() => throttledMeasure());
		observerRef.current = observer;
		observer.observe(container);
		for (const el of slotsRef.current.values()) observer.observe(el);
		// Measure once synchronously after layout so overlays land on first paint.
		measure();
		return () => {
			observer.disconnect();
			observerRef.current = null;
		};
	}, [measure, throttledMeasure]);

	// Re-measure whenever the layout tree or zoom target changes (panes added,
	// removed, resized via keyboard, or maximized) - geometry shifts without a
	// container resize event in those cases.
	React.useLayoutEffect(() => {
		measure();
	}, [measure, group.layout, zoomedPaneId]);

	// On unmount (group closed / switched away), clear any published rects so the
	// overlays fall back to standalone positioning with no orphaned geometry, and
	// cancel any pending registration-triggered measure so it can't fire post-unmount.
	React.useEffect(() => {
		return () => {
			if (measureRafRef.current != null) {
				cancelAnimationFrame(measureRafRef.current);
				measureRafRef.current = null;
			}
			if (lastKeysRef.current !== '') {
				lastKeysRef.current = '';
				onChangeRef.current?.(new Map());
			}
		};
	}, []);

	// One context value for every pane kind, rebuilt only when a bundle changes.
	const viewActions = React.useMemo<PaneViewActions>(
		() => ({ chat: paneChatActions ?? null, file: paneFileActions ?? null }),
		[paneChatActions, paneFileActions]
	);

	return (
		<PaneSlotContext.Provider value={registry}>
			<PaneViewContext.Provider value={viewActions}>
				<div
					ref={containerRef}
					className="flex-1 min-h-0 overflow-hidden flex flex-col"
					data-tour="tiled-layout"
				>
					{zoomedLeaf && zoomedLeaf.kind === 'leaf' ? (
						<PaneFrame
							node={zoomedLeaf}
							group={group}
							session={session}
							theme={theme}
							isFocused={true}
							paneTabActions={paneTabActions}
						/>
					) : (
						<LayoutNode
							node={group.layout}
							group={group}
							session={session}
							theme={theme}
							paneTabActions={paneTabActions}
						/>
					)}
				</div>
			</PaneViewContext.Provider>
		</PaneSlotContext.Provider>
	);
});
