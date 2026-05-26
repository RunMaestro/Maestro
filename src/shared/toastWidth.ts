/**
 * Toast width presets — controls how wide toast notifications render.
 *
 * 'small' preserves Maestro's original fixed sizing (320–400px). 'medium' and
 * 'large' scale the min/max pair up for users who want roomier notifications.
 * Kept in shared/ so both the renderer settings store and the Toast component
 * can import the type, validator, and pixel dimensions without duplication.
 */

export const TOAST_WIDTHS = ['small', 'medium', 'large'] as const;

export type ToastWidth = (typeof TOAST_WIDTHS)[number];

export const isToastWidth = (value: unknown): value is ToastWidth =>
	typeof value === 'string' && TOAST_WIDTHS.includes(value as ToastWidth);

/**
 * Min/max width in px for each preset. 'small' matches the legacy hardcoded
 * values so existing behavior is unchanged when the setting defaults to small.
 */
export const TOAST_WIDTH_DIMENSIONS: Record<ToastWidth, { minWidth: number; maxWidth: number }> = {
	small: { minWidth: 320, maxWidth: 400 },
	medium: { minWidth: 400, maxWidth: 560 },
	large: { minWidth: 480, maxWidth: 720 },
};
