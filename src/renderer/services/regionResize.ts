/**
 * regionResize - grow or shrink the focused region from the keyboard.
 *
 * The companion to `regionFocus`. A tiling-window-manager keymap pairs "focus
 * the pane in this direction" with "make the focused pane bigger", and Maestro
 * already lets the mouse do the second half: both bars carry a drag handle
 * wired through `useResizablePanel`. These actions are the keyboard path
 * to the same widths, which is why they write through the same setters the
 * handle commits to (`setLeftSidebarWidth` / `setRightPanelWidth` in
 * settingsStore) rather than clamping or persisting anything themselves. Those
 * setters already own the bounds (256-600 for the Left Bar,
 * `RIGHT_PANEL_MIN_WIDTH` / `RIGHT_PANEL_MAX_WIDTH` for the Right Bar) and
 * already write the value to settings, so a second clamp here would be a second
 * source of truth and the two would drift the first time a bound moved.
 *
 * Which region a press acts on follows focus, per `focusedRegion()`:
 *
 *   LEFT BAR focused  -> the Left Bar's width moves.
 *   RIGHT BAR focused -> the Right Bar's width moves.
 *   MAIN WINDOW focused -> the RIGHT BAR's width moves, INVERTED. See
 *     {@link resizeFocusedRegion} for why; it is the one decision in this file
 *     that is not mechanical.
 *
 * A region whose bar is not on screen is not resizable, and these actions do
 * NOT reveal it. That is the deliberate difference from `focusRegion`, which
 * does reveal: "focus the Right Bar" is a request to go there and so implies
 * showing it, while "grow the Right Bar" is a request about a width. Opening a
 * panel the user closed as a side effect of a resize key would be a surprise,
 * and silently storing a new width for a closed panel is worse - it would
 * resize itself behind their back the next time they opened it.
 */

import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { focusedRegion } from './regionFocus';

/**
 * How much one press moves a bar's edge, in CSS pixels.
 *
 * Sized against the ranges the setters clamp to: the Left Bar spans 344px
 * (256-600) and the Right Bar 440px (360-800), so a 32px step crosses either
 * range in roughly a dozen presses. Small enough that a single press is a
 * nudge rather than a jump, large enough to be unmistakable at a glance, and a
 * multiple of the 8px rhythm the rest of the chrome is laid out on.
 *
 * One constant for both bars on purpose. A press should feel the same wherever
 * focus is, and two step sizes would make the same key travel at two speeds.
 */
export const REGION_RESIZE_STEP_PX = 32;

/**
 * Move the focused region's edge by `delta` CSS pixels, positive to GROW the
 * focused region. Returns whether a width was actually written, which is
 * `false` only when the region has no resizable bar on screen.
 *
 * THE MAIN WINDOW CASE. The Main Window has no width of its own: it is the
 * flex child that takes whatever the two bars leave, so there is no setter to
 * point a resize at. The closest honest behavior is to move the Right Bar's
 * edge, the boundary it shares with the larger of its neighbors - and to move
 * it the other way, so that "grow" still grows the region that has focus. That
 * inversion is the whole point rather than a quirk: the action is named for the
 * FOCUSED region, so a press of Grow Region must make the thing you are looking
 * at bigger, which here means taking the space back from the Right Bar. The
 * alternative - widening the Right Bar while the Main Window is focused - makes
 * a key called "grow" shrink the region it is aimed at, and matches neither the
 * name nor the tiling-WM keymap these bindings come from, where grow always
 * grows the focused container at its neighbor's expense.
 *
 * It acts on the RIGHT Bar rather than the Left for two reasons: the Right Bar
 * is the wider of the two (360-800 against 256-600), so it has more slack to
 * give back, and the Left Bar is the one piece of chrome that is always present
 * and is where the user's agents live, so quietly narrowing it from a keystroke
 * aimed at the Main Window is the more disruptive of the two.
 */
export function resizeFocusedRegion(delta: number): boolean {
	const region = focusedRegion();
	const ui = useUIStore.getState();
	const settings = useSettingsStore.getState();

	if (region === 'leftBar') {
		// The Left Bar is a tri-state and only the open state uses the stored
		// width: hidden is `display: none` and collapsed renders a fixed 64px
		// status-dot strip, so a resize in either would write a number nothing
		// draws (see the width style in SessionList).
		if (ui.leftSidebarHidden || !ui.leftSidebarOpen) return false;
		settings.setLeftSidebarWidth(settings.leftSidebarWidth + delta);
		return true;
	}

	// A closed Right Bar renders at zero width and ignores the stored one.
	if (!ui.rightPanelOpen) return false;
	settings.setRightPanelWidth(
		settings.rightPanelWidth + (region === 'mainWindow' ? -delta : delta)
	);
	return true;
}

/** Make the focused region one step wider. Backs the `growRegion` action. */
export function growFocusedRegion(): boolean {
	return resizeFocusedRegion(REGION_RESIZE_STEP_PX);
}

/** Make the focused region one step narrower. Backs the `shrinkRegion` action. */
export function shrinkFocusedRegion(): boolean {
	return resizeFocusedRegion(-REGION_RESIZE_STEP_PX);
}
