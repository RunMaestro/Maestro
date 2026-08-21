/**
 * Tests for the shared shortcut display formatter.
 *
 * This module owns the key maps for BOTH the renderer's shortcut chips and the
 * native macOS menu labels. The menu path is the one that matters most here:
 * because Electron gives no way to show an accelerator without registering it
 * (`registerAccelerator` is `@platform linux,win32`), the menu draws the
 * keystroke as label text, and these functions are what produce that text.
 */

import { describe, it, expect } from 'vitest';
import { formatKeyFor, formatShortcutKeysFor } from '../../shared/shortcutKeys';

describe('formatKeyFor', () => {
	it('maps modifiers to macOS symbols', () => {
		expect(formatKeyFor('Meta', true)).toBe('⌘');
		expect(formatKeyFor('Alt', true)).toBe('⌥');
		expect(formatKeyFor('Shift', true)).toBe('⇧');
		expect(formatKeyFor('Control', true)).toBe('⌃');
	});

	it('maps modifiers to readable text elsewhere', () => {
		expect(formatKeyFor('Meta', false)).toBe('Ctrl');
		expect(formatKeyFor('Alt', false)).toBe('Alt');
		expect(formatKeyFor('Shift', false)).toBe('Shift');
	});

	it('uppercases single characters on both platforms', () => {
		expect(formatKeyFor('j', true)).toBe('J');
		expect(formatKeyFor('j', false)).toBe('J');
	});

	it('passes through names it has no mapping for', () => {
		expect(formatKeyFor('F12', true)).toBe('F12');
		expect(formatKeyFor('F12', false)).toBe('F12');
	});

	it('uses glyphs for named keys on macOS and words elsewhere', () => {
		expect(formatKeyFor('Backspace', true)).toBe('⌫');
		expect(formatKeyFor('Backspace', false)).toBe('Backspace');
		expect(formatKeyFor('Escape', true)).toBe('⎋');
		expect(formatKeyFor('Escape', false)).toBe('Esc');
	});
});

describe('formatShortcutKeysFor', () => {
	it('separates with a space on macOS and a plus elsewhere', () => {
		expect(formatShortcutKeysFor(['Meta', 'Shift', 'k'], true)).toBe('⌘ ⇧ K');
		expect(formatShortcutKeysFor(['Meta', 'Shift', 'k'], false)).toBe('Ctrl+Shift+K');
	});

	it('honors an explicit separator', () => {
		// The macOS app menu packs the glyphs with no separator at all, the way
		// a native accelerator column renders them.
		expect(formatShortcutKeysFor(['Meta', 'Shift', 'k'], true, '')).toBe('⌘⇧K');
		expect(formatShortcutKeysFor(['Alt', 'Meta', 'ArrowLeft'], true, '')).toBe('⌥⌘←');
	});

	it('returns an empty string for an empty binding', () => {
		expect(formatShortcutKeysFor([], true)).toBe('');
	});
});
