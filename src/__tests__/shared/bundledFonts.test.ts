import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
	BUNDLED_FONTS,
	BUNDLED_FONT_NAMES,
	bundledSubstituteFor,
	getBundledFont,
	isBundledFont,
} from '../../shared/bundledFonts';

const REPO_ROOT = path.join(__dirname, '../../..');
const GENERATED_CSS = path.join(REPO_ROOT, 'src/renderer/generated-fonts.css');
const FONTS_DIR = path.join(REPO_ROOT, 'src/renderer/public/fonts');
const FETCH_SCRIPT = path.join(REPO_ROOT, 'scripts/fetch-webfonts.mjs');

describe('bundled font catalog', () => {
	it('has no duplicate families', () => {
		expect(new Set(BUNDLED_FONT_NAMES).size).toBe(BUNDLED_FONT_NAMES.length);
	});

	it('matches a name case-insensitively but never a non-bundled one', () => {
		expect(isBundledFont('jetbrains mono')).toBe(true);
		expect(isBundledFont('  Inter  ')).toBe(true);
		expect(isBundledFont('Menlo')).toBe(false);
		expect(isBundledFont('')).toBe(false);
		expect(isBundledFont(undefined)).toBe(false);
	});

	it('maps a proprietary face to its metric-compatible substitute', () => {
		// Metric-compatible means identical advance widths, so swapping it into
		// a layout built for the original reflows nothing.
		expect(bundledSubstituteFor('Arial')?.name).toBe('Arimo');
		expect(bundledSubstituteFor('Courier New')?.name).toBe('Cousine');
		expect(bundledSubstituteFor('Georgia')?.name).toBe('Gelasio');
		expect(bundledSubstituteFor('Comic Sans MS')).toBeUndefined();
	});

	it('never claims a proprietary face is itself bundled', () => {
		// These are licensed to the OS and cannot be redistributed. Listing one
		// here would promise a font the app cannot ship.
		for (const proprietary of [
			'Menlo',
			'SF Mono',
			'Consolas',
			'Segoe UI',
			'Arial',
			'Helvetica',
			'Verdana',
			'Tahoma',
			'Georgia',
			'Avenir Next',
		]) {
			expect(isBundledFont(proprietary)).toBe(false);
		}
	});

	it('exposes the full record for a bundled name', () => {
		expect(getBundledFont('Arimo')?.substituteFor).toBe('Arial');
		expect(getBundledFont('Nonesuch')).toBeUndefined();
	});
});

describe('bundled fonts are actually present', () => {
	it('generated the @font-face stylesheet', () => {
		expect(existsSync(GENERATED_CSS)).toBe(true);
	});

	it('declares an @font-face for every catalogued family', () => {
		// A name in the catalog with no face behind it is a font the picker
		// promises and the app cannot deliver.
		const css = readFileSync(GENERATED_CSS, 'utf8');
		for (const font of BUNDLED_FONTS) {
			expect(css).toContain(`font-family: '${font.name}'`);
		}
	});

	it('ships a woff2 file for every declared face', () => {
		const css = readFileSync(GENERATED_CSS, 'utf8');
		const referenced = [...css.matchAll(/url\('\/fonts\/([^']+)'\)/g)].map((m) => m[1]);
		expect(referenced.length).toBeGreaterThan(0);

		const present = new Set(readdirSync(FONTS_DIR));
		for (const file of referenced) {
			expect(present.has(file)).toBe(true);
		}
	});

	it('keeps the catalog and the download script in sync', () => {
		// The script decides what is fetched; the catalog decides what is
		// offered. A family in one and not the other is a broken promise in
		// whichever direction it drifts.
		const script = readFileSync(FETCH_SCRIPT, 'utf8');
		const fetched = [...script.matchAll(/\{ name: '([^']+)', axis:/g)].map((m) => m[1]);
		expect(new Set(fetched)).toEqual(new Set(BUNDLED_FONT_NAMES));
	});
});
