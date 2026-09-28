/**
 * Session image references - the shape of a persisted conversation image.
 *
 * Pasted screenshots are relocated out of `maestro-sessions.json` into a
 * content-addressed store on disk (`src/main/storage/session-image-store.ts`)
 * and the transcript keeps only a reference: `maestro-image://store/<sha>.<ext>`.
 *
 * Three runtimes read that reference and each reaches the bytes differently:
 *
 *   - Electron desktop: `<img src>` loads it straight through the
 *     `maestro-image` protocol registered in `src/main/index.ts`.
 *   - web-desktop browser bundle: a browser has no handler for the custom
 *     scheme, so the same reference is rewritten to the token-scoped HTTP route
 *     the embedded web server exposes (`src/main/web-server/routes/imageRoutes.ts`,
 *     resolved on the renderer side by `src/renderer/utils/sessionImageSrc.ts`).
 *   - main process: `resolveToFilePath()` maps it onto the store directory.
 *
 * The prefix and the basename grammar live here, import-free, so all three
 * agree byte-for-byte. The basename regex is also the traversal guard: only a
 * lowercase-hex sha256 with a known image extension is ever served or
 * resolved, from any of those entry points.
 */

export const SESSION_IMAGE_REF_PREFIX = 'maestro-image://store/';

/** Lowercase-hex sha256 basename with a known image extension. */
export const SESSION_IMAGE_BASENAME_RE = /^[0-9a-f]{64}\.(png|jpe?g|gif|webp|bmp|svg)$/;

/** True if `value` is a `maestro-image://store/...` reference. */
export function isSessionImageRef(value: unknown): value is string {
	return typeof value === 'string' && value.startsWith(SESSION_IMAGE_REF_PREFIX);
}

/**
 * The validated basename (`<sha256>.<ext>`) of a reference, or null when the
 * value is not a reference or names something the store would never have
 * written (a traversal attempt, a stray extension).
 */
export function sessionImageRefBasename(value: unknown): string | null {
	if (!isSessionImageRef(value)) return null;
	const basename = value.slice(SESSION_IMAGE_REF_PREFIX.length);
	return SESSION_IMAGE_BASENAME_RE.test(basename) ? basename : null;
}

/** Route segment, under the web server's `apiBase`, that serves store images. */
export const SESSION_IMAGE_HTTP_SEGMENT = 'images';

/**
 * The HTTP path the web-desktop bundle loads a store image from. `apiBase` is
 * the server-injected `/<token>/api`, so the security token rides along and the
 * route is unreachable without it.
 */
export function sessionImageHttpPath(apiBase: string, basename: string): string {
	const base = apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase;
	return `${base}/${SESSION_IMAGE_HTTP_SEGMENT}/${basename}`;
}

/**
 * Query parameters the `maestro-image` protocol handler understands for
 * on-the-fly (disk-cached) downscaling. Bare refs - no query - always serve the
 * original bytes, so the lightbox, clipboard copy, and every export path are
 * unaffected.
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
 *
 * Thumbnails are an ELECTRON-only optimization: the query rides the custom
 * scheme, and the web-desktop bundle rewrites a ref to the token-scoped HTTP
 * route before it is ever loaded (see `sessionImageHttpPath` above), so a
 * browser client keeps receiving originals.
 */
export function sessionImageThumbnailSrc(ref: string, maxWidth: number, maxHeight: number): string {
	if (!isSessionImageRef(ref)) return ref;
	const w = Math.max(1, Math.min(Math.round(maxWidth), MAX_THUMB_DIMENSION));
	const h = Math.max(1, Math.min(Math.round(maxHeight), MAX_THUMB_DIMENSION));
	// Refs never carry a query of their own (the basename is validated against a
	// sha256 + known-extension pattern), so appending is unambiguous.
	return `${ref}?${THUMB_WIDTH_PARAM}=${w}&${THUMB_HEIGHT_PARAM}=${h}`;
}
