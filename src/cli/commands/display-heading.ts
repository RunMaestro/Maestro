// Read and write per-level heading typography (H1-H6) from the CLI.
//
// The CLI side of Settings > Display > Headings. Every edit goes through the
// same shared helpers the Settings card uses (`withHeadingStyle`,
// `parseHeadingTypography`), so the stored map is identical whichever side
// wrote it, and a running app picks the change up through its external
// settings watcher.

import { readSettingValue, writeSettingValue } from '../services/storage';
import { formatError, formatSuccess, formatWarning } from '../output/formatter';
import { emitJsonl } from '../output/jsonl';
import {
	HEADING_FONT_SIZE_MAX,
	HEADING_FONT_SIZE_MIN,
	HEADING_LEVELS,
	HEADING_TYPOGRAPHY_KEY,
	clampHeadingFontSize,
	clampFontZoom,
	parseHeadingTypography,
	resolveHeadingLevel,
	withHeadingStyle,
	type HeadingLevel,
	type HeadingStyle,
	type HeadingTypography,
} from '../../shared/typography';
import { BUNDLED_FONTS } from '../../shared/bundledFonts';

export interface DisplayHeadingOptions {
	font?: string;
	size?: string;
	reset?: boolean;
	json?: boolean;
}

/** Spellings that mean "back to the default" for either field. */
const DEFAULT_WORDS = new Set(['default', 'inherit', 'reset', '']);

function readHeadings(): HeadingTypography {
	return parseHeadingTypography(readSettingValue(HEADING_TYPOGRAPHY_KEY));
}

function describe(style: HeadingStyle | undefined): { font: string; size: string } {
	return {
		font: style?.fontFamily || 'same as surrounding text',
		size: style?.fontSize ? `${style.fontSize}px` : 'default',
	};
}

function emitLevels(headings: HeadingTypography, zoom: number, levels: readonly HeadingLevel[]) {
	emitJsonl({
		type: 'display-headings',
		zoom,
		headings: levels.map((level) => ({
			level,
			fontFamily: headings[level]?.fontFamily ?? '',
			fontSize: headings[level]?.fontSize ?? 0,
			effectiveSize: headings[level]?.fontSize
				? Math.round(headings[level]!.fontSize * zoom * 10) / 10
				: null,
		})),
	});
}

function printLevels(headings: HeadingTypography, levels: readonly HeadingLevel[]) {
	for (const level of levels) {
		const { font, size } = describe(headings[level]);
		console.log(`  ${level.toUpperCase().padEnd(4)} ${font}, ${size}`);
	}
}

function parseSize(value: string): number {
	if (DEFAULT_WORDS.has(value.trim().toLowerCase())) return 0;
	const parsed = Number(value.replace(/px$/i, '').trim());
	if (!Number.isFinite(parsed)) {
		throw new Error(`"${value}" is not a size. Pass a number of pixels, or "default".`);
	}
	const clamped = clampHeadingFontSize(parsed);
	if (clamped === 0) {
		throw new Error(
			`Size must be between ${HEADING_FONT_SIZE_MIN} and ${HEADING_FONT_SIZE_MAX} px, or "default".`
		);
	}
	return clamped;
}

/**
 * `display heading [level] [--font X] [--size N] [--reset]`.
 *
 * No level lists all six (or, with --reset, clears all six). A level with no
 * flags reads it; --font / --size set it; --reset clears it.
 */
export function displayHeading(level: string | undefined, options: DisplayHeadingOptions): void {
	try {
		const zoom = clampFontZoom(Number(readSettingValue('fontZoom') ?? 1));
		const current = readHeadings();
		const wantsWrite = options.font !== undefined || options.size !== undefined;

		if (level === undefined) {
			if (wantsWrite) {
				throw new Error('Name a heading level (h1-h6) to set its font or size.');
			}
			if (options.reset) {
				writeSettingValue(HEADING_TYPOGRAPHY_KEY, {});
				if (options.json) emitJsonl({ type: 'display-headings-reset', levels: HEADING_LEVELS });
				else console.log(formatSuccess('Every heading level restored to its default style'));
				return;
			}
			if (options.json) {
				emitLevels(current, zoom, HEADING_LEVELS);
				return;
			}
			console.log('Heading styles (sizes are px before zoom)\n');
			printLevels(current, HEADING_LEVELS);
			console.log(
				'\nSet one with: maestro-cli display heading h1 --font "Georgia" --size 28. Restore with --reset.'
			);
			return;
		}

		const resolved = resolveHeadingLevel(level);
		if (!resolved) {
			throw new Error(`Unknown heading level "${level}". Expected one of: h1, h2, h3, h4, h5, h6.`);
		}

		if (options.reset) {
			if (wantsWrite) throw new Error('Pass --reset on its own, not with --font or --size.');
			const next = { ...current };
			delete next[resolved];
			writeSettingValue(HEADING_TYPOGRAPHY_KEY, next);
			if (options.json) emitJsonl({ type: 'display-heading-reset', level: resolved });
			else console.log(formatSuccess(`${resolved.toUpperCase()} restored to its default style`));
			return;
		}

		if (!wantsWrite) {
			if (options.json) {
				emitLevels(current, zoom, [resolved]);
				return;
			}
			printLevels(current, [resolved]);
			return;
		}

		const patch: Partial<HeadingStyle> = {};
		if (options.font !== undefined) {
			const font = options.font.trim();
			patch.fontFamily = DEFAULT_WORDS.has(font.toLowerCase()) ? '' : font;
		}
		if (options.size !== undefined) patch.fontSize = parseSize(options.size);

		const next = withHeadingStyle(current, resolved, patch);
		writeSettingValue(HEADING_TYPOGRAPHY_KEY, next);

		if (options.json) {
			emitJsonl({
				type: 'display-heading-set',
				level: resolved,
				fontFamily: next[resolved]?.fontFamily ?? '',
				fontSize: next[resolved]?.fontSize ?? 0,
			});
			return;
		}
		const { font, size } = describe(next[resolved]);
		console.log(formatSuccess(`${resolved.toUpperCase()} set to ${font}, ${size}`));

		// Same caveat as `display font`: the CLI cannot see what is installed.
		const family = patch.fontFamily;
		if (family && !BUNDLED_FONTS.some((f) => f.name.toLowerCase() === family.toLowerCase())) {
			console.error(
				formatWarning(
					`"${family}" is not bundled with Maestro, so it renders only if installed. Run "maestro-cli display fonts" to list guaranteed fonts.`
				)
			);
		}
	} catch (error) {
		console.error(formatError(error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}
