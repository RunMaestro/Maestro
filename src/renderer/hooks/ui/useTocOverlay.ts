/**
 * useTocOverlay - open/close plumbing for the shared `TocOverlay`.
 *
 * Owns the parts of the TOC's muscle memory that are NOT visual: the toggle
 * hotkey, Escape-to-dismiss, click-outside-to-dismiss, and returning focus to
 * the host container on close (without which the next hotkey press is swallowed
 * by the entry button that just unmounted).
 *
 * Extracted from `FilePreview`, which had all of this open-coded, so Director's
 * Notes gets identical behavior instead of a second copy that drifts. Pair with
 * `<TocOverlay>`, which owns the panel itself and its arrow-key navigation.
 *
 * The host is still responsible for two things the hook cannot see:
 * - calling `handleKeyDown` from its own keydown handler, and
 * - ordering Escape against its other dismissible UI (a surface with a search
 *   box open may want that closed first). `closeIfOpen()` exists for that: call
 *   it from an Escape chain and it reports whether it consumed the key.
 */

import { useCallback, useRef, useState, type RefObject } from 'react';
import { useClickOutside } from './useClickOutside';
import { useKeyboardShortcutHelpers } from '../keyboard/useKeyboardShortcutHelpers';
import type { Shortcut } from '../../types';

const NO_TAB_SHORTCUTS: Record<string, Shortcut> = {};

interface UseTocOverlayOptions {
	/**
	 * User-configured shortcuts (from `useSettings`). Matching goes through the
	 * canonical `useKeyboardShortcutHelpers` matcher so a remapped binding is
	 * honored on every TOC surface, not just the one that read the setting.
	 */
	shortcuts: Record<string, Shortcut>;
	/**
	 * Focused when the overlay closes, so subsequent shortcuts keep firing.
	 * Usually the scrollable content container.
	 */
	containerRef?: RefObject<HTMLElement | null>;
	/**
	 * Shortcut that toggles the overlay. Defaults to the File Preview binding
	 * so every surface answers to the same keys unless told otherwise.
	 */
	shortcutId?: string;
	/**
	 * Gate for the hotkey: when false, the key is ignored and left to the host
	 * (e.g. no entries to show, or the surface is in edit mode).
	 */
	enabled?: boolean;
	/** Notified when the hotkey fires, for shortcut-usage telemetry. */
	onShortcutUsed?: (id: string) => void;
}

export function useTocOverlay({
	shortcuts,
	containerRef,
	shortcutId = 'toggleFilePreviewToc',
	enabled = true,
	onShortcutUsed,
}: UseTocOverlayOptions) {
	const { isShortcut } = useKeyboardShortcutHelpers({
		shortcuts,
		tabShortcuts: NO_TAB_SHORTCUTS,
	});
	const [open, setOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);

	const close = useCallback(() => {
		setOpen(false);
		containerRef?.current?.focus();
	}, [containerRef]);

	// Dismiss on a click outside the panel AND the toggle button. The delay
	// keeps the click that opened it from immediately closing it again.
	const closeOnClickOutside = useCallback(() => setOpen(false), []);
	useClickOutside<HTMLElement>([overlayRef, buttonRef], closeOnClickOutside, open, {
		delay: true,
	});

	const toggle = useCallback(() => {
		setOpen((v) => {
			// Restore focus to the host when closing - the focused entry button is
			// about to unmount and would otherwise take the keyboard with it.
			if (v) containerRef?.current?.focus();
			return !v;
		});
	}, [containerRef]);

	/**
	 * Close the overlay if it's open. Returns true when it consumed the event,
	 * so hosts can chain it into an Escape handler that has other UI to dismiss.
	 */
	const closeIfOpen = useCallback(() => {
		if (!open) return false;
		close();
		return true;
	}, [open, close]);

	/**
	 * Handles Escape and the toggle hotkey. Returns true when the event was
	 * consumed (already prevented and stopped), so the host can return early.
	 */
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent | KeyboardEvent): boolean => {
			if (e.key === 'Escape') {
				if (!open) return false;
				e.preventDefault();
				e.stopPropagation();
				close();
				return true;
			}
			// The canonical matcher reads only fields React's synthetic event also
			// carries, so a React.KeyboardEvent is safe to hand it.
			if (enabled && isShortcut(e as unknown as KeyboardEvent, shortcutId)) {
				e.preventDefault();
				e.stopPropagation();
				toggle();
				onShortcutUsed?.(shortcutId);
				return true;
			}
			return false;
		},
		[open, close, toggle, enabled, shortcutId, onShortcutUsed, isShortcut]
	);

	return {
		open,
		setOpen,
		close,
		closeIfOpen,
		toggle,
		handleKeyDown,
		buttonRef,
		overlayRef,
	};
}
