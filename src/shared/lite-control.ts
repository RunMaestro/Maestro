import * as path from 'path';
import * as os from 'os';
import { getConfigDir } from './cli-server-discovery';
import { expandTilde } from './pathUtils';
import type { LiteProfile } from '../main/lite/profiles';
import type { DiscoveryPairingState } from './lite-discovery';

export const LITE_CONTROL_PROTOCOL_VERSION = 1;
export const LITE_CONTROL_DISCOVERY_FILE = 'lite-control.json';
export const LITE_CONTROL_MAX_BYTES = 1024 * 1024;

export type LiteControlAction =
	| 'discover'
	| 'discovery-start'
	| 'discovery-import'
	| 'discovery-stop'
	| 'discovery-status'
	| 'network-changed'
	| 'pair-request'
	| 'pair-submit'
	| 'pair-read'
	| 'pair-cancel'
	| 'status'
	| 'list'
	| 'read'
	| 'save'
	| 'remove'
	| 'trust'
	| 'connect'
	| 'reconnect'
	| 'disconnect'
	| 'connections'
	| 'commands'
	| 'dismiss'
	| 'close';

export interface LiteControlState {
	status: string;
	error?: string;
	selected?: string;
	picker: boolean;
	commandsVisible?: boolean;
	canReturn?: boolean;
	profiles: LiteProfile[];
	aliases: string[];
	closing?: boolean;
	discoveryPairing?: DiscoveryPairingState;
}

export interface LiteControlOptions {
	source?: 'cli';
	confirmed?: boolean;
	afterResponse?: (callback: () => void) => void;
}

export interface LiteControlDiscovery {
	protocolVersion: number;
	endpoint: string;
	secret: string;
	pid: number;
}

export interface LiteControlRequest {
	protocolVersion: number;
	secret: string;
	action: LiteControlAction;
	payload?: unknown;
	confirmed?: boolean;
}

export interface LiteControlReply {
	success: boolean;
	error?: string;
	state?: LiteControlState;
	profile?: LiteProfile;
}

/** Only Lite-owned OS-local endpoints are eligible for discovery or ownership probes. */
export function isLiteControlEndpoint(endpoint: unknown): endpoint is string {
	if (typeof endpoint !== 'string') return false;
	if (process.platform === 'win32')
		return /^\\\\\.\\pipe\\maestro-lite-[a-f0-9]{32}$/.test(endpoint);
	return (
		path.dirname(endpoint) === os.tmpdir() &&
		/^maestro-lite-[a-f0-9]{32}\.sock$/.test(path.basename(endpoint))
	);
}

/** Explicit paths address the final isolated Lite directory, not the host's data. */
export function resolveLiteDataDirectory(explicit?: string, baseDirectory?: string): string {
	if (explicit !== undefined) {
		if (!explicit.trim()) throw new Error('Lite user-data path must not be empty.');
		return path.resolve(expandTilde(explicit.trim()));
	}
	return path.join(
		process.env.MAESTRO_USER_DATA ? getConfigDir() : (baseDirectory ?? getConfigDir()),
		'Lite'
	);
}
