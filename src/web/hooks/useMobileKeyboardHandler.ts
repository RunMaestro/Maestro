/**
 * useMobileKeyboardHandler - Mobile keyboard shortcuts handler hook
 *
 * Matches DOM KeyboardEvents against a user-configurable shortcuts map (shared
 * with the desktop app) and dispatches to per-action handler callbacks. The
 * palette's Escape-to-close behavior is hardcoded since desktop treats modal
 * Escape the same way.
 *
 * @example
 * ```tsx
 * useMobileKeyboardHandler({
 *   shortcuts,
 *   activeSession,
 *   isCommandPaletteOpen,
 *   onCloseCommandPalette,
 *   actions: {
 *     quickAction: openPalette,
 *     toggleMode: () => handleModeToggle('terminal'),
 *     prevTab: prevTab,
 *     nextTab: nextTab,
 *   },
 * });
 * ```
 */

import { useEffect, useRef } from 'react';
import type { Shortcut } from '../../shared/shortcut-types';
import type { WebShortcutId } from '../constants/webShortcuts';
import type { AITabData } from './useWebSocket';

/**
 * Session type for the mobile keyboard handler.
 * Only includes fields needed for xterm isolation.
 */
export type MobileKeyboardSession = {
	inputMode?: string;
	aiTabs?: AITabData[];
	activeTabId?: string;
};

/** Per-action handler map. Each key is a web-supported shortcut ID. */
export type MobileShortcutActions = Partial<Record<WebShortcutId, () => void>>;

/**
 * Dependencies for useMobileKeyboardHandler
 */
export interface UseMobileKeyboardHandlerDeps {
	/** Resolved shortcut map (defaults merged with user overrides from settings). */
	shortcuts: Record<string, Shortcut>;
	/** The currently active session (used for xterm isolation). */
	activeSession: MobileKeyboardSession | null | undefined;
	/** Whether the command palette is currently open (for Escape handling). */
	isCommandPaletteOpen?: boolean;
	/** Close handler invoked on Escape when the palette is open. */
	onCloseCommandPalette?: () => void;
	/** Dispatch table: action ID -> callback. */
	actions: MobileShortcutActions;
}

/**
 * Match a KeyboardEvent against a Shortcut definition.
 *
 * Mirrors the logic in `src/renderer/hooks/keyboard/useKeyboardShortcutHelpers.ts`
 * but inlined here to avoid importing a React hook from a renderer path. Kept in
 * sync manually — update both if matching rules change.
 */
const MODIFIER_KEYS = new Set(['meta', 'ctrl', 'command', 'shift', 'alt']);

function matchesShortcut(e: KeyboardEvent, sc: Shortcut | undefined): boolean {
	if (!sc) return false;
	const keys = sc.keys.map((k) => k.toLowerCase());
	if (keys.length === 0) return false;

	const mainKey = keys[keys.length - 1];
	// Skip cleared / modifier-only shortcut definitions to avoid matching ordinary typing.
	if (!mainKey || MODIFIER_KEYS.has(mainKey)) return false;

	const metaPressed = e.metaKey || e.ctrlKey;
	const shiftPressed = e.shiftKey;
	const altPressed = e.altKey;
	const key = e.key.toLowerCase();

	const configMeta = keys.includes('meta') || keys.includes('ctrl') || keys.includes('command');
	const configShift = keys.includes('shift');
	const configAlt = keys.includes('alt');

	if (metaPressed !== configMeta) return false;
	if (shiftPressed !== configShift) return false;
	if (altPressed !== configAlt) return false;

	if (mainKey === '/' && key === '/') return true;
	if (mainKey === 'arrowleft' && key === 'arrowleft') return true;
	if (mainKey === 'arrowright' && key === 'arrowright') return true;
	if (mainKey === 'arrowup' && key === 'arrowup') return true;
	if (mainKey === 'arrowdown' && key === 'arrowdown') return true;
	if (mainKey === 'backspace' && key === 'backspace') return true;
	if (mainKey === '[' && (key === '[' || key === '{')) return true;
	if (mainKey === ']' && (key === ']' || key === '}')) return true;
	if (mainKey === ',' && (key === ',' || key === '<')) return true;
	if (mainKey === '.' && (key === '.' || key === '>')) return true;

	const shiftNumberMap: Record<string, string> = {
		'!': '1',
		'@': '2',
		'#': '3',
		$: '4',
		'%': '5',
		'^': '6',
		'&': '7',
		'*': '8',
		'(': '9',
		')': '0',
	};
	if (shiftNumberMap[key] === mainKey) return true;

	// macOS Alt produces special characters; fall back to physical key via e.code.
	if (altPressed && e.code) {
		const codeKey = e.code.replace('Key', '').toLowerCase();
		const codeToKey: Record<string, string> = {
			comma: ',',
			period: '.',
			slash: '/',
			backslash: '\\',
			bracketleft: '[',
			bracketright: ']',
			semicolon: ';',
			quote: "'",
			backquote: '`',
			minus: '-',
			equal: '=',
		};
		const mappedKey = codeToKey[codeKey] || codeKey;
		return mappedKey === mainKey;
	}

	return key === mainKey;
}

/**
 * Hook for handling keyboard shortcuts in the mobile web interface.
 *
 * Registers a single stable event listener (ref-based context updates) and
 * dispatches matched events to the supplied action callbacks.
 */
export function useMobileKeyboardHandler(deps: UseMobileKeyboardHandlerDeps): void {
	const depsRef = useRef(deps);
	depsRef.current = deps;

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const { shortcuts, activeSession, isCommandPaletteOpen, onCloseCommandPalette, actions } =
				depsRef.current;

			// Keep keystrokes inside a live terminal UI.
			const target = e.target;
			const activeElement = document.activeElement;
			const isXtermElement = (el: EventTarget | null) =>
				el instanceof Element &&
				(el.classList.contains('xterm-helper-textarea') || !!el.closest('.xterm'));
			const isXtermTarget = isXtermElement(target) || isXtermElement(activeElement);
			if (activeSession?.inputMode === 'terminal' && isXtermTarget) return;

			// Escape closes the command palette. Not a configurable shortcut — mirrors
			// desktop modal behavior.
			if (e.key === 'Escape' && isCommandPaletteOpen && onCloseCommandPalette) {
				e.preventDefault();
				onCloseCommandPalette();
				return;
			}

			// Don't fire shortcuts on plain typing inside editable fields. Modifier-key
			// shortcuts (Cmd/Ctrl/Alt) still fire so palette / mode toggle work from the input.
			const isEditableElement = (el: EventTarget | null) =>
				el instanceof HTMLElement &&
				(el.isContentEditable ||
					el.tagName === 'INPUT' ||
					el.tagName === 'TEXTAREA' ||
					el.tagName === 'SELECT');
			if (
				!e.metaKey &&
				!e.ctrlKey &&
				!e.altKey &&
				(isEditableElement(target) || isEditableElement(activeElement))
			) {
				return;
			}

			for (const id of Object.keys(actions) as WebShortcutId[]) {
				const handler = actions[id];
				if (!handler) continue;
				if (matchesShortcut(e, shortcuts[id])) {
					e.preventDefault();
					handler();
					return;
				}
			}
		};

		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, []);
}

export default useMobileKeyboardHandler;
