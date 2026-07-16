import type { Shortcut } from '../types';

/** macOS Alt+key special character to normal key mapping for persisted shortcuts. */
const MAC_ALT_CHAR_MAP: Record<string, string> = {
	'¬': 'l',
	π: 'p',
	'†': 't',
	'∫': 'b',
	'∂': 'd',
	ƒ: 'f',
	'©': 'g',
	'˙': 'h',
	ˆ: 'i',
	'∆': 'j',
	'˚': 'k',
	'¯': 'm',
	'˜': 'n',
	ø: 'o',
	'®': 'r',
	ß: 's',
	'√': 'v',
	'∑': 'w',
	'≈': 'x',
	'¥': 'y',
	Ω: 'z',
};

const SHORTCUT_DEFAULT_REMAPS: Record<string, { fromKeys: string[]; toKeys: string[] }> = {
	moveToGroup: { fromKeys: ['Meta', 'Shift', 'm'], toKeys: ['Alt', 'Meta', 'm'] },
	toggleAutoRunExpanded: { fromKeys: ['Meta', 'Shift', '2'], toKeys: ['Meta', 'Shift', 'e'] },
};

function keysEqual(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((key, index) => key === right[index]);
}

export interface ShortcutMigrationResult {
	shortcuts: Record<string, Shortcut>;
	migratedRaw: Record<string, Shortcut>;
	needsMigration: boolean;
}

/**
 * Normalize legacy shortcut data and remap only untouched historical defaults.
 * The returned raw payload is always the complete final form, making a write
 * idempotent when the settings watcher reloads it.
 */
export function migrateShortcutSettings(
	saved: Record<string, Shortcut>,
	defaults: Record<string, Shortcut>
): ShortcutMigrationResult {
	const migrated: Record<string, Shortcut> = {};
	let needsMigration = false;

	for (const [id, shortcut] of Object.entries(saved)) {
		const keys = shortcut.keys.map((key) => {
			const normalized = MAC_ALT_CHAR_MAP[key];
			if (normalized) needsMigration = true;
			return normalized ?? key;
		});
		migrated[id] = { ...shortcut, keys };
	}

	for (const [id, remap] of Object.entries(SHORTCUT_DEFAULT_REMAPS)) {
		const current = migrated[id];
		if (current && keysEqual(current.keys, remap.fromKeys)) {
			migrated[id] = { ...current, keys: remap.toKeys };
			needsMigration = true;
		}
	}

	const shortcuts: Record<string, Shortcut> = {};
	for (const [id, defaultShortcut] of Object.entries(defaults)) {
		const savedShortcut = migrated[id];
		shortcuts[id] = { ...defaultShortcut, keys: savedShortcut?.keys ?? defaultShortcut.keys };
	}

	return { shortcuts, migratedRaw: migrated, needsMigration };
}
