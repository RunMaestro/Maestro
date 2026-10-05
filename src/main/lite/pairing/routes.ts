import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PairingHost } from './host';
import { PAIR_PATH, requireToken, type Route } from './protocol';
import { DISCOVERY_PATH } from '../discovery/types';
/** Discovery and OPAQUE PIN proof grant no access without explicit local host confirmation. */
export function registerPairingRoutes(
	server: FastifyInstance,
	getHost: () => PairingHost | undefined,
	authorized: (request: FastifyRequest) => boolean,
	appVersion: string
): void {
	server.get(
		DISCOVERY_PATH,
		{ config: { rateLimit: { max: 90, timeWindow: 60000 } } },
		async (request, reply) => {
			reply.header('Cache-Control', 'no-store');
			const host = getHost();
			if (!host) return reply.code(404).send({ error: 'pairing-disabled' });
			if (!authorized(request)) return reply.code(503).send({ error: 'pairing-unavailable' });
			if (
				!host.isPublishedRequest(request.headers.host, request.ip, request.raw.socket.localAddress)
			)
				return reply.code(403).send({ error: 'private-route-required' });
			try {
				const endpoint = host.discoveryEndpoint(request.headers.host, request.headers.origin);
				return host.discoveryMetadata(endpoint, appVersion);
			} catch {
				return reply.code(400).send({ error: 'route-mismatch' });
			}
		}
	);
	const operations = [
		'describe',
		'begin',
		'status',
		'start',
		'reject',
		'finish',
		'claim',
		'read',
		'cancel',
	];
	for (const operation of operations)
		server.post(
			PAIR_PATH + '/' + operation,
			{ bodyLimit: 16384, config: { rateLimit: { max: 90, timeWindow: 60000 } } },
			async (request, reply) => {
				reply.header('Cache-Control', 'no-store');
				const host = getHost();
				if (!host) return reply.code(404).send({ error: 'pairing-disabled' });
				if (
					!host.isPublishedRequest(
						request.headers.host,
						request.ip,
						request.raw.socket.localAddress
					)
				)
					return reply.code(403).send({ error: 'private-route-required' });
				if (!authorized(request)) return reply.code(503).send({ error: 'pairing-unavailable' });
				try {
					const body = request.body as { route?: Route; payload?: Record<string, unknown> };
					if (
						!body?.route ||
						!body.payload ||
						typeof body.payload !== 'object' ||
						Array.isArray(body.payload)
					)
						throw new Error('invalid-request');
					const { route, payload: p } = body;
					// Explicit published authority; never trust arbitrary X-Forwarded-* or request-provided origin aliases.
					const authority = new URL(route.endpoint).host;
					if (
						request.headers.host?.toLowerCase() !== authority.toLowerCase() ||
						(request.headers.origin && request.headers.origin !== route.endpoint)
					)
						throw new Error('route-mismatch');
					host.describe(route);
					const text = (key: string) => {
						const v = p[key];
						if (typeof v !== 'string' || v.length > 4096) throw new Error('invalid-request');
						return v;
					};
					if (operation === 'describe') return host.describe(route);
					if (operation === 'begin')
						return host.begin(
							{
								clientName: text('clientName'),
								clientNonce: text('clientNonce'),
								capabilityHash: text('capabilityHash'),
								scope: text('scope'),
								epoch: text('epoch'),
							},
							route
						);
					const id = text('id'),
						capability = text('capability');
					requireToken(id);
					requireToken(capability);
					host.checkRoute(id, capability, route);
					switch (operation) {
						case 'status':
							return host.status(id, capability);
						case 'start':
							return host.start(id, capability, text('message'));
						case 'reject':
							host.reject(id, capability, text('attemptId'));
							break;
						case 'finish':
							host.finish(id, capability, text('attemptId'), text('message'));
							break;
						case 'claim':
							return await host.claim(id, capability, text('proof'));
						case 'read':
							return host.read(
								id,
								capability,
								text('grantId'),
								p.counter as number,
								text('method'),
								text('proof')
							);
						case 'cancel':
							await host.cancel(id, capability);
							break;
					}
					return { success: true };
				} catch (error) {
					const code = error instanceof Error ? error.message : 'invalid-request';
					return reply
						.code(400)
						.send({ error: /^[a-z-]{1,64}$/.test(code) ? code : 'invalid-request' });
				}
			}
		);
}
