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
import { aiCommandKey, getAiCommandEntry, useAiCommandStore } from '../../stores/aiCommandStore';
import { acceptAiCommand, dismissAiCommand } from '../../services/aiCommand';

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
	processInput: (overrideInputValue?: string, options?: { forceParallel?: boolean }) => void;
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
						acceptAiCommand(activeSession, aiCommandEntry);
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
							acceptAiCommand(activeSession, aiCommandEntry);
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

			if (e.key === 'Enter') {
				// Check for forced parallel send shortcut (only in AI mode, only when feature enabled)
				// Note: This check is inside the `e.key === 'Enter'` guard, so the shortcut's
				// main key must be Enter. Non-Enter shortcuts are not supported by design.
				if (settings.forcedParallelExecution && activeSession?.inputMode === 'ai') {
					const shortcuts = settings.shortcuts;
					const fpShortcut = shortcuts.forcedParallelSend;
					if (fpShortcut) {
						const fpKeys = fpShortcut.keys.map((k: string) => k.toLowerCase());
						const fpNeedsMeta =
							fpKeys.includes('meta') || fpKeys.includes('ctrl') || fpKeys.includes('command');
						const fpNeedsShift = fpKeys.includes('shift');
						const fpNeedsAlt = fpKeys.includes('alt');
						const fpMainKey = fpKeys[fpKeys.length - 1];
						const metaPressed = e.metaKey || e.ctrlKey;

						logger.info('[ForcedParallel] Shortcut check:', undefined, {
							metaPressed,
							fpNeedsMeta,
							shiftKey: e.shiftKey,
							fpNeedsShift,
							altKey: e.altKey,
							fpNeedsAlt,
							key: e.key.toLowerCase(),
							fpMainKey,
							match:
								metaPressed === fpNeedsMeta &&
								e.shiftKey === fpNeedsShift &&
								e.altKey === fpNeedsAlt &&
								e.key.toLowerCase() === fpMainKey,
						});

						if (
							metaPressed === fpNeedsMeta &&
							e.shiftKey === fpNeedsShift &&
							e.altKey === fpNeedsAlt &&
							e.key.toLowerCase() === fpMainKey
						) {
							e.preventDefault();
							trackShortcutUsage('forcedParallelSend');
							// Empty input + shortcut: open the Force Send confirmation modal for
							// the most recent eligible queued item (keyboard equivalent of
							// clicking the per-item Force Send button).
							if (inputValue.trim().length === 0) {
								logger.info(
									'[ForcedParallel] Shortcut matched on empty input, dispatching triggerForceSendQueued'
								);
								window.dispatchEvent(new CustomEvent('maestro:triggerForceSendQueued'));
								return;
							}
							logger.info('[ForcedParallel] Shortcut matched, calling processInput');
							processInput(undefined, { forceParallel: true });
							return;
						}
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
			getTabCompletionSuggestions,
			getCommandMode,
			setCommandMode,
			inputRef,
			terminalOutputRef,
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
