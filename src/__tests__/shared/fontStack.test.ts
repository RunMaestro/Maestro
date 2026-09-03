/**
 * Tests for shared/fontStack.ts - monospace fallback for the interface font.
 */

import { describe, it, expect } from 'vitest';
import {
	withMonoFallback,
	resolveSurfaceFont,
	displayFontLabel,
	MONO_FALLBACK_STACK,
} from '../../shared/fontStack';
import { DEFAULT_INTERFACE_FONT } from '../../shared/typographyPresets';

describe('withMonoFallback', () => {
	it('appends the monospace fallback chain to a bare font name', () => {
		// The font picker stores bare names like "Roboto Mono" with no generic
		// family, which resolve to serif on iOS. The tail must end in monospace.
		const result = withMonoFallback('Roboto Mono');
		expect(result).toBe(`Roboto Mono, ${MONO_FALLBACK_STACK}`);
		expect(result.endsWith('monospace')).toBe(true);
	});

	it('leaves a value that already ends in a generic family unchanged', () => {
		const value = 'Roboto Mono, Menlo, "Courier New", monospace';
		expect(withMonoFallback(value)).toBe(value);
	});

	it('does not append when a non-monospace generic is present', () => {
		const value = 'Comic Sans MS, sans-serif';
		expect(withMonoFallback(value)).toBe(value);
	});

	it('returns the fallback stack for empty, whitespace, null, and undefined', () => {
		expect(withMonoFallback('')).toBe(MONO_FALLBACK_STACK);
		expect(withMonoFallback('   ')).toBe(MONO_FALLBACK_STACK);
		expect(withMonoFallback(null)).toBe(MONO_FALLBACK_STACK);
		expect(withMonoFallback(undefined)).toBe(MONO_FALLBACK_STACK);
	});

	it('trims surrounding whitespace before wrapping a bare name', () => {
		expect(withMonoFallback('  JetBrains Mono  ')).toBe(`JetBrains Mono, ${MONO_FALLBACK_STACK}`);
	});

	it('matches "monospace" only as a whole word, not as a substring', () => {
		// A hypothetical family whose name merely contains the substring should
		// still get a real generic fallback appended.
		const result = withMonoFallback('Monospacewannabe');
		expect(result).toBe(`Monospacewannabe, ${MONO_FALLBACK_STACK}`);
	});
});

describe('resolveSurfaceFont', () => {
	const INTERFACE = 'Roboto Mono';

	it('falls back to the interface font when the surface has no font of its own', () => {
		// Empty is the stored value for "Same as interface font", so every surface
		// keeps following the UI until the user picks something for it.
		expect(resolveSurfaceFont('', INTERFACE)).toBe(`${INTERFACE}, ${MONO_FALLBACK_STACK}`);
		expect(resolveSurfaceFont(undefined, INTERFACE)).toBe(`${INTERFACE}, ${MONO_FALLBACK_STACK}`);
		expect(resolveSurfaceFont(null, INTERFACE)).toBe(`${INTERFACE}, ${MONO_FALLBACK_STACK}`);
	});

	it('treats a whitespace-only surface font as unset', () => {
		// A blank family resolves to nothing and drops the pane to the browser
		// default, so it must reach the interface font rather than be applied.
		expect(resolveSurfaceFont('   ', INTERFACE)).toBe(`${INTERFACE}, ${MONO_FALLBACK_STACK}`);
	});

	it('prefers the surface font over the interface font', () => {
		expect(resolveSurfaceFont('Verdana', INTERFACE)).toBe(`Verdana, ${MONO_FALLBACK_STACK}`);
	});

	it('still guarantees a generic fallback when neither is set', () => {
		expect(resolveSurfaceFont('', '')).toBe(MONO_FALLBACK_STACK);
	});
});

describe('displayFontLabel', () => {
	it('reduces a full CSS stack to its leading family', () => {
		// The Default typography preset stores a whole fallback chain, and the
		// picker rendered every comma-separated entry as the font's name.
		expect(displayFontLabel(DEFAULT_INTERFACE_FONT)).toBe('Inter');
		expect(displayFontLabel('Roboto Mono, Menlo, "Courier New", monospace')).toBe('Roboto Mono');
	});

	it('strips the quotes a CSS stack puts around a multi-word family', () => {
		expect(displayFontLabel('"Segoe UI", Roboto, sans-serif')).toBe('Segoe UI');
		expect(displayFontLabel("'JetBrains Mono', 'Fira Code', monospace")).toBe('JetBrains Mono');
	});

	it('leaves a bare font name alone', () => {
		// The picker and the custom-font input both store bare names, which are
		// already the label.
		expect(displayFontLabel('Berkeley Mono')).toBe('Berkeley Mono');
		expect(displayFontLabel('  Berkeley Mono  ')).toBe('Berkeley Mono');
	});

	it('returns an empty string for empty, whitespace, null, and undefined', () => {
		// Empty is the stored value for "inherit", which the picker labels with
		// its own inherit option rather than this.
		expect(displayFontLabel('')).toBe('');
		expect(displayFontLabel('   ')).toBe('');
		expect(displayFontLabel(null)).toBe('');
		expect(displayFontLabel(undefined)).toBe('');
	});

	it('leaves an unbalanced quote in place rather than half-trimming it', () => {
		expect(displayFontLabel('"Segoe UI, Roboto')).toBe('"Segoe UI');
	});
});
