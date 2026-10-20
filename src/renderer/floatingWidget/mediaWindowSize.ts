/**
 * Media Window Size
 *
 * Pure sizing math for the media player's desktop window
 * (`MediaPlayerWidget`). The window opens shaped for what it plays: audio is a
 * transport strip, video is a picture at the file's own aspect ratio with the
 * transport under it. The user resizes from there, and the OS-level window
 * remembers it.
 *
 * The rule that keeps those two from fighting: the widget re-sizes the window
 * only while the window still has the size the widget last gave it. Once the
 * user drags it to another size, the widget leaves it alone until the next
 * change of media kind; at that change the user's size becomes the new
 * baseline, so a later kind change with no drag in between sizes it again.
 *
 * The in-app player (browser build) keeps its own geometry in
 * `utils/mediaFloatGeometry.ts`; this module reuses its aspect normalizing and
 * transport fallback, not its layout, because the OS owns this window's
 * position.
 */

import type { MediaKind } from '../../shared/mediaTypes';
import {
	MEDIA_FLOAT_TRANSPORT_FALLBACK_HEIGHT,
	normalizeMediaAspect,
} from '../utils/mediaFloatGeometry';

/** Height of `FloatingWidgetFrame`'s title strip (its `h-8`). */
export const MEDIA_WINDOW_STRIP_HEIGHT = 32;

/**
 * The frame's 1px border on each side. The stage sits inside it, so a video's
 * picture is this much narrower than the window and the window this much
 * taller than strip + picture + transport. Without it the picture letterboxes
 * by a pixel.
 */
export const MEDIA_WINDOW_FRAME_BORDER = 1;

/** Window width each kind opens at. */
export const MEDIA_WINDOW_WIDTH: Record<MediaKind, number> = {
	audio: 420,
	video: 480,
};

/**
 * Two sizes this close are the same size. A window on a scaled display can
 * come back a pixel off what was asked for, and that is not a user resize.
 */
const SAME_SIZE_TOLERANCE = 2;

export interface MediaWindowSize {
	width: number;
	height: number;
}

/** What the window's size depends on. */
export interface MediaWindowFit {
	kind: MediaKind;
	/** Picture aspect ratio (width / height), once the file says. Ignored for audio. */
	aspect?: number;
	/** Measured transport height, or null before the first measurement. */
	transportHeight: number | null;
}

/**
 * The last size the widget set, and the kind it set it for. Kept across
 * launches so a size the user chose last session survives the next one.
 */
export interface MediaWindowBaseline {
	kind: MediaKind;
	/** The size the widget asked for. */
	requested: MediaWindowSize;
	/** The size the window actually took (main clamps to the minimum and the screen). */
	actual: MediaWindowSize;
}

/** The window size a fit wants. */
export function mediaWindowSizeFor(fit: MediaWindowFit): MediaWindowSize {
	const transport =
		typeof fit.transportHeight === 'number' && fit.transportHeight > 0
			? Math.round(fit.transportHeight)
			: MEDIA_FLOAT_TRANSPORT_FALLBACK_HEIGHT;
	const width = MEDIA_WINDOW_WIDTH[fit.kind];
	const chrome = MEDIA_WINDOW_STRIP_HEIGHT + transport + 2 * MEDIA_WINDOW_FRAME_BORDER;
	if (fit.kind !== 'video') return { width, height: chrome };
	const stageWidth = width - 2 * MEDIA_WINDOW_FRAME_BORDER;
	return { width, height: chrome + Math.round(stageWidth / normalizeMediaAspect(fit.aspect)) };
}

export function sameMediaWindowSize(a: MediaWindowSize, b: MediaWindowSize): boolean {
	return (
		Math.abs(a.width - b.width) <= SAME_SIZE_TOLERANCE &&
		Math.abs(a.height - b.height) <= SAME_SIZE_TOLERANCE
	);
}

export interface MediaWindowSizePlan {
	/** The size to set, or null to leave the window as it is. */
	apply: MediaWindowSize | null;
	/**
	 * The baseline to keep when nothing is applied. After an apply the caller
	 * records the window's resulting size instead (see `mediaWindowBaselineAfter`).
	 */
	baseline: MediaWindowBaseline | null;
}

/**
 * Decide whether to size the window for `fit`.
 *
 * - No window bounds yet: nothing to compare, wait.
 * - No baseline: the widget never sized this window, so size it.
 * - The kind changed: size it unless the user resized since the last kind
 *   change. If they did, their size becomes the baseline for this kind.
 * - Same kind (the aspect or the transport measurement arrived): size it only
 *   when the window still has the widget's size and the wanted size moved.
 */
export function planMediaWindowSize(
	fit: MediaWindowFit,
	current: MediaWindowSize | null,
	baseline: MediaWindowBaseline | null
): MediaWindowSizePlan {
	if (!current) return { apply: null, baseline };
	const target = mediaWindowSizeFor(fit);
	if (!baseline) return { apply: target, baseline };

	const userResized = !sameMediaWindowSize(current, baseline.actual);
	if (fit.kind !== baseline.kind) {
		if (!userResized) return { apply: target, baseline };
		return {
			apply: null,
			baseline: { kind: fit.kind, requested: current, actual: current },
		};
	}
	if (userResized || sameMediaWindowSize(target, baseline.requested)) {
		return { apply: null, baseline };
	}
	return { apply: target, baseline };
}

/** The baseline after setting `requested` and the window taking `actual`. */
export function mediaWindowBaselineAfter(
	kind: MediaKind,
	requested: MediaWindowSize,
	actual: MediaWindowSize | null
): MediaWindowBaseline {
	return { kind, requested, actual: actual ?? requested };
}

function sanitizeSize(value: unknown): MediaWindowSize | null {
	if (typeof value !== 'object' || value === null) return null;
	const { width, height } = value as Record<string, unknown>;
	if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return null;
	if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return null;
	return { width, height };
}

/** Coerce a stored baseline; anything damaged reads as none. */
export function sanitizeMediaWindowBaseline(value: unknown): MediaWindowBaseline | null {
	if (typeof value !== 'object' || value === null) return null;
	const { kind, requested, actual } = value as Record<string, unknown>;
	if (kind !== 'audio' && kind !== 'video') return null;
	const requestedSize = sanitizeSize(requested);
	const actualSize = sanitizeSize(actual);
	if (!requestedSize || !actualSize) return null;
	return { kind, requested: requestedSize, actual: actualSize };
}
