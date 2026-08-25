/**
 * Tests for the shared keyboard chord matcher.
 *
 * These rules used to be duplicated in `isShortcut`, `isTabShortcut`, and the
 * AI composer's forced-parallel branch, and the copies had already drifted: the
 * composer's knew nothing about Shift- or Alt-rewritten characters, so a user
 * who rebound Forced Parallel Send to a punctuation key got a chord that worked
 * from one surface and silently died on another.
 */

import { describe, it, expect } from 'vitest';
import {
	eventMatchesShortcutKeys,
	type ShortcutKeyEvent,
} from '../../../renderer/utils/shortcutMatch';

function keyEvent(key: string, overrides: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
	return {
		key,
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		...overrides,
	};
}

describe('eventMatchesShortcutKeys', () => {
	it('matches a plain modifier combination', () => {
		expect(eventMatchesShortcutKeys(keyEvent('k', { metaKey: true }), ['Meta', 'k'])).toBe(true);
	});

	it('treats Ctrl as Meta so one binding table serves both platforms', () => {
		expect(eventMatchesShortcutKeys(keyEvent('k', { ctrlKey: true }), ['Meta', 'k'])).toBe(true);
	});

	it('requires modifiers to match exactly, not merely to be present', () => {
		// Cmd+Shift+K must not fire the action bound to Cmd+K.
		expect(
			eventMatchesShortcutKeys(keyEvent('k', { metaKey: true, shiftKey: true }), ['Meta', 'k'])
		).toBe(false);
		expect(eventMatchesShortcutKeys(keyEvent('k'), ['Meta', 'k'])).toBe(false);
	});

	it('accepts the character Shift produces for punctuation', () => {
		// Cmd+Shift+. reports '>' on a US layout; the binding names '.'.
		expect(
			eventMatchesShortcutKeys(keyEvent('>', { metaKey: true, shiftKey: true }), [
				'Meta',
				'Shift',
				'.',
			])
		).toBe(true);
		expect(
			eventMatchesShortcutKeys(keyEvent('{', { metaKey: true, shiftKey: true }), [
				'Meta',
				'Shift',
				'[',
			])
		).toBe(true);
	});

	it('accepts the symbol Shift produces for a number key', () => {
		expect(
			eventMatchesShortcutKeys(keyEvent('!', { metaKey: true, shiftKey: true }), [
				'Meta',
				'Shift',
				'1',
			])
		).toBe(true);
	});

	it('falls back to the physical key when Alt rewrites the character', () => {
		// macOS turns Opt+P into 'π' and Opt+, into '≤'.
		expect(
			eventMatchesShortcutKeys(keyEvent('π', { altKey: true, code: 'KeyP' }), ['Alt', 'p'])
		).toBe(true);
		expect(
			eventMatchesShortcutKeys(keyEvent('≤', { altKey: true, code: 'Comma' }), ['Alt', ','])
		).toBe(true);
	});

	it('matches named keys', () => {
		expect(
			eventMatchesShortcutKeys(keyEvent('Enter', { metaKey: true, shiftKey: true }), [
				'Meta',
				'Shift',
				'Enter',
			])
		).toBe(true);
		expect(
			eventMatchesShortcutKeys(keyEvent('ArrowDown', { metaKey: true }), ['Meta', 'ArrowDown'])
		).toBe(true);
	});

	it('never matches an unassigned action', () => {
		// An empty binding reads as "no modifiers, no main key", so without this
		// guard a bare keypress would fire an action the user left unbound.
		expect(eventMatchesShortcutKeys(keyEvent('a'), [])).toBe(false);
		expect(eventMatchesShortcutKeys(keyEvent('a'), undefined)).toBe(false);
	});
});
