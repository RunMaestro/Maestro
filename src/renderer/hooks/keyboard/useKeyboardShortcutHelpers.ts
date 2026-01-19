import { useCallback } from 'react';
import type { Shortcut } from '../../types';

/**
 * Dependencies for useKeyboardShortcutHelpers hook
 */
export interface UseKeyboardShortcutHelpersDeps {
	/** User-configurable global shortcuts (from useSettings) */
	shortcuts: Record<string, Shortcut>;
	/** User-configurable tab shortcuts (from useSettings) */
	tabShortcuts: Record<string, Shortcut>;
}

/**
 * Return type for useKeyboardShortcutHelpers hook
 */
export interface UseKeyboardShortcutHelpersReturn {
	/** Check if a keyboard event matches a shortcut by action ID */
	isShortcut: (e: KeyboardEvent, actionId: string) => boolean;
	/** Check if a keyboard event matches a tab shortcut (AI mode only) */
	isTabShortcut: (e: KeyboardEvent, actionId: string) => boolean;
}

/**
 * Keyboard shortcut matching utilities.
 *
 * Provides pure utility functions for matching keyboard events against
 * configured shortcuts. Handles modifier keys (Meta/Ctrl, Shift, Alt),
 * special key mappings, and macOS-specific Alt key character production.
 *
 * @param deps - Hook dependencies containing the shortcuts configuration
 * @returns Functions for matching keyboard events to shortcuts
 */
export function useKeyboardShortcutHelpers(
	deps: UseKeyboardShortcutHelpersDeps
): UseKeyboardShortcutHelpersReturn {
	const { shortcuts, tabShortcuts } = deps;

	/**
	 * Check if a keyboard event matches a shortcut by action ID.
	 *
	 * Handles:
	 * - Modifier keys (Meta/Ctrl/Command, Shift, Alt)
	 * - Arrow keys, Backspace, special characters
	 * - Shift+bracket producing { and } characters
	 * - Shift+number producing symbol characters (US layout)
	 * - macOS Alt key producing special characters (uses e.code fallback)
	 */
	const isShortcut = useCallback(
		(e: KeyboardEvent, actionId: string): boolean => {
			const sc = shortcuts[actionId];
			if (!sc) return false;
			const keys = sc.keys.map((k) => k.toLowerCase());

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

			const mainKey = keys[keys.length - 1];
			if (mainKey === '/' && key === '/') return true;
			if (mainKey === 'arrowleft' && key === 'arrowleft') return true;
			if (mainKey === 'arrowright' && key === 'arrowright') return true;
			if (mainKey === 'arrowup' && key === 'arrowup') return true;
			if (mainKey === 'arrowdown' && key === 'arrowdown') return true;
			if (mainKey === 'backspace' && key === 'backspace') return true;
			// Handle Shift+[ producing { and Shift+] producing }
			if (mainKey === '[' && (key === '[' || key === '{')) return true;
			if (mainKey === ']' && (key === ']' || key === '}')) return true;
			// Handle Shift+number producing symbol (US keyboard layout)
			// Shift+1='!', Shift+2='@', Shift+3='#', etc.
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

			// For Alt+Meta shortcuts on macOS, e.key produces special characters (e.g., Alt+p = π, Alt+l = ¬)
			// Use e.code to get the physical key pressed instead
			if (altPressed && e.code) {
				const codeKey = e.code.replace('Key', '').toLowerCase();
				// Map e.code values to key characters for punctuation keys
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
		},
		[shortcuts]
	);

	/**
	 * Check if a keyboard event matches a tab shortcut (AI mode only).
	 *
	 * Uses user-configurable tabShortcuts, falling back to global shortcuts
	 * if a tab-specific shortcut isn't defined.
	 */
	const isTabShortcut = useCallback(
		(e: KeyboardEvent, actionId: string): boolean => {
			const sc = tabShortcuts[actionId] || shortcuts[actionId];
			if (!sc) return false;
			const keys = sc.keys.map((k) => k.toLowerCase());

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

			const mainKey = keys[keys.length - 1];
			// Handle Shift+[ producing { and Shift+] producing }
			if (mainKey === '[' && (key === '[' || key === '{')) return true;
			if (mainKey === ']' && (key === ']' || key === '}')) return true;

			// For Alt+Meta shortcuts on macOS, e.key produces special characters (e.g., Alt+t = †)
			// Use e.code to get the physical key pressed instead
			if (altPressed && e.code) {
				const codeKey = e.code.replace('Key', '').toLowerCase();
				// Map e.code values to key characters for punctuation keys
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
		},
		[tabShortcuts, shortcuts]
	);

	return { isShortcut, isTabShortcut };
}
