/**
 * composerKeyDown - the keys every chat composer answers the same way.
 *
 * Shared by the AI composer (`useInputKeyDown`) and the Group Chat composer
 * (`GroupChatInput`): Cmd+F to Find, the `@` picker's Up / Down / Tab / Enter /
 * Escape, Enter or Cmd+Enter to send, and Escape to leave the composer. Each
 * function handles one branch and returns true when it consumed the key, so a
 * surface calls them in its own order around the branches only it has (the AI
 * composer's command ladder, slash commands, shell completion, category
 * cycling, steer and Forced Parallel Send). They know nothing about sessions,
 * tabs or rooms: every value a surface owns arrives as an argument, read by the
 * caller at call time, so a keystroke never subscribes a component to a store.
 *
 * `isolateFromWindowKeys`: the window keyboard handlers (`handleTabNavigation`
 * and `handleEscapeInMain` in `useKeyboardNavigation`, and the Cmd+F routing in
 * `useMainKeyboardHandler`) recognise only the AI composer. A composer they do
 * not know sets the flag, and every key handled here then stops propagating, so
 * a picker Tab cannot move panel focus and a picker Escape cannot blur the
 * composer the user is still typing in. The AI composer leaves it off.
 */

import type React from 'react';
import { useUIStore } from '../../stores/uiStore';
import { OUTPUT_SEARCH_INPUT_SELECTOR } from '../ui/useOutputSearchLayer';

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
 * stale index closes the picker with nothing inserted.
 */
export function handleComposerPickerKey<T>(
	e: React.KeyboardEvent,
	options: ComposerPickerKeyOptions<T>
): boolean {
	const { open, items, selectedIndex, setSelectedIndex, accept, close, inputRef } = options;
	if (!open) return false;
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
 * every Cmd/Ctrl+Enter, sent or not, so no window chord acts on it. Escape
 * blurs the composer and focuses `escapeFocusTarget` when one is given.
 */
export function handleComposerSendKey(
	e: React.KeyboardEvent,
	options: ComposerSendKeyOptions
): boolean {
	const { enterToSend, send, inputRef, escapeFocusTarget, isolateFromWindowKeys } = options;
	if (e.key === 'Enter') {
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
	if (e.key === 'Escape' && escapeFocusTarget) {
		e.preventDefault();
		inputRef.current?.blur();
		escapeFocusTarget.current?.focus();
		return true;
	}
	return false;
}

function consume(e: React.KeyboardEvent, options: WindowIsolation): void {
	e.preventDefault();
	if (options.isolateFromWindowKeys) e.stopPropagation();
}
