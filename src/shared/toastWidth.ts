/**
 * Toast width presets - controls how wide toast notifications render.
 *
 * 'small' preserves Maestro's original fixed sizing (320-400px). 'medium' and
 * 'large' scale the min/max pair up for users who want roomier notifications.
 * 'dynamic' has no fixed pixels: it matches the current Right Bar width so the
 * toast fills the same column and tracks the panel as the user resizes it.
 * Kept in shared/ so both the renderer settings store and the Toast component
 * can import the type, validator, and pixel dimensions without duplication.
 */

export const TOAST_WIDTHS = ['small', 'medium', 'large', 'dynamic'] as const;

export type ToastWidth = (typeof TOAST_WIDTHS)[number];

/** Presets backed by fixed pixel dimensions. 'dynamic' is computed at runtime. */
export type StaticToastWidth = Exclude<ToastWidth, 'dynamic'>;

export const isToastWidth = (value: unknown): value is ToastWidth =>
	typeof value === 'string' && TOAST_WIDTHS.includes(value as ToastWidth);

/**
 * Display name for each preset. Single source of truth so the Settings toggle
 * group and the preview toast fired when the setting changes never drift apart.
 */
export const TOAST_WIDTH_LABELS: Record<ToastWidth, string> = {
	small: 'Small',
	medium: 'Medium',
	large: 'Large',
	dynamic: 'Dynamic',
};

/**
 * Min/max width in px for each fixed preset. 'small' matches the legacy
 * hardcoded values so existing behavior is unchanged when the setting defaults
 * to small. 'dynamic' is intentionally absent - it derives its width from the
 * live Right Bar width via {@link getToastWidthDimensions}.
 */
export const TOAST_WIDTH_DIMENSIONS: Record<
	StaticToastWidth,
	{ minWidth: number; maxWidth: number }
> = {
	small: { minWidth: 320, maxWidth: 400 },
	medium: { minWidth: 400, maxWidth: 560 },
	large: { minWidth: 480, maxWidth: 720 },
};

/**
 * Distance (px) the toast stack is inset from the window's right edge - it sits
 * at `right-4` (1rem). The Right Bar is flush to the window edge, so a 'dynamic'
 * toast needs this gutter mirrored on both sides: one to clear the window edge
 * on the right, one to leave a matching gap before the panel's left boundary.
 */
export const TOAST_VIEWPORT_GUTTER = 16;

/**
 * Resolve the min/max width for a toast. Fixed presets return their static
 * dimensions; 'dynamic' pins both bounds to the current Right Bar width less a
 * gutter on each side ({@link TOAST_VIEWPORT_GUTTER}) so the toast sits centered
 * in the column with even left/right padding instead of spilling past it. The
 * stored Right Bar width is its expanded size even while the panel is collapsed,
 * so the toast still matches what the column would be when opened, and it
 * re-resolves whenever the user drags the panel's resize handle.
 */
export const getToastWidthDimensions = (
	width: ToastWidth,
	rightPanelWidth: number
): { minWidth: number; maxWidth: number } => {
	if (width === 'dynamic') {
		const dynamicWidth = Math.max(0, rightPanelWidth - 2 * TOAST_VIEWPORT_GUTTER);
		return { minWidth: dynamicWidth, maxWidth: dynamicWidth };
	}
	return TOAST_WIDTH_DIMENSIONS[width];
};

/**
 * One-line description of what a preset means in pixels, phrased for the
 * preview toast fired when the user picks a new width. Fixed presets quote
 * their min/max pair; 'dynamic' quotes the live Right Bar width it tracks.
 */
export const describeToastWidth = (width: ToastWidth, rightPanelWidth: number): string => {
	const { minWidth, maxWidth } = getToastWidthDimensions(width, rightPanelWidth);
	if (width === 'dynamic') {
		return `Toasts now match the Right Bar width (${Math.round(minWidth)}px) and follow it as you resize the panel.`;
	}
	return `Toasts now render ${minWidth}-${maxWidth}px wide. This is what that looks like.`;
};
