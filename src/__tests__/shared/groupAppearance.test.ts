/**
 * @file groupAppearance.test.ts
 * @description Tests for the shared, UI-independent group appearance catalog:
 * icon/color normalization and the validation shared by the CLI create/update
 * group commands.
 */

import { describe, it, expect } from 'vitest';
import {
	GROUP_ICON_IDS,
	GROUP_LABEL_COLORS,
	isBuiltInGroupIconId,
	isPluginNamespacedId,
	normalizeGroupColor,
	normalizeGroupIconId,
	validateGroupAppearanceInput,
} from '../../shared/groupAppearance';

describe('group appearance catalog', () => {
	it('exposes the expected built-in icon IDs', () => {
		expect(GROUP_ICON_IDS).toContain('folder');
		expect(GROUP_ICON_IDS).toContain('rocket');
		expect(GROUP_ICON_IDS).toContain('zap');
		expect(GROUP_ICON_IDS.length).toBe(16);
	});

	it('exposes normalized (uppercase) built-in colors', () => {
		for (const c of GROUP_LABEL_COLORS) {
			expect(c.value).toMatch(/^#[0-9A-F]{6}$/);
		}
	});
});

describe('isBuiltInGroupIconId / isPluginNamespacedId', () => {
	it('recognizes built-in IDs', () => {
		expect(isBuiltInGroupIconId('rocket')).toBe(true);
		expect(isBuiltInGroupIconId('nope')).toBe(false);
	});

	it('recognizes plugin-namespaced IDs by the slash', () => {
		expect(isPluginNamespacedId('com.acme/bright/bolt')).toBe(true);
		expect(isPluginNamespacedId('rocket')).toBe(false);
	});
});

describe('normalizeGroupIconId', () => {
	it('accepts built-in and plugin-namespaced IDs', () => {
		expect(normalizeGroupIconId('rocket')).toBe('rocket');
		expect(normalizeGroupIconId(' rocket ')).toBe('rocket');
		expect(normalizeGroupIconId('com.acme/bright/bolt')).toBe('com.acme/bright/bolt');
	});

	it('rejects unknown non-namespaced IDs', () => {
		expect(normalizeGroupIconId('banana')).toBeNull();
		expect(normalizeGroupIconId('')).toBeNull();
	});
});

describe('normalizeGroupColor', () => {
	it('uppercases #RRGGBB hex', () => {
		expect(normalizeGroupColor('#ef4444')).toBe('#EF4444');
		expect(normalizeGroupColor(' #Ab12Cd ')).toBe('#AB12CD');
	});

	it('passes plugin-namespaced color IDs through unchanged', () => {
		expect(normalizeGroupColor('com.acme/bright/sun')).toBe('com.acme/bright/sun');
	});

	it('rejects named colors and malformed hex', () => {
		expect(normalizeGroupColor('red')).toBeNull();
		expect(normalizeGroupColor('#fff')).toBeNull();
		expect(normalizeGroupColor('#GGGGGG')).toBeNull();
	});
});

describe('validateGroupAppearanceInput', () => {
	it('normalizes valid icon + color', () => {
		const result = validateGroupAppearanceInput({ icon: 'rocket', color: '#ef4444' });
		expect(result).toEqual({ ok: true, value: { icon: 'rocket', color: '#EF4444' } });
	});

	it('trims emoji and passes it through', () => {
		const result = validateGroupAppearanceInput({ emoji: ' 🚀 ' });
		expect(result).toEqual({ ok: true, value: { emoji: '🚀' } });
	});

	it('rejects emoji + icon together', () => {
		const result = validateGroupAppearanceInput({ emoji: '🚀', icon: 'rocket' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('mutually exclusive');
	});

	it('rejects an invalid icon', () => {
		const result = validateGroupAppearanceInput({ icon: 'banana' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('Invalid icon');
	});

	it('rejects an invalid color', () => {
		const result = validateGroupAppearanceInput({ color: 'red' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('Invalid color');
	});

	it('returns an empty appearance when nothing is provided', () => {
		expect(validateGroupAppearanceInput({})).toEqual({ ok: true, value: {} });
	});
});
