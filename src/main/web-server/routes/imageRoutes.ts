/**
 * Image Routes for Web Server
 *
 * Serves session image store files (pasted conversation screenshots) over HTTP
 * so the web-desktop browser bundle can render them.
 *
 * The Electron app loads those images through the `maestro-image://` protocol
 * handler registered in `src/main/index.ts`. A browser has no handler for the
 * scheme, so without this route every persisted image in a transcript renders
 * as a broken-image glyph on the web interface. The renderer rewrites
 * `maestro-image://store/<name>` to this route via `displayImageSrc()`.
 *
 * Routes:
 * - GET /$TOKEN/api/images/:name - one store image by basename
 *
 * The basename is validated by the same grammar the store itself enforces
 * (`sessionImageRefBasename`): lowercase-hex sha256 plus a known image
 * extension. Anything else is a 400, so the route can never read outside the
 * store directory. Images are content-addressed, so a hit is cached as
 * immutable; `private` keeps a shared cache from holding a token-protected
 * asset.
 */

import { FastifyInstance } from 'fastify';
import * as path from 'path';
import * as fsPromises from 'fs/promises';
import { logger } from '../../utils/logger';
import { getImageMimeType } from '../../../shared/gitUtils';
import {
	SESSION_IMAGE_HTTP_SEGMENT,
	SESSION_IMAGE_REF_PREFIX,
} from '../../../shared/sessionImageRefs';
import { resolveToFilePath } from '../../storage/session-image-store';

const LOG_CONTEXT = 'WebServer:Images';

export class ImageRoutes {
	private securityToken: string;

	constructor(securityToken: string) {
		this.securityToken = securityToken;
	}

	registerRoutes(server: FastifyInstance): void {
		server.get(
			`/${this.securityToken}/api/${SESSION_IMAGE_HTTP_SEGMENT}/:name`,
			async (request, reply) => {
				const { name } = request.params as { name?: string };
				// resolveToFilePath applies the store's own basename guard, so a
				// traversal attempt or a stray extension never maps to a path.
				const filePath = name ? resolveToFilePath(`${SESSION_IMAGE_REF_PREFIX}${name}`) : null;
				if (!filePath) {
					return reply.code(400).type('text/plain').send('bad request');
				}
				try {
					const data = await fsPromises.readFile(filePath);
					return reply
						.headers({
							'content-type': getImageMimeType(path.extname(filePath)),
							'cache-control': 'private, max-age=31536000, immutable',
							'x-content-type-options': 'nosniff',
						})
						.send(data);
				} catch (err) {
					if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
						return reply.code(404).type('text/plain').send('not found');
					}
					throw err;
				}
			}
		);

		logger.debug('Image routes registered', LOG_CONTEXT);
	}
}
