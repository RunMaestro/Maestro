/**
 * Floating Media Player Geometry
 *
 * Pure sizing/positioning math for the now-playing widget, kept out of the
 * component so it can be tested without a DOM: the interesting cases are a
 * persisted rect from a larger monitor, a window that just shrank, and a resize
 * dragged below the minimum.
 */

import type { MediaKind } from '../../shared/mediaTypes';
import type { MediaFloatRect } from '../stores/mediaPlaybackStore';

/**
 * Default size when the user has never moved or resized the widget. Audio has no
 * picture, so it only needs room for the transport; video gets a 16:9-ish stage
 * above it.
 */
export const MEDIA_FLOAT_DEFAULT_SIZE: Record<MediaKind, { width: number; height: number }> = {
	audio: { width: 380, height: 132 },
	video: { width: 480, height: 336 },
};

/** Gap from the viewport edge for the initial bottom-right placement. */
export const MEDIA_FLOAT_EDGE_MARGIN = 24;
/** Below this the transport controls start clipping. */
export const MEDIA_FLOAT_MIN_WIDTH = 300;
export const MEDIA_FLOAT_MIN_HEIGHT = 108;

export interface Viewport {
	width: number;
	height: number;
}

/**
 * Keep a rect on screen and above the minimum size.
 *
 * Size is clamped before position so the position clamp works against the size
 * that will actually be used. A viewport smaller than the minimum wins, because
 * an off-screen widget is worse than a cramped one.
 */
export function clampMediaFloatRect(rect: MediaFloatRect, viewport: Viewport): MediaFloatRect {
	const width = Math.min(Math.max(rect.width, MEDIA_FLOAT_MIN_WIDTH), viewport.width);
	const height = Math.min(Math.max(rect.height, MEDIA_FLOAT_MIN_HEIGHT), viewport.height);
	return {
		width,
		height,
		left: Math.min(Math.max(rect.left, 0), Math.max(0, viewport.width - width)),
		top: Math.min(Math.max(rect.top, 0), Math.max(0, viewport.height - height)),
	};
}

/** Opening placement: bottom-right, inset by the edge margin. */
export function initialMediaFloatRect(kind: MediaKind, viewport: Viewport): MediaFloatRect {
	const size = MEDIA_FLOAT_DEFAULT_SIZE[kind];
	return clampMediaFloatRect(
		{
			width: size.width,
			height: size.height,
			left: viewport.width - size.width - MEDIA_FLOAT_EDGE_MARGIN,
			top: viewport.height - size.height - MEDIA_FLOAT_EDGE_MARGIN,
		},
		viewport
	);
}
