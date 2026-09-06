/**
 * Concerto Routes for Web Server
 *
 * Serves agent-authored Concerto HTML documents (Movement panels and Cadenza
 * cards) over HTTP so the web-desktop browser bundle can render them.
 *
 * The Electron app reaches the same documents through the `maestro-concerto://`
 * protocol handler registered in `src/main/index.ts`. A browser has no such
 * handler, so without this route every HTML Movement renders as a blank iframe
 * in web-desktop (see issue #1442).
 *
 * Routes:
 * - GET /$CONCERTO_TOKEN/concerto/render?surface=&id=&revision= - one document
 *
 * The path carries a dedicated per-server token rather than the web server's
 * master security token. Documents are sandboxed, but a sandboxed frame can
 * still navigate itself, so an agent-authored mockup can exfiltrate anything in
 * its own URL. See `buildConcertoHtmlHttpPath` in shared/concerto-html.ts.
 */

import { FastifyInstance } from 'fastify';
import { logger } from '../../utils/logger';
import { CONCERTO_HTML_RESPONSE_HEADERS, getConcertoHtmlDocumentBody } from '../../concerto-html';

const LOG_CONTEXT = 'WebServer:Concerto';

interface RenderQuery {
	surface?: string;
	id?: string;
	/** Present so a new revision busts the frame's cache; not used for lookup. */
	revision?: string;
}

export class ConcertoRoutes {
	private concertoToken: string;

	constructor(concertoToken: string) {
		this.concertoToken = concertoToken;
	}

	registerRoutes(server: FastifyInstance): void {
		server.get(`/${this.concertoToken}/concerto/render`, async (request, reply) => {
			const { surface, id } = request.query as RenderQuery;
			if ((surface !== 'movement' && surface !== 'cadenza') || !id) {
				return reply.code(400).type('text/plain').send('bad request');
			}
			const body = getConcertoHtmlDocumentBody(surface, id);
			if (body === null) {
				return reply.code(404).type('text/plain').send('not found');
			}
			return reply.headers({ ...CONCERTO_HTML_RESPONSE_HEADERS }).send(body);
		});

		logger.debug('Concerto routes registered', LOG_CONTEXT);
	}
}
