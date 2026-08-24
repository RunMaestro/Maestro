/**
 * Tests for the tab-kind icon and color maps.
 *
 * These exist mainly to pin the rc-only fifth kind. `getTabKindIcon` is an
 * exhaustive switch written on main, where `UnifiedTab` has four kinds; rc has
 * five, and the missing `group` arm failed to compile during the back-merge
 * (TS2366). A test is cheaper than rediscovering that on the next merge.
 */

import { describe, it, expect } from 'vitest';
import {
	getTabKindIcon,
	getTabKindColor,
} from '../../../../renderer/components/TabBar/tabBarUtils';
import { mockTheme } from '../../../helpers/mockTheme';
import type { TabKind } from '../../../../renderer/components/TabBar/tabBarUtils';

const ALL_KINDS: TabKind[] = ['ai', 'file', 'browser', 'terminal', 'group'];

describe('getTabKindIcon', () => {
	it('returns an icon for every kind in the union, including group', () => {
		for (const kind of ALL_KINDS) {
			expect(getTabKindIcon(kind), `no icon for ${kind}`).toBeTruthy();
		}
	});

	it('gives each kind a distinct icon, so a mixed list is readable at a glance', () => {
		const icons = ALL_KINDS.map((kind) => getTabKindIcon(kind));
		expect(new Set(icons).size).toBe(ALL_KINDS.length);
	});
});

describe('getTabKindColor', () => {
	it('returns a color for every kind, group included', () => {
		for (const kind of ALL_KINDS) {
			expect(getTabKindColor(kind, mockTheme), `no color for ${kind}`).toBeTruthy();
		}
	});

	it('tracks the theme for the kinds that use semantic tokens', () => {
		expect(getTabKindColor('ai', mockTheme)).toBe(mockTheme.colors.accent);
		expect(getTabKindColor('file', mockTheme)).toBe(mockTheme.colors.warning);
		expect(getTabKindColor('terminal', mockTheme)).toBe(mockTheme.colors.success);
	});

	it('keeps browser on a fixed blue rather than a theme token', () => {
		// Deliberate: ansiBlue lands on desaturated purples/grays in several vibe
		// themes, which makes the browser icon read as gray beside the others.
		expect(getTabKindColor('browser', mockTheme)).not.toBe(mockTheme.colors.accent);
		expect(getTabKindColor('browser', mockTheme)).toMatch(/^#/);
	});
});
