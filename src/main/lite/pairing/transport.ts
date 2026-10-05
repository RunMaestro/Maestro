import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { tailnetDestination } from '../tailnet';
import { connectionOrigin } from '../discovery/types';
import { PAIR_PATH, type PairingTransport, type Route } from './protocol';
/** Fixed routes, no redirects or ambient proxy. Direct mode binds verified Tailscale source and destination. */
export function pairingTransport(route: Route, send?: typeof request): PairingTransport {
	const origin = connectionOrigin(route.endpoint);
	const direct = origin.startsWith('http:');
	if (direct && route.source !== 'tailscale')
		throw new Error('Direct transport requires a Tailscale peer.');
	return {
		async call<T>(operation: string, payload: unknown, signal?: AbortSignal): Promise<T> {
			if (!/^[a-z]+$/.test(operation)) return Promise.reject(new Error('invalid-operation'));
			const data = JSON.stringify({ route, payload });
			if (Buffer.byteLength(data) > 16384) return Promise.reject(new Error('request-too-large'));
			const bound = direct
				? await tailnetDestination(origin, signal ?? AbortSignal.timeout(5000))
				: undefined;
			if (bound && bound.peerId !== route.peerId)
				throw new Error('Tailscale node identity changed. Refresh and verify the host.');
			return new Promise((resolve, reject) => {
				const req = (send ?? (direct ? httpRequest : request))(
					origin + PAIR_PATH + '/' + operation,
					{
						...bound,
						method: 'POST',
						signal,
						rejectUnauthorized: true,
						headers: {
							'content-type': 'application/json',
							'content-length': Buffer.byteLength(data),
						},
					},
					(res) => {
						const chunks: Buffer[] = [];
						let size = 0;
						res.on('data', (chunk: Buffer) => {
							size += chunk.length;
							if (size > 32768) {
								req.destroy();
								reject(new Error('response-too-large'));
							} else chunks.push(chunk);
						});
						res.on('error', () => reject(new Error('connection-lost')));
						res.on('end', () => {
							if (
								res.statusCode === 401 ||
								res.statusCode === 403 ||
								((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400)
							) {
								reject(new Error('authentication-required-use-manual'));
								return;
							}
							try {
								const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
								if (res.statusCode !== 200)
									reject(
										new Error(typeof body.error === 'string' ? body.error : 'pairing-unavailable')
									);
								else resolve(body as T);
							} catch {
								reject(new Error('invalid-host-response'));
							}
						});
					}
				);
				const deadline = setTimeout(() => req.destroy(new Error('connection-timeout')), 5000);
				req.once('close', () => clearTimeout(deadline));
				req.on('error', () =>
					reject(
						new Error(
							signal?.aborted
								? 'cancelled'
								: direct
									? 'tailnet-connection-failed'
									: 'tls-or-connection-failed'
						)
					)
				);
				req.end(data);
			});
		},
	};
}
