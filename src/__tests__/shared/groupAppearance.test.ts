/**
 * @file groupAppearance.test.ts
 * @description Tests for the shared group appearance catalog: normalization,
 * validation, and the update-request rules that both the CLI and the WebSocket
 * message handlers rely on.
 */

import { describe, it, expect } from 'vitest';
import {
	GROUP_ICON_CATALOG,
	GROUP_ICON_IDS,
	GROUP_LABEL_COLORS,
	normalizeGroupColor,
	normalizeGroupIconId,
	validateGroupAppearance,
	validateGroupUpdate,
} from '../../shared/groupAppearance';

describe('group appearance catalog', () => {
	it('exposes the documented built-in icon ids', () => {
		expect(GROUP_ICON_IDS).toEqual([
			'folder',
			'briefcase',
			'rocket',
			'code',
			'star',
			'heart',
			'lightbulb',
			'target',
			'calendar',
			'book',
			'layers',
			'shield',
			'wrench',
			'palette',
			'archive',
			'zap',
		]);
	});

	it('labels every icon', () => {
		expect(GROUP_ICON_CATALOG.every((entry) => entry.label.length > 0)).toBe(true);
	});

	it('stores every built-in color as an uppercase hex value', () => {
		for (const color of GROUP_LABEL_COLORS) {
			expect(color.value).toMatch(/^#[0-9A-F]{6}$/);
		}
	});
});

describe('normalizeGroupIconId', () => {
	it('accepts a built-in id regardless of case or padding', () => {
		expect(normalizeGroupIconId('  Rocket ')).toBe('rocket');
	});

	it('accepts a plugin-namespaced id', () => {
		expect(normalizeGroupIconId('my-plugin/my-pack/my-icon')).toBe('my-plugin/my-pack/my-icon');
	});

	it('rejects an unknown bare id', () => {
		expect(normalizeGroupIconId('sparkle-pony')).toBeNull();
	});

	it('rejects a namespaced id with an empty segment', () => {
		expect(normalizeGroupIconId('my-plugin//my-icon')).toBeNull();
	});

	it('rejects an empty string', () => {
		expect(normalizeGroupIconId('   ')).toBeNull();
	});
});

describe('normalizeGroupColor', () => {
	it('uppercases a hex value', () => {
		expect(normalizeGroupColor('#ef4444')).toBe('#EF4444');
	});

	it('accepts a plugin-namespaced color id', () => {
		expect(normalizeGroupColor('my-plugin/my-pack/brand')).toBe('my-plugin/my-pack/brand');
	});

	it('rejects a three-digit hex value', () => {
		expect(normalizeGroupColor('#f44')).toBeNull();
	});

	it('rejects a CSS color name', () => {
		expect(normalizeGroupColor('red')).toBeNull();
	});
});

describe('validateGroupAppearance', () => {
	it('returns only the supplied fields', () => {
		const result = validateGroupAppearance({ icon: 'star' });
		expect(result).toEqual({ ok: true, value: { icon: 'star' } });
	});

	it('rejects emoji and icon together', () => {
		const result = validateGroupAppearance({ emoji: '🚀', icon: 'rocket' });
		expect(result.ok).toBe(false);
	});

	it('allows a color alongside an emoji', () => {
		const result = validateGroupAppearance({ emoji: '🚀', color: '#22c55e' });
		expect(result).toEqual({ ok: true, value: { emoji: '🚀', color: '#22C55E' } });
	});

	it('allows a color alongside an icon', () => {
		const result = validateGroupAppearance({ icon: 'shield', color: '#22c55e' });
		expect(result).toEqual({ ok: true, value: { icon: 'shield', color: '#22C55E' } });
	});

	it('names the offending value in an icon error', () => {
		const result = validateGroupAppearance({ icon: 'nope' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('"nope"');
	});
});

describe('validateGroupUpdate', () => {
	it('rejects an update with nothing in it', () => {
		const result = validateGroupUpdate({});
		expect(result).toEqual({ ok: false, error: 'Nothing to update' });
	});

	it('rejects setting and clearing the same field', () => {
		const result = validateGroupUpdate({ icon: 'star', clear: ['icon'] });
		expect(result).toEqual({ ok: false, error: 'Cannot both set and clear icon' });
	});

	it('allows clearing an emoji while setting an icon', () => {
		const result = validateGroupUpdate({ icon: 'star', clear: ['emoji'] });
		expect(result).toEqual({ ok: true, value: { icon: 'star', clear: ['emoji'] } });
	});

	it('rejects an explicitly empty name', () => {
		const result = validateGroupUpdate({ name: '   ' });
		expect(result).toEqual({ ok: false, error: 'Group name must not be empty' });
	});

	it('rejects an explicitly empty parent', () => {
		const result = validateGroupUpdate({ parentGroupId: '' });
		expect(result).toEqual({ ok: false, error: 'Parent group ID must not be empty' });
	});

	it('rejects an unknown clear target', () => {
		const result = validateGroupUpdate({ clear: ['collapsed' as never] });
		expect(result.ok).toBe(false);
	});

	it('normalizes appearance values it passes through', () => {
		const result = validateGroupUpdate({ icon: 'Rocket', color: '#a855f7' });
		expect(result).toEqual({ ok: true, value: { icon: 'rocket', color: '#A855F7' } });
	});

	it('trims a name but leaves its case to the desktop', () => {
		const result = validateGroupUpdate({ name: '  Team Alpha  ' });
		expect(result).toEqual({ ok: true, value: { name: 'Team Alpha' } });
	});

	it('carries a clear-parent request through', () => {
		const result = validateGroupUpdate({ clear: ['parent'] });
		expect(result).toEqual({ ok: true, value: { clear: ['parent'] } });
	});
});
