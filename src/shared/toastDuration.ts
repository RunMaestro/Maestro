/**
 * Toast duration semantics - one number decides both whether in-app toasts
 * appear at all and how long they stay.
 *
 * `-1` means toasts are off (every notification still lands in the
 * notification center), `0` means they stay until dismissed, and any positive
 * value is seconds on screen. Kept in shared/ so the notification store, the
 * Settings panel, the bell popover, and the command palette all read the same
 * sentinel instead of each hard-coding `-1`.
 */

/** Sentinel `toastDuration` value that hides in-app floating toasts. */
export const TOAST_DURATION_OFF = -1;

/** Factory default `toastDuration`, in seconds. */
export const DEFAULT_TOAST_DURATION = 20;

/** Whether a `toastDuration` value lets in-app toasts render. */
export const areToastsEnabled = (duration: number): boolean => duration !== TOAST_DURATION_OFF;

/**
 * The duration to restore when toasts are switched back on. The duration the
 * user had before switching them off wins, so a toggle never silently resets a
 * hand-picked 5s or "Never" to the factory default. Anything unusable (missing,
 * or itself the off sentinel) falls back to the default.
 */
export function resolveEnabledToastDuration(previous: unknown): number {
	return typeof previous === 'number' && Number.isFinite(previous) && previous >= 0
		? previous
		: DEFAULT_TOAST_DURATION;
}
