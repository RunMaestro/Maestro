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
import {
	formatKeyFor,
	formatShortcutKeysFor,
	findReservedShortcutCombo,
	shortcutKeysCollide,
} from '../../shared/shortcutKeys';

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

describe('findReservedShortcutCombo', () => {
	it('flags Cmd+Shift+Down, which the OS uses to extend a text selection', () => {
		expect(findReservedShortcutCombo(['Meta', 'Shift', 'ArrowDown'])?.reason).toContain(
			'text selection'
		);
	});

	it('flags the Ctrl spelling too, since Meta and Ctrl are one modifier when matching', () => {
		expect(findReservedShortcutCombo(['Ctrl', 'Shift', 'ArrowDown'])).not.toBeNull();
	});

	it('ignores key order, matching how a chord is compared everywhere else', () => {
		expect(findReservedShortcutCombo(['Shift', 'ArrowDown', 'Meta'])).not.toBeNull();
	});

	it('leaves Opt+Cmd+Down free - it is the default for Next Unread / Draft Tab', () => {
		expect(findReservedShortcutCombo(['Alt', 'Meta', 'ArrowDown'])).toBeNull();
	});

	it('returns null for an unbound action rather than treating [] as a chord', () => {
		expect(findReservedShortcutCombo([])).toBeNull();
		expect(findReservedShortcutCombo(undefined)).toBeNull();
	});

	it('flags the macOS app-menu chords, which never reach the renderer', () => {
		// These are registered as menu roles in src/main/app-menu.ts, so the
		// accelerator is swallowed before the keydown arrives. A Maestro binding
		// on one of them reads to the user as a dead shortcut.
		expect(findReservedShortcutCombo(['Meta', 'h'])?.reason).toContain('hides Maestro');
		expect(findReservedShortcutCombo(['Alt', 'Meta', 'h'])?.reason).toContain('every other app');
		expect(findReservedShortcutCombo(['Meta', 'q'])?.reason).toContain('quits');
		expect(findReservedShortcutCombo(['Meta', 'm'])?.reason).toContain('minimizes');
		expect(findReservedShortcutCombo(['Meta', 'x'])?.reason).toContain('cuts');
		expect(findReservedShortcutCombo(['Meta', 'c'])?.reason).toContain('copies');
		expect(findReservedShortcutCombo(['Meta', 'v'])?.reason).toContain('pastes');
		expect(findReservedShortcutCombo(['Meta', 'a'])?.reason).toContain('selects all');
		expect(findReservedShortcutCombo(['Alt', 'Meta', 'Shift', 'v'])?.reason).toContain(
			'matches style'
		);
	});

	it('leaves the chords the app menu deliberately does not register', () => {
		// app-menu.ts omits undo / redo and role: 'close' on purpose, and the
		// custom Quit item swallows only Cmd+Q, so Opt+Q stays free for Cue.
		expect(findReservedShortcutCombo(['Meta', 'z'])).toBeNull();
		expect(findReservedShortcutCombo(['Meta', 'w'])).toBeNull();
		expect(findReservedShortcutCombo(['Alt', 'q'])).toBeNull();
	});

	it('leaves Ctrl+Cmd+H free - holding both modifiers is a different chord', () => {
		// computerHistory ships on ['Control', 'Meta', 'h'] precisely because
		// Opt+Cmd+H is the macOS Hide Others chord.
		expect(findReservedShortcutCombo(['Control', 'Meta', 'h'])).toBeNull();
	});
});

describe('shortcutKeysCollide', () => {
	it('collides Ctrl and Meta spellings, which are one modifier at runtime', () => {
		expect(shortcutKeysCollide(['Ctrl', 'o'], ['Meta', 'o'])).toBe(true);
		expect(shortcutKeysCollide(['Command', 'o'], ['Control', 'o'])).toBe(true);
	});

	it('ignores key order', () => {
		expect(shortcutKeysCollide(['Meta', 'Shift', 'k'], ['k', 'Shift', 'Meta'])).toBe(true);
	});

	it('does not collide chords that differ by a modifier', () => {
		expect(shortcutKeysCollide(['Alt', 'Meta', 'v'], ['Meta', 'v'])).toBe(false);
	});

	it('keeps a Ctrl+Meta pane chord distinct from the plain Meta chord', () => {
		// The collapse maps both names onto "meta" but does NOT deduplicate, so
		// holding both physical keys stays a different chord. isPaneShortcut
		// matches that family separately.
		expect(shortcutKeysCollide(['Control', 'Meta', 'w'], ['Meta', 'w'])).toBe(false);
	});

	it('does not collide different main keys under the same modifiers', () => {
		expect(shortcutKeysCollide(['Meta', 'o'], ['Meta', 'p'])).toBe(false);
	});

	it('treats an unassigned binding as colliding with nothing, including itself', () => {
		// `keys: []` is "registered but unassigned"; several shipped actions sit
		// there on purpose and must not be reported as fighting each other.
		expect(shortcutKeysCollide([], [])).toBe(false);
		expect(shortcutKeysCollide([], ['Meta', 'o'])).toBe(false);
		expect(shortcutKeysCollide(undefined, ['Meta', 'o'])).toBe(false);
	});
});
