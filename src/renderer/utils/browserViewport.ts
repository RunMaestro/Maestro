/**
 * Where a browser tab puts a page shown at a fixed viewport preset.
 *
 * The page is laid out at the preset's CSS width, so its media queries see that
 * width, and is then scaled down with a CSS transform when the tab is narrower.
 * The scaled page is centered, with the tab's own background on both sides. The
 * page keeps the tab's full height: its viewport is that height divided by the
 * scale, so the scaled page ends exactly at the tab's bottom edge.
 *
 * Pure geometry; `BrowserTabView` applies it.
 */

import { browserViewportWidth, type BrowserViewportPreset } from '../../shared/browserViewport';

export interface BrowserViewportBox {
	/** The viewport the page sees, in CSS px (what its media queries read). */
	width: number;
	height: number;
	/** How far the page is scaled down to fit the tab: 1 when the tab is wide enough. */
	scale: number;
	/** The box the scaled page fills inside the tab: its left edge and its width, in the tab's px. */
	frame: { left: number; width: number };
}

/**
 * The box for a preset in a tab of `host` px, or null when the page simply fills
 * the tab: the `fit` preset, or a tab that has not been measured yet.
 */
export function computeBrowserViewportBox(
	preset: BrowserViewportPreset,
	host: { width: number; height: number }
): BrowserViewportBox | null {
	const width = browserViewportWidth(preset);
	if (width === null || !(host.width > 0) || !(host.height > 0)) return null;
	if (host.width >= width) {
		// Room to spare: the page keeps its size and sits in the middle. Whole
		// pixels, or the page lands on a half pixel and is resampled blurry.
		return {
			width,
			height: host.height,
			scale: 1,
			frame: { left: Math.floor((host.width - width) / 2), width },
		};
	}
	return {
		width,
		// Rounded up from the ratio itself (not from the scale, whose rounding error
		// can add a whole pixel), so the scaled page always reaches the bottom edge.
		height: Math.ceil((host.height * width) / host.width),
		scale: host.width / width,
		frame: { left: 0, width: host.width },
	};
}
