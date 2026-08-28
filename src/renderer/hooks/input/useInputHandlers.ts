/**
 * useInputHandlers - extracted from App.tsx (Phase 2J)
 *
 * Orchestrates all input-related state and handlers by:
 *   - Managing dual input state (AI per-tab + terminal per-session)
 *   - Calling sub-hooks: useInputSync, useTabCompletion, useAtMentionCompletion,
 *     useInputProcessing, useInputKeyDown
 *   - Computing memoized completion suggestions
 *   - Owning tab/session switching effects for input persistence
 *   - Providing paste, drop, blur, and replay handlers
 *
 * PERF: Does not subscribe to the full active Session. Streaming log / token
 * updates must not re-render MaestroConsoleInner via this hook. Reactive
 * subscriptions are limited to primitives (activeSessionId, inputMode,
 * activeTabId) and stable field refs (stagedImages). Handlers and sync
 * callbacks resolve the live session via getState() / sessionsRef at event time.
 *
 * Reads from: sessionStore, settingsStore, groupChatStore, uiStore,
 *             fileExplorerStore, InputContext
 */

import { useCallback, useEffect, useRef, useMemo } from 'react';
import type { Session, Group, BatchRunState, QueuedItem, CustomAICommand } from '../../types';
import {
	useSessionStore,
	selectActiveSession,
	updateSessionWith,
	updateAiTab,
} from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useUIStore } from '../../stores/uiStore';
import { useFileExplorerStore } from '../../stores/fileExplorerStore';
import { useInputContext } from '../../contexts/InputContext';
import { getActiveTab } from '../../utils/tabHelpers';
import { setLiveDraft } from '../../utils/liveDraftStore';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { notifyToast } from '../../stores/notificationStore';
import { uploadPathlessFile } from '../../utils/osFileDrop';
import { useComposerInputStore } from '../../stores/composerInputStore';
import { useDebouncedValue } from '../utils';
import { useInputSync } from './useInputSync';
import { useTabCompletion } from './useTabCompletion';
import type { TabCompletionSuggestion } from './useTabCompletion';
import { useAtMentionCompletion } from './useAtMentionCompletion';
import { useMentionPicker, type MentionPickerItem, type MentionCategory } from './useMentionPicker';
import { useInputProcessing } from './useInputProcessing';
import { useInputKeyDown } from './useInputKeyDown';
import {
	useCrossAgentDispatch,
	type SpawnBackgroundSynopsisFn,
} from '../agent/useCrossAgentDispatch';
import {
	planCrossAgentMentions,
	dispatchCrossAgentMentions,
	type CrossAgentMentionPlan,
} from '../../services/crossAgentMentions';
import { formatFileMention, stripMentionQuotes } from '../../../shared/mentionPatterns';
import { IMAGE_EXTENSIONS } from '../../utils/fileExplorerIcons/shared';
import { screenshotReferenceLabel } from '../../utils/stagedImageOrder';
import { STAGED_IMAGE_MIME } from '../../components/InputArea/components/stagedImageDrag';
import {
	normalizeComposerCommandMode,
	type ComposerCommandMode,
} from '../../utils/shellCommandInput';
import {
	FILE_TREE_SINGLE_MIME,
	FILE_TREE_MULTI_MIME,
} from '../../components/FileExplorerPanel/types';

function isImagePath(path: string): boolean {
	const ext = path.toLowerCase().split('.').pop();
	return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

// Stable empty references so the gated sessions/groups selectors return the same
// value on every render while the `@` picker is closed - no re-render churn.
const EMPTY_SESSIONS: Session[] = [];
const EMPTY_GROUPS: Group[] = [];
const EMPTY_STAGED_IMAGES: string[] = [];

/**
 * Convert an absolute filesystem path into the form used inside an `@` mention:
 * if it sits inside `projectRoot`, return the relative path; otherwise return
 * the absolute path unchanged. Forward-slash normalised so Windows drops still
 * produce a clean mention.
 */
function toMentionPath(absolutePath: string, projectRoot?: string): string {
	const norm = absolutePath.replace(/\\/g, '/');
	if (!projectRoot) return norm;
	const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
	if (norm === root) return '.';
	if (norm.startsWith(root + '/')) {
		return norm.slice(root.length + 1);
	}
	return norm;
}

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseInputHandlersDeps {
	/** Ref to the input textarea */
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	/** Ref to the terminal output container */
	terminalOutputRef: React.RefObject<HTMLDivElement | null>;
	/** Ref to file tree keyboard nav flag */
	fileTreeKeyboardNavRef: React.MutableRefObject<boolean>;
	/** Drag counter ref for image drop handling */
	dragCounterRef: React.MutableRefObject<number>;
	/** Set dragging image state */
	setIsDraggingFile: (value: boolean) => void;

	// From useBatchHandlers
	/** Get batch state for a specific session */
	getBatchState: (sessionId: string) => BatchRunState;
	/** Active batch run state (prioritizes running batch session) */
	activeBatchRunState: BatchRunState;

	// From other hooks/App.tsx
	/** Ref to processQueuedItem function */
	processQueuedItemRef: React.MutableRefObject<
		((sessionId: string, item: QueuedItem) => Promise<void>) | null
	>;
	/** Flush pending batched session updates */
	flushBatchedUpdates: () => void;
	/** Handler for /history command */
	handleHistoryCommand: () => Promise<void>;
	/** Handler for /wizard command */
	handleWizardCommand: (args: string) => void;
	/** Handler for sending wizard messages */
	sendWizardMessageWithThinking: (content: string, images?: string[]) => Promise<void>;
	/** Whether wizard is active for current tab */
	isWizardActiveForCurrentTab: boolean;
	/** Handler for /skills command */
	handleSkillsCommand: () => Promise<void>;
	/** All slash commands (built-in + custom + speckit + openspec + agent) */
	allSlashCommands: Array<{
		command: string;
		description: string;
		terminalOnly?: boolean;
		aiOnly?: boolean;
	}>;
	/** All custom AI commands (custom + speckit + openspec) */
	allCustomCommands: CustomAICommand[];
	/** Sessions ref for non-reactive access */
	sessionsRef: React.MutableRefObject<Session[]>;
	/** Active session ID ref for non-reactive access */
	activeSessionIdRef: React.MutableRefObject<string>;
	/**
	 * Background synopsis spawn (from useAgentExecution), forwarded to the
	 * cross-agent consult so it can condense a finished consultation's response
	 * into the History detail view.
	 */
	spawnBackgroundSynopsis: SpawnBackgroundSynopsisFn;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseInputHandlersReturn {
	/**
	 * Set current input value (dispatches to AI or terminal slice based on mode).
	 * The live value itself lives in useComposerInputStore; read it there
	 * (InputArea subscribes; non-reactive readers use getState()).
	 */
	setInputValue: (value: string | ((prev: string) => string)) => void;
	/** Staged images for the current message */
	stagedImages: string[];
	/** Set staged images for the current message */
	setStagedImages: (images: string[] | ((prev: string[]) => string[])) => void;
	/** Process and send the current input */
	processInput: (
		text?: string,
		options?: { forceParallel?: boolean; images?: string[]; sessionId?: string; tabId?: string }
	) => void;
	/** Ref to latest processInput for use in memoized callbacks */
	processInputRef: React.MutableRefObject<
		(
			text?: string,
			options?: { forceParallel?: boolean; images?: string[]; sessionId?: string; tabId?: string }
		) => void
	>;
	/** Keyboard event handler for the input textarea */
	handleInputKeyDown: (e: React.KeyboardEvent) => void;
	/** Capture the agent/tab that owns the composer when the input gains focus */
	handleMainPanelInputFocus: () => void;
	/** Handler for input blur (persists input to session state) */
	handleMainPanelInputBlur: () => void;
	/** Replay a message (optionally with images) */
	handleReplayMessage: (text: string, images?: string[]) => void;
	/** Clipboard paste handler (trims text, stages images) */
	handlePaste: (e: React.ClipboardEvent) => void;
	/** Drag-and-drop handler (stages image files) */
	handleDrop: (e: React.DragEvent) => void;
	/** Tab completion suggestions for terminal mode */
	tabCompletionSuggestions: TabCompletionSuggestion[];
	/** Unified `@` picker rows for the active category (AI mode) */
	atMentionItems: MentionPickerItem[];
	/** Per-category totals for the picker's category bar */
	atMentionCounts: Record<MentionCategory, number>;
	/** Sync file tree highlight to match tab completion suggestion */
	syncFileTreeToTabCompletion: (suggestion: TabCompletionSuggestion | undefined) => void;
}

// ============================================================================
// Selectors
// ============================================================================

const selectActiveRightTab = (s: ReturnType<typeof useUIStore.getState>) => s.activeRightTab;

// ============================================================================
// Hook
// ============================================================================

export function useInputHandlers(deps: UseInputHandlersDeps): UseInputHandlersReturn {
	const {
		inputRef,
		terminalOutputRef,
		fileTreeKeyboardNavRef,
		dragCounterRef,
		setIsDraggingFile,
		getBatchState,
		activeBatchRunState,
		processQueuedItemRef,
		flushBatchedUpdates,
		handleHistoryCommand,
		handleWizardCommand,
		sendWizardMessageWithThinking,
		isWizardActiveForCurrentTab,
		handleSkillsCommand,
		allSlashCommands,
		allCustomCommands,
		sessionsRef,
		activeSessionIdRef,
		spawnBackgroundSynopsis,
	} = deps;

	// --- Store subscriptions (reactive, narrow) ---
	// PERF: Never useSessionStore(selectActiveSession). Streamed logs/tokens would
	// re-render MaestroConsoleInner on every chunk.
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	// The id `selectActiveSession` actually resolved to, which is NOT always
	// `activeSessionId`: the selector falls back to `sessions[0]` while a freshly
	// created agent catches up. Draft ownership has to tell those apart, so it
	// gets its own narrow subscription rather than the whole session object.
	const resolvedSessionId = useSessionStore((s) => selectActiveSession(s)?.id);
	const activeSessionInputMode = useSessionStore((s) => selectActiveSession(s)?.inputMode);
	const activeTabId = useSessionStore((s) => {
		const session = selectActiveSession(s);
		return session ? getActiveTab(session)?.id : undefined;
	});
	const stagedImages = useSessionStore((s) => {
		const session = selectActiveSession(s);
		if (!session || session.inputMode !== 'ai') return EMPTY_STAGED_IMAGES;
		const images = getActiveTab(session)?.stagedImages;
		// Empty arrays are truthy - without this, every stream flush that rebuilds
		// the tab with `stagedImages: []` returns a new [] ref and re-renders App.
		if (!images || images.length === 0) return EMPTY_STAGED_IMAGES;
		return images;
	});
	const setSessions = useMemo(() => useSessionStore.getState().setSessions, []);
	const setGroupChatStagedImages = useMemo(
		() => useGroupChatStore.getState().setGroupChatStagedImages,
		[]
	);
	const activeRightTab = useUIStore(selectActiveRightTab);
	const setActiveRightTab = useMemo(() => useUIStore.getState().setActiveRightTab, []);
	const setSuccessFlashNotification = useMemo(
		() => useUIStore.getState().setSuccessFlashNotification,
		[]
	);
	const flatFileList = useFileExplorerStore((s) => s.flatFileList);
	const setSelectedFileIndex = useMemo(
		() => useFileExplorerStore.getState().setSelectedFileIndex,
		[]
	);
	const conductorProfile = useSettingsStore((s) => s.conductorProfile);
	const automaticTabNamingEnabled = useSettingsStore((s) => s.automaticTabNamingEnabled);

	// --- InputContext state (completion dropdowns) ---
	const {
		tabCompletionOpen,
		tabCompletionFilter,
		atMentionOpen,
		atMentionFilter,
		atMentionCategory,
		setSlashCommandOpen,
	} = useInputContext();

	// All agents + groups feed the Agents scope of the unified `@` picker. Gate
	// the subscription on atMentionOpen so streaming flushes from any agent don't
	// recompute mention suggestions while the picker is closed (mirrors the
	// fileSuggestions gate below). Stable empty refs avoid re-render churn.
	const sessions = useSessionStore((s) => (atMentionOpen ? s.sessions : EMPTY_SESSIONS));
	const groups = useSessionStore((s) => (atMentionOpen ? s.groups : EMPTY_GROUPS));

	// --- Derived values ---
	// The tab the composer is currently drafting FOR, which is not the same
	// question as "which tab does the app show". `selectActiveSession` falls back
	// to `sessions[0]` so the UI has something to render while a freshly created
	// agent's session object catches up with `activeSessionId` - useful for
	// rendering, actively wrong for attributing text, because it names an agent
	// the user is not typing into. Resolve `undefined` in that window instead:
	// the text is then parked unowned and adopted by the real tab when it lands,
	// rather than flushed onto a stranger's tab.
	const activeTabIdForInput =
		resolvedSessionId && (!activeSessionId || resolvedSessionId === activeSessionId)
			? activeTabId
			: undefined;
	const isAiMode = activeSessionInputMode === 'ai';

	// ====================================================================
	// Input State
	// ====================================================================

	// PERF: live composer text lives in useComposerInputStore, NOT useState here.
	// A keystroke updates the store, which re-renders only the memoized InputArea
	// leaf that subscribes to it - this hook (and App) no longer re-render per
	// keystroke. The store setters are stable; grab them once.
	const setAiValue = useMemo(() => useComposerInputStore.getState().setAiValue, []);
	const setTerminalValue = useMemo(() => useComposerInputStore.getState().setTerminalValue, []);
	const setAiCommandMode = useMemo(() => useComposerInputStore.getState().setAiCommandMode, []);
	const loadAiDraft = useMemo(() => useComposerInputStore.getState().loadAiDraft, []);
	const adoptAiDraft = useMemo(() => useComposerInputStore.getState().adoptAiDraft, []);

	// Ref-mirror of the tab the composer drafts for, so the live-draft mirror can
	// adopt text typed before any tab existed, and the tab-switch effect can act
	// on a change without re-triggering on tab-switch alone.
	const activeTabIdRef = useRef<string | undefined>(activeTabIdForInput);

	// Ref-mirror of the current mode so non-reactive readers (getInputValue) pick
	// the right slice at call time without subscribing.
	const isAiModeRef = useRef(isAiMode);
	useEffect(() => {
		isAiModeRef.current = isAiMode;
	}, [isAiMode]);

	// Read the live value non-reactively (at call time) for handlers and sub-hooks
	// so they never need a reactive `inputValue` dependency.
	const getInputValue = useCallback(() => {
		const s = useComposerInputStore.getState();
		return isAiModeRef.current ? s.aiValue : s.terminalValue;
	}, []);

	// The bang ladder only exists for the AI composer; the terminal is already a
	// shell, so it reports 'off' there rather than double-routing.
	const getCommandMode = useCallback(
		(): ComposerCommandMode =>
			isAiModeRef.current ? useComposerInputStore.getState().aiCommandMode : 'off',
		[]
	);

	// Memoized setter that dispatches to the correct slice based on current mode.
	const setInputValue = useCallback(
		(value: string | ((prev: string) => string)) => {
			if (activeSessionInputMode === 'ai') {
				setAiValue(value);
			} else {
				setTerminalValue(value);
			}
		},
		[activeSessionInputMode, setAiValue, setTerminalValue]
	);

	// ====================================================================
	// Staged Images
	// ====================================================================

	const setStagedImages = useCallback(
		(imagesOrUpdater: string[] | ((prev: string[]) => string[])) => {
			const activeSession = selectActiveSession(useSessionStore.getState());
			if (!activeSession) return;
			updateSessionWith(activeSession.id, (s) => {
				const tabId = s.activeTabId;
				if (!tabId) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((tab) => {
						if (tab.id !== tabId) return tab;
						const currentImages = tab.stagedImages || [];
						const newImages =
							typeof imagesOrUpdater === 'function'
								? imagesOrUpdater(currentImages)
								: imagesOrUpdater;
						return { ...tab, stagedImages: newImages };
					}),
				};
			});
		},
		[]
	);

	// ====================================================================
	// Sub-hook calls
	// ====================================================================

	// Input sync handlers (resolve session via getState inside callbacks)
	const { syncAiInputToSession, queueAiDraftFlush, syncTerminalInputToSession } = useInputSync({
		setSessions,
	});

	// Mirror the live AI draft out of the composer store on every keystroke:
	//  - into liveDraftStore, so hasDraft() reflects what's on screen
	//    (tab.inputValue only updates on blur/submit);
	//  - onto the tab itself via a coalesced write-back, so the text survives
	//    anything that skips the blur / submit / tab-switch flush points (a
	//    quit while typing, an unmount, focus that never left the textarea).
	// Both are attributed to the tab that OWNS the text (composerInputStore's
	// `aiValueTabId`), never to whatever tab is active when the write lands.
	// A keystroke on unowned text claims it for the tab being drafted for, if
	// there is one - text typed while the agent has no AI tab at all stays
	// unowned and is adopted by the next tab to become active, rather than being
	// filed against the last tab of the agent the user just left.
	// Subscribing outside React render keeps this off the re-render path.
	useEffect(() => {
		activeTabIdRef.current = activeTabIdForInput;
		const ownerOf = (stamped: string | null): string | undefined => {
			if (stamped) return stamped;
			const adoptable = activeTabIdRef.current;
			if (adoptable) adoptAiDraft(adoptable);
			return adoptable;
		};
		const state = useComposerInputStore.getState();
		if (state.aiValueTabId) setLiveDraft(state.aiValueTabId, state.aiValue);
		return useComposerInputStore.subscribe((next, prev) => {
			// Ownership changes matter as much as edits: a tab handed the same text
			// its neighbour was holding still needs its own live-draft entry, or the
			// tab strip shows no draft marker on the tab that actually has one.
			if (
				next.aiValue === prev.aiValue &&
				next.aiCommandMode === prev.aiCommandMode &&
				next.aiValueTabId === prev.aiValueTabId
			)
				return;
			const ownerTabId = ownerOf(next.aiValueTabId);
			if (!ownerTabId) return;
			setLiveDraft(ownerTabId, next.aiValue);
			queueAiDraftFlush(ownerTabId, next.aiValue, next.aiCommandMode);
		});
	}, [activeTabIdForInput, adoptAiDraft, queueAiDraftFlush]);

	// Tab / @mention completion: no-arg form subscribes only to non-streaming fields
	const { getSuggestions: getTabCompletionSuggestions } = useTabCompletion();
	const { getSuggestions: getAtMentionSuggestions } = useAtMentionCompletion();

	// ====================================================================
	// Tab/Session switching effects
	// ====================================================================

	const prevActiveTabIdRef = useRef<string | undefined>(activeTabIdForInput);
	const prevActiveSessionIdRef = useRef<string | undefined>(resolvedSessionId);
	const didHydrateAiInputRef = useRef(false);
	const didHydrateTerminalInputRef = useRef(false);

	useEffect(() => {
		if (!activeTabIdForInput || didHydrateAiInputRef.current) return;
		// Read the tab from the store rather than subscribing to it: this hook
		// deliberately holds no whole-session subscription (see the PERF note on
		// the selectors above), and the store copy is the fresher one anyway.
		const session = selectActiveSession(useSessionStore.getState());
		const tab = session ? getActiveTab(session) : null;
		if (!tab) return;
		loadAiDraft(
			activeTabIdForInput,
			tab.inputValue ?? '',
			normalizeComposerCommandMode(tab.commandMode)
		);
		didHydrateAiInputRef.current = true;
	}, [activeTabIdForInput, loadAiDraft]);

	useEffect(() => {
		if (!activeSessionId || didHydrateTerminalInputRef.current) return;
		const session = selectActiveSession(useSessionStore.getState());
		setTerminalValue(session?.terminalDraftInput ?? '');
		didHydrateTerminalInputRef.current = true;
	}, [activeSessionId, setTerminalValue]);

	// Hand the composer over when the tab being drafted for changes - including
	// to "no tab at all", which is a legal state (every AI tab closed with a file
	// tab still open, or an agent whose session object has not landed yet) and
	// leaves the composer on screen and typeable.
	useEffect(() => {
		const nextTabId = activeTabIdForInput;
		if (nextTabId === prevActiveTabIdRef.current) return;
		prevActiveTabIdRef.current = nextTabId;

		// Save the outgoing text to the tab that OWNS it, not to whichever tab was
		// last active: those differ exactly when the previous window had no tab to
		// draft for, and that gap is how text typed on one agent used to be filed
		// against another. Command mode rides along with the text
		// (syncAiInputToSession reads it from the store) - a command draft that
		// came back as a plain message would be sent to the agent, not the shell.
		const composer = useComposerInputStore.getState();
		const ownerTabId = composer.aiValueTabId;
		if (ownerTabId) {
			syncAiInputToSession(composer.aiValue, { tabId: ownerTabId });
		}

		// Resolve the incoming session/tab from the store, not a render snapshot:
		// this hook keeps no whole-session subscription, and a coalesced draft
		// write-back (or text injected by another surface) can land between the
		// render and this effect, which a snapshot would show as empty.
		const session = selectActiveSession(useSessionStore.getState());
		const nextTab = session ? getActiveTab(session) : null;

		if (!nextTabId || !nextTab) {
			// Nowhere to draft for. Text that belonged to a tab is safely flushed
			// above, so clear it; text nobody owns stays parked in the composer for
			// the next tab to adopt, because the user typed it and it is not ours
			// to throw away.
			if (ownerTabId) loadAiDraft(null, '', 'off');
			return;
		}

		const storedTab = session?.aiTabs?.find((t) => t.id === nextTabId) ?? nextTab;
		const storedValue = storedTab.inputValue ?? '';
		// Unowned text was typed while no tab existed to hold it (the user started
		// a message as a new agent was still coming up). The tab that materializes
		// under it adopts it, unless that tab already has a draft of its own -
		// which would mean overwriting one draft with another.
		const adoptsOrphanText = !ownerTabId && composer.aiValue.trim() !== '' && storedValue === '';
		if (adoptsOrphanText) {
			loadAiDraft(nextTabId, composer.aiValue, composer.aiCommandMode);
		} else {
			loadAiDraft(nextTabId, storedValue, normalizeComposerCommandMode(storedTab.commandMode));
		}

		// Clear hasUnread indicator on newly active tab
		if (nextTab.hasUnread && session) {
			updateAiTab(session.id, nextTabId, (t) => ({ ...t, hasUnread: false }));
		}
		// Intentionally only depend on the drafted-for tab id, NOT inputValue
	}, [activeTabIdForInput]);

	// Sync terminal input when switching sessions
	useEffect(() => {
		if (activeSessionId && activeSessionId !== prevActiveSessionIdRef.current) {
			const prevSessionId = prevActiveSessionIdRef.current;

			// Save terminal input to the previous session (including empty string to persist cleared input)
			if (prevSessionId) {
				const currentTerminalValue = useComposerInputStore.getState().terminalValue;
				updateSessionWith(prevSessionId, (s) => ({
					...s,
					terminalDraftInput: currentTerminalValue,
				}));
			}

			// Load terminal input from the new session
			const session = selectActiveSession(useSessionStore.getState());
			setTerminalValue(session?.terminalDraftInput ?? '');
			prevActiveSessionIdRef.current = activeSessionId;
		}
	}, [activeSessionId]);

	// ====================================================================
	// Completion suggestions (memoized)
	// ====================================================================

	// Gated store subscription: returns '' (a stable primitive) unless the
	// tab-completion dropdown is open, so zustand's Object.is bail-out means
	// normal typing does NOT re-render this hook. Only while the dropdown is
	// open do we track the live text to refresh suggestions.
	//
	// Reads the AI draft in AI mode: completion also serves command mode, where
	// the shell draft lives in `aiValue`, not `terminalValue`.
	const tabCompletionInput = useComposerInputStore((s) => {
		if (!tabCompletionOpen) return '';
		return activeSessionInputMode === 'terminal' ? s.terminalValue : s.aiValue;
	});
	// Same gating trick for the mode flag: a stable `false` unless the dropdown
	// is open, so toggling command mode doesn't re-render this hook either. Only
	// the 'shell' rung completes - AI command mode's draft is prose.
	const tabCompletionCommandMode = useComposerInputStore((s) =>
		tabCompletionOpen ? s.aiCommandMode === 'shell' : false
	);
	const debouncedInputForTabCompletion = useDebouncedValue(tabCompletionInput, 50);
	const tabCompletionSuggestions = useMemo(() => {
		if (!tabCompletionOpen || !activeSessionId) return [];
		const isTerminal = activeSessionInputMode === 'terminal';
		// AI mode only gets completions in command mode; an ordinary message has
		// nothing shell-shaped to complete against.
		if (!isTerminal && !tabCompletionCommandMode) return [];
		return getTabCompletionSuggestions(
			debouncedInputForTabCompletion,
			tabCompletionFilter,
			!isTerminal
		);
	}, [
		tabCompletionOpen,
		activeSessionId,
		activeSessionInputMode,
		tabCompletionCommandMode,
		debouncedInputForTabCompletion,
		tabCompletionFilter,
		getTabCompletionSuggestions,
	]);

	// The stored filter is raw (it carries the opening quote while the user types a
	// quoted `@"path with spaces"` mention); the fuzzy file search wants it bare.
	const debouncedAtMentionFilter = useDebouncedValue(
		atMentionOpen ? stripMentionQuotes(atMentionFilter) : '',
		100
	);
	// File/directory suggestions (raw) - only computed while the picker is open in
	// AI mode. These feed the Files/Directories scopes of the unified picker.
	const fileSuggestions = useMemo(() => {
		if (!atMentionOpen || !activeSessionId || activeSessionInputMode !== 'ai') {
			return [];
		}
		return getAtMentionSuggestions(debouncedAtMentionFilter);
	}, [
		atMentionOpen,
		activeSessionId,
		activeSessionInputMode,
		debouncedAtMentionFilter,
		getAtMentionSuggestions,
	]);

	// Unified picker: composes file/dir suggestions with agents/groups into one
	// ranked, category-aware list. Single source of truth for the dropdown.
	const { items: atMentionItems, counts: atMentionCounts } = useMentionPicker({
		filter: debouncedAtMentionFilter,
		category: atMentionCategory,
		sessions,
		groups,
		currentSessionId: activeSessionId,
		fileSuggestions,
	});

	// Sync file tree selection to match tab completion suggestion
	const syncFileTreeToTabCompletion = useCallback(
		(suggestion: TabCompletionSuggestion | undefined) => {
			if (!suggestion || suggestion.type === 'history' || flatFileList.length === 0) return;

			const targetPath = suggestion.value.replace(/\/$/, '');
			// Strip the command-mode bang so a single-token completion (`!src/`)
			// still resolves to a real path in the file tree.
			const pathOnly = (targetPath.split(/\s+/).pop() || targetPath).replace(/^!/, '');
			const matchIndex = flatFileList.findIndex((item) => item.fullPath === pathOnly);

			if (matchIndex >= 0) {
				fileTreeKeyboardNavRef.current = true;
				setSelectedFileIndex(matchIndex);
				if (activeRightTab !== 'files') {
					setActiveRightTab('files');
				}
			}
		},
		[flatFileList, activeRightTab]
	);

	// ====================================================================
	// useInputProcessing (processes and sends input)
	// ====================================================================

	// Cross-agent @mention dispatch (Phase 03). Mounted here (a singleton hook)
	// so the response-chunk subscription is set up once. The planning/dispatch
	// pair itself lives in services/crossAgentMentions so the queue drain can
	// fire a deferred consult from outside React.
	useCrossAgentDispatch(spawnBackgroundSynopsis);

	// Resolve a message's mentions WITHOUT consulting anyone yet. The send path
	// decides when to fire: immediately for a message that dispatches now, or at
	// dequeue time for one that lands in the execution queue. `suppressLocal` on
	// the returned plan means the message leads with an `@agent` mention, so only
	// the mentioned agent(s) answer; a trailing mention (`hey @Backend,
	// thoughts?`) or a leading `@file` mention leaves it false and the source
	// agent answers too.
	const handleCrossAgentMentionPlan = useCallback(
		(message: string, sourceSession: Session): CrossAgentMentionPlan | null =>
			planCrossAgentMentions(message, sourceSession.id),
		[]
	);

	const { processInput, processInputRef: _hookProcessInputRef } = useInputProcessing({
		// PERF: Omit activeSession; processInput resolves via sessionsRef / getState.
		activeSessionId,
		setSessions,
		getInputValue,
		isCommandMode: getCommandMode,
		setInputValue,
		stagedImages,
		setStagedImages,
		inputRef,
		customAICommands: allCustomCommands,
		setSlashCommandOpen,
		syncAiInputToSession,
		syncTerminalInputToSession,
		isAiMode,
		sessionsRef,
		getBatchState,
		activeBatchRunState,
		processQueuedItemRef,
		flushBatchedUpdates,
		onHistoryCommand: handleHistoryCommand,
		onWizardCommand: handleWizardCommand,
		onWizardSendMessage: sendWizardMessageWithThinking,
		isWizardActive: isWizardActiveForCurrentTab,
		onSkillsCommand: handleSkillsCommand,
		automaticTabNamingEnabled,
		conductorProfile,
		onPlanCrossAgentMentions: handleCrossAgentMentionPlan,
		onDispatchCrossAgentMentions: dispatchCrossAgentMentions,
	});

	// processInputRef - maintained for access in memoized callbacks without stale closures
	const processInputRef = useRef<
		(
			text?: string,
			options?: { forceParallel?: boolean; images?: string[]; sessionId?: string; tabId?: string }
		) => void
	>(() => {});
	useEffect(() => {
		processInputRef.current = processInput;
	}, [processInput]);

	// ====================================================================
	// useInputKeyDown (absorb - keyboard handler for input textarea)
	// ====================================================================

	const { handleInputKeyDown } = useInputKeyDown({
		getInputValue,
		setInputValue,
		tabCompletionSuggestions,
		atMentionItems,
		allSlashCommands,
		syncFileTreeToTabCompletion,
		processInput,
		getTabCompletionSuggestions,
		getCommandMode,
		setCommandMode: setAiCommandMode,
		inputRef,
		terminalOutputRef,
	});

	// ====================================================================
	// Handlers
	// ====================================================================

	// Agent/tab that owned the composer when it last gained focus. Blur must write
	// here - not to the live active agent (click can switch focus before blur runs).
	const composerFocusTargetRef = useRef<{ sessionId: string; tabId?: string } | null>(null);

	const handleMainPanelInputFocus = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		const tab = session ? getActiveTab(session) : null;
		composerFocusTargetRef.current = session ? { sessionId: session.id, tabId: tab?.id } : null;
	}, []);

	const handleMainPanelInputBlur = useCallback(() => {
		const target = composerFocusTargetRef.current;
		const blurSessionId = target?.sessionId ?? activeSessionIdRef.current;
		const currentIsAiMode =
			sessionsRef.current.find((s) => s.id === blurSessionId)?.inputMode === 'ai';
		const composer = useComposerInputStore.getState();
		if (currentIsAiMode) {
			// Attribute the text to the tab that owns it. Blur can fire after the
			// active tab already moved (focus leaving asynchronously, a tab
			// activated from outside the composer), and the unattributed write
			// would then stamp this text onto the newly active tab - erasing that
			// tab's own draft. Unowned text has no tab to be written to yet.
			const ownerTabId = composer.aiValueTabId ?? activeTabIdRef.current;
			if (ownerTabId) syncAiInputToSession(composer.aiValue, { tabId: ownerTabId });
		} else {
			syncTerminalInputToSession(composer.terminalValue, blurSessionId || undefined);
		}
	}, [syncAiInputToSession, syncTerminalInputToSession]);

	const handleReplayMessage = useCallback(
		(text: string, images?: string[]) => {
			// Preserve draft input so replay doesn't clobber what the user was typing
			const draftInput = useComposerInputStore.getState().aiValue;
			const activeSession = selectActiveSession(useSessionStore.getState());
			const activeTab = activeSession ? getActiveTab(activeSession) : null;
			const draftImages = activeTab?.stagedImages ? [...activeTab.stagedImages] : [];
			// The restore below runs a tick later - pin it to the tab that OWNS the
			// draft so it can't be written onto whatever tab is active by then.
			const draftTabId = useComposerInputStore.getState().aiValueTabId ?? activeTabIdRef.current;
			const pin = activeSession
				? { sessionId: activeSession.id, tabId: draftTabId ?? activeTab?.id }
				: undefined;

			if (images && images.length > 0) {
				setStagedImages(images);
			}
			setTimeout(() => {
				// Pin the agent/tab from click time so a focus change before the
				// timeout cannot retarget the replay. Images were staged above.
				processInputRef.current(text, pin);
				// Restore draft input after processInput clears it
				if (draftInput) {
					setInputValue(draftInput);
					if (pin) {
						syncAiInputToSession(draftInput, pin);
					} else {
						syncAiInputToSession(draftInput);
					}
				}
				if (draftImages.length > 0) {
					setStagedImages(draftImages);
				}
			}, 0);
		},
		[setStagedImages, setInputValue, syncAiInputToSession]
	);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent) => {
			const activeSession = selectActiveSession(useSessionStore.getState());
			const isGroupChatActive = !!useGroupChatStore.getState().activeGroupChatId;
			const isDirectAIMode = activeSession && activeSession.inputMode === 'ai';

			const items = e.clipboardData.items;
			const hasImage = Array.from(items).some((item) => item.type.startsWith('image/'));

			// Handle text paste with whitespace trimming
			if (!hasImage && !isGroupChatActive) {
				const text = e.clipboardData.getData('text/plain');
				if (text) {
					const trimmedText = text.trim();
					if (trimmedText !== text) {
						e.preventDefault();
						const target = e.target as HTMLTextAreaElement;
						const start = target.selectionStart ?? 0;
						const end = target.selectionEnd ?? 0;
						const currentValue = target.value;
						const newValue = currentValue.slice(0, start) + trimmedText + currentValue.slice(end);
						setInputValue(newValue);
						requestAnimationFrame(() => {
							target.selectionStart = target.selectionEnd = start + trimmedText.length;
						});
					}
				}
				return;
			}

			// Image handling requires AI mode or group chat
			if (!isGroupChatActive && !isDirectAIMode) return;

			// Neither command rung has anywhere to put an image: one pipes the draft
			// to `sh`, the other asks the model for a command line. Say so rather
			// than silently swallowing the paste - an image that vanishes with no
			// feedback reads as a broken paste.
			if (!isGroupChatActive && getCommandMode() !== 'off') {
				e.preventDefault();
				notifyCenterFlash({
					message: 'Images are not supported in command mode',
					color: 'yellow',
					detail: 'Press Esc to step back toward the agent',
				});
				return;
			}

			for (let i = 0; i < items.length; i++) {
				if (items[i].type.indexOf('image') !== -1) {
					e.preventDefault();
					const blob = items[i].getAsFile();
					if (blob) {
						const reader = new FileReader();
						reader.onload = (event) => {
							if (event.target?.result) {
								const imageData = event.target!.result as string;
								if (isGroupChatActive) {
									setGroupChatStagedImages((prev: string[]) => {
										if (prev.includes(imageData)) {
											setSuccessFlashNotification('Duplicate image ignored');
											setTimeout(() => setSuccessFlashNotification(null), 2000);
											return prev;
										}
										return [...prev, imageData];
									});
								} else {
									setStagedImages((prev) => {
										if (prev.includes(imageData)) {
											setSuccessFlashNotification('Duplicate image ignored');
											setTimeout(() => setSuccessFlashNotification(null), 2000);
											return prev;
										}
										return [...prev, imageData];
									});
								}
							}
						};
						reader.readAsDataURL(blob);
					}
				}
			}
		},
		[setInputValue, setStagedImages, getCommandMode]
	);

	/**
	 * Append arbitrary text to the LIVE composer. Used by drops that are not
	 * `@` mentions (a staged-image slot reference, say), which always target the
	 * tab on screen because the drag ends there.
	 */
	const appendToAiInput = useCallback(
		(text: string) => {
			setInputValue((prev) => {
				if (!prev) return text + ' ';
				const sep = /\s$/.test(prev) ? '' : ' ';
				return prev + sep + text + ' ';
			});
		},
		[setInputValue]
	);

	/**
	 * Append `@` mentions to the AI composer.
	 *
	 * `pinnedTabId` names the tab the mentions belong to. Pass it whenever the
	 * append can land after the active tab may have moved (an upload that awaits
	 * the host, say): the composer store holds whatever draft is on screen right
	 * now, so an unpinned write would drop the mention into whichever
	 * conversation the user switched to. When the pinned tab is no longer the one
	 * on screen the mention goes onto that tab's own persisted draft instead.
	 *
	 * The background write deliberately does not go through
	 * `syncAiInputToSession`: that reads `aiCommandMode` from the live composer
	 * and would stamp the on-screen tab's bang-ladder rung onto the background
	 * tab, and it cancels the queued flush that belongs to the tab being typed
	 * in. Only `inputValue` is touched here.
	 *
	 * Returns true when the live composer was the one updated, so the caller
	 * knows whether focusing the textarea is the right follow-up.
	 */
	const appendMentionsToAiInput = useCallback(
		(paths: string[], pinnedTabId?: string): boolean => {
			if (paths.length === 0) return false;
			const joined = paths.map((p) => formatFileMention(p)).join(' ');
			const append = (prev: string) => {
				if (!prev) return joined + ' ';
				const sep = /\s$/.test(prev) ? '' : ' ';
				return prev + sep + joined + ' ';
			};
			const pinIsOnScreen =
				!pinnedTabId || (isAiModeRef.current && pinnedTabId === activeTabIdRef.current);
			if (!pinIsOnScreen) {
				// Tab was closed mid-upload: the file is still on the host, there is
				// just no draft left to mention it in.
				const owner = useSessionStore
					.getState()
					.sessions.find((s) => s.aiTabs?.some((t) => t.id === pinnedTabId));
				if (!owner || !pinnedTabId) {
					notifyToast({
						color: 'yellow',
						title: 'Attachment has nowhere to go',
						message: 'The tab it was dropped into was closed before the upload finished',
					});
					return false;
				}
				updateAiTab(owner.id, pinnedTabId, (t) => ({
					...t,
					inputValue: append(t.inputValue ?? ''),
				}));
				return false;
			}
			setInputValue(append);
			return true;
		},
		[setInputValue]
	);

	const appendMentionsToGroupChatDraft = useCallback((paths: string[], pinnedChatId?: string) => {
		if (paths.length === 0) return;
		const joined = paths.map((p) => formatFileMention(p)).join(' ');
		// Reading the store via getState() (instead of subscribing) is intentional:
		// this callback only runs on user drop events, so we always want the latest
		// chatId / setter at fire time and don't want stale-closure invalidation to
		// re-create the callback (and bust handleDrop's useCallback deps) on every
		// store update.
		//
		// `pinnedChatId` is the chat the drop happened in. An upload resolves
		// asynchronously, so without the pin a mention would land in whichever chat
		// is open when it finishes - or vanish entirely once the user has left
		// group chat.
		const { activeGroupChatId, setGroupChats } = useGroupChatStore.getState();
		const chatId = pinnedChatId ?? activeGroupChatId;
		if (!chatId) return;
		setGroupChats((prev) =>
			prev.map((c) => {
				if (c.id !== chatId) return c;
				const current = c.draftMessage ?? '';
				const sep = current && !/\s$/.test(current) ? ' ' : '';
				const next = current ? current + sep + joined + ' ' : joined + ' ';
				return { ...c, draftMessage: next };
			})
		);
	}, []);

	/**
	 * Attach dropped files that carry no filesystem path (the web-desktop build
	 * runs in a browser, so `getPathForFile` comes back empty and the file may
	 * live on a different machine than the agent). The bytes are uploaded into
	 * the session's attachments directory and the resulting host path is
	 * @mentioned. Anything that fails raises a toast - dropping a file into the
	 * chat and getting nothing back at all is the bug this exists to avoid.
	 */
	const uploadAndMentionPathlessFiles = useCallback(
		async (
			files: File[],
			ownerId: string,
			projectRoot: string | undefined,
			toGroupChat: boolean,
			pinnedTabId: string | undefined
		) => {
			const mentions: string[] = [];
			for (const file of files) {
				try {
					const savedPath = await uploadPathlessFile(file, ownerId);
					mentions.push(toMentionPath(savedPath, projectRoot));
				} catch (error) {
					notifyToast({
						color: 'red',
						title: 'Could not attach file',
						message: error instanceof Error ? error.message : `Could not attach ${file.name}`,
					});
				}
			}
			if (mentions.length === 0) return;
			if (toGroupChat) {
				// `ownerId` is the group chat the drop happened in.
				appendMentionsToGroupChatDraft(mentions, ownerId);
			} else if (appendMentionsToAiInput(mentions, pinnedTabId)) {
				// Only steal focus when the mention actually went into the composer
				// that is on screen.
				inputRef.current?.focus();
			}
		},
		[appendMentionsToAiInput, appendMentionsToGroupChatDraft, inputRef]
	);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			dragCounterRef.current = 0;
			setIsDraggingFile(false);

			const activeSession = selectActiveSession(useSessionStore.getState());
			const isGroupChatActive = !!useGroupChatStore.getState().activeGroupChatId;
			const isDirectAIMode = activeSession && activeSession.inputMode === 'ai';

			// Neither command rung has an agent to hand attachments (or @mentions)
			// to - the draft goes to a shell or to a one-shot command request. Drop
			// is a no-op there.
			if (!isGroupChatActive && getCommandMode() !== 'off') {
				notifyCenterFlash({
					message: 'Attachments are not supported in command mode',
					color: 'yellow',
					detail: 'Press Esc to step back toward the agent',
				});
				return;
			}

			// A thumbnail dragged out of the staged-image strip. It is already
			// attached, so the drop inserts the slot reference the user can then
			// talk about ("crop Screenshot 2") rather than staging anything new.
			// Appended at the end like an @mention: the drop caret a textarea
			// paints during a drag is not readable from selectionStart, so
			// pretending to insert "where you dropped it" would land the text
			// somewhere else.
			const stagedImageIndex = e.dataTransfer.getData(STAGED_IMAGE_MIME);
			if (stagedImageIndex !== '') {
				if (isGroupChatActive || !isDirectAIMode) return;
				const index = Number(stagedImageIndex);
				if (!Number.isInteger(index) || index < 0) return;
				appendToAiInput(screenshotReferenceLabel(index));
				inputRef.current?.focus();
				return;
			}

			// Files-panel drag: image files are staged as image attachments;
			// other files/folders are inserted as @<path> in the AI input.
			// AI mode only; group chat is excluded.
			//
			// A multi-selection drag packs every selected relative path into the
			// multi MIME (a JSON array); a single-row drag packs just one path into
			// the single MIME. Read the array first so dragging N selected rows
			// inserts N mentions (folders included, each as its own @mention), and
			// fall back to the single path otherwise.
			const internalMulti = e.dataTransfer.getData(FILE_TREE_MULTI_MIME);
			const internalSingle = e.dataTransfer.getData(FILE_TREE_SINGLE_MIME);
			if (internalMulti || internalSingle) {
				if (isGroupChatActive || !isDirectAIMode) return;

				let internalPaths: string[] = [];
				if (internalMulti) {
					try {
						const parsed = JSON.parse(internalMulti);
						if (Array.isArray(parsed)) {
							internalPaths = parsed.filter((p): p is string => typeof p === 'string');
						}
					} catch {
						// Malformed payload - fall back to the single path below.
					}
				}
				if (internalPaths.length === 0 && internalSingle) internalPaths = [internalSingle];
				if (internalPaths.length === 0) return;

				// Relative paths are built by FileExplorerPanel against `session.fullPath`
				// (see TreeRow's `${session.fullPath}/${fullPath}`), so resolve image
				// reads against fullPath first to match the explorer's own absolute-path
				// construction.
				const treeRoot = activeSession?.fullPath ?? activeSession?.projectRoot;
				const sshRemoteId =
					activeSession?.sshRemoteId ??
					activeSession?.sessionSshRemoteConfig?.remoteId ??
					undefined;

				const mentionPaths: string[] = [];
				for (const p of internalPaths) {
					if (isImagePath(p) && treeRoot) {
						const absolutePath = `${treeRoot}/${p}`;
						void window.maestro.fs
							.readFile(absolutePath, sshRemoteId)
							.then((content) => {
								if (typeof content !== 'string' || !content.startsWith('data:image/')) return;
								setStagedImages((prev) => {
									if (prev.includes(content)) {
										setSuccessFlashNotification('Duplicate image ignored');
										setTimeout(() => setSuccessFlashNotification(null), 2000);
										return prev;
									}
									return [...prev, content];
								});
							})
							.catch(() => {
								setSuccessFlashNotification('Could not read image file');
								setTimeout(() => setSuccessFlashNotification(null), 2000);
							});
					} else {
						// Non-image file, folder, or image we can't resolve a root for:
						// insert as an @mention rather than dropping it silently.
						mentionPaths.push(p);
					}
				}

				if (mentionPaths.length > 0) appendMentionsToAiInput(mentionPaths);
				inputRef.current?.focus();
				return;
			}

			if (!isGroupChatActive && !isDirectAIMode) return;

			const files = e.dataTransfer.files;
			const externalPaths: string[] = [];
			// Files with no resolvable path (browser drops) get uploaded instead.
			const pathlessFiles: File[] = [];
			const projectRoot = activeSession?.projectRoot ?? activeSession?.fullPath;

			for (let i = 0; i < files.length; i++) {
				const file = files[i];
				if (file.type.startsWith('image/')) {
					const reader = new FileReader();
					reader.onload = (event) => {
						if (event.target?.result) {
							const imageData = event.target!.result as string;
							if (isGroupChatActive) {
								setGroupChatStagedImages((prev: string[]) => {
									if (prev.includes(imageData)) {
										setSuccessFlashNotification('Duplicate image ignored');
										setTimeout(() => setSuccessFlashNotification(null), 2000);
										return prev;
									}
									return [...prev, imageData];
								});
							} else {
								setStagedImages((prev) => {
									if (prev.includes(imageData)) {
										setSuccessFlashNotification('Duplicate image ignored');
										setTimeout(() => setSuccessFlashNotification(null), 2000);
										return prev;
									}
									return [...prev, imageData];
								});
							}
						}
					};
					reader.readAsDataURL(file);
				} else {
					// External non-image file or folder - collect path for @-mention.
					// `File.path` was removed in modern Electron; resolve via webUtils
					// (bridged through the preload as `getPathForFile`).
					const filePath = window.maestro.fs.getPathForFile(file);
					if (filePath) {
						externalPaths.push(toMentionPath(filePath, projectRoot));
					} else {
						// No path to mention: the web-desktop build is a browser, where
						// `File` objects have no path at all. Upload the bytes to the host
						// so the agent has something real to read.
						pathlessFiles.push(file);
					}
				}
			}

			if (pathlessFiles.length > 0) {
				const ownerId = isGroupChatActive
					? useGroupChatStore.getState().activeGroupChatId
					: activeSession?.id;
				if (ownerId) {
					void uploadAndMentionPathlessFiles(
						pathlessFiles,
						ownerId,
						projectRoot,
						isGroupChatActive,
						// Pin the tab from drop time so switching tabs or agents while
						// the bytes are in flight cannot retarget the mention.
						activeSession ? getActiveTab(activeSession)?.id : undefined
					);
				} else {
					notifyToast({
						color: 'red',
						title: 'Could not attach file',
						message: 'There is no active agent to attach it to',
					});
				}
			}

			if (externalPaths.length > 0) {
				if (isGroupChatActive) {
					appendMentionsToGroupChatDraft(externalPaths);
				} else if (isDirectAIMode) {
					appendMentionsToAiInput(externalPaths);
					inputRef.current?.focus();
				}
			}
		},
		[
			setStagedImages,
			appendToAiInput,
			appendMentionsToAiInput,
			appendMentionsToGroupChatDraft,
			uploadAndMentionPathlessFiles,
			getCommandMode,
		]
	);

	// ====================================================================
	// Return
	// ====================================================================

	return {
		setInputValue,
		stagedImages,
		setStagedImages,
		processInput,
		processInputRef,
		handleInputKeyDown,
		handleMainPanelInputFocus,
		handleMainPanelInputBlur,
		handleReplayMessage,
		handlePaste,
		handleDrop,
		tabCompletionSuggestions,
		atMentionItems,
		atMentionCounts,
		syncFileTreeToTabCompletion,
	};
}
