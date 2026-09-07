/**
 * Session image reference format - shared between main and renderer.
 *
 * Pasted conversation images are stored content-addressed on disk by
 * `src/main/storage/session-image-store.ts` and referenced from the session
 * JSON as `maestro-image://store/<sha256>.<ext>`. The `maestro-image` protocol
 * (registered in `src/main/index.ts`) serves those refs straight into
 * `<img src>`, so the bytes never re-enter the JSON blob or an IPC payload.
 *
 * The prefix used to be a bare string literal repeated across the store, the
 * clipboard helper, the export helper, and the transcript. It lives here so
 * there is exactly one definition and so the renderer can build a thumbnail
 * URL without importing main-process (fs-dependent) code.
 */

/** Scheme + host of every reference this app produces. */
export const IMAGE_REF_PREFIX = 'maestro-image://store/';

/** True if `value` is a `maestro-image://` reference produced by the store. */
export function isSessionImageRef(value: unknown): value is string {
	return typeof value === 'string' && value.startsWith(IMAGE_REF_PREFIX);
}

/**
 * Query parameters the `maestro-image` protocol handler understands for
 * on-the-fly (disk-cached) downscaling. Bare refs - no query - always serve the
 * original bytes, so the lightbox and every export path are unaffected.
 */
export const THUMB_WIDTH_PARAM = 'tw';
export const THUMB_HEIGHT_PARAM = 'th';

/**
 * Largest thumbnail either dimension may be asked for. Bounds the work the
 * protocol handler will do and the number of distinct cache files a single
 * source image can spawn. 1024 comfortably covers a 2x-DPR strip thumbnail.
 */
export const MAX_THUMB_DIMENSION = 1024;

/**
 * Build a URL that asks the protocol handler for a downscaled copy of `ref`,
 * fitted inside `maxWidth` x `maxHeight` (aspect preserved, never upscaled).
 *
 * A transcript screenshot is routinely 4984x2578 (13MB), while the strip that
 * renders it is 200x80 CSS px. Without this, Chromium decodes the full-resolution
 * bitmap - a 12-megapixel image costs ~48MB of RGBA and ~70ms of decode - purely
 * to throw 99% of the pixels away. One field trace found 47 images totalling
 * 193 megapixels (~0.7GB decoded) in a single tab, which is what made scrolling
 * that transcript stutter.
 *
 * Returns non-ref values (data URLs, http URLs, absolute paths) unchanged, so
 * this is safe to call over a mixed `images` array.
 */
export function sessionImageThumbnailSrc(ref: string, maxWidth: number, maxHeight: number): string {
	if (!isSessionImageRef(ref)) return ref;
	const w = Math.max(1, Math.min(Math.round(maxWidth), MAX_THUMB_DIMENSION));
	const h = Math.max(1, Math.min(Math.round(maxHeight), MAX_THUMB_DIMENSION));
	// Refs never carry a query of their own (the basename is validated against a
	// sha256 + known-extension pattern), so appending is unambiguous.
	return `${ref}?${THUMB_WIDTH_PARAM}=${w}&${THUMB_HEIGHT_PARAM}=${h}`;
}
