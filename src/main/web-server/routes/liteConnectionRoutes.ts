import type { FastifyInstance, FastifyRequest } from 'fastify';
import path from 'node:path';
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import { CONNECT_PATH, ADMISSION_HEADER } from '../../lite/pairing/protocol';
import type { PairingHost } from '../../lite/pairing/host';
import { bindPairedDeviceAuth } from '../auth/web-login-policy';

import { StaticRoutes } from './staticRoutes';

import { FileRoutes } from './fileRoutes';
import { MediaRoutes } from './mediaRoutes';
import { ImageRoutes } from './imageRoutes';
import { ConcertoRoutes } from './concertoRoutes';
import type { ApiRoutes } from './apiRoutes';
import type { WsRoute } from './wsRoute';
import { registerLiteRoutes, type RemoteHostStatus } from './liteRoutes';

/** Dedicated paired-device routes reuse the production application without changing legacy account policy.
 */
export function registerLiteConnectionRoutes(
	server: FastifyInstance,
	options: {
		getHost: () => PairingHost | undefined;
		webDesktopPath: string | null;
		webAssetsPath: string | null;
		apiRoutes: ApiRoutes;
		wsRoute: WsRoute;
		getHostStatus: () => Promise<RemoteHostStatus>;
	}
): void {
	const token = CONNECT_PATH.slice(1);
	const resolveDevice = (request: FastifyRequest) =>
		options
			.getHost()
			?.resolveDevice(
				request.headers[ADMISSION_HEADER],
				request.headers.host,
				request.ip,
				request.raw.socket.localAddress
			);
	const admitted = (request: FastifyRequest) => !!resolveDevice(request);
	server.register(async (scope) => {
		scope.addHook('onRequest', async (request, reply) => {
			bindPairedDeviceAuth(request, () => {
				const device = resolveDevice(request);
				return device
					? {
							id: 'paired-device:' + device.id,
							username: 'paired-device',
							displayName: device.name,
						}
					: undefined;
			});
			reply.header('cache-control', 'no-store');
			if (!admitted(request))
				return reply.code(403).send({
					error: 'device-pairing-required',
					message:
						'Pair this device with a temporary code and approve it on the host. A revoked device must pair again.',
				});
		});

		for (const [directory, suffix] of [
			['assets', 'desktop/assets'],
			['icons', 'icons'],
		]) {
			const base = directory === 'assets' ? options.webDesktopPath : options.webAssetsPath;
			if (base && existsSync(path.join(base, directory)))
				await scope.register(fastifyStatic, {
					root: path.join(base, directory),
					prefix: CONNECT_PATH + '/' + suffix + '/',
					decorateReply: false,
				});
		}
		new StaticRoutes(token, options.webAssetsPath, options.webDesktopPath, token).registerRoutes(
			scope,
			true
		);

		registerLiteRoutes(scope, token, options.getHostStatus);
		options.apiRoutes.registerRoutes(scope, token);
		new FileRoutes(token).registerRoutes(scope);
		new MediaRoutes(token).registerRoutes(scope);
		new ImageRoutes(token).registerRoutes(scope);
		new ConcertoRoutes(token).registerRoutes(scope);
		options.wsRoute.registerRoute(scope, token, admitted);
	});
}
