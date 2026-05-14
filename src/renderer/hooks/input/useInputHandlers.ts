/**
 * useInputHandlers — extracted from App.tsx (Phase 2J)
 *
 * Orchestrates all input-related state and handlers by:
 *   - Managing dual input state (AI per-tab + terminal per-session)
 *   - Calling sub-hooks: useInputSync, useTabCompletion, useAtMentionCompletion,
 *     useInputProcessing, useInputKeyDown
 *   - Computing memoized completion suggestions
 *   - Owning tab/session switching effects for input persistence
 *   - Providing paste, drop, blur, and replay handlers
 *
 * Reads from: sessionStore, settingsStore, groupChatStore, uiStore,
 *             fileExplorerStore, InputContext
 */

import { useState, useCallback, useEffect, useRef, useMemo, useDeferredValue } from 'react';
import type { Session, BatchRunState, QueuedItem, CustomAICommand } from '../../types';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useUIStore } from '../../stores/uiStore';
import { useFileExplorerStore } from '../../stores/fileExplorerStore';
import { useInputContext } from '../../contexts/InputContext';
import { getActiveTab } from '../../utils/tabHelpers';
import { useDebouncedValue } from '../utils';
import { useInputSync } from './useInputSync';
import { useTabCompletion } from './useTabCompletion';
import type { TabCompletionSuggestion } from './useTabCompletion';
import { useAtMentionCompletion, type AtMentionSuggestion } from './useAtMentionCompletion';
import { useInputProcessing } from './useInputProcessing';
import { useInputKeyDown } from './useInputKeyDown';

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
	setIsDraggingImage: (value: boolean) => void;

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
}

// ============================================================================
// Return type
// ============================================================================

export interface UseInputHandlersReturn {
	/** Current input value (AI or terminal, depending on mode) */
	inputValue: string;
	/** Deferred input value for expensive consumers (slash command filtering, etc.) */
	deferredInputValue: string;
	/** Set current input value (dispatches to AI or terminal state based on mode) */
	setInputValue: (value: string | ((prev: string) => string)) => void;
	/** Staged images for the current message */
	stagedImages: string[];
	/** Set staged images for the current message */
	setStagedImages: (images: string[] | ((prev: string[]) => string[])) => void;
	/** Process and send the current input */
	processInput: (text?: string) => void;
	/** Ref to latest processInput for use in memoized callbacks */
	processInputRef: React.MutableRefObject<(text?: string) => void>;
	/** Keyboard event handler for the input textarea */
	handleInputKeyDown: (e: React.KeyboardEvent) => void;
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
	/** @ mention suggestions for AI mode */
	atMentionSuggestions: AtMentionSuggestion[];
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
		setIsDraggingImage,
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
	} = deps;

	// --- Store subscriptions (reactive) ---
	const activeSession = useSessionStore(selectActiveSession);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	const setSessions = useMemo(() => useSessionStore.getState().setSessions, []);
	const activeGroupChatId = useGroupChatStore((s) => s.activeGroupChatId);
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
		setSlashCommandOpen,
	} = useInputContext();

	// --- Derived values ---
	const activeTab = activeSession ? getActiveTab(activeSession) : null;
	const isAiMode = activeSession?.inputMode === 'ai';
	const activeSessionInputMode = activeSession?.inputMode;

	// ====================================================================
	// Input State
	// ====================================================================

	const [terminalInputValue, setTerminalInputValue] = useState('');
	const [aiInputValueLocal, setAiInputValueLocal] = useState('');

	// PERF: Refs to access current input values without triggering re-renders
	const terminalInputValueRef = useRef(terminalInputValue);
	const aiInputValueLocalRef = useRef(aiInputValueLocal);
	useEffect(() => {
		terminalInputValueRef.current = terminalInputValue;
	}, [terminalInputValue]);
	useEffect(() => {
		aiInputValueLocalRef.current = aiInputValueLocal;
	}, [aiInputValueLocal]);

	// Derived input value
	const inputValue = isAiMode ? aiInputValueLocal : terminalInputValue;
	const deferredInputValue = useDeferredValue(inputValue);

	// Memoized setter that dispatches to the correct state
	const setInputValue = useCallback(
		(value: string | ((prev: string) => string)) => {
			if (activeSession?.inputMode === 'ai') {
				setAiInputValueLocal(value);
			} else {
				setTerminalInputValue(value);
			}
		},
		[activeSession?.inputMode]
	);

	// ====================================================================
	// Staged Images
	// ====================================================================

	const stagedImages = useMemo(() => {
		if (!activeSession || activeSession.inputMode !== 'ai') return [];
		return activeTab?.stagedImages || [];
	}, [activeTab?.stagedImages, activeSession?.inputMode]);

	const setStagedImages = useCallback(
		(imagesOrUpdater: string[] | ((prev: string[]) => string[])) => {
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
		[activeSession]
	);

	// ====================================================================
	// Sub-hook calls
	// ====================================================================

	// Input sync handlers
	const { syncAiInputToSession, syncTerminalInputToSession } = useInputSync(activeSession, {
		setSessions,
	});

	// Tab completion
	const { getSuggestions: getTabCompletionSuggestions } = useTabCompletion(activeSession);

	// @ mention completion
	const { getSuggestions: getAtMentionSuggestions } = useAtMentionCompletion(activeSession);

	// ====================================================================
	// Tab/Session switching effects
	// ====================================================================

	const prevActiveTabIdRef = useRef<string | undefined>(activeTab?.id);
	const prevActiveSessionIdRef = useRef<string | undefined>(activeSession?.id);

	// Sync local AI input with tab's persisted value when switching tabs
	useEffect(() => {
		if (activeTab && activeTab.id !== prevActiveTabIdRef.current) {
			const prevTabId = prevActiveTabIdRef.current;

			// Save current AI input to the PREVIOUS tab
			if (prevTabId) {
				setSessions((prev) =>
					prev.map((s) => ({
						...s,
						aiTabs: s.aiTabs.map((tab) =>
							tab.id === prevTabId ? { ...tab, inputValue: aiInputValueLocal } : tab
						),
					}))
				);
			}

			// Load new tab's persisted input value
			setAiInputValueLocal(activeTab.inputValue ?? '');
			prevActiveTabIdRef.current = activeTab.id;

			// Clear hasUnread indicator on newly active tab
			if (activeTab.hasUnread && activeSession) {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== activeSession.id) return s;
						return {
							...s,
							aiTabs: s.aiTabs.map((t) => (t.id === activeTab.id ? { ...t, hasUnread: false } : t)),
						};
					})
				);
			}
		}
		// Intentionally only depend on activeTab?.id, NOT inputValue
	}, [activeTab?.id]);

	// Sync terminal input when switching sessions
	useEffect(() => {
		if (activeSession && activeSession.id !== prevActiveSessionIdRef.current) {
			const prevSessionId = prevActiveSessionIdRef.current;

			// Save terminal input to the previous session (including empty string to persist cleared input)
			if (prevSessionId) {
				setSessions((prev) =>
					prev.map((s) =>
						s.id === prevSessionId ? { ...s, terminalDraftInput: terminalInputValue } : s
					)
				);
			}

			// Load terminal input from the new session
			setTerminalInputValue(activeSession.terminalDraftInput ?? '');
			prevActiveSessionIdRef.current = activeSession.id;
		}
	}, [activeSession?.id]);

	// ====================================================================
	// Completion suggestions (memoized)
	// ====================================================================

	const debouncedInputForTabCompletion = useDebouncedValue(tabCompletionOpen ? inputValue : '', 50);
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
	const atMentionSuggestions = useMemo(() => {
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

	const { processInput, processInputRef: _hookProcessInputRef } = useInputProcessing({
		activeSession,
		activeSessionId,
		setSessions,
		inputValue,
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
	});

	// processInputRef — maintained for access in memoized callbacks without stale closures
	const processInputRef = useRef<(text?: string) => void>(() => {});
	useEffect(() => {
		processInputRef.current = processInput;
	}, [processInput]);

	// ====================================================================
	// useInputKeyDown (absorb — keyboard handler for input textarea)
	// ====================================================================

	const { handleInputKeyDown } = useInputKeyDown({
		inputValue,
		setInputValue,
		tabCompletionSuggestions,
		atMentionSuggestions,
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

	const handleMainPanelInputBlur = useCallback(() => {
		const currentIsAiMode =
			sessionsRef.current.find((s) => s.id === activeSessionIdRef.current)?.inputMode === 'ai';
		if (currentIsAiMode) {
			syncAiInputToSession(aiInputValueLocalRef.current);
		} else {
			syncTerminalInputToSession(terminalInputValueRef.current);
		}
	}, [syncAiInputToSession, syncTerminalInputToSession]);

	const handleReplayMessage = useCallback(
		(text: string, images?: string[]) => {
			// Preserve draft input so replay doesn't clobber what the user was typing
			const draftInput = aiInputValueLocalRef.current;
			const draftImages = activeTab?.stagedImages ? [...activeTab.stagedImages] : [];

			if (images && images.length > 0) {
				setStagedImages(images);
			}
			setTimeout(() => {
				processInputRef.current(text);
				// Restore draft input after processInput clears it
				if (draftInput) {
					setInputValue(draftInput);
					syncAiInputToSession(draftInput);
				}
				if (draftImages.length > 0) {
					setStagedImages(draftImages);
				}
			}, 0);
		},
		[setStagedImages, setInputValue, syncAiInputToSession, activeTab?.stagedImages]
	);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent) => {
			const isGroupChatActive = !!activeGroupChatId;
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
		[activeGroupChatId, activeSession, setInputValue, setStagedImages]
	);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			dragCounterRef.current = 0;
			setIsDraggingImage(false);

			const isGroupChatActive = !!activeGroupChatId;
			const isDirectAIMode = activeSession && activeSession.inputMode === 'ai';

			if (!isGroupChatActive && !isDirectAIMode) return;

			const files = e.dataTransfer.files;

			for (let i = 0; i < files.length; i++) {
				if (files[i].type.startsWith('image/')) {
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
					reader.readAsDataURL(files[i]);
				}
			}
		},
		[activeGroupChatId, activeSession, setStagedImages]
	);

	// ====================================================================
	// Return
	// ====================================================================

	return {
		inputValue,
		deferredInputValue,
		setInputValue,
		stagedImages,
		setStagedImages,
		processInput,
		processInputRef,
		handleInputKeyDown,
		handleMainPanelInputBlur,
		handleReplayMessage,
		handlePaste,
		handleDrop,
		tabCompletionSuggestions,
		atMentionSuggestions,
		syncFileTreeToTabCompletion,
	};
}
