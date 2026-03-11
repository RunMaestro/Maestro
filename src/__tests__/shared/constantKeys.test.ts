/**
 * @fileoverview Tests for i18n constantKeys — typed key constants for non-React contexts.
 */

import { describe, it, expect } from 'vitest';
import { SHORTCUT_LABELS } from '../../shared/i18n/constantKeys';
import type { ShortcutLabelKey } from '../../shared/i18n/constantKeys';
import {
	DEFAULT_SHORTCUTS,
	FIXED_SHORTCUTS,
	TAB_SHORTCUTS,
} from '../../renderer/constants/shortcuts';
import shortcutsEn from '../../shared/i18n/locales/en/shortcuts.json';

describe('SHORTCUT_LABELS', () => {
	it('has a key for every DEFAULT_SHORTCUTS entry', () => {
		for (const id of Object.keys(DEFAULT_SHORTCUTS)) {
			expect(SHORTCUT_LABELS).toHaveProperty(id);
		}
	});

	it('has a key for every FIXED_SHORTCUTS entry', () => {
		for (const id of Object.keys(FIXED_SHORTCUTS)) {
			expect(SHORTCUT_LABELS).toHaveProperty(id);
		}
	});

	it('has a key for every TAB_SHORTCUTS entry', () => {
		for (const id of Object.keys(TAB_SHORTCUTS)) {
			expect(SHORTCUT_LABELS).toHaveProperty(id);
		}
	});

	it('all values use the shortcuts: namespace prefix', () => {
		for (const [, value] of Object.entries(SHORTCUT_LABELS)) {
			expect(value).toMatch(/^shortcuts:/);
		}
	});

	it('all translation keys reference valid keys in shortcuts.json', () => {
		for (const [, value] of Object.entries(SHORTCUT_LABELS)) {
			const jsonKey = value.replace('shortcuts:', '');
			expect(shortcutsEn).toHaveProperty(jsonKey);
		}
	});

	it('shortcuts.json values match the current shortcut labels', () => {
		const allShortcuts = { ...DEFAULT_SHORTCUTS, ...FIXED_SHORTCUTS, ...TAB_SHORTCUTS };
		for (const [id, translationKey] of Object.entries(SHORTCUT_LABELS)) {
			const jsonKey = translationKey.replace('shortcuts:', '');
			const jsonValue = (shortcutsEn as Record<string, string>)[jsonKey];
			const shortcut = allShortcuts[id];
			if (shortcut) {
				expect(jsonValue).toBe(shortcut.label);
			}
		}
	});

	it('exports ShortcutLabelKey type that matches values', () => {
		// Type-level test: ensure a known value satisfies the type
		const key: ShortcutLabelKey = SHORTCUT_LABELS.toggleSidebar;
		expect(key).toBe('shortcuts:toggle_sidebar');
	});
});
