/**
 * Typography presets - the two answers to "how should Maestro read?".
 *
 * Maestro was monospace everywhere until per-surface fonts existed, which is a
 * deliberate look rather than an oversight: it reads like a terminal. Now that
 * the interface, the chat transcript, the file preview, and the file editor can
 * each carry their own face, "which font?" is five questions, and asking a new
 * user five is worse than asking none. A preset answers all five at once, and
 * the individual pickers in Settings -> Display stay available for anyone who
 * wants to take them apart afterwards.
 *
 * Shared rather than renderer-local so the preset the picker writes and the
 * preset the first-run modal writes cannot drift into two different definitions
 * of what "Hacker" means.
 *
 * Every field is written explicitly, including the empty ones. A preset that
 * omitted a surface would leave whatever the previous preset put there, so
 * switching Default -> Hacker -> Default would not round-trip.
 */

import { SANS_FALLBACK_STACK } from './fontStack';

/** The interface font that produces Maestro's original all-monospace look. */
export const MONO_INTERFACE_FONT = 'Roboto Mono, Menlo, "Courier New", monospace';

/**
 * The monospace face the proportional preset pins its code surfaces to.
 * Spelled as a full stack rather than a bare name so it resolves on every
 * platform without depending on what the font sweep happens to find.
 */
export const MONO_SURFACE_FONT = MONO_INTERFACE_FONT;

export type TypographyPresetId = 'default' | 'hacker';

/**
 * The five font settings a preset writes. Keys match the settings-store fields
 * exactly, so applying one is a spread rather than a hand-written mapping that
 * could miss a surface.
 */
export interface TypographyPresetFonts {
	fontFamily: string;
	chatFontFamily: string;
	terminalFontFamily: string;
	filePreviewFontFamily: string;
	fileEditorFontFamily: string;
}

export interface TypographyPreset {
	id: TypographyPresetId;
	/** Title shown on the preset's card. */
	label: string;
	/** One-line summary shown under the title. */
	tagline: string;
	/** Per-surface summary rendered as a small table on the card. */
	surfaces: Array<{ label: string; kind: 'mono' | 'proportional' }>;
	fonts: TypographyPresetFonts;
}

export const TYPOGRAPHY_PRESETS: Record<TypographyPresetId, TypographyPreset> = {
	default: {
		id: 'default',
		label: 'Default',
		tagline: 'Proportional to read, monospace to work.',
		surfaces: [
			{ label: 'Interface', kind: 'proportional' },
			{ label: 'AI chat', kind: 'proportional' },
			{ label: 'Terminal', kind: 'mono' },
			{ label: 'File preview', kind: 'mono' },
			{ label: 'File editor', kind: 'mono' },
		],
		fonts: {
			fontFamily: SANS_FALLBACK_STACK,
			// Empty means "inherit the interface font", so chat follows the
			// proportional face without pinning a second copy of it that would
			// stop tracking a later interface-font change.
			chatFontFamily: '',
			terminalFontFamily: MONO_SURFACE_FONT,
			filePreviewFontFamily: MONO_SURFACE_FONT,
			fileEditorFontFamily: MONO_SURFACE_FONT,
		},
	},
	hacker: {
		id: 'hacker',
		label: 'Hacker',
		tagline: 'Monospace everywhere. The original Maestro.',
		surfaces: [
			{ label: 'Interface', kind: 'mono' },
			{ label: 'AI chat', kind: 'mono' },
			{ label: 'Terminal', kind: 'mono' },
			{ label: 'File preview', kind: 'mono' },
			{ label: 'File editor', kind: 'mono' },
		],
		fonts: {
			fontFamily: MONO_INTERFACE_FONT,
			// Every surface inherits, so a later interface-font change moves the
			// whole app at once - which is the point of this preset.
			chatFontFamily: '',
			terminalFontFamily: '',
			filePreviewFontFamily: '',
			fileEditorFontFamily: '',
		},
	},
};

export const TYPOGRAPHY_PRESET_IDS: TypographyPresetId[] = ['default', 'hacker'];

/**
 * Which preset a set of font settings currently matches, or null when the user
 * has taken the pickers apart into something that is neither.
 *
 * Used to preselect a card, never to decide whether to ASK: a returning user's
 * settings match `hacker` exactly (that was the only look Maestro had), so
 * gating the prompt on this would mean never prompting anyone.
 */
export function matchTypographyPreset(fonts: TypographyPresetFonts): TypographyPresetId | null {
	for (const id of TYPOGRAPHY_PRESET_IDS) {
		const preset = TYPOGRAPHY_PRESETS[id].fonts;
		const same = (Object.keys(preset) as Array<keyof TypographyPresetFonts>).every(
			(key) => (fonts[key] ?? '').trim() === preset[key]
		);
		if (same) return id;
	}
	return null;
}
