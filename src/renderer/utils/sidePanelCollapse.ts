/**
 * Fold the Left Bar and the Right Bar out of the way for a surface that needs
 * the width, and give back only what this call took.
 *
 * `collapseSidePanels()` closes whichever bar is open and returns `restore`.
 * What `restore` reopens is decided by the user's own moves, not just by what
 * this call closed:
 *
 *  - A bar that was already shut when this ran is never opened.
 *  - A bar the user touches while it is folded is theirs again: opening it,
 *    opening and closing it, or cycling the Left Bar on to its hidden state all
 *    count, and `restore` leaves that bar exactly as the user left it.
 *  - On a narrow viewport both bars are drawers the app keeps shut on purpose
 *    (App.tsx closes them when the window narrows), so `restore` opens nothing:
 *    a window resized narrow while the bars were folded would otherwise get a
 *    drawer thrown over the page.
 *
 * The Left Bar has a third state (hidden, no panel at all), but a bar can only
 * be folded from its full state: a collapsed strip or a hidden bar is left
 * alone and stays that way.
 *
 * `restore` is safe to call twice; the second call does nothing.
 */

import { useUIStore } from '../stores/uiStore';
import { isNarrowViewportNow } from '../hooks/ui/useViewportBreakpoint';

const NOTHING_TO_RESTORE = (): void => {};

export function collapseSidePanels(): () => void {
	const ui = useUIStore.getState();
	// Bars this call closed and the user has not touched since.
	let left = ui.leftSidebarOpen;
	let right = ui.rightPanelOpen;
	if (!left && !right) return NOTHING_TO_RESTORE;

	if (left) ui.setLeftSidebarOpen(false);
	if (right) ui.setRightPanelOpen(false);

	// Compare values rather than counting events: a store write that changes
	// neither bar (or sets a bar to the value it already has, as the window
	// state hydration does) is not the user's doing.
	const unsubscribe = useUIStore.subscribe((state) => {
		if (state.leftSidebarOpen || state.leftSidebarHidden) left = false;
		if (state.rightPanelOpen) right = false;
	});

	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		unsubscribe();
		if (isNarrowViewportNow()) return;
		const { setLeftSidebarOpen, setRightPanelOpen } = useUIStore.getState();
		if (left) setLeftSidebarOpen(true);
		if (right) setRightPanelOpen(true);
	};
}
