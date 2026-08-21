/**
 * Floating Media Player Geometry
 *
 * Pure sizing/positioning math for the now-playing widget, kept out of the
 * component so it can be tested without a DOM: the interesting cases are a
 * persisted position from a larger monitor, a window that just shrank, and a
 * queue that alternates between audio and video.
 *
 * **Height is derived, never stored.** The frame is chrome (title bar +
 * transport) plus a stage, and the stage's size is dictated by the media: audio
 * has no picture at all, so the frame collapses to the chrome, while video wants
 * exactly its own aspect ratio or it plays inside black bars. That makes width
 * the only size the user meaningfully chooses, so width is what gets remembered
 * - per kind, because a good size for a podcast bar is a bad size for a movie.
 *
 * The aspect ratio comes from the file itself (`videoWidth / videoHeight`), so a
 * 4:3 screen recording and a vertical phone clip each get a frame that fits
 * them, rather than everything being forced into 16:9.
 */

import type { MediaKind } from '../../shared/mediaTypes';

/** Position and size of the floating player. Height is always derived. */
export interface MediaFloatRect {
	top: number;
	left: number;
	width: number;
	height: number;
}

/** What persists across restarts: where it sits, and how wide per kind. */
export interface PersistedMediaFloat {
	top: number;
	left: number;
	/** Last width the user chose, per media kind. */
	widths: Partial<Record<MediaKind, number>>;
}

/** Height of the player's title bar. Matches its `h-10`. */
export const MEDIA_FLOAT_TITLE_BAR_HEIGHT = 40;

/**
 * Transport height used until the real one is measured.
 *
 * The transport's height depends on font metrics, so it differs between
 * platforms and themes - the component measures it and passes the real number
 * in. This is only the first-paint estimate (and what tests run against, since
 * jsdom has no layout).
 */
export const MEDIA_FLOAT_TRANSPORT_FALLBACK_HEIGHT = 92;

/**
 * Assumed shape of a video until its metadata loads. Most video is 16:9, so
 * this is the guess that resizes the fewest frames on open.
 */
export const DEFAULT_MEDIA_ASPECT = 16 / 9;

/**
 * Opening width per kind. Audio is a control strip and wants to be
 * unobtrusive; video is something you actually look at, so it opens wide enough
 * to watch (560 x 315 of picture at 16:9) while still leaving the workspace
 * usable behind it.
 */
export const MEDIA_FLOAT_DEFAULT_WIDTH: Record<MediaKind, number> = {
	audio: 380,
	video: 560,
};

/** Gap from the viewport edge for the initial bottom-right placement. */
export const MEDIA_FLOAT_EDGE_MARGIN = 24;
/** Below this the transport controls start clipping. */
export const MEDIA_FLOAT_MIN_WIDTH = 300;

export interface Viewport {
	width: number;
	height: number;
}

/** Everything that decides how tall the frame has to be. */
export interface MediaFloatFit {
	kind: MediaKind;
	/** Picture aspect ratio (width / height). Ignored for audio. */
	aspect: number;
	/** Measured title bar + transport, or the fallback estimate. */
	chromeHeight: number;
}

/** Title bar plus transport, with the fallback for before it is measured. */
export function mediaFloatChromeHeight(transportHeight?: number | null): number {
	const transport =
		typeof transportHeight === 'number' && transportHeight > 0
			? transportHeight
			: MEDIA_FLOAT_TRANSPORT_FALLBACK_HEIGHT;
	return MEDIA_FLOAT_TITLE_BAR_HEIGHT + Math.round(transport);
}

/** A usable aspect ratio, or the 16:9 default for anything nonsensical. */
export function normalizeMediaAspect(aspect: unknown): number {
	const value = typeof aspect === 'number' ? aspect : Number(aspect);
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_MEDIA_ASPECT;
	// A frame more extreme than these is almost certainly bad metadata, and it
	// would produce a widget shaped like a ruler.
	return Math.min(4, Math.max(0.25, value));
}

/**
 * Frame height for a given width.
 *
 * Audio collapses to the chrome: its stage has nothing in it, so any extra
 * height would be dead space under the controls.
 */
export function mediaFloatHeight(fit: MediaFloatFit, width: number): number {
	if (fit.kind !== 'video') return fit.chromeHeight;
	return fit.chromeHeight + Math.round(width / normalizeMediaAspect(fit.aspect));
}

/**
 * Fit the frame to the media at a desired width, then pull it on screen.
 *
 * A video too tall for the viewport loses width rather than running off the
 * bottom - the picture stays whole, just smaller.
 */
export function fitMediaFloatRect(
	desired: { top: number; left: number; width: number },
	fit: MediaFloatFit,
	viewport: Viewport
): MediaFloatRect {
	const maxWidth = Math.max(1, viewport.width);
	let width = Math.min(Math.max(desired.width, MEDIA_FLOAT_MIN_WIDTH), maxWidth);
	let height = mediaFloatHeight(fit, width);

	if (height > viewport.height && fit.kind === 'video') {
		const stage = Math.max(0, viewport.height - fit.chromeHeight);
		width = Math.min(
			width,
			Math.max(MEDIA_FLOAT_MIN_WIDTH, stage * normalizeMediaAspect(fit.aspect))
		);
		width = Math.min(width, maxWidth);
		height = mediaFloatHeight(fit, width);
	}
	// A viewport shorter than the chrome itself wins: a cramped widget beats one
	// hanging off the screen.
	height = Math.min(height, Math.max(1, viewport.height));

	return {
		width: Math.round(width),
		height: Math.round(height),
		left: Math.min(Math.max(desired.left, 0), Math.max(0, viewport.width - width)),
		top: Math.min(Math.max(desired.top, 0), Math.max(0, viewport.height - height)),
	};
}

/** Opening placement: bottom-right, inset by the edge margin. */
export function initialMediaFloatRect(fit: MediaFloatFit, viewport: Viewport): MediaFloatRect {
	const width = MEDIA_FLOAT_DEFAULT_WIDTH[fit.kind];
	const height = mediaFloatHeight(fit, width);
	return fitMediaFloatRect(
		{
			width,
			left: viewport.width - width - MEDIA_FLOAT_EDGE_MARGIN,
			top: viewport.height - height - MEDIA_FLOAT_EDGE_MARGIN,
		},
		fit,
		viewport
	);
}

/**
 * Width to open a kind at: what the user last chose for it, else its default.
 *
 * Per kind rather than one shared width because the two are different objects.
 * Carrying a movie's 900px across to an MP3 would make a control strip half the
 * screen wide, and carrying a podcast's 380px to a movie would show it in a
 * thumbnail.
 */
export function mediaFloatWidthFor(
	kind: MediaKind,
	widths: Partial<Record<MediaKind, number>>
): number {
	const stored = widths[kind];
	return typeof stored === 'number' && stored > 0 ? stored : MEDIA_FLOAT_DEFAULT_WIDTH[kind];
}

/**
 * Corner-drag resize with the aspect locked.
 *
 * The grip is a corner, so dragging it down should make a video bigger even
 * though height is not a free dimension - whichever axis the user moved further
 * wins, and width follows from it. For audio there is no picture to grow, so
 * only the horizontal drag means anything.
 */
export function mediaFloatResizeWidth(
	origin: { width: number; height: number },
	delta: { dx: number; dy: number },
	fit: MediaFloatFit
): number {
	if (fit.kind !== 'video') return origin.width + delta.dx;
	const fromX = origin.width + delta.dx;
	const fromY = (origin.height + delta.dy - fit.chromeHeight) * normalizeMediaAspect(fit.aspect);
	return Math.abs(fromX - origin.width) >= Math.abs(fromY - origin.width) ? fromX : fromY;
}

/**
 * Coerce the persisted float geometry, tolerating the older shape.
 *
 * Geometry used to be stored as a full rect. Those values carry a height that no
 * longer means anything (it is derived now) and a width whose kind was never
 * recorded, so the position is kept and the width is dropped rather than
 * guessed onto the wrong kind.
 */
export function sanitizeMediaFloat(value: unknown): PersistedMediaFloat | null {
	if (typeof value !== 'object' || value === null) return null;
	const { top, left, widths } = value as Record<string, unknown>;
	if (!Number.isFinite(top) || !Number.isFinite(left)) return null;

	const cleaned: Partial<Record<MediaKind, number>> = {};
	if (typeof widths === 'object' && widths !== null) {
		for (const kind of ['audio', 'video'] as const) {
			const width = (widths as Record<string, unknown>)[kind];
			if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
				cleaned[kind] = width;
			}
		}
	}
	return { top: top as number, left: left as number, widths: cleaned };
}
