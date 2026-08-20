/**
 * Launch another modal from inside the Settings modal.
 *
 * Settings sits near the top of the stacking order (`z-[9999]`), so a modal
 * opened from a control inside it (Extensions -> "Open Pianola", a plugin's
 * contributed panel) renders BEHIND the settings surface and looks like the
 * click did nothing. Every settings-hosted launcher therefore has to dismiss
 * Settings first.
 *
 * Route those launchers through this helper rather than repeating
 * `closeSettings()` at each call site: the ordering (close, then open) is the
 * part that is easy to get wrong, and a new extension launcher should inherit
 * it for free.
 *
 * Only for launchers that open a SEPARATE top-level modal. Inline settings
 * controls, confirmations, and pickers that are meant to stack on top of
 * Settings must not use it.
 */

import { getModalActions } from '../stores/modalStore';

export function launchFromSettings(open: () => void): void {
	getModalActions().closeSettings();
	open();
}
