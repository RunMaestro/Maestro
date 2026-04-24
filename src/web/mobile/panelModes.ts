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

export function getPanelMode(
	tier: BreakpointTier,
	isLeftOpen: boolean,
	isRightOpen: boolean,
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
