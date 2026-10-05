import { directTailnetOrigin } from '../tailnet-origin';
export type DiscoverySource = 'lan' | 'tailscale' | 'cloudflare';
export interface Candidate {
	key: string;
	id: string;
	name: string;
	endpoint: string;
	source: DiscoverySource;
	expiresAt: number;
	availability:
		| 'unmeasured'
		| 'ready'
		| 'peer-offline'
		| 'unreachable'
		| 'auth-required'
		| 'incompatible'
		| 'pairing-disabled';
	sources?: DiscoverySource[];
	detail?: string;
	version?: string;
	/** Identity from the local Tailscale daemon, never from the remote manifest. */
	peerId?: string;
	connection?: import('../pairing/protocol').ConnectionDescriptor;
	/** DNS-SD/invitation identity hint; never saved trust. Named Services have no instance ID. */
	identityHint?: string;
	/** Unadvertised peer hints stay hidden until a valid Maestro manifest is returned. */
	requiresManifest?: boolean;
}
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
export interface DiscoveryState {
	running: boolean;
	generation: number;
	candidates: Candidate[];
	errors: string[];
	sources: Partial<Record<DiscoverySource, SourceState>>;
}
export interface SourceState {
	status:
		| 'searching'
		| 'ready'
		| 'empty'
		| 'offline'
		| 'permission-denied'
		| 'unavailable'
		| 'invitation-required'
		| 'stopped';
	message: string;
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
/** Storage/parser acceptance is not transport authorization; direct sockets also verify the local daemon. */
export function connectionOrigin(value: unknown): string {
	return typeof value === 'string' && value.startsWith('http:')
		? directTailnetOrigin(value)
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
	const origin = source === 'tailscale' ? connectionOrigin(endpoint) : httpsOrigin(endpoint);
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
