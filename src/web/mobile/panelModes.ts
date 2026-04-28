/**
 * Panel mode resolution for the mobile web layout.
 *
 * Maps the current viewport tier plus the open/closed state of the left and
 * right panels into a rendering mode for each: `inline` (rendered as a
 * resizable column inside the flex row) or `overlay` (rendered as a fixed
 * swipe-to-close sheet on top of the main area).
 *
 * Tier rules:
 *  - `phone`:   both panels overlay.
 *  - `tablet`:  exactly one inline, the other overlay. When both panels are
 *               open, the left panel wins the inline slot and the right panel
 *               becomes an overlay.
 *  - `desktop`: both panels inline.
 */

import type { BreakpointTier } from './constants';

export type PanelMode = 'overlay' | 'inline';

export interface PanelModes {
	leftMode: PanelMode;
	rightMode: PanelMode;
}

/**
 * Which panel the user most recently opened. Consumed by
 * `applyMainMinWidthGuard()` to decide which inline panel to demote when the
 * main content area would be squeezed below `MAIN_MIN_WIDTH`.
 */
export type MostRecentlyOpenedPanel = 'left' | 'right' | null;

/**
 * Floor for the main content column's inline width. When the combined inline
 * panel widths would push `main` below this value, `applyMainMinWidthGuard`
 * demotes inline panels to overlay until the guarantee holds.
 */
export const MAIN_MIN_WIDTH = 420;

export function getPanelMode(
	tier: BreakpointTier,
	isLeftOpen: boolean,
	isRightOpen: boolean
): PanelModes {
	if (tier === 'phone') {
		return { leftMode: 'overlay', rightMode: 'overlay' };
	}

	if (tier === 'desktop') {
		return { leftMode: 'inline', rightMode: 'inline' };
	}

	// tablet: exactly one inline, the other overlay.
	if (isLeftOpen && isRightOpen) {
		return { leftMode: 'inline', rightMode: 'overlay' };
	}

	if (isRightOpen && !isLeftOpen) {
		return { leftMode: 'overlay', rightMode: 'inline' };
	}

	// Only left open, or neither open — left wins the inline slot by default.
	return { leftMode: 'inline', rightMode: 'overlay' };
}

export interface MainMinWidthGuardOptions {
	/** Current viewport width in CSS pixels. */
	viewportWidth: number;
	/** Nominal inline width of the left panel. */
	leftInlineWidth: number;
	/** Nominal inline width of the right panel. */
	rightInlineWidth: number;
	/** Whichever panel the user opened most recently (demoted first). */
	mostRecentlyOpened: MostRecentlyOpenedPanel;
	/** Optional override of the 420px floor, primarily for tests. */
	minMainWidth?: number;
}

/**
 * Force inline panels to overlay when leaving them inline would squeeze the
 * `main` column below `minMainWidth` (default `MAIN_MIN_WIDTH`).
 *
 * Demotion order when both panels are inline and main is squeezed:
 *  1. The most-recently-opened panel (user's freshest action) is demoted first.
 *  2. If no recency signal is available, the right panel is demoted first —
 *     matches the tablet-tier default that favors keeping the left panel inline.
 *  3. If demoting one panel isn't enough to clear the floor, the remaining
 *     inline panel is demoted too.
 *
 * Never promotes overlay → inline; the helper is a floor, not a layout solver.
 */
export function applyMainMinWidthGuard(
	modes: PanelModes,
	options: MainMinWidthGuardOptions
): PanelModes {
	const {
		viewportWidth,
		leftInlineWidth,
		rightInlineWidth,
		mostRecentlyOpened,
		minMainWidth = MAIN_MIN_WIDTH,
	} = options;

	const computeMainWidth = (current: PanelModes): number => {
		const leftCost = current.leftMode === 'inline' ? leftInlineWidth : 0;
		const rightCost = current.rightMode === 'inline' ? rightInlineWidth : 0;
		return viewportWidth - leftCost - rightCost;
	};

	let next: PanelModes = modes;

	if (computeMainWidth(next) >= minMainWidth) {
		return next;
	}

	// Pick which side to demote first. Prefer the MRO if it's currently inline;
	// otherwise fall back to the right panel (keeps left inline by default,
	// matching the tablet tiebreaker in `getPanelMode`).
	const firstDemotion: 'left' | 'right' | null = (() => {
		if (mostRecentlyOpened === 'left' && next.leftMode === 'inline') return 'left';
		if (mostRecentlyOpened === 'right' && next.rightMode === 'inline') return 'right';
		if (next.rightMode === 'inline') return 'right';
		if (next.leftMode === 'inline') return 'left';
		return null;
	})();

	if (firstDemotion === 'left') {
		next = { ...next, leftMode: 'overlay' };
	} else if (firstDemotion === 'right') {
		next = { ...next, rightMode: 'overlay' };
	}

	if (computeMainWidth(next) >= minMainWidth) {
		return next;
	}

	// Still squeezed — demote the other inline panel too.
	if (next.leftMode === 'inline') {
		next = { ...next, leftMode: 'overlay' };
	}
	if (next.rightMode === 'inline') {
		next = { ...next, rightMode: 'overlay' };
	}

	return next;
}
