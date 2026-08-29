import { describe, it, expect } from 'vitest';
import {
	TYPOGRAPHY_PRESETS,
	TYPOGRAPHY_PRESET_IDS,
	MONO_INTERFACE_FONT,
	DEFAULT_INTERFACE_FONT,
	matchTypographyPreset,
	type TypographyPresetFonts,
} from '../../shared/typographyPresets';
import { SANS_FALLBACK_STACK } from '../../shared/fontStack';
import { isBundledFont } from '../../shared/bundledFonts';

const FONT_KEYS: Array<keyof TypographyPresetFonts> = [
	'fontFamily',
	'chatFontFamily',
	'terminalFontFamily',
	'filePreviewFontFamily',
	'fileEditorFontFamily',
];

describe('typography presets', () => {
	it('writes every font field, including the empty ones', () => {
		// A preset that omitted a surface would leave whatever the PREVIOUS preset
		// put there, so Default -> Hacker -> Default would not round-trip.
		for (const id of TYPOGRAPHY_PRESET_IDS) {
			const fonts = TYPOGRAPHY_PRESETS[id].fonts;
			for (const key of FONT_KEYS) {
				expect(fonts).toHaveProperty(key);
				expect(typeof fonts[key]).toBe('string');
			}
		}
	});

	it('makes Hacker monospace on every surface', () => {
		const { fonts } = TYPOGRAPHY_PRESETS.hacker;
		expect(fonts.fontFamily).toBe(MONO_INTERFACE_FONT);
		// Every surface inherits, so a later interface-font change moves the whole
		// app at once - which is the point of this preset.
		expect(fonts.chatFontFamily).toBe('');
		expect(fonts.terminalFontFamily).toBe('');
		expect(fonts.filePreviewFontFamily).toBe('');
		expect(fonts.fileEditorFontFamily).toBe('');
	});

	it('makes Default proportional for reading and monospace only where alignment matters', () => {
		const { fonts } = TYPOGRAPHY_PRESETS.default;
		expect(fonts.fontFamily).toBe(DEFAULT_INTERFACE_FONT);
		expect(fonts.fontFamily).toContain(SANS_FALLBACK_STACK);
		// Chat and file preview inherit rather than pinning a second copy of the
		// sans stack, so they keep tracking a later interface-font change.
		// Reading a document is prose, so the preview is proportional too.
		expect(fonts.chatFontFamily).toBe('');
		expect(fonts.filePreviewFontFamily).toBe('');
		// Only the surfaces where character alignment carries meaning stay mono:
		// the terminal's column output and the editor's line-number gutter.
		for (const key of ['terminalFontFamily', 'fileEditorFontFamily'] as const) {
			expect(fonts[key]).not.toBe('');
			expect(fonts[key].toLowerCase()).toContain('monospace');
		}
	});

	it('leads Default with bundled faces so it renders on a bare machine', () => {
		// A preset that named only system faces would degrade to the generic
		// fallback on a machine without them, which is exactly the failure the
		// bundled fonts exist to prevent.
		const { fonts } = TYPOGRAPHY_PRESETS.default;
		expect(isBundledFont(fonts.fontFamily.split(',')[0].trim())).toBe(true);
		expect(isBundledFont(fonts.terminalFontFamily.split(',')[0].trim())).toBe(true);
		expect(isBundledFont(fonts.fileEditorFontFamily.split(',')[0].trim())).toBe(true);
	});

	it('gives Default a larger base than Hacker to offset the smaller x-height', () => {
		// A proportional face at 14px reads visibly smaller than a monospace one
		// at 14px, so switching families without retuning sizes makes the whole
		// app look like it shrank.
		expect(TYPOGRAPHY_PRESETS.default.sizes.fontSize).toBeGreaterThan(
			TYPOGRAPHY_PRESETS.hacker.sizes.fontSize
		);
		// The code surfaces keep their tighter size rather than following it up.
		expect(TYPOGRAPHY_PRESETS.default.sizes.terminalFontSize).toBeLessThan(
			TYPOGRAPHY_PRESETS.default.sizes.fontSize
		);
	});

	it('makes every Hacker surface inherit one size', () => {
		const { sizes } = TYPOGRAPHY_PRESETS.hacker;
		expect(sizes.fontSize).toBeGreaterThan(0);
		for (const key of [
			'chatFontSize',
			'terminalFontSize',
			'filePreviewFontSize',
			'fileEditorFontSize',
		] as const) {
			expect(sizes[key]).toBe(0);
		}
	});

	it('describes each surface on the card exactly once', () => {
		for (const id of TYPOGRAPHY_PRESET_IDS) {
			const labels = TYPOGRAPHY_PRESETS[id].surfaces.map((s) => s.label);
			expect(labels).toHaveLength(FONT_KEYS.length);
			expect(new Set(labels).size).toBe(labels.length);
		}
	});

	it('the surface summary matches the fonts it claims to describe', () => {
		// The card is the only thing the user reads before committing, so a
		// summary that disagreed with the settings would be a lie.
		const defaultKinds = Object.fromEntries(
			TYPOGRAPHY_PRESETS.default.surfaces.map((s) => [s.label, s.kind])
		);
		expect(defaultKinds).toEqual({
			Interface: 'proportional',
			'AI chat': 'proportional',
			Terminal: 'mono',
			'File preview': 'proportional',
			'File editor': 'mono',
		});
		expect(TYPOGRAPHY_PRESETS.hacker.surfaces.every((s) => s.kind === 'mono')).toBe(true);
	});
});

describe('matchTypographyPreset', () => {
	it('recognizes each preset from its own fonts', () => {
		for (const id of TYPOGRAPHY_PRESET_IDS) {
			expect(matchTypographyPreset(TYPOGRAPHY_PRESETS[id].fonts)).toBe(id);
		}
	});

	it('returns null once the user has taken the pickers apart', () => {
		expect(
			matchTypographyPreset({
				...TYPOGRAPHY_PRESETS.default.fonts,
				chatFontFamily: 'Comic Sans MS',
			})
		).toBeNull();
	});

	it('ignores surrounding whitespace on a stored value', () => {
		// A whitespace-only surface font means "inherit" everywhere else in the
		// app, so it must not read as a third, unmatched state here.
		expect(
			matchTypographyPreset({
				...TYPOGRAPHY_PRESETS.hacker.fonts,
				terminalFontFamily: '   ',
			})
		).toBe('hacker');
	});

	it('reports the shipped defaults as Hacker', () => {
		// This is why the prompt cannot be gated on the current fonts: every
		// existing user matches `hacker` exactly, since that was the only look
		// Maestro had. Gating on it would mean never prompting anyone.
		expect(matchTypographyPreset(TYPOGRAPHY_PRESETS.hacker.fonts)).toBe('hacker');
	});
});
