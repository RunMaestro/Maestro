// Custom theme commands - manage the user-configurable "Custom" theme palette
// from the CLI. This mirrors the in-app Custom Theme Builder (ThemeTab /
// CustomThemeBuilder): the palette lives in the `customThemeColors` setting,
// the originating built-in in `customThemeBaseId`, and the theme is activated
// by setting `activeThemeId` to 'custom'.
//
// Reads come from the on-disk settings store (work even when the app is
// closed). Writes go through the running app's `set_setting` WS bridge so the
// change applies live and persists - matching how `set-theme` already works.
// The export JSON format is byte-compatible with the in-app export
// ({ name, baseTheme, colors, exportedAt }) so files round-trip between the UI
// and the CLI.

import { writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { THEMES } from '../../shared/themes';
import { isValidThemeId, type ThemeColors, type ThemeId } from '../../shared/theme-types';
import { isValidCssColor } from '../../shared/cssColor';
import { readSettingValue } from '../services/storage';
import { sendSimpleCommand, failCommand } from '../services/session-command';
import { formatSuccess } from '../output/formatter';

// Required ThemeColors keys - every non-optional field on the palette. Mirrors
// the in-app importer: `bgTitleBar`, the `ansi*` entries, and `selection` are
// optional (the UI falls back to `bgMain` / terminal defaults), so they are not
// required here. Keep in sync with ThemeColors in src/shared/theme-types.ts.
const REQUIRED_COLOR_KEYS: (keyof ThemeColors)[] = [
	'bgMain',
	'bgSidebar',
	'bgActivity',
	'border',
	'textMain',
	'textDim',
	'accent',
	'accentDim',
	'accentText',
	'accentForeground',
	'success',
	'warning',
	'error',
];

// All color keys a caller may set (required + the optional ones the palette
// understands). Used to validate `theme set key=value` inputs.
const SETTABLE_COLOR_KEYS = new Set<string>([
	...REQUIRED_COLOR_KEYS,
	'bgTitleBar',
	'ansiBlack',
	'ansiRed',
	'ansiGreen',
	'ansiYellow',
	'ansiBlue',
	'ansiMagenta',
	'ansiCyan',
	'ansiWhite',
	'ansiBrightBlack',
	'ansiBrightRed',
	'ansiBrightGreen',
	'ansiBrightYellow',
	'ansiBrightBlue',
	'ansiBrightMagenta',
	'ansiBrightCyan',
	'ansiBrightWhite',
	'selection',
]);

const DEFAULT_BASE_ID: ThemeId = 'dracula';

interface ShowOptions {
	json?: boolean;
}
interface ExportOptions {
	file?: string;
	json?: boolean;
}
interface ImportOptions {
	noActivate?: boolean;
	json?: boolean;
}
interface SetOptions {
	base?: string;
	activate?: boolean;
	json?: boolean;
}

/** Read the current custom palette + base from the on-disk settings store. */
function readCurrentCustomTheme(): { colors: ThemeColors; baseTheme: ThemeId } {
	const stored = readSettingValue('customThemeColors');
	const colors =
		stored && typeof stored === 'object'
			? (stored as ThemeColors)
			: ({ ...THEMES.dracula.colors } as ThemeColors);

	const storedBase = readSettingValue('customThemeBaseId');
	const baseTheme =
		typeof storedBase === 'string' && isValidThemeId(storedBase)
			? (storedBase as ThemeId)
			: DEFAULT_BASE_ID;

	return { colors, baseTheme };
}

/** Validate a palette object the way the in-app importer does. Returns an error string, or null when valid. */
function validatePalette(colors: unknown): string | null {
	if (!colors || typeof colors !== 'object') {
		return 'Invalid theme: missing "colors" object';
	}
	const obj = colors as Record<string, unknown>;

	const missing = REQUIRED_COLOR_KEYS.filter((key) => !(key in obj));
	if (missing.length > 0) {
		return `Invalid theme: missing color keys (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '...' : ''})`;
	}

	// Validate every present key (including the optional ones when supplied).
	const invalid = Object.keys(obj).filter(
		(key) => SETTABLE_COLOR_KEYS.has(key) && !isValidCssColor(obj[key])
	);
	if (invalid.length > 0) {
		return `Invalid theme: invalid color values for ${invalid.slice(0, 4).join(', ')}${invalid.length > 4 ? '...' : ''}`;
	}
	return null;
}

/** Push a palette + base to the running app via the live `set_setting` bridge. Optionally activate it. */
async function applyCustomTheme(
	colors: ThemeColors,
	baseTheme: ThemeId,
	activate: boolean
): Promise<void> {
	const colorsResult = await sendSimpleCommand(
		{ type: 'set_setting', key: 'customThemeColors', value: colors },
		'set_setting_result'
	);
	if (!colorsResult.success) {
		throw new Error(colorsResult.error || 'Failed to write customThemeColors');
	}

	const baseResult = await sendSimpleCommand(
		{ type: 'set_setting', key: 'customThemeBaseId', value: baseTheme },
		'set_setting_result'
	);
	if (!baseResult.success) {
		throw new Error(baseResult.error || 'Failed to write customThemeBaseId');
	}

	if (activate) {
		const activeResult = await sendSimpleCommand(
			{ type: 'set_setting', key: 'activeThemeId', value: 'custom' },
			'set_setting_result'
		);
		if (!activeResult.success) {
			throw new Error(activeResult.error || 'Failed to activate custom theme');
		}
	}
}

/** Build the portable export object (byte-compatible with the in-app export). */
function buildExportObject(colors: ThemeColors, baseTheme: ThemeId): Record<string, unknown> {
	return {
		name: 'Custom Theme',
		baseTheme,
		colors,
		// Note: no `exportedAt` - the CLI sandbox forbids Date.now()/new Date().
		// The field is optional and unused on import, so omitting it keeps the
		// file valid while staying deterministic.
	};
}

/** `theme show` - print the current custom palette + base (reads from disk, works offline). */
export function themeShow(options: ShowOptions): void {
	const { colors, baseTheme } = readCurrentCustomTheme();
	if (options.json) {
		console.log(JSON.stringify({ success: true, baseTheme, colors }));
		return;
	}
	console.log(`Custom theme (base: ${baseTheme})`);
	for (const key of Object.keys(colors) as (keyof ThemeColors)[]) {
		const value = colors[key];
		if (value === undefined) continue;
		console.log(`  ${key}${' '.repeat(Math.max(1, 20 - key.length))}${value}`);
	}
	console.log('\nActivate with: maestro-cli set-theme custom');
}

/** `theme export` - dump the custom theme as portable JSON (stdout or --file). */
export function themeExport(options: ExportOptions): void {
	const { colors, baseTheme } = readCurrentCustomTheme();
	const exportObj = buildExportObject(colors, baseTheme);
	const serialized = JSON.stringify(exportObj, null, 2);

	if (options.file) {
		const target = resolve(options.file);
		try {
			writeFileSync(target, serialized + '\n', 'utf8');
		} catch (error) {
			failCommand(
				`Failed to write ${target}: ${error instanceof Error ? error.message : String(error)}`,
				options.json
			);
		}
		if (options.json) {
			console.log(JSON.stringify({ success: true, file: target, baseTheme }));
		} else {
			console.log(formatSuccess(`Exported custom theme to ${target}`));
		}
		return;
	}

	// No --file: emit the JSON to stdout (pipe-friendly).
	console.log(serialized);
}

/** `theme import <file>` - load + validate a theme JSON file, apply live, and activate (unless --no-activate). */
export async function themeImport(file: string, options: ImportOptions): Promise<void> {
	const target = resolve(file);
	let raw: string;
	try {
		raw = readFileSync(target, 'utf8');
	} catch (error) {
		return failCommand(
			`Failed to read ${target}: ${error instanceof Error ? error.message : String(error)}`,
			options.json
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return failCommand(`Failed to parse ${target}: invalid JSON`, options.json);
	}

	const data = parsed as { colors?: unknown; baseTheme?: unknown };
	const validationError = validatePalette(data.colors);
	if (validationError) {
		return failCommand(validationError, options.json);
	}

	const colors = data.colors as ThemeColors;
	const baseTheme =
		typeof data.baseTheme === 'string' && isValidThemeId(data.baseTheme)
			? (data.baseTheme as ThemeId)
			: DEFAULT_BASE_ID;
	const activate = !options.noActivate;

	try {
		await applyCustomTheme(colors, baseTheme, activate);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), options.json);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, baseTheme, activated: activate }));
	} else {
		console.log(formatSuccess(`Imported custom theme from ${target} (base: ${baseTheme})`));
		console.log(
			activate ? '  Activated the Custom theme.' : '  Saved (not activated; --no-activate set).'
		);
	}
}

/** `theme set key=value...` - tweak individual color keys, optionally re-basing from a built-in first. */
export async function themeSet(assignments: string[], options: SetOptions): Promise<void> {
	// Start from the chosen base palette, or the current custom palette when no
	// --base is given. --base mirrors the builder's "Initialize from base".
	let colors: ThemeColors;
	let baseTheme: ThemeId;

	if (options.base !== undefined) {
		if (!isValidThemeId(options.base) || options.base === 'custom' || !THEMES[options.base]) {
			return failCommand(
				`Unknown base theme "${options.base}". Run "maestro-cli set-theme --list" to see the options.`,
				options.json
			);
		}
		baseTheme = options.base as ThemeId;
		colors = { ...THEMES[baseTheme].colors };
	} else {
		const current = readCurrentCustomTheme();
		colors = { ...current.colors };
		baseTheme = current.baseTheme;
	}

	if (assignments.length === 0 && options.base === undefined) {
		return failCommand(
			'Nothing to set. Provide key=value pairs (e.g. accent=#ff0000) and/or --base <id>.',
			options.json
		);
	}

	for (const assignment of assignments) {
		const eq = assignment.indexOf('=');
		if (eq <= 0) {
			return failCommand(
				`Invalid assignment "${assignment}". Use key=value (e.g. accent=#bd93f9).`,
				options.json
			);
		}
		const key = assignment.slice(0, eq).trim();
		const value = assignment.slice(eq + 1).trim();
		if (!SETTABLE_COLOR_KEYS.has(key)) {
			return failCommand(
				`Unknown color key "${key}". Valid keys: ${[...SETTABLE_COLOR_KEYS].join(', ')}`,
				options.json
			);
		}
		if (!isValidCssColor(value)) {
			return failCommand(`Invalid color value for "${key}": ${value}`, options.json);
		}
		(colors as unknown as Record<string, string>)[key] = value;
	}

	const activate = options.activate === true;
	try {
		await applyCustomTheme(colors, baseTheme, activate);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), options.json);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, baseTheme, activated: activate }));
	} else {
		const changed = assignments.length;
		const basePart = options.base !== undefined ? `re-based on ${baseTheme}` : '';
		const setPart = changed > 0 ? `${changed} color${changed === 1 ? '' : 's'} set` : '';
		const summary = [basePart, setPart].filter(Boolean).join(', ') || 'updated';
		console.log(formatSuccess(`Custom theme ${summary}.`));
		if (!activate) {
			console.log('  Activate with: maestro-cli set-theme custom (or pass --activate).');
		}
	}
}
