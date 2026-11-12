/**
 * Media Routes for Web Server
 *
 * Streams local audio/video to the web-desktop browser bundle. The Electron
 * app plays media over the `maestro-media://` scheme; a browser has no handler
 * for that scheme, so every video opened in web-desktop failed to load and the
 * player fell through to its "Cannot Play This File" card.
 *
 * Route:
 * - GET /$TOKEN/media/stream/:mediaToken/:hex - one file, with Range support
 *
 * The path mirrors the scheme URL exactly (`maestro-media://stream/<mediaToken>/<hex>`)
 * and is handed to the SAME handler the scheme uses, so both hosts agree on
 * which files are servable, how a Range header is honored, and what a missing
 * or stale-token request gets back. The web server's master token gates the
 * route like every other `/$TOKEN/...` path; the per-boot media token inside
 * it is what stops a client from naming an arbitrary file on disk.
 */

import { Readable } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { FastifyInstance } from 'fastify';
import { logger } from '../../utils/logger';
import { handleMediaStreamRequest } from '../../media/media-stream';
import { MEDIA_SCHEME, MEDIA_STREAM_HOST } from '../../../shared/mediaTypes';

const LOG_CONTEXT = 'WebServer:Media';

/**
 * The `:hex` segment is the file's absolute path hex-encoded, so it is twice
 * the path's byte length: a 60-byte path is already a 120-character param.
 * Fastify refuses to MATCH a route whose param exceeds `maxParamLength`
 * (default 100) and answers 404 before any handler runs, which is how the very
 * first real file tried through this route came back "Route not found" while
 * a short bogus path reached the handler fine. WebServer passes this as the
 * server's `maxParamLength`; PATH_MAX is 1024 on macOS and 4096 on Linux.
 */
export const MEDIA_PATH_PARAM_MAX_LENGTH = 8192;

interface StreamParams {
	mediaToken: string;
	hex: string;
}

export class MediaRoutes {
	private securityToken: string;

	constructor(securityToken: string) {
		this.securityToken = securityToken;
	}

	registerRoutes(server: FastifyInstance): void {
		server.get(`/${this.securityToken}/media/stream/:mediaToken/:hex`, async (request, reply) => {
			const { mediaToken, hex } = request.params as StreamParams;
			const streamUrl = `${MEDIA_SCHEME}://${MEDIA_STREAM_HOST}/${mediaToken}/${hex}`;
			const range = request.headers.range;
			const response = await handleMediaStreamRequest(
				new Request(streamUrl, { headers: range ? { range } : {} })
			);
			reply.code(response.status).headers(Object.fromEntries(response.headers));
			if (!response.body) return reply.send();
			return reply.send(Readable.fromWeb(response.body as unknown as NodeReadableStream));
		});

		logger.debug('Media routes registered', LOG_CONTEXT);
	}
}
