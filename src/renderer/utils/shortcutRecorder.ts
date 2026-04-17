import type React from 'react';

/**
 * Build a shortcut key array from a keyboard event.
 * Returns null if only modifier keys are pressed (caller should keep recording).
 *
 * Handles macOS Alt+letter producing special characters (e.g. Alt+L = ¬) by
 * using e.code to recover the physical key name.
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
