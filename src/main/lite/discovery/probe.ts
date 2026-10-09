import { LITE_SETUP_REVISION } from '../../../shared/lite-discovery';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { tailnetDestination } from '../tailnet';
import {
	candidate,
	DISCOVERY_PATH,
	DISCOVERY_PROTOCOL,
	DISCOVERY_VERSION,
	type Candidate,
} from './types';
import { PROTOCOL, SCOPE, CONNECT_PATH, CONNECTION_CAPABILITIES } from '../pairing/protocol';
const CLIENT_VERSION: string = require('../../../../package.json').version;

export type ServiceProbe = (row: Candidate, signal: AbortSignal) => Promise<Candidate>;

/** Advertisements are hints. Only a compatible service response makes a row pairable. */
export function validateManifest(row: Candidate, value: unknown): Candidate {
	const manifest = value as Record<string, unknown> | null;
	const pairing = manifest?.pairing as Record<string, unknown> | undefined;
	if (
		!manifest ||
		manifest.protocol !== DISCOVERY_PROTOCOL ||
		manifest.version !== DISCOVERY_VERSION ||
		typeof manifest.appVersion !== 'string' ||
		!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(manifest.appVersion) ||
		pairing?.protocol !== PROTOCOL ||
		pairing.scope !== SCOPE ||
		!Array.isArray(manifest.capabilities) ||
		!manifest.capabilities.includes(SCOPE)
	)
		return {
			...row,
			availability: 'incompatible',
			detail: 'This service does not support this version of Maestro temporary pairing.',
		};
	let identity: Candidate;
	try {
		identity = candidate(
			manifest.instanceId,
			manifest.name,
			row.endpoint,
			row.source,
			row.expiresAt
		);
	} catch {
		return {
			...row,
			availability: 'incompatible',
			detail: 'The host returned invalid discovery metadata.',
		};
	}
	if (row.identityHint && identity.id !== row.identityHint)
		return {
			...row,
			availability: 'incompatible',
			detail:
				'Host identity differs from its advertisement or invitation. Request a fresh invitation.',
		};
	if (manifest.setupRevision !== LITE_SETUP_REVISION || manifest.appVersion !== CLIENT_VERSION)
		return {
			...identity,
			key: row.key,
			version: manifest.appVersion,
			availability: 'incompatible',
			detail:
				'Host and Lite have different setup versions. Use Check for Maestro update here and in Connect another device on the host, then enable discovery again. Unpublished review builds require the matching supplied installer.',
		};
	const connection = manifest.connection as Record<string, unknown> | undefined;
	if (
		connection?.path !== CONNECT_PATH ||
		connection.authentication !== 'device-pairing' ||
		connection.admission !== 'device' ||
		!Array.isArray(connection.capabilities) ||
		!CONNECTION_CAPABILITIES.every((c) => (connection.capabilities as unknown[]).includes(c))
	)
		return {
			...identity,
			key: row.key,
			availability: 'incompatible',
			detail: 'Update this host and Lite together to enable an authorized connection.',
		};

	if (pairing.enabled !== true)
		return {
			...identity,
			key: row.key,
			version: manifest.appVersion,
			availability: 'pairing-disabled',
			detail: 'Ask the host operator to enable attended Lite pairing.',
		};
	return {
		...identity,
		key: row.key,
		peerId: row.peerId,
		availability: 'ready',
		version: manifest.appVersion,
		connection: {
			path: CONNECT_PATH,
			authentication: 'device-pairing',
			admission: 'device',
			capabilities: [...CONNECTION_CAPABILITIES],
		},
		detail: 'Select to connect. New devices pair once using a temporary code and host approval.',
	};
}
/** Fixed manifest path. Direct mode uses only daemon-verified peers and binds the Tailscale interface. */
export async function probeService(
	row: Candidate,
	signal: AbortSignal,
	send?: typeof request
): Promise<Candidate> {
	const direct = row.endpoint.startsWith('http:');
	let bound = {};
	try {
		if (direct && row.source !== 'tailscale') throw new Error('Not a Tailscale peer');
		if (direct) {
			const route = await tailnetDestination(row.endpoint, signal);
			if (route.peerId !== row.peerId) throw new Error('Tailscale node changed');
			bound = route;
		}
	} catch {
		return {
			...row,
			availability: 'unreachable',
			detail: 'This host is not reachable through the current Tailscale interface.',
		};
	}
	const { promise, resolve } = Promise.withResolvers<Candidate>();
	let settled = false;
	let timer: NodeJS.Timeout | undefined;
	const finish = (result: Candidate) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(result);
	};
	const unavailable = (detail: string) => finish({ ...row, availability: 'unreachable', detail });
	try {
		const req = (send ?? (direct ? httpRequest : request))(
			row.endpoint + DISCOVERY_PATH,
			{
				...bound,
				method: 'GET',
				rejectUnauthorized: true,
				signal,
				headers: { accept: 'application/json' },
			},
			(res) => {
				const status = res.statusCode ?? 0;
				if (status !== 200) {
					const auth = status === 401 || status === 403 || (status >= 300 && status < 400);
					finish({
						...row,
						availability: auth
							? 'auth-required'
							: status === 404
								? 'pairing-disabled'
								: 'unreachable',
						detail: auth
							? 'Existing Web Login or Access authorization is required. Use a saved or manual connection; PIN cannot bypass it.'
							: status === 404
								? 'No attended Maestro pairing service is available at this endpoint.'
								: 'The advertised service is currently unavailable.',
					});
					res.destroy();
					return;
				}
				const chunks: Buffer[] = [];
				let size = 0;
				res.on('data', (chunk: Buffer) => {
					size += chunk.length;
					if (size > 16384) {
						unavailable('Discovery response exceeded the size limit.');
						res.destroy();
					} else chunks.push(chunk);
				});
				res.on('error', () => unavailable('The discovery response was interrupted.'));
				res.on('aborted', () => unavailable('The discovery response was interrupted.'));
				res.on('end', () => {
					if (settled) return;
					try {
						finish(validateManifest(row, JSON.parse(Buffer.concat(chunks).toString('utf8'))));
					} catch {
						finish({
							...row,
							availability: 'incompatible',
							detail: 'This endpoint did not return a Maestro discovery manifest.',
						});
					}
				});
			}
		);
		req.on('error', (error: NodeJS.ErrnoException) => {
			const denied = error.code === 'EACCES' || error.code === 'EPERM';
			unavailable(
				denied
					? 'Network access was denied. No permission or firewall settings were changed.'
					: 'Host unreachable or TLS verification failed. No insecure fallback was attempted.'
			);
		});
		if (!settled)
			timer = setTimeout(() => {
				unavailable('The advertised host did not respond in time.');
				req.destroy();
			}, 4000);
		req.end();
	} catch {
		unavailable('The advertised service could not be reached securely.');
	}
	return promise;
}
