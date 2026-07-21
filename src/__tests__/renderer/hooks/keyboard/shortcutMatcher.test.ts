import { describe, expect, it } from 'vitest';
import {
	matchesShortcut,
	type ShortcutMatchEvent,
} from '../../../../renderer/hooks/keyboard/shortcutMatcher';

function keyboardEvent(options: {
	key: string;
	code?: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	repeat?: boolean;
}): ShortcutMatchEvent & { repeat: boolean } {
	return {
		key: options.key,
		code: options.code ?? `Key${options.key.toUpperCase()}`,
		metaKey: options.metaKey ?? false,
		ctrlKey: options.ctrlKey ?? false,
		altKey: options.altKey ?? false,
		shiftKey: options.shiftKey ?? false,
		repeat: options.repeat ?? false,
	};
}

describe('matchesShortcut', () => {
	it.each([
		['macOS Meta', keyboardEvent({ key: 'k', metaKey: true })],
		['Windows Ctrl', keyboardEvent({ key: 'k', ctrlKey: true })],
	])('matches a Meta alias with %s', (_platform, event) => {
		expect(matchesShortcut(event, ['Command', 'k'])).toBe(true);
	});

	it('matches shifted punctuation produced by a US layout', () => {
		expect(
			matchesShortcut(keyboardEvent({ key: '}', metaKey: true, shiftKey: true }), [
				'Meta',
				'Shift',
				']',
			])
		).toBe(true);
		expect(
			matchesShortcut(keyboardEvent({ key: '<', ctrlKey: true, shiftKey: true }), [
				'Ctrl',
				'Shift',
				',',
			])
		).toBe(true);
	});

	it('uses the physical key code when Option rewrites the key value', () => {
		expect(
			matchesShortcut(keyboardEvent({ key: 'π', code: 'KeyP', metaKey: true, altKey: true }), [
				'Meta',
				'Alt',
				'p',
			])
		).toBe(true);
	});

	it('does not treat an AltGr character as an unrelated Ctrl shortcut', () => {
		expect(
			matchesShortcut(keyboardEvent({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true }), [
				'Meta',
				'q',
			])
		).toBe(false);
	});

	it('does not apply repeat or editable-target policy', () => {
		expect(
			matchesShortcut(keyboardEvent({ key: 'w', metaKey: true, repeat: true }), ['Meta', 'w'])
		).toBe(true);
	});

	it('does not match a pane shortcut unless both physical modifiers are held', () => {
		const keys = ['Control', 'Meta', 'ArrowLeft'];
		expect(
			matchesShortcut(keyboardEvent({ key: 'ArrowLeft', metaKey: true }), keys, {
				requirePhysicalMetaAndCtrl: true,
			})
		).toBe(false);
		expect(
			matchesShortcut(keyboardEvent({ key: 'ArrowLeft', metaKey: true, ctrlKey: true }), keys, {
				requirePhysicalMetaAndCtrl: true,
			})
		).toBe(true);
	});
});
