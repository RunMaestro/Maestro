import { describe, it, expect } from 'vitest';
import {
	FONT_ZOOM_DEFAULT,
	FONT_ZOOM_MAX,
	FONT_ZOOM_MIN,
	SURFACE_FONT_SIZE_MAX,
	SURFACE_FONT_SIZE_MIN,
	TYPOGRAPHY_SURFACES,
	TYPOGRAPHY_SURFACE_LIST,
	TYPOGRAPHY_SURFACE_SPECS,
	clampFontZoom,
	clampSurfaceFontSize,
	resolveSurfaceFontSize,
	resolveTypographySurface,
} from '../../shared/typography';

describe('typography surface registry', () => {
	it('gives every surface a unique settings key and CSS variable', () => {
		// A shared key would make two surfaces silently overwrite each other.
		const keys = TYPOGRAPHY_SURFACE_LIST.flatMap((s) => [s.fontKey, s.sizeKey]);
		const vars = TYPOGRAPHY_SURFACE_LIST.flatMap((s) => [s.fontVar, s.sizeVar]);
		expect(new Set(keys).size).toBe(keys.length);
		expect(new Set(vars).size).toBe(vars.length);
	});

	it('makes exactly one surface the non-inheriting base', () => {
		// Inheritance resolves toward the interface surface, so a second root
		// would be unreachable and a zero-root would be a cycle.
		const roots = TYPOGRAPHY_SURFACE_LIST.filter((s) => !s.inheritable);
		expect(roots).toHaveLength(1);
		expect(roots[0].id).toBe('interface');
	});

	it('keeps the ordered list and the spec map in agreement', () => {
		expect(TYPOGRAPHY_SURFACE_LIST.map((s) => s.id)).toEqual([...TYPOGRAPHY_SURFACES]);
		for (const id of TYPOGRAPHY_SURFACES) {
			expect(TYPOGRAPHY_SURFACE_SPECS[id].id).toBe(id);
		}
	});

	it('does not let an alias collide with another surface id', () => {
		const ids = new Set<string>(TYPOGRAPHY_SURFACES);
		for (const spec of TYPOGRAPHY_SURFACE_LIST) {
			for (const alias of spec.aliases) {
				expect(ids.has(alias)).toBe(false);
			}
		}
	});
});

describe('resolveTypographySurface', () => {
	it('resolves by id, alias, and label spelling', () => {
		expect(resolveTypographySurface('filePreview')?.id).toBe('filePreview');
		expect(resolveTypographySurface('preview')?.id).toBe('filePreview');
		expect(resolveTypographySurface('ui')?.id).toBe('interface');
	});

	it('ignores case, spaces, hyphens, and underscores', () => {
		// A CLI user types file-preview or file_preview at least as often as the
		// camelCase key, and rejecting those is pure friction.
		for (const spelling of ['File Preview', 'file-preview', 'FILE_PREVIEW', ' filepreview ']) {
			expect(resolveTypographySurface(spelling)?.id).toBe('filePreview');
		}
	});

	it('returns null for an unknown surface rather than guessing', () => {
		expect(resolveTypographySurface('sidebar')).toBeNull();
		expect(resolveTypographySurface('')).toBeNull();
	});
});

describe('clampFontZoom', () => {
	it('clamps to the supported range', () => {
		expect(clampFontZoom(99)).toBe(FONT_ZOOM_MAX);
		expect(clampFontZoom(0.01)).toBe(FONT_ZOOM_MIN);
	});

	it('falls back to 100% for a non-finite value', () => {
		// A corrupted setting must not render the app at NaN pixels. Any
		// non-finite value is treated as corruption and returns the default
		// rather than being clamped to an extreme.
		expect(clampFontZoom(NaN)).toBe(FONT_ZOOM_DEFAULT);
		expect(clampFontZoom(Infinity)).toBe(FONT_ZOOM_DEFAULT);
		expect(clampFontZoom(-Infinity)).toBe(FONT_ZOOM_DEFAULT);
	});

	it('rounds to two decimals so repeated steps do not drift', () => {
		expect(clampFontZoom(1.0000001)).toBe(1);
		expect(clampFontZoom(1.2349)).toBe(1.23);
	});
});

describe('clampSurfaceFontSize', () => {
	it('treats zero and negatives as "inherit"', () => {
		expect(clampSurfaceFontSize(0)).toBe(0);
		expect(clampSurfaceFontSize(-4)).toBe(0);
	});

	it('clamps a real size into range', () => {
		expect(clampSurfaceFontSize(999)).toBe(SURFACE_FONT_SIZE_MAX);
		expect(clampSurfaceFontSize(1)).toBe(SURFACE_FONT_SIZE_MIN);
	});
});

describe('resolveSurfaceFontSize', () => {
	it('falls back to the base size when the surface has none', () => {
		expect(resolveSurfaceFontSize(0, 15, 1)).toBe(15);
		expect(resolveSurfaceFontSize(undefined, 15, 1)).toBe(15);
	});

	it('prefers the surface size over the base', () => {
		expect(resolveSurfaceFontSize(13, 15, 1)).toBe(13);
	});

	it('scales every surface by the same ratio, preserving their proportions', () => {
		// This is the property that makes zoom safe: a user who set the terminal
		// smaller than the chat keeps that relationship at every zoom level.
		const chat = resolveSurfaceFontSize(16, 16, 1.5);
		const terminal = resolveSurfaceFontSize(12, 16, 1.5);
		expect(chat / terminal).toBeCloseTo(16 / 12, 5);
	});

	it('is reversible, so zooming out returns to the original size', () => {
		// Pushing the base around instead would clamp and lose the value.
		const base = 15;
		expect(resolveSurfaceFontSize(base, base, 2)).toBe(30);
		expect(resolveSurfaceFontSize(base, base, 1)).toBe(base);
	});

	it('keeps one decimal so consecutive zoom steps stay distinguishable', () => {
		// Whole-pixel rounding makes 1.0 and 1.05 both land on 11px at small
		// sizes, so a keypress appears to do nothing.
		expect(resolveSurfaceFontSize(11, 11, 1)).toBe(11);
		expect(resolveSurfaceFontSize(11, 11, 1.05)).toBe(11.6);
	});

	it('survives a zero or corrupted base', () => {
		expect(resolveSurfaceFontSize(0, 0, 1)).toBeGreaterThan(0);
	});
});
