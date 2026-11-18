/**
 * composerKeyDown - the keys every chat composer answers the same way.
 *
 * Shared by the AI composer (`useInputKeyDown`) and the Group Chat composer
 * (`GroupChatInput`): Cmd+F to Find, the `@` picker's Up / Down / Tab / Enter /
 * Escape, Tab on a partial `@agent` reference with the picker closed, Enter or
 * Cmd+Enter to send, and Escape to leave the composer. Each function handles one
 * branch and returns true when it consumed the key, so a surface calls them in
 * its own order around the branches only it has (the AI composer's command
 * ladder, slash commands, shell completion, category cycling, steer and Forced
 * Parallel Send). They know nothing about sessions, tabs or rooms: every value
 * a surface owns arrives as an argument, read by the caller at call time, so a
 * keystroke never subscribes a component to a store.
 *
 * `isolateFromWindowKeys`: the window keyboard handlers (`handleTabNavigation`
 * and `handleEscapeInMain` in `useKeyboardNavigation`, and the Cmd+F routing in
 * `useMainKeyboardHandler`) recognise only the AI composer. A composer they do
 * not know sets the flag, and every key handled here then stops propagating, so
 * a picker Tab cannot move panel focus. The AI composer leaves it off.
 *
 * The picker's Escape stops propagating in every composer, isolated or not:
 * the window's `handleEscapeInMain` blurs any composer it sees Escape in, and
 * it cannot know a picker was open, so letting the key through took the caret
 * away from a composer the user only meant to close the picker in. Escape with
 * the picker closed is not touched and still reaches the window.
 *
 * IME composition: while a composition is active the keystroke belongs to the
 * input method, which confirms a candidate with Enter, moves between candidates
 * with the arrows or Tab, and cancels with Escape. The picker and send branches
 * then act on nothing (they still claim the key, so a surface's own branches do
 * not act on it either), and a half-composed draft is never sent or accepted.
 * A surface's own popovers and key branches yield the same way through
 * `yieldKeyToIme`.
 */

import type React from 'react';
import { useUIStore } from '../../stores/uiStore';
import { OUTPUT_SEARCH_INPUT_SELECTOR } from '../ui/useOutputSearchLayer';
import { isImeComposing } from '../../utils/ime';
import { getAtMentionTrigger } from '../../../shared/maestro-lib/mentions/trigger';
import {
	isWindowsDrivePath,
	mentionBodyEndAt,
	mentionQuoteChar,
	stripMentionQuotes,
	trimMentionBodyPunctuation,
} from '../../../shared/mentionPatterns';
import type { AgentMentionSuggestion } from './useAgentMentionCompletion';

interface WindowIsolation {
	/** See the module comment. Off for the AI composer. */
	isolateFromWindowKeys?: boolean;
}

export interface ComposerFindKeyOptions extends WindowIsolation {
	/** The output-search key this composer's transcript uses, or null for none. */
	resolveSearchKey: () => string | null;
}

/**
 * Cmd/Ctrl+F opens the transcript Find bar. Alt is excluded: Opt+Cmd+F is
 * cross-tab search, and on Windows/Linux it still reports `e.key === 'f'`
 * (macOS rewrites it to 'ƒ'), so without the guard that combo would open Find.
 *
 * An isolated composer also leaves Shift alone (Cmd+Shift+F is a window
 * shortcut it must not swallow) and refocuses a bar that is already open,
 * since the window handler that would otherwise do it never sees the key.
 */
export function handleComposerFindKey(
	e: React.KeyboardEvent,
	options: ComposerFindKeyOptions
): boolean {
	const { resolveSearchKey, isolateFromWindowKeys } = options;
	if (e.key !== 'f' || !(e.metaKey || e.ctrlKey) || e.altKey) return false;
	if (isolateFromWindowKeys && e.shiftKey) return false;
	e.preventDefault();
	const key = resolveSearchKey();
	if (!isolateFromWindowKeys) {
		if (key) useUIStore.getState().setOutputSearchOpen(key, true);
		return true;
	}
	e.stopPropagation();
	if (!key) return true;
	const ui = useUIStore.getState();
	if (ui.outputSearchByKey[key]?.open) {
		document.querySelector<HTMLInputElement>(OUTPUT_SEARCH_INPUT_SELECTOR)?.focus();
	} else {
		ui.setOutputSearchOpen(key, true);
	}
	return true;
}

export interface ComposerPickerKeyOptions<T> extends WindowIsolation {
	/** Whether the `@` picker is showing (an empty state counts as showing). */
	open: boolean;
	items: readonly T[];
	selectedIndex: number;
	setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
	/**
	 * Accept a row. The surface writes the text (via `buildMentionAccept`),
	 * places the caret, and closes the picker, or keeps it open for a folder
	 * drill-in.
	 */
	accept: (item: T) => void;
	/** Close the picker and clear its filter and anchor. */
	close: () => void;
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

/**
 * Up / Down move the selection (clamped, no wrap), Tab or Enter accept it with
 * any modifier, Escape closes the picker. Gated on `open` alone, not on there
 * being rows, so Escape and Tab/Enter still close an empty picker. The selected
 * index is looked up rather than trusted: the rows can shrink under it, and a
 * stale index closes the picker with nothing inserted. Mid-composition every
 * one of these keys is left to the IME.
 */
export function handleComposerPickerKey<T>(
	e: React.KeyboardEvent,
	options: ComposerPickerKeyOptions<T>
): boolean {
	const { open, items, selectedIndex, setSelectedIndex, accept, close, inputRef } = options;
	if (!open) return false;
	if (isImeComposing(e)) {
		if (!PICKER_KEYS.has(e.key)) return false;
		yieldToIme(e, options);
		return true;
	}
	if (e.key === 'ArrowDown') {
		consume(e, options);
		if (items.length > 0) {
			setSelectedIndex((prev) => Math.min(prev + 1, items.length - 1));
		}
		return true;
	}
	if (e.key === 'ArrowUp') {
		consume(e, options);
		if (items.length > 0) {
			setSelectedIndex((prev) => Math.max(prev - 1, 0));
		}
		return true;
	}
	if (e.key === 'Tab' || e.key === 'Enter') {
		consume(e, options);
		const selected = items[selectedIndex];
		if (selected) {
			accept(selected);
		} else {
			close();
		}
		return true;
	}
	if (e.key === 'Escape') {
		consume(e, options);
		close();
		inputRef.current?.focus();
		return true;
	}
	return false;
}

export interface PartialMentionTrigger {
	startIndex: number;
	filter: string;
}

/**
 * Locate a partial `@name` reference under the caret. Returns null when the
 * caret is not inside or at the end of an `@name` token, when the trigger boundary
 * is invalid (e.g. an email address), or when there is whitespace between `@`
 * and the caret.
 *
 * Trailing characters after the caret up to whitespace or sentence punctuation
 * are included in `filter` so completing a mention with the caret mid-token
 * replaces the whole token rather than leaving trailing characters behind.
 */
export function findPartialMentionAtCursor(
	value: string,
	cursorPosition: number
): PartialMentionTrigger | null {
	const trigger = getAtMentionTrigger(value, cursorPosition);
	if (!trigger) return null;

	// A bare Windows drive path is a file mention, never an agent reference. The
	// drive colon is not a mention-body character, so a caret right after `@C`
	// would otherwise offer agent completion that replaces only the drive letter
	// and leaves `:/Users/...` behind. Read the whole token, not just the text
	// before the caret.
	if (isWindowsDrivePath(value.slice(trigger.startIndex + 1))) return null;

	const openQuote = mentionQuoteChar(trigger.filter);
	if (openQuote) {
		let tail = '';
		let idx = cursorPosition;
		while (idx < value.length && value[idx] !== openQuote && value[idx] !== '\n') {
			tail += value[idx];
			idx++;
		}
		return { startIndex: trigger.startIndex, filter: trigger.filter + tail };
	}

	// Walk the rest of the bare token by code point. A dot is a NAME character
	// (`@RunMaestro.ai`), so the scan must not stop at it; only sentence
	// punctuation that ends the token is trimmed back off, leaving it in the
	// draft.
	const bodyEnd = mentionBodyEndAt(value, cursorPosition);
	const rawFilter = trigger.filter + value.slice(cursorPosition, bodyEnd);
	return {
		startIndex: trigger.startIndex,
		filter: trimMentionBodyPunctuation(rawFilter),
	};
}

export interface ComposerAgentTabOptions extends WindowIsolation {
	/** Ref to the textarea to read selection and focus. */
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	/** Read the composer text at call time. */
	getInputValue: () => string;
	/**
	 * Return the mentionable agent rows matching `filter`. Groups and terminal
	 * agents must already be excluded (see `buildAgentMentionSuggestions`).
	 */
	getAgentSuggestions: (filter: string) => readonly AgentMentionSuggestion[];
	/**
	 * Accept a single matching agent. The surface writes the text (via
	 * `buildMentionAccept`) and places the caret after the trailing space.
	 */
	accept: (item: AgentMentionSuggestion, startIndex: number, filter: string) => void;
	/**
	 * Open the picker when multiple agents match, filtered to `filter` starting
	 * at `startIndex`.
	 */
	openPicker: (startIndex: number, filter: string) => void;
}

/**
 * Tab with the `@` picker closed: completes a partly typed `@agent` reference.
 * One match completes it; several open the picker filtered to them; none does
 * what Tab did before on that surface. Mid-composition the key is left to the IME.
 * Groups are never targets, so a matching group does not complete.
 */
export function handleComposerAgentTabKey(
	e: React.KeyboardEvent,
	options: ComposerAgentTabOptions
): boolean {
	if (e.key !== 'Tab') return false;
	if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
	if (isImeComposing(e)) return false;

	const el = options.inputRef.current;
	if (
		el &&
		el.selectionStart !== null &&
		el.selectionEnd !== null &&
		el.selectionStart !== el.selectionEnd
	) {
		return false;
	}

	const value = options.getInputValue();
	const cursorPosition = el?.selectionStart ?? value.length;
	const partial = findPartialMentionAtCursor(value, cursorPosition);
	if (!partial) return false;

	const suggestions = options.getAgentSuggestions(stripMentionQuotes(partial.filter));
	const agentMatches = suggestions.filter((item) => item.kind === 'agent');

	if (agentMatches.length === 0) {
		return false;
	}

	consume(e, options);

	if (agentMatches.length === 1) {
		options.accept(agentMatches[0], partial.startIndex, partial.filter);
	} else {
		options.openPicker(partial.startIndex, partial.filter);
	}

	return true;
}

export interface ComposerSendKeyOptions extends WindowIsolation {
	/** The surface's Enter-to-send value, read by the caller at call time. */
	enterToSend: boolean;
	send: () => void;
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	/**
	 * Where Escape hands focus when it leaves the composer. Omit it to leave
	 * Escape to the window handler (`handleEscapeInMain`), which knows where the
	 * surface's transcript is.
	 */
	escapeFocusTarget?: React.RefObject<HTMLElement | null>;
}

/**
 * Enter-to-send on: Enter sends (with or without Cmd/Ctrl), Shift+Enter is a
 * newline. Off: only Cmd/Ctrl+Enter sends. An isolated composer also stops
 * every Cmd/Ctrl+Enter, sent or not, so no window chord acts on it. An Enter
 * that confirms an IME candidate never sends. Escape blurs the composer and
 * focuses `escapeFocusTarget` when one is given. Mid-composition Escape is
 * left to the IME on every surface, stops propagating so the window handler
 * does not blur the composer, and never calls preventDefault.
 */
export function handleComposerSendKey(
	e: React.KeyboardEvent,
	options: ComposerSendKeyOptions
): boolean {
	const { enterToSend, send, inputRef, escapeFocusTarget, isolateFromWindowKeys } = options;
	if (e.key === 'Enter') {
		if (isImeComposing(e)) {
			if (e.metaKey || e.ctrlKey) yieldToIme(e, options);
			return true;
		}
		if (isolateFromWindowKeys && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			e.stopPropagation();
		}
		if (enterToSend && !e.shiftKey) {
			e.preventDefault();
			send();
		} else if (!enterToSend && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			send();
		}
		return true;
	}
	if (e.key === 'Escape') {
		if (isImeComposing(e)) {
			yieldToIme(e, options);
			return true;
		}
		if (escapeFocusTarget) {
			e.preventDefault();
			inputRef.current?.blur();
			escapeFocusTarget.current?.focus();
			return true;
		}
		return false;
	}
	return false;
}

/**
 * The keys a composer popover (the `@` picker, slash commands, shell tab
 * completion) navigates, accepts and closes with. Mid-composition every one of
 * them belongs to the IME.
 */
export const PICKER_KEYS: ReadonlySet<string> = new Set([
	'ArrowDown',
	'ArrowUp',
	'Tab',
	'Enter',
	'Escape',
]);

/**
 * For a surface's own branches (the AI composer's slash commands, shell tab
 * completion, command proposal card, history recall and Tab trigger): true when
 * an IME composition is active and the key is one of `keys`, after claiming it
 * the way the picker does mid-composition. The caller returns without acting.
 * No preventDefault, so the input method still gets the key; Escape stops
 * propagating so the window handler does not blur the composer mid-word.
 */
export function yieldKeyToIme(e: React.KeyboardEvent, keys: ReadonlySet<string>): boolean {
	if (!isImeComposing(e) || !keys.has(e.key)) return false;
	yieldToIme(e, {});
	return true;
}

function consume(e: React.KeyboardEvent, options: WindowIsolation): void {
	e.preventDefault();
	if (stopsAtComposer(e, options)) e.stopPropagation();
}

/** Whether a picker key must not reach the window handlers (see the module comment). */
function stopsAtComposer(e: React.KeyboardEvent, options: WindowIsolation): boolean {
	return options.isolateFromWindowKeys === true || e.key === 'Escape';
}

/**
 * Claim a key the IME is using without acting on it. No preventDefault, which
 * would keep the key from the input method; the window still does not see a
 * key `consume` would have stopped.
 */
function yieldToIme(e: React.KeyboardEvent, options: WindowIsolation): void {
	if (stopsAtComposer(e, options)) e.stopPropagation();
}
