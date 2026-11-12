/**
 * Shared annotator constants.
 *
 * ANNOTATOR_PALETTE is the preset color set offered in both the toolbar's
 * current-color popover and the settings drawer's swatch grid. Keep it here so
 * the two surfaces stay in lock-step instead of drifting apart. The size bounds
 * below are shared for the same reason.
 */
export const ANNOTATOR_PALETTE: readonly string[] = [
	'#ec4899',
	'#ef4444',
	'#f59e0b',
	'#10b981',
	'#3b82f6',
	'#a855f7',
	'#000000',
	'#ffffff',
];

/**
 * Palette index for a bare digit key: `1` picks the first swatch, `8` the last.
 * Null for anything else, including digits past the palette and `0`, which the
 * canvas already owns for resetting zoom.
 */
export function paletteHotkeyIndex(key: string): number | null {
	if (key.length !== 1 || key < '1' || key > '9') return null;
	const index = Number(key) - 1;
	return index < ANNOTATOR_PALETTE.length ? index : null;
}

/**
 * Pen / shape stroke size bounds. Shared by the drawer's Size slider and the
 * `+` / `-` hotkeys so the two can never disagree on the clamp.
 */
export const PEN_SIZE_MIN = 1;
export const PEN_SIZE_MAX = 64;
export const PEN_SIZE_STEP = 1;

/**
 * Text size bounds. The step is larger than the pen's because the range is
 * roughly twice as wide - one keypress should feel like a visible change.
 */
export const TEXT_SIZE_MIN = 10;
export const TEXT_SIZE_MAX = 120;
export const TEXT_SIZE_STEP = 2;
