import { describe, it, expect } from 'vitest';
import {
	TYPOGRAPHY_PRESETS,
	TYPOGRAPHY_PRESET_IDS,
	MONO_INTERFACE_FONT,
	matchTypographyPreset,
	type TypographyPresetFonts,
} from '../../shared/typographyPresets';
import { SANS_FALLBACK_STACK } from '../../shared/fontStack';

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

	it('makes Default proportional for reading and monospace for work', () => {
		const { fonts } = TYPOGRAPHY_PRESETS.default;
		expect(fonts.fontFamily).toBe(SANS_FALLBACK_STACK);
		// Chat inherits rather than pinning a second copy of the sans stack, so it
		// keeps tracking a later interface-font change.
		expect(fonts.chatFontFamily).toBe('');
		for (const key of [
			'terminalFontFamily',
			'filePreviewFontFamily',
			'fileEditorFontFamily',
		] as const) {
			expect(fonts[key]).not.toBe('');
			expect(fonts[key].toLowerCase()).toContain('monospace');
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
			'File preview': 'mono',
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
