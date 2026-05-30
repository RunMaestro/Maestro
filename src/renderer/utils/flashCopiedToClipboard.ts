/**
 * Convenience helper for the canonical "Copied to Clipboard" center flash.
 *
 * Use this instead of `notifyCenterFlash` directly for clipboard copy
 * acknowledgements so the wording, color, and duration stay consistent
 * across the app.
 *
 * Defaults to `color: 'theme'` so the flash matches the active theme.
 */

import { notifyCenterFlash } from '../stores/centerFlashStore';

/**
 * Show the standard "Copied to Clipboard" center flash.
 *
 * @param detail Optional preview of the copied value, shown beneath the title.
 *               Truncated visually; full value available on hover.
 * @param message Override the title text (defaults to "Copied to Clipboard").
 */
export function flashCopiedToClipboard(detail?: string, message = 'Copied to Clipboard'): void {
	notifyCenterFlash({
		message,
		detail,
		color: 'theme',
	});
}
