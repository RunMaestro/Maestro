/** Increment when a host/client setup capability cannot safely interoperate. */
export const LITE_SETUP_REVISION = 6;
export interface ConnectionDescriptor {
	path: '/.well-known/maestro/connect';
	authentication: 'device-pairing';
	admission: 'device';
	capabilities: readonly string[];
}
export interface Metadata {
	name: string;
	instanceId: string;
	hostKey: string;
	connection: ConnectionDescriptor;
}
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
	connection?: ConnectionDescriptor;
	/** DNS-SD/invitation identity hint; never saved trust. Named Services have no instance ID. */
	identityHint?: string;
	/** Unadvertised peer hints stay hidden until a valid Maestro manifest is returned. */
	requiresManifest?: boolean;
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
export interface ClientState {
	phase: string;
	error?: string;
	hostKey?: string;
	instanceId?: string;
	expiresAt?: number;
	metadata?: Metadata;
}
export interface DiscoveryPairingState {
	discovery: DiscoveryState;
	pairing: ClientState;
}
