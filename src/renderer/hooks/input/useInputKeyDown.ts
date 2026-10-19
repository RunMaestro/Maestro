/**
 * useInputKeyDown - extracted from App.tsx (Phase 2F)
 *
 * Owns the handleInputKeyDown keyboard event handler for the main input area.
 * Handles tab completion, @ mentions, slash commands, enter-to-send,
 * command history, and escape/focus management.
 *
 * Reads completion state from InputContext directly.
 * Receives external deps (memoized values, refs, callbacks) via params.
 */

import { useCallback } from 'react';
import type { TabCompletionSuggestion, TabCompletionFilter } from '../input/useTabCompletion';
import {
	MENTION_CATEGORY_CYCLE,
	buildMentionAccept,
	type MentionPickerItem,
} from '../input/useMentionPicker';
import { useInputContext } from '../../contexts/InputContext';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { useUIStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { filterSlashCommands } from '../../utils/search';
import { logger } from '../../utils/logger';
import { trackShortcutUsage } from '../../utils/shortcutTracking';
import { outputSearchKeyFor } from '../../utils/outputSearch';
import {
	previousComposerCommandMode,
	type ComposerCommandMode,
} from '../../utils/shellCommandInput';
import {
	aiCommandKey,
	getAiCommandEntry,
	useAiCommandStore,
	type AiCommandEntry,
} from '../../stores/aiCommandStore';
import type { Session } from '../../types';
import { acceptAiCommand, dismissAiCommand } from '../../services/aiCommand';
import { eventMatchesShortcutKeys } from '../../utils/shortcutMatch';
import { useEventListener } from '../utils/useEventListener';
import { STEER_SEND_EVENT, steerNewestQueuedMessage } from '../../services/chatSteering';
import { useGroupChatStore } from '../../stores/groupChatStore';

/**
 * Window event that runs Forced Parallel Send from outside the composer.
 *
 * The composer owns the behavior (it holds the draft and `processInput`), so
 * the window-level keyboard handler asks for it by name rather than
 * reimplementing the decision. Exported here, next to its only listener, so the
 * two ends of the bridge stay in one place.
 */
export const FORCED_PARALLEL_SEND_EVENT = 'maestro:forcedParallelSend';

/**
 * Window event that runs Queue Held: queue the draft PAUSED, so it waits on its
 * card until the user resumes it. Raised by the Send button's menu; same bridge
 * as {@link FORCED_PARALLEL_SEND_EVENT}, because the composer owns the draft.
 */
export const HOLD_SEND_EVENT = 'maestro:holdSend';

/** Steer in this window: the default of {@link InputKeyDownDeps.steerNewest}. Module scope keeps it stable. */
function steerNewestHere(sessionId: string, tabId: string): void {
	void steerNewestQueuedMessage(sessionId, tabId);
}

// ============================================================================
// Dependencies interface
// ============================================================================

export interface InputKeyDownDeps {
	/** Read the current input value at call time (non-reactive; reads the store) */
	getInputValue: () => string;
	/** Set input value */
	setInputValue: (value: string | ((prev: string) => string)) => void;
	/** Memoized tab completion suggestions (already filtered) */
	tabCompletionSuggestions: TabCompletionSuggestion[];
	/** Unified `@` picker rows for the active category (files/dirs/agents/groups) */
	atMentionItems: MentionPickerItem[];
	/** Memoized slash commands list */
	allSlashCommands: Array<{
		command: string;
		description: string;
		terminalOnly?: boolean;
		aiOnly?: boolean;
	}>;
	/** Sync file tree to highlight the tab completion suggestion */
	syncFileTreeToTabCompletion: (suggestion: TabCompletionSuggestion | undefined) => void;
	/** Process and send the current input */
	processInput: (
		overrideInputValue?: string,
		options?: { forceParallel?: boolean; steer?: boolean; hold?: boolean }
	) => void;
	/** Get tab completion suggestions for a given input */
	getTabCompletionSuggestions: (
		input: string,
		filter?: TabCompletionFilter,
		commandMode?: boolean
	) => TabCompletionSuggestion[];
	/** Which rung of the bang ladder the AI composer is on, read at call time. */
	getCommandMode: () => ComposerCommandMode;
	/** Move to another rung (Escape / Backspace on an empty command line). */
	setCommandMode: (commandMode: ComposerCommandMode) => void;
	/** Ref to the input textarea */
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	/** Ref to the terminal output container */
	terminalOutputRef: React.RefObject<HTMLDivElement | null>;
	/**
	 * Run an AI command proposal the user accepted (Y, or Enter on Run).
	 * Defaults to running it here; a tab window sends it to its owner window,
	 * which runs every command for the agent (Tab Windows, D1).
	 */
	acceptAiCommand?: (session: Session, entry: AiCommandEntry) => void;
	/**
	 * Steer the tab's newest queued message (Steer with an empty draft).
	 * Defaults to steering here; a tab window asks its owner window, which holds
	 * the queue.
	 */
	steerNewest?: (sessionId: string, tabId: string) => void;
}

// ============================================================================
// Return type
// ============================================================================

export interface InputKeyDownReturn {
	handleInputKeyDown: (e: React.KeyboardEvent) => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useInputKeyDown(deps: InputKeyDownDeps): InputKeyDownReturn {
	const {
		getInputValue,
		setInputValue,
		tabCompletionSuggestions,
		atMentionItems,
		allSlashCommands,
		syncFileTreeToTabCompletion,
		processInput,
		getTabCompletionSuggestions,
		getCommandMode,
		setCommandMode,
		inputRef,
		terminalOutputRef,
		acceptAiCommand: runAcceptedAiCommand = acceptAiCommand,
		steerNewest = steerNewestHere,
	} = deps;

	// --- InputContext state (completion dropdowns) ---
	const {
		slashCommandOpen,
		setSlashCommandOpen,
		selectedSlashCommandIndex,
		setSelectedSlashCommandIndex,
		tabCompletionOpen,
		setTabCompletionOpen,
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
		selectedAtMentionIndex,
		setSelectedAtMentionIndex,
		atMentionCategory,
		setAtMentionCategory,
		commandHistoryOpen,
		setCommandHistoryOpen,
		setCommandHistoryFilter,
		setCommandHistorySelectedIndex,
	} = useInputContext();

	/**
	 * Forced Parallel Send, from wherever the user pressed it.
	 *
	 * What the chord acts on - the tab's draft and its execution queue - belongs
	 * to the TAB, not to the textarea, so gating it on composer focus made it
	 * look broken from the transcript, which is exactly where the queued items
	 * the user wants to force through are drawn. `useMainKeyboardHandler`
	 * dispatches {@link FORCED_PARALLEL_SEND_EVENT} when the chord reaches the
	 * window unhandled; both paths land here so the two can never drift on what
	 * an empty draft means.
	 */
	const runForcedParallelSend = useCallback(() => {
		if (!useSettingsStore.getState().forcedParallelExecution) return;
		const activeSession = selectActiveSession(useSessionStore.getState());
		if (activeSession?.inputMode !== 'ai') return;

		trackShortcutUsage('forcedParallelSend');
		// Empty draft: open the Force Send confirmation for the most recent
		// eligible queued item - the keyboard equivalent of clicking that item's
		// Force Send button. With text in the draft, send the draft in parallel.
		if (getInputValue().trim().length === 0) {
			logger.info('[ForcedParallel] Empty input, dispatching triggerForceSendQueued');
			window.dispatchEvent(new CustomEvent('maestro:triggerForceSendQueued'));
			return;
		}
		logger.info('[ForcedParallel] Draft present, calling processInput');
		processInput(undefined, { forceParallel: true });
	}, [getInputValue, processInput]);

	useEventListener(FORCED_PARALLEL_SEND_EVENT, runForcedParallelSend);

	/**
	 * Steer Running Turn, from wherever the user pressed it (the composer, the
	 * window handler, the command palette - the last two via
	 * {@link STEER_SEND_EVENT}). Force Send's counterpart for a tab that is BUSY.
	 *
	 * With a draft, send it flagged to steer: `processInput` queues it behind the
	 * running turn as usual and then steers that item, so a message that cannot be
	 * steered is still queued rather than lost. With an empty draft, steer the
	 * newest queued message on this tab. No confirmation, matching the Steer button.
	 *
	 * Staged images count as a draft even with no text. Force Send can treat an
	 * image-only draft as empty because it asks before sending the queued item; a
	 * steer does not ask and cannot be taken back, so it must never pick an older
	 * message while the user is looking at one they have not sent.
	 */
	const runSteerSend = useCallback(() => {
		// A group chat covers the agent without changing which agent is active, so
		// this would act on a draft and a queue the user cannot see.
		if (useGroupChatStore.getState().activeGroupChatId) return;
		const activeSession = selectActiveSession(useSessionStore.getState());
		if (activeSession?.inputMode !== 'ai') return;

		trackShortcutUsage('steerSend');
		const stagedImageCount =
			activeSession.aiTabs?.find((tab) => tab.id === activeSession.activeTabId)?.stagedImages
				?.length ?? 0;
		if (getInputValue().trim().length === 0 && stagedImageCount === 0) {
			steerNewest(activeSession.id, activeSession.activeTabId);
			return;
		}
		processInput(undefined, { steer: true });
	}, [getInputValue, processInput, steerNewest]);

	useEventListener(STEER_SEND_EVENT, runSteerSend);

	/**
	 * Queue Held, from the Send button's menu. Queues the draft paused even on an
	 * idle agent; an empty draft has nothing to hold, so it does nothing.
	 */
	const runHoldSend = useCallback(() => {
		if (useGroupChatStore.getState().activeGroupChatId) return;
		const activeSession = selectActiveSession(useSessionStore.getState());
		if (activeSession?.inputMode !== 'ai') return;
		const stagedImageCount =
			activeSession.aiTabs?.find((tab) => tab.id === activeSession.activeTabId)?.stagedImages
				?.length ?? 0;
		if (getInputValue().trim().length === 0 && stagedImageCount === 0) return;
		processInput(undefined, { hold: true });
	}, [getInputValue, processInput]);

	useEventListener(HOLD_SEND_EVENT, runHoldSend);

	const handleInputKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			const activeSession = selectActiveSession(useSessionStore.getState());
			// Snapshot the live composer text once at call time (it lives in the
			// store now, not in a reactive prop).
			const inputValue = getInputValue();

			// Cmd+F opens output search from input field. Search is scoped per
			// agent+AI-tab, so target the active window's slot.
			// Alt must be excluded: Opt+Cmd+F is cross-tab search, and on
			// Windows/Linux it still reports e.key === 'f' (macOS rewrites it to 'ƒ'),
			// so without this guard that combo silently opens the in-tab Find bar.
			if (e.key === 'f' && (e.metaKey || e.ctrlKey) && !e.altKey) {
				e.preventDefault();
				if (activeSession) {
					const key = outputSearchKeyFor(activeSession.id, activeSession.activeTabId);
					useUIStore.getState().setOutputSearchOpen(key, true);
				}
				return;
			}

			// Handle command history modal
			if (commandHistoryOpen) {
				return; // Let the modal handle keys
			}

			// Which rung the AI composer is on. Only the 'shell' rung is a command
			// line: AI command mode holds prose, so it gets none of the shell
			// affordances below (completion, history recall, the `$` prefix).
			const commandMode: ComposerCommandMode =
				activeSession?.inputMode === 'ai' ? getCommandMode() : 'off';
			const isCommandMode = commandMode === 'shell';
			const isShellInput = activeSession?.inputMode === 'terminal' || isCommandMode;

			// A proposed command owns the keyboard until it is answered. Handled
			// before every other branch because the caret deliberately stays in the
			// textarea (see InputTextarea's readOnly), so Enter / arrows / Escape
			// would otherwise be read as composing rather than as an answer.
			const aiCommandEntry =
				commandMode === 'ai' && activeSession
					? getAiCommandEntry(activeSession.id, activeSession.activeTabId)
					: undefined;
			if (aiCommandEntry && activeSession) {
				const entryKey = aiCommandKey(aiCommandEntry.sessionId, aiCommandEntry.tabId);
				const decline = () => {
					// The request text comes back so the user can refine it. Declining is
					// nearly always "not what I meant", not "never mind".
					setInputValue(dismissAiCommand(aiCommandEntry));
					inputRef.current?.focus();
				};

				if (e.key === 'Escape') {
					e.preventDefault();
					// Same reason as the ladder branch below: a window-level Escape
					// listener blurs the composer, and the caret has to stay here.
					e.stopPropagation();
					decline();
					return;
				}

				if (aiCommandEntry.status === 'proposed') {
					if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
						e.preventDefault();
						// Left is Run, right is Cancel - the order they are drawn in.
						useAiCommandStore
							.getState()
							.setAiCommandChoice(entryKey, e.key === 'ArrowLeft' ? 'run' : 'cancel');
						return;
					}
					if (e.key === 'y' || e.key === 'Y') {
						e.preventDefault();
						runAcceptedAiCommand(activeSession, aiCommandEntry);
						return;
					}
					if (e.key === 'n' || e.key === 'N') {
						e.preventDefault();
						decline();
						return;
					}
					if (e.key === 'Enter') {
						e.preventDefault();
						if (aiCommandEntry.choice === 'run') {
							runAcceptedAiCommand(activeSession, aiCommandEntry);
						} else {
							decline();
						}
						return;
					}
				}

				if (e.key === 'Enter') {
					// Thinking: nothing to answer yet. Error: Enter hands the request
					// back, which is one more Enter away from a retry.
					e.preventDefault();
					if (aiCommandEntry.status === 'error') decline();
					return;
				}

				if (e.key === 'Backspace') {
					// Swallowed, not passed to the ladder below: Backspace on an empty
					// line would step down a rung and leave this card parked on a tab
					// that no longer shows it, to reappear the next time the user
					// climbs back. Answering the card is the only way past it.
					e.preventDefault();
					return;
				}
			}

			// Leaving command mode. The composer holds no `!` to delete (the gesture
			// consumed it), so the mode needs its own way out: Escape on an empty
			// command line, and Backspace past the start of one - the same keys that
			// would have removed the bang back when it was a character.
			//
			// Escape uses trim(): a line of spaces LOOKS empty, so Escape has to mean
			// "get me out" there too. Without that it fell through to the generic
			// Escape branch below, which blurs the composer - so a stray space turned
			// the exit gesture into "lose command mode AND lose focus".
			//
			// Backspace stays on a strictly empty line: it is an editing key, and on
			// "   " the user is deleting a space, not asking to leave.
			if (
				commandMode !== 'off' &&
				((e.key === 'Escape' && !inputValue.trim()) || (e.key === 'Backspace' && !inputValue))
			) {
				e.preventDefault();
				// stopPropagation is what actually keeps the caret here, and it is not
				// optional. `useKeyboardNavigation.handleEscapeInMain` is a WINDOW-level
				// keydown listener that blurs the composer and focuses the transcript on
				// any Escape pressed while the composer has focus. This handler is on
				// the element, so it runs first - and without stopping the event, that
				// window listener fires immediately afterwards and undoes the focus()
				// below. Verified: with propagation the composer ends up blurred, with
				// it stopped the caret stays put.
				e.stopPropagation();
				// One rung down: AI command -> command mode -> the agent.
				setCommandMode(previousComposerCommandMode(commandMode));
				// Belt and braces alongside the line above: exiting hands the input back
				// to the agent, so the user is still typing. Explicit rather than relying
				// on React not remounting the textarea when the mode bar and `$` prefix
				// unmount around it.
				inputRef.current?.focus();
				return;
			}

			// Handle tab completion dropdown
			if (tabCompletionOpen && isShellInput) {
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					const newIndex = Math.min(
						selectedTabCompletionIndex + 1,
						tabCompletionSuggestions.length - 1
					);
					setSelectedTabCompletionIndex(newIndex);
					syncFileTreeToTabCompletion(tabCompletionSuggestions[newIndex]);
					return;
				} else if (e.key === 'ArrowUp') {
					e.preventDefault();
					const newIndex = Math.max(selectedTabCompletionIndex - 1, 0);
					setSelectedTabCompletionIndex(newIndex);
					syncFileTreeToTabCompletion(tabCompletionSuggestions[newIndex]);
					return;
				} else if (e.key === 'Tab') {
					e.preventDefault();
					if (activeSession?.isGitRepo) {
						const filters: TabCompletionFilter[] = ['all', 'history', 'branch', 'tag', 'file'];
						const currentIndex = filters.indexOf(tabCompletionFilter);
						const nextIndex = e.shiftKey
							? (currentIndex - 1 + filters.length) % filters.length
							: (currentIndex + 1) % filters.length;
						setTabCompletionFilter(filters[nextIndex]);
						setSelectedTabCompletionIndex(0);
					} else {
						if (tabCompletionSuggestions[selectedTabCompletionIndex]) {
							setInputValue(tabCompletionSuggestions[selectedTabCompletionIndex].value);
							syncFileTreeToTabCompletion(tabCompletionSuggestions[selectedTabCompletionIndex]);
						}
						setTabCompletionOpen(false);
					}
					return;
				} else if (e.key === 'Enter') {
					e.preventDefault();
					if (tabCompletionSuggestions[selectedTabCompletionIndex]) {
						setInputValue(tabCompletionSuggestions[selectedTabCompletionIndex].value);
						syncFileTreeToTabCompletion(tabCompletionSuggestions[selectedTabCompletionIndex]);
					}
					setTabCompletionOpen(false);
					return;
				} else if (e.key === 'Escape') {
					e.preventDefault();
					setTabCompletionOpen(false);
					inputRef.current?.focus();
					return;
				}
			}

			// Handle unified @ mention picker (AI mode only)
			if (atMentionOpen && activeSession?.inputMode === 'ai') {
				// Left/Right cycle the category filter and MUST NOT move the caret.
				if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
					e.preventDefault();
					const cycle = MENTION_CATEGORY_CYCLE;
					const currentIdx = cycle.indexOf(atMentionCategory);
					const delta = e.key === 'ArrowRight' ? 1 : -1;
					const nextIdx = (currentIdx + delta + cycle.length) % cycle.length;
					setAtMentionCategory(cycle[nextIdx]);
					setSelectedAtMentionIndex(0);
					return;
				} else if (e.key === 'ArrowDown') {
					e.preventDefault();
					if (atMentionItems.length > 0) {
						setSelectedAtMentionIndex((prev) => Math.min(prev + 1, atMentionItems.length - 1));
					}
					return;
				} else if (e.key === 'ArrowUp') {
					e.preventDefault();
					if (atMentionItems.length > 0) {
						setSelectedAtMentionIndex((prev) => Math.max(prev - 1, 0));
					}
					return;
				} else if (e.key === 'Tab' || e.key === 'Enter') {
					e.preventDefault();
					const selected = atMentionItems[selectedAtMentionIndex];
					if (selected) {
						const accept = buildMentionAccept(
							inputValue,
							atMentionStartIndex,
							atMentionFilter,
							selected
						);
						setInputValue(accept.value);
						// Land the caret right after the inserted token (past its
						// trailing space) so typing continues seamlessly. Deferred a
						// frame so it runs after the controlled value commits.
						requestAnimationFrame(() => {
							const el = inputRef.current;
							if (el) el.selectionStart = el.selectionEnd = accept.caretPos;
						});
						if (accept.keepOpen) {
							// Directory drill-in: keep the picker open and re-filter
							// inside the chosen folder (category preserved).
							setAtMentionFilter(accept.nextFilter);
							setSelectedAtMentionIndex(0);
							return;
						}
					}
					setAtMentionOpen(false);
					setAtMentionFilter('');
					setAtMentionStartIndex(-1);
					return;
				} else if (e.key === 'Escape') {
					e.preventDefault();
					setAtMentionOpen(false);
					setAtMentionFilter('');
					setAtMentionStartIndex(-1);
					inputRef.current?.focus();
					return;
				}
			}

			// Handle slash command autocomplete
			if (slashCommandOpen) {
				const isTerminalMode = activeSession?.inputMode === 'terminal';
				const query = inputValue.toLowerCase().replace(/^\//, '');
				const filteredCommands = filterSlashCommands(allSlashCommands, query, !!isTerminalMode);

				if (e.key === 'ArrowDown') {
					e.preventDefault();
					setSelectedSlashCommandIndex((prev) => Math.min(prev + 1, filteredCommands.length - 1));
				} else if (e.key === 'ArrowUp') {
					e.preventDefault();
					setSelectedSlashCommandIndex((prev) => Math.max(prev - 1, 0));
				} else if (e.key === 'Tab' || e.key === 'Enter') {
					e.preventDefault();
					if (filteredCommands.length === 0) return;
					const clampedIndex = Math.max(
						0,
						Math.min(selectedSlashCommandIndex, filteredCommands.length - 1)
					);
					setInputValue(filteredCommands[clampedIndex].command + ' ');
					setSlashCommandOpen(false);
					inputRef.current?.focus();
				} else if (e.key === 'Escape') {
					e.preventDefault();
					setSlashCommandOpen(false);
				}
				return;
			}

			// Read enter-to-send settings at call time (not closure).
			// A per-tab override wins over the global default - set when the user
			// clicks the chip or runs the palette toggle on a specific tab.
			const settings = useSettingsStore.getState();
			const activeTab = activeSession?.aiTabs?.find((t) => t.id === activeSession.activeTabId);
			const enterToSendAI = activeTab?.enterToSend ?? settings.enterToSendAI;

			// Steer Running Turn. Checked ahead of the Enter rules because its default
			// chord contains Enter, and they would read it as a plain send. Not inside
			// the Enter guard, so a rebind to any other key still works here.
			if (
				activeSession?.inputMode === 'ai' &&
				eventMatchesShortcutKeys(e, settings.shortcuts.steerSend?.keys)
			) {
				// Mid-composition the keystroke belongs to the IME, which confirms a
				// candidate with Enter. Return without acting: steering the
				// half-composed text cannot be taken back, and falling through would
				// let the Enter rules below send it as a plain message instead.
				if (e.nativeEvent?.isComposing) return;
				e.preventDefault();
				runSteerSend();
				return;
			}

			if (e.key === 'Enter') {
				// Check for forced parallel send shortcut (only in AI mode, only when feature enabled)
				// Note: This check is inside the `e.key === 'Enter'` guard, so the shortcut's
				// main key must be Enter. Non-Enter shortcuts are not supported by design.
				if (settings.forcedParallelExecution && activeSession?.inputMode === 'ai') {
					const fpShortcut = settings.shortcuts.forcedParallelSend;
					if (fpShortcut && eventMatchesShortcutKeys(e, fpShortcut.keys)) {
						e.preventDefault();
						runForcedParallelSend();
						return;
					}
				}

				if (enterToSendAI && !e.shiftKey) {
					e.preventDefault();
					processInput();
				} else if (!enterToSendAI && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					processInput();
				}
			} else if (e.key === 'Escape') {
				e.preventDefault();
				inputRef.current?.blur();
				terminalOutputRef.current?.focus();
			} else if (e.key === 'ArrowUp') {
				if (activeSession?.inputMode === 'terminal') {
					e.preventDefault();
					setCommandHistoryOpen(true);
					setCommandHistoryFilter(inputValue);
					setCommandHistorySelectedIndex(0);
				}
			} else if (e.key === 'Tab') {
				e.preventDefault();

				if (isShellInput && !slashCommandOpen) {
					// An empty command line is a valid trigger - it means "what have I
					// run before". A terminal needs something to complete against.
					if (inputValue.trim() || isCommandMode) {
						const suggestions = getTabCompletionSuggestions(inputValue, 'all', isCommandMode);
						if (suggestions.length > 0) {
							if (suggestions.length === 1) {
								setInputValue(suggestions[0].value);
							} else {
								setSelectedTabCompletionIndex(0);
								setTabCompletionFilter('all');
								setTabCompletionOpen(true);
							}
						}
					}
				}
			}
		},
		[
			getInputValue,
			setInputValue,
			tabCompletionSuggestions,
			atMentionItems,
			allSlashCommands,
			syncFileTreeToTabCompletion,
			processInput,
			runSteerSend,
			getTabCompletionSuggestions,
			getCommandMode,
			setCommandMode,
			inputRef,
			terminalOutputRef,
			runAcceptedAiCommand,
			// InputContext values
			commandHistoryOpen,
			tabCompletionOpen,
			selectedTabCompletionIndex,
			tabCompletionFilter,
			atMentionOpen,
			atMentionFilter,
			atMentionStartIndex,
			selectedAtMentionIndex,
			atMentionCategory,
			slashCommandOpen,
			selectedSlashCommandIndex,
			// InputContext setters
			setSlashCommandOpen,
			setSelectedSlashCommandIndex,
			setTabCompletionOpen,
			setSelectedTabCompletionIndex,
			setTabCompletionFilter,
			setAtMentionOpen,
			setAtMentionFilter,
			setAtMentionStartIndex,
			setSelectedAtMentionIndex,
			setAtMentionCategory,
			setCommandHistoryOpen,
			setCommandHistoryFilter,
			setCommandHistorySelectedIndex,
		]
	);

	return { handleInputKeyDown };
}
