import type { FastifyInstance } from 'fastify';
import type { MaestroRemoteHandshake } from '../../../shared/maestroRemote';
import {
	MAESTRO_REMOTE_PROTOCOL_VERSION,
	MAESTRO_REMOTE_WORKFLOW_VERSION,
} from '../../../shared/maestroRemote';
import { resolveWebRequestAuth, isWebRequestAuthorized } from '../auth/web-login-policy';
import { qualifyRemoteWorkflows } from '../remote-workflows';

export type RemoteHostStatus = Omit<
	MaestroRemoteHandshake,
	'protocolVersion' | 'authentication' | 'workflowQualificationVersion'
>;

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
		const qualification = await qualifyRemoteWorkflows(status.capabilities, {
			id: request.id,
			user: auth.user,
			cli: false,
		});
		const currentAuth = resolveWebRequestAuth(request);
		if (
			!isWebRequestAuthorized(currentAuth) ||
			currentAuth.user?.id !== auth.user?.id ||
			currentAuth.method !== auth.method
		) {
			return reply
				.code(401)
				.send({ error: 'Unauthorized', message: 'Authorization changed during workflow checks' });
		}
		if (!status.ready || qualification.temporarilyUnavailable) {
			return reply
				.code(503)
				.header('cache-control', 'no-store')
				.send({
					error: 'Temporarily unavailable',
					message: status.ready
						? qualification.failures.join('; ')
						: status.unavailableReason || 'Host is not ready to accept remote work',
				});
		}
		const handshake: MaestroRemoteHandshake = {
			...status,
			protocolVersion: MAESTRO_REMOTE_PROTOCOL_VERSION,
			workflowQualificationVersion: MAESTRO_REMOTE_WORKFLOW_VERSION,
			capabilities: qualification.capabilities,
			...(qualification.failures.length
				? {
						unavailableReason: [status.unavailableReason, ...qualification.failures]
							.filter(Boolean)
							.join('; '),
					}
				: {}),
			authentication: {
				loginEnabled: auth.method === 'device-pairing' ? false : auth.required,
				authenticated: auth.user !== undefined,
				...(auth.method ? { method: auth.method } : {}),
			},
		};
		return reply.header('cache-control', 'no-store').send(handshake);
	});
}
