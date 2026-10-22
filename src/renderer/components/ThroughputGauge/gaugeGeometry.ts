/**
 * Throughput Gauge card geometry: where it opens, how big it may be, and how
 * it stays on screen. Pure, so it is tested without a DOM, the way
 * `mediaFloatGeometry.ts` is for the media player.
 *
 * The card remembers one rect per layout. The "All three" layout is a wide
 * strip and the single gauge a small square, so a size chosen for one is wrong
 * for the other.
 *
 * Every rect the card draws goes through `fitGaugeRect`: sizes are held between
 * the layout's minimum and the viewport, and the card is kept a small margin
 * inside the window and below the custom title strip. That strip is an OS drag
 * region that eats every click over it, so a card pushed under it could no
 * longer be dragged or closed.
 */

import type { ThroughputLayout } from '../../../shared/throughputGauge';
import { MEDIA_FLOAT_LANE_LIFT_RATIO } from '../../utils/mediaFloatGeometry';

export interface GaugeRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface GaugeSize {
	width: number;
	height: number;
}

export interface GaugeViewport {
	width: number;
	height: number;
	/** Pixels at the top the card must stay below (the custom title strip). Defaults to 0. */
	top?: number;
}

/** The rects the card remembers, one per layout. */
export type GaugeRects = Partial<Record<ThroughputLayout, GaugeRect>>;

/** Size each layout opens at. */
export const GAUGE_DEFAULT_SIZE: Readonly<Record<ThroughputLayout, GaugeSize>> = {
	single: { width: 208, height: 232 },
	all: { width: 520, height: 232 },
};

/** Below these the readings stop fitting. */
export const GAUGE_MIN_SIZE: Readonly<Record<ThroughputLayout, GaugeSize>> = {
	single: { width: 160, height: 176 },
	all: { width: 380, height: 176 },
};

/** Gap from the window's left edge where the card first opens. */
export const GAUGE_EDGE_MARGIN = 24;
/**
 * Gap from the window's bottom where the card first opens: enough to sit above
 * the composer rather than on it.
 */
export const GAUGE_INPUT_AREA_CLEARANCE = 120;
/** Closest the card may come to any window edge once the user moves it. */
export const GAUGE_CLAMP_MARGIN = 8;

/**
 * Pull a rect inside the viewport. The size is held between the layout's
 * minimum and the room available; when the window is smaller than the minimum,
 * the window wins, since a cramped card beats one hanging off screen.
 */
export function fitGaugeRect(
	rect: GaugeRect,
	layout: ThroughputLayout,
	viewport: GaugeViewport
): GaugeRect {
	const min = GAUGE_MIN_SIZE[layout];
	const minLeft = GAUGE_CLAMP_MARGIN;
	const minTop = Math.max(0, viewport.top ?? 0) + GAUGE_CLAMP_MARGIN;
	const roomWidth = Math.max(1, viewport.width - 2 * GAUGE_CLAMP_MARGIN);
	const roomHeight = Math.max(1, viewport.height - minTop - GAUGE_CLAMP_MARGIN);

	const width = Math.min(Math.max(rect.width, min.width), roomWidth);
	const height = Math.min(Math.max(rect.height, min.height), roomHeight);
	const maxLeft = Math.max(minLeft, viewport.width - GAUGE_CLAMP_MARGIN - width);
	const maxTop = Math.max(minTop, viewport.height - GAUGE_CLAMP_MARGIN - height);

	return {
		left: Math.round(Math.min(Math.max(rect.left, minLeft), maxLeft)),
		top: Math.round(Math.min(Math.max(rect.top, minTop), maxTop)),
		width: Math.round(width),
		height: Math.round(height),
	};
}

/** Where a layout first opens: bottom-left, above the composer, clear of the media player's corner. */
export function initialGaugeRect(layout: ThroughputLayout, viewport: GaugeViewport): GaugeRect {
	const { width, height } = GAUGE_DEFAULT_SIZE[layout];
	return fitGaugeRect(
		{
			left: GAUGE_EDGE_MARGIN,
			top: viewport.height - height - GAUGE_INPUT_AREA_CLEARANCE,
			width,
			height,
		},
		layout,
		viewport
	);
}

/** Whether two rects are the same box, so a no-op re-fit can skip a render. */
export function sameGaugeRect(a: GaugeRect, b: GaugeRect): boolean {
	return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/** A stored rect, or null when it is not four finite numbers with a positive size. */
export function sanitizeGaugeRect(raw: unknown): GaugeRect | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
	const { left, top, width, height } = raw as Record<string, unknown>;
	const values = [left, top, width, height];
	if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
	if ((width as number) <= 0 || (height as number) <= 0) return null;
	return {
		left: left as number,
		top: top as number,
		width: width as number,
		height: height as number,
	};
}

/** The stored per-layout rects, keeping each good rect and dropping the rest. */
export function sanitizeGaugeRects(raw: unknown): GaugeRects {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
	const stored = raw as Record<string, unknown>;
	const rects: GaugeRects = {};
	for (const layout of Object.keys(GAUGE_DEFAULT_SIZE) as ThroughputLayout[]) {
		const rect = sanitizeGaugeRect(stored[layout]);
		if (rect) rects[layout] = rect;
	}
	return rects;
}

/**
 * The rect a layout opens at: the remembered one pulled into this viewport, or
 * the default placement when there is none.
 */
export function resolveGaugeRect(
	layout: ThroughputLayout,
	stored: GaugeRect | undefined,
	viewport: GaugeViewport
): GaugeRect {
	return stored ? fitGaugeRect(stored, layout, viewport) : initialGaugeRect(layout, viewport);
}

/**
 * Whether the toast stack should step over the card. Only a card in the lower
 * part of the window: lifting a bottom stack over a card parked high up would
 * push the toasts toward the top of the window, which costs more than the
 * overlap. Same cut-off the media player uses. Whether the card shares the
 * stack's column is the stack's own check (`toastBottomInset`).
 */
export function gaugeLiftsToasts(rect: GaugeRect, viewport: GaugeViewport): boolean {
	return viewport.height - rect.top <= viewport.height * MEDIA_FLOAT_LANE_LIFT_RATIO;
}
