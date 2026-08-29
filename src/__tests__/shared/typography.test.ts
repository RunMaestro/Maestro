import { describe, it, expect } from 'vitest';
import {
	FONT_ZOOM_DEFAULT,
	FONT_ZOOM_MAX,
	FONT_ZOOM_MIN,
	SURFACE_FONT_SIZE_MAX,
	SURFACE_FONT_SIZE_MIN,
	INHERIT_TERMINAL,
	TYPOGRAPHY_ROOTS,
	TYPOGRAPHY_SURFACES,
	inheritOptionsForSurface,
	resolveInheritRoot,
	resolveInheritedFont,
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

	it('makes exactly one surface inherit from nothing', () => {
		// `interface` is the base of the whole graph. `terminal` is a root others
		// may follow, but it still follows the interface itself.
		const bases = TYPOGRAPHY_SURFACE_LIST.filter((s) => s.inheritsFrom.length === 0);
		expect(bases).toHaveLength(1);
		expect(bases[0].id).toBe('interface');
	});

	it('keeps the inheritance graph exactly two levels deep', () => {
		// This is what makes a cycle impossible without a graph walk to detect
		// one: every surface a root can follow must itself follow nothing.
		for (const root of TYPOGRAPHY_ROOTS) {
			for (const parent of TYPOGRAPHY_SURFACE_SPECS[root].inheritsFrom) {
				expect(TYPOGRAPHY_SURFACE_SPECS[parent].inheritsFrom).toEqual([]);
			}
		}
	});

	it('only ever points a surface at a declared root', () => {
		for (const spec of TYPOGRAPHY_SURFACE_LIST) {
			for (const parent of spec.inheritsFrom) {
				expect(TYPOGRAPHY_ROOTS).toContain(parent);
			}
		}
	});

	it('never lets a surface inherit from itself', () => {
		for (const spec of TYPOGRAPHY_SURFACE_LIST) {
			expect(spec.inheritsFrom).not.toContain(spec.id);
		}
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

describe('two-root inheritance', () => {
	const roots = { interface: 'Inter', terminal: 'JetBrains Mono' };

	it('treats the empty string as "follow the interface"', () => {
		// Every existing install stores '' on surfaces it never customized, so
		// this meaning must not move.
		expect(resolveInheritedFont('', roots)).toBe('Inter');
		expect(resolveInheritRoot('')).toBe('interface');
	});

	it('follows the terminal when pointed at it', () => {
		expect(resolveInheritedFont(INHERIT_TERMINAL, roots)).toBe('JetBrains Mono');
		expect(resolveInheritRoot(INHERIT_TERMINAL)).toBe('terminal');
	});

	it('prefers a font of its own over either root', () => {
		expect(resolveInheritedFont('Georgia', roots)).toBe('Georgia');
		expect(resolveInheritRoot('Georgia')).toBeNull();
	});

	it('falls through to the interface when the terminal itself inherits', () => {
		// The second and final hop. Returning empty here would leave the surface
		// with no font at all.
		expect(resolveInheritedFont(INHERIT_TERMINAL, { interface: 'Inter', terminal: '' })).toBe(
			'Inter'
		);
	});

	it('cannot loop, even if the terminal somehow stored the sentinel itself', () => {
		// Defensive: the UI cannot produce this, but a hand-edited settings file
		// could, and it must terminate rather than recurse.
		expect(
			resolveInheritedFont(INHERIT_TERMINAL, { interface: 'Inter', terminal: INHERIT_TERMINAL })
		).toBe('Inter');
	});

	it('ignores surrounding whitespace on a stored value', () => {
		expect(resolveInheritedFont('   ', roots)).toBe('Inter');
		expect(resolveInheritedFont(` ${INHERIT_TERMINAL} `, roots)).toBe('JetBrains Mono');
	});

	it('uses a sentinel no real font name can collide with', () => {
		// A CSS font-family cannot begin with '@', so a user typing a name into
		// the custom-font box can never accidentally produce this value.
		expect(INHERIT_TERMINAL.startsWith('@')).toBe(true);
	});

	describe('picker options', () => {
		it('offers both roots to a dependent surface', () => {
			const options = inheritOptionsForSurface(TYPOGRAPHY_SURFACE_SPECS.chat);
			expect(options.map((o) => o.root)).toEqual(['interface', 'terminal']);
			expect(options.map((o) => o.value)).toEqual(['', INHERIT_TERMINAL]);
		});

		it('offers only the interface to the terminal', () => {
			// Terminal is a root; letting it follow another surface is what would
			// open the door to a cycle.
			const options = inheritOptionsForSurface(TYPOGRAPHY_SURFACE_SPECS.terminal);
			expect(options.map((o) => o.root)).toEqual(['interface']);
		});

		it('offers nothing to the interface', () => {
			expect(inheritOptionsForSurface(TYPOGRAPHY_SURFACE_SPECS.interface)).toEqual([]);
		});

		it('labels each option after the surface it follows', () => {
			const options = inheritOptionsForSurface(TYPOGRAPHY_SURFACE_SPECS.fileEditor);
			expect(options.map((o) => o.label)).toEqual([
				'Same as interface font',
				'Same as terminal font',
			]);
		});
	});
});
