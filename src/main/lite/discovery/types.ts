import { directTailnetOrigin } from '../tailnet-origin';
import { lanIPv4, lanOrigin } from '../lan';
import type { Candidate, DiscoverySource } from '../../../shared/lite-discovery';
export interface DiscoveryAdapter {
	start(publish: (rows: Candidate[]) => void, failed: (message: string) => void): Promise<void>;
	stop(): void;
}
export interface DiscoveryConfig {
	lan?: boolean;
	interfaceAddress?: string;
	tailscale?: boolean;
	/** Explicit consent for fixed-port checks of existing Tailscale peers. */
	tailscalePeers?: boolean;
}
export const DISCOVERY_PATH = '/.well-known/maestro/discovery';
export const DISCOVERY_PROTOCOL = 'maestro-discovery';
export const DISCOVERY_VERSION = 1;
export function httpsOrigin(value: unknown): string {
	if (typeof value !== 'string' || value.length > 512)
		throw new Error('A bare HTTPS origin is required');
	const u = new URL(value);
	if (
		u.protocol !== 'https:' ||
		u.username ||
		u.password ||
		u.search ||
		u.hash ||
		u.pathname !== '/'
	)
		throw new Error('A bare HTTPS origin is required; no credentials or token paths');
	return u.origin;
}
/** Storage/parser acceptance is not transport authorization; direct sockets also verify their private interface. */
export function connectionOrigin(value: unknown): string {
	return typeof value === 'string' && value.startsWith('http:')
		? lanIPv4(new URL(value).hostname)
			? lanOrigin(value)
			: directTailnetOrigin(value)
		: httpsOrigin(value);
}
export function displayName(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value.length > 64 ||
		[...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
	)
		throw new Error('Invalid display name');
	return value.trim();
}
/** Build an untrusted location hint, restricting plain HTTP origins to the discovery source's private network. */
export function candidate(
	id: unknown,
	name: unknown,
	endpoint: unknown,
	source: DiscoverySource,
	expiresAt: number,
	availability: Candidate['availability'] = 'unmeasured'
): Candidate {
	if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,88}$/.test(id))
		throw new Error('Invalid host identifier');
	const origin =
		typeof endpoint === 'string' && endpoint.startsWith('http:')
			? source === 'lan'
				? lanOrigin(endpoint)
				: source === 'tailscale'
					? directTailnetOrigin(endpoint)
					: httpsOrigin(endpoint)
			: httpsOrigin(endpoint);
	return {
		key: source + ':' + id + ':' + origin,
		id,
		identityHint: id,
		name: displayName(name),
		endpoint: origin,
		source,
		expiresAt,
		availability,
	};
}
