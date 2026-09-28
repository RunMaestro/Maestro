/**
 * Disk-cached thumbnails for session images.
 *
 * The transcript renders every pasted image as a ~200x80 CSS-px chip, but the
 * source is whatever the user pasted - routinely a 4984x2578 Retina screenshot.
 * Chromium has no way to decode "just the small version": it decodes the full
 * bitmap, downscales for paint, and holds the decoded RGBA in its image cache.
 * A field trace of one tab found 47 images totalling 193 megapixels (~0.7GB of
 * decoded RGBA, 230MB on disk) and ~70ms of decode per image, thrashing the
 * decode cache on every scroll pass.
 *
 * This module resizes once, writes the result next to the original, and serves
 * the cache on every subsequent request. Generation is:
 *
 *  - Lazy. Only images the protocol handler is actually asked for are resized,
 *    and the transcript marks its chips `loading="lazy"`, so scrolling past an
 *    image without stopping never generates anything.
 *  - Serialized. `nativeImage` decoding runs on the main thread, so a fast
 *    scroll must not stack 47 full-resolution decodes on top of each other.
 *    One at a time keeps the worst case to a single image's decode.
 *  - Deduplicated. Concurrent requests for the same rendition await the same
 *    promise rather than each doing the work.
 *
 * Cache files live in the image directory as `<sha>.<ext>.<w>x<h>.png`, which
 * `REF_BASENAME_RE` in the store deliberately does NOT match - they can never
 * be addressed as a source image, only produced here.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { nativeImage } from 'electron';
import { logger } from '../utils/logger';

/**
 * Below this, resizing is not worth a second file: the decode is already cheap
 * and the thumbnail would be nearly as large as the original.
 */
const MIN_SOURCE_BYTES = 96 * 1024;

/** In-flight generations, keyed by cache path, so duplicates share one run. */
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Serializes all resize work. `nativeImage.createFromBuffer` decodes on the
 * calling thread, and the calling thread here is the main process, so this
 * chain is what keeps a burst of requests from becoming a multi-second stall.
 */
let queue: Promise<unknown> = Promise.resolve();

/** Path of the cached rendition for a source file at a given box. */
function thumbnailPathFor(sourcePath: string, maxWidth: number, maxHeight: number): string {
	return `${sourcePath}.${maxWidth}x${maxHeight}.png`;
}

/**
 * Return a path to a cached thumbnail of `sourcePath` fitted inside
 * `maxWidth` x `maxHeight`, generating it if needed.
 *
 * Returns null when the caller should just serve the original: the source is
 * already small, it is a vector (SVG has no raster size to reduce), it already
 * fits the box, or the decode failed. Callers must handle null by falling back
 * to the original bytes rather than showing a broken image.
 */
export async function getOrCreateThumbnail(
	sourcePath: string,
	maxWidth: number,
	maxHeight: number
): Promise<string | null> {
	// SVG scales for free and nativeImage cannot rasterize it here.
	if (path.extname(sourcePath).toLowerCase() === '.svg') return null;

	const cachePath = thumbnailPathFor(sourcePath, maxWidth, maxHeight);

	// Fast path: already generated. This is the steady state - every scroll
	// after the first hits here and never touches the queue.
	try {
		await fs.access(cachePath);
		return cachePath;
	} catch {
		// Not cached yet; fall through and build it.
	}

	const existing = inFlight.get(cachePath);
	if (existing) return existing;

	const run = queue
		.catch(() => undefined)
		.then(() => generate(sourcePath, cachePath, maxWidth, maxHeight))
		.finally(() => {
			inFlight.delete(cachePath);
		});
	queue = run.catch(() => undefined);
	inFlight.set(cachePath, run);
	return run;
}

async function generate(
	sourcePath: string,
	cachePath: string,
	maxWidth: number,
	maxHeight: number
): Promise<string | null> {
	// A second request may have completed the file while we sat in the queue.
	try {
		await fs.access(cachePath);
		return cachePath;
	} catch {
		// Still missing - generate it.
	}

	let bytes: Buffer;
	try {
		bytes = await fs.readFile(sourcePath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
	if (bytes.byteLength < MIN_SOURCE_BYTES) return null;

	const image = nativeImage.createFromBuffer(bytes);
	if (image.isEmpty()) {
		logger.warn(`Could not decode session image for thumbnailing: ${sourcePath}`, 'SessionImages');
		return null;
	}

	const { width, height } = image.getSize();
	if (!width || !height) return null;

	// Never upscale: an image already inside the box is served as-is.
	const scale = Math.min(maxWidth / width, maxHeight / height);
	if (scale >= 1) return null;

	const resized = image.resize({
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
		quality: 'good',
	});
	const png = resized.toPNG();
	if (!png.byteLength) return null;

	// Write via a temp file so a crash mid-write cannot leave a truncated PNG
	// that would then be served forever from the fast path above.
	const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
	try {
		await fs.writeFile(tmpPath, png);
		await fs.rename(tmpPath, cachePath);
	} catch (err) {
		await fs.rm(tmpPath, { force: true }).catch(() => undefined);
		throw err;
	}

	logger.debug(
		`Thumbnailed ${path.basename(sourcePath)} ${width}x${height} -> ` +
			`${Math.round(width * scale)}x${Math.round(height * scale)} ` +
			`(${(bytes.byteLength / 1024).toFixed(0)}KB -> ${(png.byteLength / 1024).toFixed(0)}KB)`,
		'SessionImages'
	);
	return cachePath;
}

/** Reset queue + in-flight state. Test-only. */
export function __resetThumbnailStateForTests(): void {
	inFlight.clear();
	queue = Promise.resolve();
}
