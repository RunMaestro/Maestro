import type { FastifyRequest, FastifyReply } from 'fastify';
import { isSecureRequest } from '../routes/authRoutes';

/**
 * Browsers must be same-origin. Requests without Origin include the trusted
 * native handshake and CLI; those still need the path token and login/CLI auth.
 * Reverse proxies must preserve Host and supply the original HTTPS protocol.
 * Never trust X-Forwarded-Host as a second attacker-controlled origin allowlist.
 */
export function isRemoteOriginAllowed(
	request: Pick<FastifyRequest, 'headers' | 'protocol'>
): boolean {
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	if (typeof origin !== 'string' || !request.headers.host) return false;
	try {
		const expected = new URL(
			`${isSecureRequest(request) ? 'https' : 'http'}://${request.headers.host}`
		);
		const actual = new URL(origin);
		return actual.origin === expected.origin && actual.origin === origin;
	} catch {
		return false;
	}
}

export async function remoteOriginPreHandler(
	request: FastifyRequest,
	reply: FastifyReply
): Promise<void> {
	if (!isRemoteOriginAllowed(request)) {
		await reply
			.code(403)
			.send({ error: 'Forbidden', message: 'Cross-origin remote access is not allowed' });
	}
}
