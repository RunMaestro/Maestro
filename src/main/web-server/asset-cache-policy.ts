/**
 * Cache policy for the web-desktop bundle's `/<token>/desktop/assets/` mount.
 *
 * Every file Vite emits at the top level of `assets/` is named
 * `[name]-[hash].[ext]`, so its bytes can never change under that name. They
 * used to be served with @fastify/static's default `public, max-age=0`, which
 * makes the browser revalidate every module on every page load: about a hundred
 * conditional requests just to boot.
 *
 * Over a Cloudflare quick tunnel that is not only slow, it fails. Quick tunnels
 * cap the number of requests in flight at once and answer the overflow with an
 * empty `429` (`cf-int-tunnel-request-limit-hit: tunnel`). The bridge reloads
 * the page whenever its WebSocket reconnects, and iOS drops sockets on every
 * wake, so two or three Maestro tabs on a phone reload together, overflow the
 * tunnel, and one of them boots into "Maestro web-desktop failed to load" until
 * the user refreshes by hand. Marking hashed files immutable takes those
 * revalidations off the wire entirely: a reload serves them from cache.
 *
 * Subfolders are excluded on purpose. `assets/fonts/` is copied in verbatim by
 * the bundled-fonts plugin under stable names, so a font replaced in place must
 * still be revalidated.
 *
 * The service worker (`src/web/public/sw.js`) applies the same naming rule to
 * pick its cache-first set. It is served raw and cannot import this module, so
 * keep the two patterns in step.
 */

import path from 'path';

/** Vite's default `[name]-[hash].[ext]`: an 8-character base64url hash. */
const CONTENT_HASHED_FILE_NAME = /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+(?:\.map)?$/;

/** One year, never revalidated. Safe only because the name changes with the bytes. */
export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * True when `filePath` is a content-hashed file directly inside `assetsRoot`.
 * Anything outside the root, in a subfolder, or without a hash suffix keeps the
 * default revalidating policy.
 */
export function isContentHashedAsset(assetsRoot: string, filePath: string): boolean {
	const relative = path.relative(assetsRoot, filePath);
	if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
	if (relative.includes('/') || relative.includes('\\')) return false;
	return CONTENT_HASHED_FILE_NAME.test(relative);
}
