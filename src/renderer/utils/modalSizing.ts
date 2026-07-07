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

export const MODAL_VIEWPORT_PADDING = 32;
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
	return {
		width: Math.round(candidate.width),
		height: Math.round(candidate.height),
	};
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
