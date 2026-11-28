/**
 * Session Image Store
 *
 * Content-addressed storage for images pasted into AI conversations.
 *
 * Historically, pasted screenshots were persisted inline as full
 * `data:image/png;base64,...` data URLs inside `maestro-sessions.json`
 * (under `session.aiTabs[].logs[].images`). A single Retina screenshot is
 * several megabytes; a field trace found 264MB of base64 image data in one
 * user's sessions file (98% of a 272MB file). electron-store serializes and
 * writeFileSync's that ENTIRE blob synchronously on the main thread on every
 * persistence flush, and ships it over IPC on load - which froze keyboard
 * input and scrolling for 1-1.5s at a time.
 *
 * This store relocates the bytes out of the JSON blob and into
 * content-addressed files on disk (`<syncPath>/session-images/<sha256>.<ext>`),
 * leaving a lightweight `maestro-image://store/<sha256>.<ext>` reference in the
 * log entry. The reference is directly loadable by `<img src>` via the
 * `maestro-image` protocol registered in `src/main/index.ts`, so render-only
 * consumers need no changes. Content addressing dedupes identical pastes
 * automatically (the same image referenced from two tabs stores once).
 *
 * No data is lost: the image bytes live on disk and resolve back to a data URL
 * on demand (web clients, export, clipboard, send-to-agent) via the resolve
 * helpers below.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
	MAX_THUMB_DIMENSION,
	SESSION_IMAGE_REF_PREFIX,
	THUMB_HEIGHT_PARAM,
	THUMB_WIDTH_PARAM,
	isSessionImageRef,
} from '../../shared/sessionImageRefs';
import { setMaestroLibImageRefResolver } from '../../shared/maestro-lib/host';
import {
	createSessionImageStore,
	extFromMediaType as sharedExtFromMediaType,
	isInlineImageDataUrl as sharedIsInlineImageDataUrl,
} from '../../shared/maestro-lib/store/session-images';

const IMAGE_DIR_NAME = 'session-images';
// The reference grammar is shared with the renderer (which rewrites refs to
// the web server's image route) and the web server route itself, so all three
// agree on what a reference looks like. See src/shared/sessionImageRefs.ts.
export const IMAGE_REF_PREFIX = SESSION_IMAGE_REF_PREFIX;

/**
 * mediaType (e.g. 'image/png') -> file extension. Exported so the CLI's
 * `image save` names a file after the bytes it actually wrote rather than
 * re-deriving the mapping. The rule lives with the shared store.
 */
export const extFromMediaType = sharedExtFromMediaType;

// The media type is derived by the shared `getImageMimeType`, never by
// `image/${ext}`: `image/jpg` is not a real media type and Electron's
// nativeImage refuses to decode it, which is what made "Copy Image" paste a
// data URL as text instead of the picture.

let baseDir: string | null = null;
let cachedDir: string | null = null;

/**
 * Point the image store at a base directory (the sessions sync path). Called
 * once during main startup, right after the stores are initialized. Kept
 * separate from the store getters so this module has no electron dependency and
 * stays unit-testable against a plain temp dir.
 */
export function configureImageStore(dir: string): void {
	baseDir = dir;
	cachedDir = null;
}

/** Absolute path to the image directory, creating it on first use. */
export function getImageDir(): string {
	if (cachedDir) return cachedDir;
	if (!baseDir) {
		throw new Error('Session image store not configured - call configureImageStore() first');
	}
	const dir = path.join(baseDir, IMAGE_DIR_NAME);
	fs.mkdirSync(dir, { recursive: true });
	cachedDir = dir;
	return dir;
}

// One implementation of the store, shared with the headless host
// (`src/shared/maestro-lib/store/session-images.ts`); this module owns where the
// desktop's folder is and the protocol handler's thumbnails.
const store = createSessionImageStore(getImageDir);

/** True if `value` is a `maestro-image://` reference produced by this store. */
export function isImageRef(value: string): boolean {
	return isSessionImageRef(value);
}

/** True if `value` is an inline base64 image data URL. */
export function isInlineImageDataUrl(value: string): boolean {
	return sharedIsInlineImageDataUrl(value);
}

/**
 * Resolve a ref to its on-disk file path, or null if it isn't a valid ref.
 * Any `?...` query (the thumbnail request the protocol handler understands) is
 * ignored here - it selects a rendition, not a different source file. The
 * shared basename grammar is the traversal guard.
 */
export function resolveToFilePath(ref: string): string | null {
	return store.resolveToFilePath(ref);
}

/**
 * Read the thumbnail box (if any) a ref URL is asking for. Returns null for a
 * bare ref, which must always serve the original bytes - the lightbox, clipboard
 * copy, and every export path depend on that.
 */
export function parseThumbnailRequest(ref: string): { maxWidth: number; maxHeight: number } | null {
	const q = ref.indexOf('?');
	if (q === -1) return null;
	const params = new URLSearchParams(ref.slice(q + 1));
	const w = Number(params.get(THUMB_WIDTH_PARAM));
	const h = Number(params.get(THUMB_HEIGHT_PARAM));
	if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return null;
	return {
		maxWidth: Math.min(Math.round(w), MAX_THUMB_DIMENSION),
		maxHeight: Math.min(Math.round(h), MAX_THUMB_DIMENSION),
	};
}

/**
 * Store an inline image data URL as a content-addressed file and return its
 * `maestro-image://` reference. If `value` is already a reference (or not an
 * inline data URL at all), it is returned unchanged - so this is safe to call
 * repeatedly over a mixed array.
 */
export function storeInlineImage(value: string): Promise<string> {
	return store.storeInlineImage(value);
}

/**
 * Resolve a reference (or passthrough data URL) to a data URL. Returns the
 * value unchanged if it is already a data URL; null if a ref's file is missing.
 * Used by surfaces that cannot use the `maestro-image` protocol: web/mobile
 * clients, HTML export, clipboard copy.
 */
export function resolveToDataUrl(value: string): Promise<string | null> {
	return store.resolveToDataUrl(value);
}

/**
 * Synchronously resolve a reference to its raw bytes and media type. The
 * send-to-agent path (process-manager/utils/imageUtils.ts) runs synchronously,
 * so it needs a sync resolver to turn a persisted ref back into bytes for
 * temp-file / stream-json hand-off. Returns null for a missing file; passes
 * inline data URLs through by decoding them.
 */
export function resolveToBytesSync(value: string): { buffer: Buffer; mediaType: string } | null {
	return store.resolveToBytesSync(value);
}

/**
 * Synchronously resolve a reference (or passthrough data URL) to a data URL.
 * Returns the value unchanged if already a data URL; null if a ref's file is
 * missing. Used by the web-server session-detail callback, which is synchronous
 * and serves images to browser clients that cannot use the maestro-image
 * protocol.
 */
export function resolveToDataUrlSync(value: string): string | null {
	return store.resolveToDataUrlSync(value);
}

/**
 * Replace every inline image data URL found under a session's image-bearing
 * fields with a `maestro-image://` reference, storing the bytes on disk. Only
 * clones the parts of the tree that actually change (reference-stable
 * otherwise), so it is cheap to run on every persistence flush. The walk (which
 * fields, closed tabs, the queue) is the shared store's.
 *
 * @returns the (possibly new) sessions array plus the number of images relocated.
 */
export function relocateSessionImages<T>(
	sessions: T[]
): Promise<{ sessions: T[]; relocated: number }> {
	return store.relocateSessionImages(sessions);
}

/** Reset cached state. Test-only. */
export function __resetImageStoreCacheForTests(): void {
	baseDir = null;
	cachedDir = null;
}

// maestro-lib resolves `maestro-image://` refs through its host
// (src/shared/maestro-lib/host.ts); this store is where those bytes live.
setMaestroLibImageRefResolver(resolveToBytesSync);
