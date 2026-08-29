// Read and write typography settings from the CLI.
//
// `settings set fontFamily ...` could already write these keys, but only if you
// knew the key names, the empty-string-means-inherit convention, and which of
// the ten keys go together. These verbs address the SURFACE instead - the same
// noun the Settings tab uses - and validate against the shared registry, so a
// scripted demo or screenshot setup can put the app in a known typographic
// state in one line.

import { readSettingValue, writeSettingValue } from '../services/storage';
import { formatError, formatSuccess, formatWarning } from '../output/formatter';
import { emitJsonl } from '../output/jsonl';
import {
	TYPOGRAPHY_SURFACE_LIST,
	clampFontZoom,
	clampSurfaceFontSize,
	resolveSurfaceFontSize,
	resolveTypographySurface,
	SURFACE_FONT_SIZE_MAX,
	SURFACE_FONT_SIZE_MIN,
} from '../../shared/typography';
import {
	TYPOGRAPHY_PRESETS,
	TYPOGRAPHY_PRESET_IDS,
	matchTypographyPreset,
	type TypographyPresetFonts,
	type TypographyPresetId,
	type TypographyPresetSizes,
} from '../../shared/typographyPresets';
import { BUNDLED_FONTS } from '../../shared/bundledFonts';

interface DisplayFontOptions {
	json?: boolean;
}

function readFonts(): TypographyPresetFonts {
	return {
		fontFamily: String(readSettingValue('fontFamily') ?? ''),
		chatFontFamily: String(readSettingValue('chatFontFamily') ?? ''),
		terminalFontFamily: String(readSettingValue('terminalFontFamily') ?? ''),
		filePreviewFontFamily: String(readSettingValue('filePreviewFontFamily') ?? ''),
		fileEditorFontFamily: String(readSettingValue('fileEditorFontFamily') ?? ''),
	};
}

function readSizes(): TypographyPresetSizes {
	return {
		fontSize: Number(readSettingValue('fontSize') ?? 14),
		chatFontSize: Number(readSettingValue('chatFontSize') ?? 0),
		terminalFontSize: Number(readSettingValue('terminalFontSize') ?? 0),
		filePreviewFontSize: Number(readSettingValue('filePreviewFontSize') ?? 0),
		fileEditorFontSize: Number(readSettingValue('fileEditorFontSize') ?? 0),
	};
}

/** `display font` with no surface - show every surface's resolved typography. */
export function displayFontList(options: DisplayFontOptions): void {
	try {
		const fonts = readFonts();
		const sizes = readSizes();
		const zoom = clampFontZoom(Number(readSettingValue('fontZoom') ?? 1));
		const baseSize = sizes.fontSize;
		const preset = matchTypographyPreset(fonts, sizes);

		const rows = TYPOGRAPHY_SURFACE_LIST.map((spec) => {
			const rawFont = (fonts as unknown as Record<string, string>)[spec.fontKey] ?? '';
			const rawSize = Number((sizes as unknown as Record<string, number>)[spec.sizeKey] ?? 0);
			return {
				surface: spec.id,
				label: spec.label,
				font: rawFont,
				// What actually renders, so the output answers "what am I looking
				// at" rather than only "what is stored".
				effectiveFont: rawFont || (spec.inheritable ? '(inherits interface)' : rawFont),
				size: rawSize,
				effectiveSize: resolveSurfaceFontSize(
					spec.inheritable ? rawSize : baseSize,
					baseSize,
					zoom
				),
			};
		});

		if (options.json) {
			emitJsonl({ type: 'display-fonts', preset, zoom, surfaces: rows });
			return;
		}

		console.log(`Typography${preset ? ` (preset: ${TYPOGRAPHY_PRESETS[preset].label})` : ''}`);
		console.log(`Zoom: ${Math.round(zoom * 100)}%\n`);
		for (const row of rows) {
			console.log(`  ${row.label.padEnd(14)} ${row.effectiveFont}`);
			console.log(
				`  ${''.padEnd(14)} ${row.size === 0 ? 'inherit' : `${row.size}px`} -> renders at ${row.effectiveSize}px\n`
			);
		}
		console.log('Surfaces: ' + TYPOGRAPHY_SURFACE_LIST.map((s) => s.id).join(', '));
	} catch (error) {
		console.error(formatError(error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}

/** `display font <surface> [value]` - read or set one surface's family. */
export function displayFont(
	surface: string,
	value: string | undefined,
	options: DisplayFontOptions
): void {
	try {
		const spec = resolveTypographySurface(surface);
		if (!spec) {
			throw new Error(
				`Unknown surface "${surface}". Expected one of: ${TYPOGRAPHY_SURFACE_LIST.map((s) => s.id).join(', ')}.`
			);
		}

		if (value === undefined) {
			const current = String(readSettingValue(spec.fontKey) ?? '');
			if (options.json) {
				emitJsonl({ type: 'display-font', surface: spec.id, font: current });
			} else {
				console.log(current || '(inherits the interface font)');
			}
			return;
		}

		// `inherit` is the spelling of the empty string, which is otherwise
		// awkward to pass through a shell and easy to confuse with "unset".
		const normalized = value.trim().toLowerCase() === 'inherit' ? '' : value.trim();
		if (normalized === '' && !spec.inheritable) {
			throw new Error(
				`The ${spec.label} font is the base every other surface inherits, so it cannot itself inherit.`
			);
		}

		writeSettingValue(spec.fontKey, normalized);

		if (options.json) {
			emitJsonl({ type: 'display-font-set', surface: spec.id, font: normalized });
			return;
		}
		console.log(
			formatSuccess(
				normalized
					? `${spec.label} font set to "${normalized}"`
					: `${spec.label} font now inherits the interface font`
			)
		);
		// A bundled font is guaranteed to render; anything else may silently
		// fall back, and the CLI has no way to check what is installed.
		if (
			normalized &&
			!BUNDLED_FONTS.some((f) => f.name.toLowerCase() === normalized.toLowerCase())
		) {
			console.error(
				formatWarning(
					`"${normalized}" is not bundled with Maestro, so it renders only if installed. Run "maestro-cli display fonts" to list guaranteed fonts.`
				)
			);
		}
	} catch (error) {
		console.error(formatError(error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}

/** `display size <surface> [px|inherit]` - read or set one surface's size. */
export function displayFontSize(
	surface: string,
	value: string | undefined,
	options: DisplayFontOptions
): void {
	try {
		const spec = resolveTypographySurface(surface);
		if (!spec) {
			throw new Error(
				`Unknown surface "${surface}". Expected one of: ${TYPOGRAPHY_SURFACE_LIST.map((s) => s.id).join(', ')}.`
			);
		}

		if (value === undefined) {
			const stored = Number(readSettingValue(spec.sizeKey) ?? 0);
			if (options.json) {
				emitJsonl({ type: 'display-size', surface: spec.id, size: stored });
			} else {
				console.log(stored === 0 ? 'inherit' : `${stored}px`);
			}
			return;
		}

		const wantsInherit = value.trim().toLowerCase() === 'inherit';
		if (wantsInherit && !spec.inheritable) {
			throw new Error(
				`The ${spec.label} size is the base every other surface inherits, so it cannot itself inherit.`
			);
		}

		let next: number;
		if (wantsInherit) {
			next = 0;
		} else {
			const parsed = Number(value.replace(/px$/i, '').trim());
			if (!Number.isFinite(parsed)) {
				throw new Error(`"${value}" is not a size. Pass a number of pixels, or "inherit".`);
			}
			next = clampSurfaceFontSize(parsed);
			if (next === 0) {
				throw new Error(
					`Size must be between ${SURFACE_FONT_SIZE_MIN} and ${SURFACE_FONT_SIZE_MAX} px.`
				);
			}
		}

		writeSettingValue(spec.sizeKey, next);

		if (options.json) {
			emitJsonl({ type: 'display-size-set', surface: spec.id, size: next });
			return;
		}
		console.log(
			formatSuccess(
				next === 0
					? `${spec.label} size now inherits the interface size`
					: `${spec.label} size set to ${next}px`
			)
		);
	} catch (error) {
		console.error(formatError(error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}

/** `display zoom [percent]` - read or set the global multiplier. */
export function displayZoom(value: string | undefined, options: DisplayFontOptions): void {
	try {
		const current = clampFontZoom(Number(readSettingValue('fontZoom') ?? 1));

		if (value === undefined) {
			if (options.json) emitJsonl({ type: 'display-zoom', zoom: current });
			else console.log(`${Math.round(current * 100)}%`);
			return;
		}

		// Accept both "125%" and "1.25" - a percentage is what the Settings row
		// shows, a multiplier is what gets stored.
		const trimmed = value.trim();
		const raw = Number(trimmed.replace(/%$/, ''));
		if (!Number.isFinite(raw)) {
			throw new Error(`"${value}" is not a zoom level. Pass e.g. 125% or 1.25.`);
		}
		const next = clampFontZoom(trimmed.endsWith('%') || raw > 5 ? raw / 100 : raw);

		writeSettingValue('fontZoom', next);
		if (options.json) emitJsonl({ type: 'display-zoom-set', zoom: next });
		else console.log(formatSuccess(`Zoom set to ${Math.round(next * 100)}%`));
	} catch (error) {
		console.error(formatError(error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}

/** `display preset <default|hacker>` - the CLI form of Factory Reset Fonts. */
export function displayPreset(id: string | undefined, options: DisplayFontOptions): void {
	try {
		if (id === undefined) {
			const preset = matchTypographyPreset(readFonts(), readSizes());
			if (options.json) emitJsonl({ type: 'display-preset', preset });
			else console.log(preset ?? '(customized - matches neither preset)');
			return;
		}

		const normalized = id.trim().toLowerCase() as TypographyPresetId;
		if (!TYPOGRAPHY_PRESET_IDS.includes(normalized)) {
			throw new Error(
				`Unknown preset "${id}". Expected one of: ${TYPOGRAPHY_PRESET_IDS.join(', ')}.`
			);
		}

		const preset = TYPOGRAPHY_PRESETS[normalized];
		// Writes fonts AND sizes, exactly like the in-app Factory Reset. Zoom is
		// left alone: it is an accessibility accommodation, not part of the look.
		for (const [key, value] of Object.entries({ ...preset.fonts, ...preset.sizes })) {
			writeSettingValue(key, value);
		}

		if (options.json) {
			emitJsonl({ type: 'display-preset-set', preset: normalized });
			return;
		}
		console.log(formatSuccess(`Typography reset to ${preset.label}: ${preset.tagline}`));
	} catch (error) {
		console.error(formatError(error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}

/** `display fonts` - list the families guaranteed to be available. */
export function displayFontsCatalog(options: DisplayFontOptions): void {
	if (options.json) {
		emitJsonl({ type: 'display-font-catalog', fonts: BUNDLED_FONTS });
		return;
	}
	console.log('Fonts bundled with Maestro (always available, no install needed):\n');
	for (const kind of ['mono', 'sans', 'serif'] as const) {
		const group = BUNDLED_FONTS.filter((f) => f.kind === kind);
		if (group.length === 0) continue;
		const heading = kind === 'mono' ? 'Monospace' : kind === 'sans' ? 'Proportional' : 'Serif';
		console.log(`  ${heading}`);
		for (const font of group) {
			const note = font.substituteFor
				? `  (metric-compatible with ${font.substituteFor})`
				: font.note
					? `  (${font.note})`
					: '';
			console.log(`    ${font.name}${note}`);
		}
		console.log('');
	}
	console.log('Any other installed font can be used too - pass its name to "display font".');
}
