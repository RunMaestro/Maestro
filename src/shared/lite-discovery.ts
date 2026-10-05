/** Increment when a host/client setup capability cannot safely interoperate. */
export const LITE_SETUP_REVISION = 6;
import type { DiscoveryState } from '../main/lite/discovery/types';
export interface ClientState {
	phase: string;
	error?: string;
	hostKey?: string;
	instanceId?: string;
	expiresAt?: number;
	metadata?: import('../main/lite/pairing/protocol').Metadata;
}
export interface DiscoveryPairingState {
	discovery: DiscoveryState;
	pairing: ClientState;
}
