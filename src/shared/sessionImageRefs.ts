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
