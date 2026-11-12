/**
 * Flip in-app floating toasts on or off from a command (palette entry or the
 * user-bound `toggleInAppToasts` shortcut).
 *
 * The acknowledgement is a center flash, never a toast: a toast confirming
 * that toasts are now off would be suppressed by the very setting it reports.
 * The bell popover calls `setToastsEnabled` directly, since its own switch is
 * already the visible state.
 */

import { areToastsEnabled } from '../../shared/toastDuration';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { useSettingsStore } from '../stores/settingsStore';

/** Toggle in-app toasts and flash the new state. Returns whether they are now on. */
export function toggleInAppToasts(): boolean {
	const { toastDuration, setToastsEnabled } = useSettingsStore.getState();
	const enabled = !areToastsEnabled(toastDuration);
	setToastsEnabled(enabled);
	notifyCenterFlash({
		message: enabled ? 'In-App Toasts: ON' : 'In-App Toasts: OFF',
		detail: enabled ? undefined : 'Notifications still collect in the notification center',
		color: enabled ? 'green' : 'theme',
	});
	return enabled;
}
