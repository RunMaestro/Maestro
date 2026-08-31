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
import { BASE_FONT_SIZE_DEFAULT } from './typography';

/** The interface font that produces Maestro's original all-monospace look. */
export const MONO_INTERFACE_FONT = 'Roboto Mono, Menlo, "Courier New", monospace';

/**
 * The monospace face the proportional preset pins its code surfaces to.
 * Spelled as a full stack rather than a bare name so it resolves on every
 * platform without depending on what the font sweep happens to find.
 */
export const MONO_SURFACE_FONT = MONO_INTERFACE_FONT;

/**
 * The proportional interface font for the Default preset. Inter leads because
 * it BUNDLES with the app (see bundledFonts.ts), so the preset renders
 * identically on a machine with no fonts installed; the platform UI faces
 * follow for anyone who prefers the native look, and the generic anchors the
 * chain.
 */
export const DEFAULT_INTERFACE_FONT = `Inter, ${SANS_FALLBACK_STACK}`;

/**
 * The monospace face for the Default preset's code surfaces. JetBrains Mono is
 * bundled, so this is guaranteed to resolve rather than silently degrading.
 */
export const DEFAULT_CODE_FONT = 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace';

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

/**
 * The size settings a preset writes, in px before zoom. `0` on an inheritable
 * surface means "follow the interface size".
 *
 * A preset carries sizes as well as families because the two are one decision:
 * a proportional face at 14px reads visibly smaller than a monospace face at
 * 14px (smaller x-height, tighter advance), so switching families without
 * retuning sizes makes the whole app look like it shrank.
 */
export interface TypographyPresetSizes {
	fontSize: number;
	chatFontSize: number;
	terminalFontSize: number;
	filePreviewFontSize: number;
	fileEditorFontSize: number;
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
	sizes: TypographyPresetSizes;
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
			{ label: 'File preview', kind: 'proportional' },
			{ label: 'File editor', kind: 'mono' },
		],
		fonts: {
			fontFamily: DEFAULT_INTERFACE_FONT,
			// Empty means "inherit the interface font", so these follow the
			// proportional face without pinning a second copy of it that would
			// stop tracking a later interface-font change.
			chatFontFamily: '',
			// Reading a document is prose, so the preview is proportional too.
			// Only the two surfaces where character alignment carries meaning -
			// the terminal's box drawing and column output, and the editor's
			// line-number gutter - stay monospace.
			filePreviewFontFamily: '',
			terminalFontFamily: DEFAULT_CODE_FONT,
			fileEditorFontFamily: DEFAULT_CODE_FONT,
		},
		sizes: {
			// A proportional face needs roughly one more pixel to match the
			// apparent size of a monospace face, which is why this is 15 rather
			// than the historical 14.
			fontSize: 15,
			chatFontSize: 0,
			filePreviewFontSize: 0,
			// The code surfaces keep the tighter size they were tuned at, so
			// they do not balloon alongside the larger reading base.
			terminalFontSize: 13,
			fileEditorFontSize: 13,
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
		sizes: {
			// One size everywhere, inherited, matching the single-font idea.
			fontSize: BASE_FONT_SIZE_DEFAULT,
			chatFontSize: 0,
			terminalFontSize: 0,
			filePreviewFontSize: 0,
			fileEditorFontSize: 0,
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
export function matchTypographyPreset(
	fonts: TypographyPresetFonts,
	sizes?: TypographyPresetSizes
): TypographyPresetId | null {
	for (const id of TYPOGRAPHY_PRESET_IDS) {
		const preset = TYPOGRAPHY_PRESETS[id];
		const fontsMatch = (Object.keys(preset.fonts) as Array<keyof TypographyPresetFonts>).every(
			(key) => (fonts[key] ?? '').trim() === preset.fonts[key]
		);
		if (!fontsMatch) continue;
		// Sizes are optional so a caller that only cares about families (the
		// picker's "which preset am I on?" label) need not thread them through.
		if (!sizes) return id;
		const sizesMatch = (Object.keys(preset.sizes) as Array<keyof TypographyPresetSizes>).every(
			(key) => Number(sizes[key] ?? 0) === preset.sizes[key]
		);
		if (sizesMatch) return id;
	}
	return null;
}
