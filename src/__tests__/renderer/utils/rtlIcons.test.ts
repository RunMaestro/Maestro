/**
 * @fileoverview Tests for RTL icon flip list and shouldFlipIcon utility.
 */

import { describe, it, expect } from 'vitest';
import { RTL_FLIP_ICONS, shouldFlipIcon } from '../../../renderer/utils/rtlIcons';

describe('RTL_FLIP_ICONS', () => {
	it('is a non-empty Set', () => {
		expect(RTL_FLIP_ICONS).toBeInstanceOf(Set);
		expect(RTL_FLIP_ICONS.size).toBeGreaterThan(0);
	});

	it('contains directional arrow icons', () => {
		expect(RTL_FLIP_ICONS.has('ArrowLeft')).toBe(true);
		expect(RTL_FLIP_ICONS.has('ArrowRight')).toBe(true);
	});

	it('contains chevron icons', () => {
		expect(RTL_FLIP_ICONS.has('ChevronLeft')).toBe(true);
		expect(RTL_FLIP_ICONS.has('ChevronRight')).toBe(true);
		expect(RTL_FLIP_ICONS.has('ChevronsLeft')).toBe(true);
		expect(RTL_FLIP_ICONS.has('ChevronsRight')).toBe(true);
	});

	it('contains ExternalLink', () => {
		expect(RTL_FLIP_ICONS.has('ExternalLink')).toBe(true);
	});

	it('does not contain symmetrical icons', () => {
		expect(RTL_FLIP_ICONS.has('Settings')).toBe(false);
		expect(RTL_FLIP_ICONS.has('Search')).toBe(false);
		expect(RTL_FLIP_ICONS.has('Plus')).toBe(false);
		expect(RTL_FLIP_ICONS.has('X')).toBe(false);
	});
});

describe('shouldFlipIcon', () => {
	it('returns true for icons in the flip list', () => {
		expect(shouldFlipIcon('ChevronRight')).toBe(true);
		expect(shouldFlipIcon('ArrowLeft')).toBe(true);
		expect(shouldFlipIcon('ExternalLink')).toBe(true);
		expect(shouldFlipIcon('LogIn')).toBe(true);
	});

	it('returns false for icons not in the flip list', () => {
		expect(shouldFlipIcon('Settings')).toBe(false);
		expect(shouldFlipIcon('Search')).toBe(false);
		expect(shouldFlipIcon('Trash2')).toBe(false);
		expect(shouldFlipIcon('')).toBe(false);
	});

	it('is case-sensitive (PascalCase required)', () => {
		expect(shouldFlipIcon('chevronright')).toBe(false);
		expect(shouldFlipIcon('CHEVRONRIGHT')).toBe(false);
		expect(shouldFlipIcon('chevron-right')).toBe(false);
	});
});
