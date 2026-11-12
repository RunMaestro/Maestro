export interface ModalSize {
	width: number;
	height: number;
}

export type ModalResizeKey = string;
export type ModalSizes = Record<ModalResizeKey, ModalSize>;

export interface ModalViewport {
	width: number;
	height: number;
}

export interface ModalSizeBounds {
	minSize?: Partial<ModalSize>;
	maxSize?: Partial<ModalSize>;
	viewport?: ModalViewport;
	viewportPadding?: number;
	maxViewportRatio?: number;
}

export const DEFAULT_MODAL_MIN_SIZE: ModalSize = {
	width: 320,
	height: 240,
};

export const DEFAULT_MODAL_SIZE: ModalSize = {
	width: 600,
	height: 420,
};

/** Top-left corner of a floating modal, in viewport pixels. */
export interface ModalPosition {
	x: number;
	y: number;
}

export const MODAL_VIEWPORT_PADDING = 32;

/** How much of a floating window must stay on screen so its header - the only
 *  drag handle and the home of its close button - is always reachable (px). */
export const MODAL_FLOAT_VISIBLE_MARGIN_X = 140;
export const MODAL_FLOAT_VISIBLE_MARGIN_Y = 48;
export const MODAL_MAX_VIEWPORT_RATIO = 0.9;

function isFinitePositiveNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Developer-supplied minSize/maxSize/defaultSize props aren't persisted user data,
// but a NaN/zero/negative value would otherwise propagate silently through
// Math.min/Math.max into the final clamp. Drop invalid bounds instead of using them.
function sanitizeBound(value: number | undefined): number | undefined {
	return isFinitePositiveNumber(value) ? value : undefined;
}

export function getViewportSize(): ModalViewport {
	if (typeof window === 'undefined') {
		return { width: 1440, height: 900 };
	}
	return {
		width: window.innerWidth || 1440,
		height: window.innerHeight || 900,
	};
}

export function normalizeModalSize(value: unknown): ModalSize | null {
	if (!value || typeof value !== 'object') return null;
	const candidate = value as Partial<ModalSize>;
	if (!isFinitePositiveNumber(candidate.width) || !isFinitePositiveNumber(candidate.height)) {
		return null;
	}
	// Round AFTER the positive check, then re-check: a sub-0.5 width passes
	// isFinitePositiveNumber but rounds to 0, which would persist a zero-size modal.
	const width = Math.round(candidate.width);
	const height = Math.round(candidate.height);
	if (width <= 0 || height <= 0) return null;
	return { width, height };
}

export function sanitizeModalSizes(value: unknown): ModalSizes {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

	const sizes: ModalSizes = {};
	for (const [key, rawSize] of Object.entries(value)) {
		const size = normalizeModalSize(rawSize);
		if (size) {
			sizes[key] = size;
		}
	}
	return sizes;
}

export function getModalMaxSize({
	maxSize,
	viewport = getViewportSize(),
	viewportPadding = MODAL_VIEWPORT_PADDING,
	maxViewportRatio = MODAL_MAX_VIEWPORT_RATIO,
}: ModalSizeBounds = {}): ModalSize {
	const paddedWidth = Math.max(1, viewport.width - viewportPadding * 2);
	const paddedHeight = Math.max(1, viewport.height - viewportPadding * 2);
	const ratioWidth = Math.max(1, viewport.width * maxViewportRatio);
	const ratioHeight = Math.max(1, viewport.height * maxViewportRatio);

	return {
		width: Math.floor(Math.min(sanitizeBound(maxSize?.width) ?? Infinity, paddedWidth, ratioWidth)),
		height: Math.floor(
			Math.min(sanitizeBound(maxSize?.height) ?? Infinity, paddedHeight, ratioHeight)
		),
	};
}

export function clampModalSize(size: ModalSize, bounds: ModalSizeBounds = {}): ModalSize {
	const minSize = {
		width: sanitizeBound(bounds.minSize?.width) ?? DEFAULT_MODAL_MIN_SIZE.width,
		height: sanitizeBound(bounds.minSize?.height) ?? DEFAULT_MODAL_MIN_SIZE.height,
	};
	const maxSize = getModalMaxSize(bounds);
	const effectiveMin = {
		width: Math.min(minSize.width, maxSize.width),
		height: Math.min(minSize.height, maxSize.height),
	};

	return {
		width: Math.round(Math.max(effectiveMin.width, Math.min(size.width, maxSize.width))),
		height: Math.round(Math.max(effectiveMin.height, Math.min(size.height, maxSize.height))),
	};
}

export function resolveModalSize({
	savedSize,
	defaultSize = DEFAULT_MODAL_SIZE,
	minSize,
	maxSize,
	viewport,
	viewportPadding,
	maxViewportRatio,
}: {
	savedSize?: unknown;
	defaultSize?: Partial<ModalSize>;
} & ModalSizeBounds): ModalSize {
	const normalizedSaved = normalizeModalSize(savedSize);
	const baseSize = normalizedSaved ?? {
		width: sanitizeBound(defaultSize.width) ?? DEFAULT_MODAL_SIZE.width,
		height: sanitizeBound(defaultSize.height) ?? DEFAULT_MODAL_SIZE.height,
	};

	return clampModalSize(baseSize, {
		minSize,
		maxSize,
		viewport,
		viewportPadding,
		maxViewportRatio,
	});
}

/**
 * A default size expressed as a fraction of the viewport, for surfaces whose
 * useful size is "as much room as the screen has" rather than a fixed pixel box
 * - a graph canvas, a dashboard, anything the user pans around inside. A fixed
 * default that reads as generous on a laptop is a postage stamp on a 5K
 * display, and the user has to resize it by hand on every machine.
 *
 * The result still goes through `clampModalSize`, so the 90% viewport cap and
 * any declared minSize apply on top of it.
 */
export function viewportModalSize(
	ratio: Partial<ModalSize>,
	viewport: ModalViewport = getViewportSize()
): ModalSize {
	const widthRatio = sanitizeBound(ratio.width) ?? 1;
	const heightRatio = sanitizeBound(ratio.height) ?? 1;
	return {
		width: Math.round(viewport.width * widthRatio),
		height: Math.round(viewport.height * heightRatio),
	};
}

export function normalizeModalPosition(value: unknown): ModalPosition | null {
	if (!value || typeof value !== 'object') return null;
	const candidate = value as Partial<ModalPosition>;
	if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return null;
	return { x: Math.round(candidate.x as number), y: Math.round(candidate.y as number) };
}

/**
 * Keep a floating window's top-left corner somewhere its header stays grabbable.
 *
 * Clamped on BOTH ends: never off the top or left edge, and never so far right
 * or down that the title bar (the only drag handle, and where the close button
 * lives) is pushed off screen. Without the far-edge clamp, a window dragged to
 * the corner and then a smaller display or window resize would strand it with
 * no way back short of resetting the setting.
 */
export function clampModalPosition(
	position: ModalPosition,
	viewport: ModalViewport = getViewportSize()
): ModalPosition {
	const maxX = Math.max(0, viewport.width - MODAL_FLOAT_VISIBLE_MARGIN_X);
	const maxY = Math.max(0, viewport.height - MODAL_FLOAT_VISIBLE_MARGIN_Y);
	return {
		x: Math.round(Math.min(Math.max(0, position.x), maxX)),
		y: Math.round(Math.min(Math.max(0, position.y), maxY)),
	};
}

/**
 * Where a window should sit the first time it is popped out: offset from the
 * top-left rather than centered, since the point of floating it is to work
 * beside it. Clamped, so it lands on screen on a small display too.
 */
export function defaultModalFloatPosition(
	size: ModalSize,
	viewport: ModalViewport = getViewportSize()
): ModalPosition {
	return clampModalPosition(
		{
			x: Math.max(MODAL_VIEWPORT_PADDING, viewport.width - size.width - MODAL_VIEWPORT_PADDING),
			y: MODAL_VIEWPORT_PADDING * 2,
		},
		viewport
	);
}
