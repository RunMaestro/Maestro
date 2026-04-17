import type React from 'react';

/**
 * Build a shortcut key array from a keyboard event.
 * Returns null if only modifier keys are pressed (caller should keep recording).
 *
 * When Alt is held, the main key is derived from e.code rather than e.key.
 * This recovers the physical key name across layouts where Alt rewrites the
 * character — most notably macOS (Alt+L = ¬, Alt+P = π) but also AltGr-based
 * layouts on Windows/Linux. Applied unconditionally so recording stays
 * symmetric with isShortcut's matching path in useKeyboardShortcutHelpers.ts.
 */
export function buildKeysFromEvent(e: React.KeyboardEvent): string[] | null {
	if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null;

	const keys: string[] = [];
	if (e.metaKey) keys.push('Meta');
	if (e.ctrlKey) keys.push('Ctrl');
	if (e.altKey) keys.push('Alt');
	if (e.shiftKey) keys.push('Shift');

	let mainKey = e.key;
	if (e.altKey && e.code) {
		if (e.code.startsWith('Key')) {
			mainKey = e.code.replace('Key', '').toLowerCase();
		} else if (e.code.startsWith('Digit')) {
			mainKey = e.code.replace('Digit', '');
		}
	}
	keys.push(mainKey);
	return keys;
}
