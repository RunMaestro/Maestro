/**
 * Local Media Streaming
 *
 * Serves audio/video files to the renderer over the `maestro-media://` custom
 * protocol with HTTP range support, so `<audio>`/`<video>` can seek without
 * ever pulling the whole file into memory or across IPC.
 *
 * Access is gated two ways:
 *  - `protocol.handle` is registered on the default session only, so browser
 *    tab webviews (which run in their own `persist:browser-<id>` partitions)
 *    cannot reach the scheme at all.
 *  - Every URL carries a token minted once per boot, which keeps embedded
 *    content inside the main renderer (the sandboxed HTML preview iframe) from
 *    guessing a URL for an arbitrary file on disk.
 *
 * See src/shared/mediaTypes.ts for the URL format and supported extensions.
 */

import { randomBytes } from 'crypto';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { Readable } from 'stream';

import {
	buildMediaStreamUrl,
	getMediaMimeType,
	parseMediaStreamUrl,
} from '../../shared/mediaTypes';

/**
 * Per-boot capability token embedded in every media stream URL. Regenerated on
 * each launch, so URLs persisted in file tabs go stale rather than becoming a
 * durable handle to the filesystem.
 */
const MEDIA_STREAM_TOKEN = randomBytes(16).toString('hex');

/** Build the renderer-facing stream URL for a local media file. */
export function buildLocalMediaStreamUrl(absolutePath: string): string {
	return buildMediaStreamUrl(MEDIA_STREAM_TOKEN, absolutePath);
}

type ParsedRange = { start: number; end: number };

/**
 * Parse a `Range: bytes=...` header against a known file size.
 *
 * @returns `null` when there is no usable range (serve the whole file),
 *   `'unsatisfiable'` when the client asked for bytes that do not exist, or the
 *   resolved inclusive byte range.
 */
export function parseRangeHeader(
	header: string | null,
	size: number
): ParsedRange | null | 'unsatisfiable' {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;

	const [, rawStart, rawEnd] = match;
	if (rawStart === '' && rawEnd === '') return null;

	let start: number;
	let end: number;
	if (rawStart === '') {
		// Suffix form (`bytes=-500`): the trailing N bytes.
		const suffix = Number(rawEnd);
		if (suffix <= 0) return 'unsatisfiable';
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(rawStart);
		end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
	}

	if (start >= size || start > end) return 'unsatisfiable';
	return { start, end };
}

/**
 * Handle one `maestro-media://` request. Registered via `protocol.handle` in
 * src/main/index.ts.
 */
export async function handleMediaStreamRequest(request: Request): Promise<Response> {
	const filePath = parseMediaStreamUrl(request.url, MEDIA_STREAM_TOKEN);
	if (!filePath) return new Response('bad request', { status: 400 });

	const mimeType = getMediaMimeType(filePath);
	if (!mimeType) return new Response('unsupported media type', { status: 415 });

	let size: number;
	try {
		const info = await stat(filePath);
		if (!info.isFile()) return new Response('not found', { status: 404 });
		size = info.size;
	} catch (err) {
		// Only swallow "file went away" - every other fs error (EACCES, EIO)
		// should surface to Sentry instead of masquerading as a 404.
		if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
			return new Response('not found', { status: 404 });
		}
		throw err;
	}

	const range = parseRangeHeader(request.headers.get('range'), size);
	if (range === 'unsatisfiable') {
		return new Response(null, {
			status: 416,
			headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' },
		});
	}

	const start = range ? range.start : 0;
	const end = range ? range.end : Math.max(0, size - 1);
	const length = size === 0 ? 0 : end - start + 1;

	const headers: Record<string, string> = {
		'content-type': mimeType,
		'accept-ranges': 'bytes',
		'content-length': String(length),
		// The file can change on disk under an open tab; never let Chromium
		// serve a stale body for a path that was just rewritten.
		'cache-control': 'no-store',
	};
	if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;

	if (length === 0) {
		return new Response(null, { status: range ? 206 : 200, headers });
	}

	const body = Readable.toWeb(
		createReadStream(filePath, { start, end })
	) as ReadableStream<Uint8Array>;

	return new Response(body, { status: range ? 206 : 200, headers });
}
