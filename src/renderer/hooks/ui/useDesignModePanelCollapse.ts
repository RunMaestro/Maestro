/**
 * Give Design Mode the width it needs.
 *
 * With the Left Bar and Right Bar both open the browser tab can be narrow
 * enough that the page lays itself out at its mobile breakpoint, which is not
 * the page the user came to design. While Design Mode is up in a tab the user
 * is looking at, this folds both bars away; when it goes down (turned off, the
 * tab switched away or closed) it brings back only the bars it closed, and only
 * the ones the user did not open or close themselves meanwhile. The rules live
 * in `collapseSidePanels()`.
 *
 * `shown` is "Design Mode is on in a tab the user can see", which is not the
 * same as the overlay being armed: a dialog opened over the tab (the command
 * palette, Settings) un-arms the overlay but must not make the page reflow
 * behind it and again when it closes.
 *
 * The `designModeCollapsePanels` setting (on by default) turns all of this off.
 * Flipping it while Design Mode is up takes effect at once.
 */

import { useEffect } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { collapseSidePanels } from '../../utils/sidePanelCollapse';

export function useDesignModePanelCollapse(shown: boolean): void {
	const collapsePanels = useSettingsStore((s) => s.designModeCollapsePanels);
	const collapsed = shown && collapsePanels;

	useEffect(() => {
		if (!collapsed) return;
		return collapseSidePanels();
	}, [collapsed]);
}
