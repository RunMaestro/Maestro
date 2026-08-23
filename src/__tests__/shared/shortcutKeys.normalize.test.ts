import { describe, it, expect } from 'vitest';
import { normalizeShortcutKeys, shortcutKeysEqual } from '../../shared/shortcutKeys';

describe('normalizeShortcutKeys', () => {
	it('is order-independent', () => {
		expect(normalizeShortcutKeys(['Meta', 'Shift', 'k'])).toBe(
			normalizeShortcutKeys(['Shift', 'Meta', 'k'])
		);
	});

	it('preserves case, because k and K are different chords', () => {
		expect(normalizeShortcutKeys(['Meta', 'k'])).not.toBe(normalizeShortcutKeys(['Meta', 'K']));
	});

	it('does not mutate its input', () => {
		const keys = ['Shift', 'Meta', 'k'];
		normalizeShortcutKeys(keys);
		expect(keys).toEqual(['Shift', 'Meta', 'k']);
	});
});

describe('shortcutKeysEqual', () => {
	it('matches a reordered duplicate - the case an ordered compare misses', () => {
		expect(shortcutKeysEqual(['Meta', 'Shift', 'k'], ['Shift', 'Meta', 'k'])).toBe(true);
	});

	it('rejects a different chord', () => {
		expect(shortcutKeysEqual(['Meta', 'k'], ['Meta', 'j'])).toBe(false);
	});

	it('rejects a superset', () => {
		expect(shortcutKeysEqual(['Meta', 'k'], ['Meta', 'Shift', 'k'])).toBe(false);
	});

	it('treats two empty combinations as equal', () => {
		expect(shortcutKeysEqual([], [])).toBe(true);
	});

	it('rejects an empty combination against a real one', () => {
		expect(shortcutKeysEqual([], ['Meta', 'k'])).toBe(false);
	});
});
