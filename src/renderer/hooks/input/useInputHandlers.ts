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
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useUIStore } from '../../stores/uiStore';
import { useFileExplorerStore } from '../../stores/fileExplorerStore';
import { useInputContext } from '../../contexts/InputContext';
import { getActiveTab } from '../../utils/tabHelpers';
import { setLiveDraft } from '../../utils/liveDraftStore';
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
	resolveMentionedTargetSessionIds,
	buildKnownMentionNameSet,
} from './useAgentMentionCompletion';
import { messageStartsWithAgentMention } from '../../../shared/crossAgentContext';
import { IMAGE_EXTENSIONS } from '../../utils/fileExplorerIcons/shared';
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

	// Ref-mirror of activeTab.id so the live-draft mirror attributes text to the
	// correct tab, and the tab-switch effect can flush the OLD tab's text without
	// re-triggering on tab-switch alone.
	const activeTabIdRef = useRef<string | undefined>(activeTabId);

	// Ref-mirror of the current mode so non-reactive readers (getInputValue) pick
	// the right slice at call time without subscribing.
	const isAiModeRef = useRef(isAiMode);
	useEffect(() => {
		isAiModeRef.current = isAiMode;
	}, [isAiMode]);

	// Mirror the live AI draft into liveDraftStore so hasDraft() reflects what's
	// on screen for the active tab (tab.inputValue only updates on blur/submit).
	// Subscribing outside React render keeps this off the re-render path.
	useEffect(() => {
		activeTabIdRef.current = activeTabId;
		const mirror = (aiValue: string) => {
			const currentTabId = activeTabIdRef.current;
			if (currentTabId) setLiveDraft(currentTabId, aiValue);
		};
		mirror(useComposerInputStore.getState().aiValue);
		return useComposerInputStore.subscribe((state, prev) => {
			if (state.aiValue !== prev.aiValue) mirror(state.aiValue);
		});
	}, [activeTabId]);

	// Read the live value non-reactively (at call time) for handlers and sub-hooks
	// so they never need a reactive `inputValue` dependency.
	const getInputValue = useCallback(() => {
		const s = useComposerInputStore.getState();
		return isAiModeRef.current ? s.aiValue : s.terminalValue;
	}, []);

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
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSession.id) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) => {
							if (tab.id !== s.activeTabId) return tab;
							const currentImages = tab.stagedImages || [];
							const newImages =
								typeof imagesOrUpdater === 'function'
									? imagesOrUpdater(currentImages)
									: imagesOrUpdater;
							return { ...tab, stagedImages: newImages };
						}),
					};
				})
			);
		},
		[setSessions]
	);

	// ====================================================================
	// Sub-hook calls
	// ====================================================================

	// Input sync handlers (resolve session via getState inside callbacks)
	const { syncAiInputToSession, syncTerminalInputToSession } = useInputSync({
		setSessions,
	});

	// Tab / @mention completion: no-arg form subscribes only to non-streaming fields
	const { getSuggestions: getTabCompletionSuggestions } = useTabCompletion();
	const { getSuggestions: getAtMentionSuggestions } = useAtMentionCompletion();

	// ====================================================================
	// Tab/Session switching effects
	// ====================================================================

	const prevActiveTabIdRef = useRef<string | undefined>(activeTabId);
	const prevActiveSessionIdRef = useRef<string | undefined>(activeSessionId ?? undefined);
	const didHydrateAiInputRef = useRef(false);
	const didHydrateTerminalInputRef = useRef(false);

	useEffect(() => {
		if (!activeTabId || didHydrateAiInputRef.current) return;
		const session = selectActiveSession(useSessionStore.getState());
		const tab = session ? getActiveTab(session) : null;
		setAiValue(tab?.inputValue ?? '');
		didHydrateAiInputRef.current = true;
	}, [activeTabId, setAiValue]);

	useEffect(() => {
		if (!activeSessionId || didHydrateTerminalInputRef.current) return;
		const session = selectActiveSession(useSessionStore.getState());
		setTerminalValue(session?.terminalDraftInput ?? '');
		didHydrateTerminalInputRef.current = true;
	}, [activeSessionId, setTerminalValue]);

	// Sync local AI input with tab's persisted value when switching tabs
	useEffect(() => {
		if (activeTabId && activeTabId !== prevActiveTabIdRef.current) {
			const prevTabId = prevActiveTabIdRef.current;

			// Save current AI input to the PREVIOUS tab
			if (prevTabId) {
				const currentAiValue = useComposerInputStore.getState().aiValue;
				setSessions((prev) =>
					prev.map((s) => ({
						...s,
						aiTabs: s.aiTabs.map((tab) =>
							tab.id === prevTabId ? { ...tab, inputValue: currentAiValue } : tab
						),
					}))
				);
			}

			// Load new tab's persisted input value
			const session = selectActiveSession(useSessionStore.getState());
			const activeTab = session ? getActiveTab(session) : null;
			setAiValue(activeTab?.inputValue ?? '');
			prevActiveTabIdRef.current = activeTabId;

			// Clear hasUnread indicator on newly active tab
			if (activeTab?.hasUnread && session) {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== session.id) return s;
						return {
							...s,
							aiTabs: s.aiTabs.map((t) => (t.id === activeTabId ? { ...t, hasUnread: false } : t)),
						};
					})
				);
			}
		}
		// Intentionally only depend on activeTabId, NOT inputValue
	}, [activeTabId]);

	// Sync terminal input when switching sessions
	useEffect(() => {
		if (activeSessionId && activeSessionId !== prevActiveSessionIdRef.current) {
			const prevSessionId = prevActiveSessionIdRef.current;

			// Save terminal input to the previous session (including empty string to persist cleared input)
			if (prevSessionId) {
				const currentTerminalValue = useComposerInputStore.getState().terminalValue;
				setSessions((prev) =>
					prev.map((s) =>
						s.id === prevSessionId ? { ...s, terminalDraftInput: currentTerminalValue } : s
					)
				);
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
	// terminal tab-completion dropdown is open, so zustand's Object.is bail-out
	// means normal typing does NOT re-render this hook. Only while the dropdown
	// is open do we track the live text to refresh suggestions.
	const tabCompletionInput = useComposerInputStore((s) =>
		tabCompletionOpen ? s.terminalValue : ''
	);
	const debouncedInputForTabCompletion = useDebouncedValue(tabCompletionInput, 50);
	const tabCompletionSuggestions = useMemo(() => {
		if (!tabCompletionOpen || !activeSessionId || activeSessionInputMode !== 'terminal') {
			return [];
		}
		return getTabCompletionSuggestions(debouncedInputForTabCompletion, tabCompletionFilter);
	}, [
		tabCompletionOpen,
		activeSessionId,
		activeSessionInputMode,
		debouncedInputForTabCompletion,
		tabCompletionFilter,
		getTabCompletionSuggestions,
	]);

	const debouncedAtMentionFilter = useDebouncedValue(atMentionOpen ? atMentionFilter : '', 100);
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
			const pathOnly = targetPath.split(/\s+/).pop() || targetPath;
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
	// so the response-chunk subscription is set up once. resolveMentionedTargetSessionIds
	// reuses the same agent/group resolution the `@` picker uses, so a typed
	// `@name` dispatches identically to one chosen from the popover.
	const { sendCrossAgentRequest } = useCrossAgentDispatch(spawnBackgroundSynopsis);
	// Returns `true` when the source agent's own send should be SUPPRESSED - i.e.
	// the message is addressed at the mentioned agent(s), so only they answer.
	// That is the case when the message leads with an `@agent` mention and at
	// least one target resolves. A trailing mention (`hey @Backend, thoughts?`)
	// or a leading `@file` mention returns false, so the source agent answers too.
	const handleCrossAgentMentions = useCallback(
		(message: string, sourceSession: Session, sourceTabId: string): boolean => {
			const { sessions: allSessions, groups: allGroups } = useSessionStore.getState();
			const targetSessionIds = resolveMentionedTargetSessionIds(
				message,
				allSessions,
				allGroups,
				sourceSession.id
			).filter((id) => id !== sourceSession.id); // Self-mention guard (defend at dispatch).
			if (targetSessionIds.length === 0) return false;

			// Roster for the leading-mention check below, so a message that leads with
			// a file-shaped agent name (`@RunMaestro.ai fix this`) suppresses the local
			// send just like a bare `@Codex` does.
			const knownMentionNames = buildKnownMentionNameSet(allSessions, allGroups, sourceSession.id);

			const sourceTab = sourceSession.aiTabs.find((t) => t.id === sourceTabId);
			const sourceLogs = sourceTab?.logs ?? [];
			for (const targetSessionId of targetSessionIds) {
				sendCrossAgentRequest({
					sourceSessionId: sourceSession.id,
					sourceAgentName: sourceSession.name,
					sourceTabId,
					targetSessionId,
					userPrompt: message,
					sourceLogs,
					// The source agent's working directory: the consulted agent is told it
					// may READ files here to answer (see cross-agent-router prompt).
					sourceCwd: sourceSession.cwd,
				});
			}

			return messageStartsWithAgentMention(message, knownMentionNames);
		},
		[sendCrossAgentRequest]
	);

	const { processInput, processInputRef: _hookProcessInputRef } = useInputProcessing({
		// PERF: Omit activeSession; processInput resolves via sessionsRef / getState.
		activeSessionId,
		setSessions,
		getInputValue,
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
		onCrossAgentMentions: handleCrossAgentMentions,
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
			if (target?.sessionId) {
				syncAiInputToSession(composer.aiValue, target);
			} else {
				syncAiInputToSession(composer.aiValue);
			}
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
			const pin = activeSession ? { sessionId: activeSession.id, tabId: activeTab?.id } : undefined;

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
		[setInputValue, setStagedImages]
	);

	const appendMentionsToAiInput = useCallback(
		(paths: string[]) => {
			if (paths.length === 0) return;
			const joined = paths.map((p) => `@${p}`).join(' ');
			setInputValue((prev) => {
				if (!prev) return joined + ' ';
				const sep = /\s$/.test(prev) ? '' : ' ';
				return prev + sep + joined + ' ';
			});
		},
		[setInputValue]
	);

	const appendMentionsToGroupChatDraft = useCallback((paths: string[]) => {
		if (paths.length === 0) return;
		const joined = paths.map((p) => `@${p}`).join(' ');
		// Reading the store via getState() (instead of subscribing) is intentional:
		// this callback only runs on user drop events, so we always want the latest
		// chatId / setter at fire time and don't want stale-closure invalidation to
		// re-create the callback (and bust handleDrop's useCallback deps) on every
		// store update.
		const { activeGroupChatId: chatId, setGroupChats } = useGroupChatStore.getState();
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

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			dragCounterRef.current = 0;
			setIsDraggingFile(false);

			const activeSession = selectActiveSession(useSessionStore.getState());
			const isGroupChatActive = !!useGroupChatStore.getState().activeGroupChatId;
			const isDirectAIMode = activeSession && activeSession.inputMode === 'ai';

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
					}
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
		[setStagedImages, appendMentionsToAiInput, appendMentionsToGroupChatDraft]
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
