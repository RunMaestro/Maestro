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
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';

const IMAGE_DIR_NAME = 'session-images';
export const IMAGE_REF_PREFIX = 'maestro-image://store/';

// Only lowercase-hex sha256 basenames with a known image extension are ever
// served or resolved. Guards the protocol handler against path traversal and
// keeps `resolveToFilePath` from touching anything but our own files.
const REF_BASENAME_RE = /^[0-9a-f]{64}\.(png|jpe?g|gif|webp|bmp|svg)$/;

// mediaType (e.g. 'image/png') -> file extension. Mirrors the split('/')[1]
// convention already used by process-manager/utils/imageUtils.ts.
function extFromMediaType(mediaType: string): string {
	const sub = mediaType.split('/')[1]?.toLowerCase() ?? 'png';
	if (sub === 'svg+xml') return 'svg';
	if (sub === 'jpeg') return 'jpeg';
	return sub;
}

function mediaTypeFromExt(ext: string): string {
	const e = ext.toLowerCase();
	if (e === 'svg') return 'image/svg+xml';
	return `image/${e}`;
}

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

/** True if `value` is a `maestro-image://` reference produced by this store. */
export function isImageRef(value: string): boolean {
	return typeof value === 'string' && value.startsWith(IMAGE_REF_PREFIX);
}

/** True if `value` is an inline base64 image data URL. */
export function isInlineImageDataUrl(value: string): boolean {
	return typeof value === 'string' && value.startsWith('data:image/');
}

/** Parse a data URL into its media type and base64 payload, or null. */
function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } | null {
	const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
	if (!match) return null;
	return { mediaType: match[1], base64: match[2] };
}

/** Resolve a ref to its on-disk file path, or null if it isn't a valid ref. */
export function resolveToFilePath(ref: string): string | null {
	if (!isImageRef(ref)) return null;
	const basename = ref.slice(IMAGE_REF_PREFIX.length);
	if (!REF_BASENAME_RE.test(basename)) return null;
	return path.join(getImageDir(), basename);
}

/**
 * Store an inline image data URL as a content-addressed file and return its
 * `maestro-image://` reference. If `value` is already a reference (or not an
 * inline data URL at all), it is returned unchanged - so this is safe to call
 * repeatedly over a mixed array.
 */
export async function storeInlineImage(value: string): Promise<string> {
	if (!isInlineImageDataUrl(value)) return value;
	const parsed = parseDataUrl(value);
	if (!parsed) return value;

	const buffer = Buffer.from(parsed.base64, 'base64');
	const sha = crypto.createHash('sha256').update(buffer).digest('hex');
	const ext = extFromMediaType(parsed.mediaType);
	const basename = `${sha}.${ext}`;
	const filePath = path.join(getImageDir(), basename);

	// Content-addressed: identical bytes always hash to the same filename, so
	// skip the write if we already have it (dedupes repeated pastes).
	try {
		await fsPromises.access(filePath);
	} catch {
		await fsPromises.writeFile(filePath, buffer);
	}
	return `${IMAGE_REF_PREFIX}${basename}`;
}

/**
 * Resolve a reference (or passthrough data URL) to a data URL. Returns the
 * value unchanged if it is already a data URL; null if a ref's file is missing.
 * Used by surfaces that cannot use the `maestro-image` protocol: web/mobile
 * clients, HTML export, clipboard copy.
 */
export async function resolveToDataUrl(value: string): Promise<string | null> {
	if (isInlineImageDataUrl(value)) return value;
	const filePath = resolveToFilePath(value);
	if (!filePath) return isInlineImageDataUrl(value) ? value : null;
	try {
		const buffer = await fsPromises.readFile(filePath);
		const ext = path.extname(filePath).slice(1);
		return `data:${mediaTypeFromExt(ext)};base64,${buffer.toString('base64')}`;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		logger.warn(`Missing session image for ref: ${value}`, 'SessionImageStore');
		return null;
	}
}

/**
 * Synchronously resolve a reference to its raw bytes and media type. The
 * send-to-agent path (process-manager/utils/imageUtils.ts) runs synchronously,
 * so it needs a sync resolver to turn a persisted ref back into bytes for
 * temp-file / stream-json hand-off. Returns null for a missing file; passes
 * inline data URLs through by decoding them.
 */
export function resolveToBytesSync(value: string): { buffer: Buffer; mediaType: string } | null {
	if (isInlineImageDataUrl(value)) {
		const parsed = parseDataUrl(value);
		if (!parsed) return null;
		return { buffer: Buffer.from(parsed.base64, 'base64'), mediaType: parsed.mediaType };
	}
	const filePath = resolveToFilePath(value);
	if (!filePath) return null;
	try {
		const buffer = fs.readFileSync(filePath);
		const ext = path.extname(filePath).slice(1);
		return { buffer, mediaType: mediaTypeFromExt(ext) };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		logger.warn(`Missing session image for ref: ${value}`, 'SessionImageStore');
		return null;
	}
}

/**
 * Synchronously resolve a reference (or passthrough data URL) to a data URL.
 * Returns the value unchanged if already a data URL; null if a ref's file is
 * missing. Used by the web-server session-detail callback, which is synchronous
 * and serves images to browser clients that cannot use the maestro-image
 * protocol.
 */
export function resolveToDataUrlSync(value: string): string | null {
	if (isInlineImageDataUrl(value)) return value;
	const resolved = resolveToBytesSync(value);
	if (!resolved) return null;
	return `data:${resolved.mediaType};base64,${resolved.buffer.toString('base64')}`;
}

/**
 * Replace every inline image data URL found under a session's image-bearing
 * fields with a `maestro-image://` reference, storing the bytes on disk. Only
 * clones the parts of the tree that actually change (reference-stable
 * otherwise), so it is cheap to run on every persistence flush - a scan over
 * already-relocated sessions does no writes and allocates nothing new.
 *
 * Walks `aiTabs[].logs[].images`, `aiTabs[].stagedImages`, and
 * `executionQueue[].images` - the three fields that carry pasted images.
 *
 * @returns the (possibly new) sessions array plus the number of images relocated.
 */
export async function relocateSessionImages<T>(
	sessions: T[]
): Promise<{ sessions: T[]; relocated: number }> {
	let relocated = 0;

	// Replace inline data URLs in a string[] with refs. Returns the same array
	// reference when nothing changed so callers can detect no-ops.
	const relocateArray = async (images: unknown): Promise<string[] | undefined> => {
		if (!Array.isArray(images) || images.length === 0) return images as undefined;
		let changed = false;
		const next: string[] = new Array(images.length);
		for (let i = 0; i < images.length; i++) {
			const img = images[i];
			if (typeof img === 'string' && isInlineImageDataUrl(img)) {
				const ref = await storeInlineImage(img);
				next[i] = ref;
				if (ref !== img) {
					changed = true;
					relocated++;
				}
			} else {
				next[i] = img as string;
			}
		}
		return changed ? next : (images as string[]);
	};

	const nextSessions = await Promise.all(
		sessions.map(async (rawSession) => {
			const session = rawSession as unknown as Record<string, unknown>;
			let sessionChanged = false;
			const patch: Record<string, unknown> = {};

			// aiTabs[].logs[].images + aiTabs[].stagedImages
			const aiTabs = session.aiTabs as Array<Record<string, unknown>> | undefined;
			if (Array.isArray(aiTabs)) {
				let tabsChanged = false;
				const nextTabs = await Promise.all(
					aiTabs.map(async (tab) => {
						let tabChanged = false;
						const tabPatch: Record<string, unknown> = {};

						const logs = tab.logs as Array<Record<string, unknown>> | undefined;
						if (Array.isArray(logs)) {
							let logsChanged = false;
							const nextLogs = await Promise.all(
								logs.map(async (log) => {
									const nextImages = await relocateArray(log.images);
									if (nextImages !== log.images) {
										logsChanged = true;
										return { ...log, images: nextImages };
									}
									return log;
								})
							);
							if (logsChanged) {
								tabPatch.logs = nextLogs;
								tabChanged = true;
							}
						}

						const nextStaged = await relocateArray(tab.stagedImages);
						if (nextStaged !== tab.stagedImages) {
							tabPatch.stagedImages = nextStaged;
							tabChanged = true;
						}

						if (tabChanged) {
							tabsChanged = true;
							return { ...tab, ...tabPatch };
						}
						return tab;
					})
				);
				if (tabsChanged) {
					patch.aiTabs = nextTabs;
					sessionChanged = true;
				}
			}

			// executionQueue[].images
			const queue = session.executionQueue as Array<Record<string, unknown>> | undefined;
			if (Array.isArray(queue)) {
				let queueChanged = false;
				const nextQueue = await Promise.all(
					queue.map(async (item) => {
						const nextImages = await relocateArray(item.images);
						if (nextImages !== item.images) {
							queueChanged = true;
							return { ...item, images: nextImages };
						}
						return item;
					})
				);
				if (queueChanged) {
					patch.executionQueue = nextQueue;
					sessionChanged = true;
				}
			}

			return sessionChanged ? ({ ...session, ...patch } as unknown as T) : rawSession;
		})
	);

	return { sessions: nextSessions, relocated };
}

/** Reset cached state. Test-only. */
export function __resetImageStoreCacheForTests(): void {
	baseDir = null;
	cachedDir = null;
}
