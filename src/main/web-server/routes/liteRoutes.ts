import type { FastifyInstance } from 'fastify';
import type { MaestroRemoteHandshake } from '../../../shared/maestroRemote';
import { MAESTRO_REMOTE_PROTOCOL_VERSION } from '../../../shared/maestroRemote';
import { resolveWebRequestAuth, isWebRequestAuthorized } from '../auth/web-login-policy';

export type RemoteHostStatus = Omit<MaestroRemoteHandshake, 'protocolVersion' | 'authentication'>;

/** Registered on the existing server, behind its token and global login policy. */
export function registerLiteRoutes(
	server: FastifyInstance,
	token: string,
	getHostStatus: () => Promise<RemoteHostStatus>
): void {
	server.get(`/${token}/api/lite/handshake`, async (request, reply) => {
		const auth = resolveWebRequestAuth(request);
		if (!isWebRequestAuthorized(auth)) {
			return reply.code(401).send({ error: 'Unauthorized', message: 'Login required' });
		}
		const status = await getHostStatus();
		const handshake: MaestroRemoteHandshake = {
			...status,
			protocolVersion: MAESTRO_REMOTE_PROTOCOL_VERSION,
			authentication: { loginEnabled: auth.required, authenticated: auth.user !== undefined },
		};
		return reply.header('cache-control', 'no-store').send(handshake);
	});
}
