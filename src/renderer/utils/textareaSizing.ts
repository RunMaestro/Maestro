/**
 * textareaSizing.ts
 *
 * Sizing math for user-resized textareas. Textareas with a native `resize-y`
 * grip only change height (their width is always driven by the layout), so a
 * remembered size is a single number rather than a `ModalSize` pair.
 */

export type TextareaSizeKey = string;
export type TextareaHeights = Record<TextareaSizeKey, number>;

export const DEFAULT_TEXTAREA_MIN_HEIGHT = 60;
export const TEXTAREA_VIEWPORT_PADDING = 32;
export const TEXTAREA_MAX_VIEWPORT_RATIO = 0.9;

export interface TextareaHeightBounds {
	minHeight?: number;
	maxHeight?: number;
	viewportHeight?: number;
	viewportPadding?: number;
	maxViewportRatio?: number;
}

function isFinitePositiveNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Developer-supplied bounds aren't persisted user data, but a NaN/zero/negative
// value would otherwise propagate silently through Math.min/Math.max into the
// final clamp. Drop invalid bounds instead of using them.
function sanitizeBound(value: number | undefined): number | undefined {
	return isFinitePositiveNumber(value) ? value : undefined;
}

function getViewportHeight(): number {
	if (typeof window === 'undefined') return 900;
	return window.innerHeight || 900;
}

export function normalizeTextareaHeight(value: unknown): number | null {
	if (!isFinitePositiveNumber(value)) return null;
	const height = Math.round(value);
	return height > 0 ? height : null;
}

export function sanitizeTextareaHeights(value: unknown): TextareaHeights {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

	const heights: TextareaHeights = {};
	for (const [key, rawHeight] of Object.entries(value)) {
		const height = normalizeTextareaHeight(rawHeight);
		if (height) {
			heights[key] = height;
		}
	}
	return heights;
}

export function getTextareaMaxHeight({
	maxHeight,
	viewportHeight = getViewportHeight(),
	viewportPadding = TEXTAREA_VIEWPORT_PADDING,
	maxViewportRatio = TEXTAREA_MAX_VIEWPORT_RATIO,
}: TextareaHeightBounds = {}): number {
	const paddedHeight = Math.max(1, viewportHeight - viewportPadding * 2);
	const ratioHeight = Math.max(1, viewportHeight * maxViewportRatio);

	return Math.floor(Math.min(sanitizeBound(maxHeight) ?? Infinity, paddedHeight, ratioHeight));
}

export function clampTextareaHeight(height: number, bounds: TextareaHeightBounds = {}): number {
	const minHeight = sanitizeBound(bounds.minHeight) ?? DEFAULT_TEXTAREA_MIN_HEIGHT;
	const maxHeight = getTextareaMaxHeight(bounds);
	const effectiveMin = Math.min(minHeight, maxHeight);

	return Math.round(Math.max(effectiveMin, Math.min(height, maxHeight)));
}

/**
 * Height to render at, or `null` when nothing is remembered and no default was
 * declared - the caller then leaves the textarea at its natural size (rows /
 * min-height) instead of pinning an invented one.
 */
export function resolveTextareaHeight({
	savedHeight,
	defaultHeight,
	minHeight,
	maxHeight,
	viewportHeight,
	viewportPadding,
	maxViewportRatio,
}: {
	savedHeight?: unknown;
	defaultHeight?: number;
} & TextareaHeightBounds): number | null {
	const baseHeight = normalizeTextareaHeight(savedHeight) ?? sanitizeBound(defaultHeight);
	if (baseHeight === undefined) return null;

	return clampTextareaHeight(baseHeight, {
		minHeight,
		maxHeight,
		viewportHeight,
		viewportPadding,
		maxViewportRatio,
	});
}

/**
 * Auto-grow sizing for composer textareas (the ones that grow with their content
 * up to a cap, rather than the ones the user drags). Shared by the AI composer,
 * both wizard composers, group chat, and feedback chat so they cannot drift on
 * the scroll-preservation rule below.
 */

/** Cap used when the value changed from outside the keystroke path. */
export const EXTERNAL_TEXTAREA_MAX_HEIGHT = 112;
/** Cap used while the user is actively typing. */
export const KEYSTROKE_TEXTAREA_MAX_HEIGHT = 176;

export function resizeTextareaToContent(textarea: HTMLTextAreaElement, maxHeight: number): void {
	// Setting height to 'auto' momentarily removes the overflow and collapses the
	// internal scroll to the top. Capture and restore scrollTop so resizing a
	// scrolled textarea never yanks the view (and the caret) out of sight. Callers
	// that want the caret pinned to the bottom re-scroll after this returns.
	const previousScrollTop = textarea.scrollTop;
	textarea.style.height = 'auto';
	textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
	textarea.scrollTop = previousScrollTop;
}

/**
 * Keep the caret visible after a resize. resizeTextareaToContent sets
 * height:'auto' first, which resets the textarea's scrollTop, so once the box hits
 * its max height and scrolls internally the freshly typed text at the end would
 * otherwise fall out of view. Snap the scroll to the bottom only in the guaranteed
 * post-insertion case: the caret parked at the very END of the value. There the
 * caret is on the last visual row by definition, so scrollHeight always reveals it.
 *
 * We deliberately do NOT snap for a caret merely sitting on the final LOGICAL line
 * (e.g. before trailing characters). A long final logical line can soft-wrap across
 * several visual rows, so a caret near its start belongs to an EARLIER row; snapping
 * to scrollHeight would scroll that row out of view. Those mid-line edits fall back
 * to the scrollTop resizeTextareaToContent already restored, which keeps the
 * pre-edit viewport intact. See issues #1169, #1294, #1321.
 */
export function scrollTextareaToCaretEnd(textarea: HTMLTextAreaElement): void {
	if (textarea.selectionEnd === textarea.value.length) {
		textarea.scrollTop = textarea.scrollHeight;
	}
}
