/**
 * ICE, NAT traversal, and TURN, stated honestly.
 *
 * Three paths a phone can reach the desktop on, in the order they are tried and
 * in decreasing order of how good they are:
 *
 *   1. **Host candidates.** Same WiFi, or an overlay network like Tailscale or
 *      ZeroTier where both machines already have a routable address for each
 *      other. Nothing in the path, single-digit milliseconds, connects
 *      instantly, needs no infrastructure at all. This is the common case and it
 *      is the case this design is optimised for.
 *   2. **STUN.** Both ends learn their public mapping and punch through their
 *      NATs. Media is still direct. Works for most home routers.
 *   3. **TURN.** A relay in the middle forwards every packet. It is the only
 *      thing that works behind carrier-grade NAT, which is what a phone on
 *      cellular is behind, and it is therefore not an exotic fallback: **if you
 *      want voice to work on a walk, you need a TURN server.** Somebody has to
 *      run it and somebody has to pay for its bandwidth. Pretending otherwise is
 *      how a feature ships that works in the office and nowhere else.
 *
 * The thing that is NOT a path: the Cloudflare quick tunnel in
 * `src/main/tunnel-manager.ts`. It is an HTTP(S) reverse proxy. It can carry the
 * signaling WebSocket, and it does. It cannot carry the media, because the media
 * is UDP between two peers and the tunnel terminates TCP at Cloudflare. See
 * {@link TUNNEL_MEDIA_NOTE}, which is the copy shown in Settings rather than a
 * comment nobody reads.
 */

import { getLocalIpAddressSync, listLocalIpv4Addresses } from '../../utils/networkUtils';
import type { DeviceCandidateType } from '../../../shared/acappella/device-protocol';
import type { IceServerConfig } from '../../../shared/acappella/webrtc-host';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface TurnSettings {
	enabled: boolean;
	/** `turn:host:3478` or `turns:host:5349`. Multiple, comma-free, one per entry. */
	url: string;
	username: string;
	credential: string;
}

export interface IceTransportSettings {
	/**
	 * STUN servers, in preference order. Empty is legal and means "LAN and
	 * overlay only", which is a reasonable choice for someone who never leaves
	 * their own network and does not want their address reflected off anyone.
	 */
	stunUrls: string[];
	turn: TurnSettings;
	/**
	 * Advertise host candidates. On by default and essentially always right; the
	 * switch exists because a machine with a dozen virtual interfaces gathers a
	 * dozen useless candidates, which slows the connection down.
	 */
	hostCandidates: boolean;
	/**
	 * Refuse anything but a relay.
	 *
	 * `RTCConfiguration.iceTransportPolicy: 'relay'`. Not a performance setting -
	 * it is a privacy one: a direct connection tells the far end your address,
	 * and forcing a relay hides both ends from each other. Costs latency, so it
	 * is off by default and labelled for what it is.
	 */
	forceRelay: boolean;
}

/**
 * Google's public STUN servers.
 *
 * A default rather than a recommendation, and it is stated in the settings copy:
 * using them tells Google the IP address of anything that connects. They are
 * here because a STUN-less default silently fails for most home users, and a
 * feature that fails silently is worse than one that discloses an IP and says
 * so. Both are removable and neither is required on a LAN.
 */
export const DEFAULT_STUN_URLS: readonly string[] = [
	'stun:stun.l.google.com:19302',
	'stun:stun1.l.google.com:19302',
];

export const DEFAULT_ICE_SETTINGS: IceTransportSettings = {
	stunUrls: [...DEFAULT_STUN_URLS],
	turn: { enabled: false, url: '', username: '', credential: '' },
	hostCandidates: true,
	forceRelay: false,
};

/** The one paragraph a user has to read before blaming the tunnel. Shown in Settings. */
export const TUNNEL_MEDIA_NOTE =
	'The Cloudflare quick tunnel that serves the browser interface cannot carry voice audio. ' +
	'It is an HTTPS reverse proxy and the audio leg is a direct UDP connection between the two ' +
	'devices, so the media path is separate from the tunnel rather than borrowed from it. On the ' +
	'same network (or a Tailscale-style overlay) the connection is direct and needs nothing else. ' +
	'Off your network, a phone on cellular sits behind carrier-grade NAT and genuinely requires a ' +
	'TURN relay.';

/** The one sentence per candidate type, used by the device list and the test button. */
export const CANDIDATE_TYPE_LABELS: Record<DeviceCandidateType, string> = {
	lan: 'Direct (LAN or overlay)',
	stun: 'Direct (through NAT)',
	relay: 'Relayed (TURN)',
	unknown: 'Not connected',
};

export const CANDIDATE_TYPE_DESCRIPTIONS: Record<DeviceCandidateType, string> = {
	lan: 'Audio goes straight between the two devices on your own network. Nothing else is in the path.',
	stun: 'Audio goes straight between the two devices. A STUN server was used to find the route, but carries no audio.',
	relay:
		'Audio is being forwarded by your TURN server. This is the path that works on cellular, and it adds a hop of latency.',
	unknown: 'No connection has been negotiated yet.',
};

// ---------------------------------------------------------------------------
// Reading stored settings
// ---------------------------------------------------------------------------

function asStringList(value: unknown, fallback: readonly string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	const urls = value.filter(
		(entry): entry is string => typeof entry === 'string' && !!entry.trim()
	);
	return urls.map((url) => url.trim());
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * Widen whatever is on disk into a complete configuration.
 *
 * Sanitised rather than validated, for the same reason as the floor-control
 * config: these numbers and strings come from a settings pane, and a typo must
 * not be able to throw somewhere that leaves a device unable to connect with no
 * explanation.
 */
export function readIceSettings(stored: unknown): IceTransportSettings {
	const raw = (stored ?? {}) as Record<string, unknown>;
	const turnRaw = (raw.turn ?? {}) as Record<string, unknown>;
	const url = asString(turnRaw.url);
	return {
		stunUrls: asStringList(raw.stunUrls, DEFAULT_STUN_URLS),
		turn: {
			// A TURN server switched on with no URL is off, whatever the flag says:
			// the alternative is an ICE configuration that throws on an empty `urls`.
			enabled: turnRaw.enabled === true && !!url,
			url,
			username: asString(turnRaw.username),
			credential: asString(turnRaw.credential),
		},
		hostCandidates: raw.hostCandidates !== false,
		forceRelay: raw.forceRelay === true,
	};
}

// ---------------------------------------------------------------------------
// Building the configuration
// ---------------------------------------------------------------------------

/**
 * The `RTCIceServer[]` for a peer connection.
 *
 * TURN is appended last so ICE tries the free paths first; the browser's own
 * candidate-pair prioritisation does the rest.
 */
export function buildIceServers(settings: IceTransportSettings): IceServerConfig[] {
	const servers: IceServerConfig[] = [];
	if (settings.stunUrls.length > 0) servers.push({ urls: [...settings.stunUrls] });
	if (settings.turn.enabled && settings.turn.url) {
		servers.push({
			urls: settings.turn.url,
			username: settings.turn.username,
			credential: settings.turn.credential,
		});
	}
	return servers;
}

/** `iceTransportPolicy` for a peer, which is the only thing `forceRelay` changes. */
export function iceTransportPolicy(settings: IceTransportSettings): 'all' | 'relay' {
	return settings.forceRelay ? 'relay' : 'all';
}

/**
 * What a configuration can and cannot reach, in one sentence, for the settings
 * pane. Written as a statement of fact rather than a warning, because the user
 * needs to decide whether to run a TURN server and cannot decide that from a
 * yellow triangle.
 */
export function describeIceReach(settings: IceTransportSettings): string {
	if (settings.forceRelay) {
		return settings.turn.enabled
			? 'Relay only. Every connection goes through your TURN server, including ones on this network.'
			: 'Relay only is on but no TURN server is configured, so no device can connect at all.';
	}
	if (settings.turn.enabled) {
		return 'This network, overlay networks, most home NATs through STUN, and cellular through your TURN relay.';
	}
	if (settings.stunUrls.length > 0) {
		return 'This network, overlay networks, and most home NATs. Cellular will not connect without a TURN server.';
	}
	return 'This network and overlay networks only. Nothing outside them will connect without STUN.';
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * Collapse an ICE candidate type onto the three words a person can act on.
 *
 * `prflx` joins `srflx` under `stun`: both mean the media is direct and a
 * reflexive address was involved, and the difference between them is an ICE
 * implementation detail nobody outside this file should have to hold.
 */
export function classifyCandidateType(candidateType: string | undefined): DeviceCandidateType {
	switch (candidateType) {
		case 'host':
			return 'lan';
		case 'srflx':
		case 'prflx':
			return 'stun';
		case 'relay':
			return 'relay';
		default:
			return 'unknown';
	}
}

/**
 * The winning pair's type, from the LOCAL and REMOTE candidate types.
 *
 * A relay on either end means the media is relayed, so the worse of the two is
 * the honest answer: a device list that said "direct" because our end happened
 * to gather a host candidate would be describing a path the audio is not taking.
 */
export function classifyCandidatePair(
	localType: string | undefined,
	remoteType: string | undefined
): DeviceCandidateType {
	const local = classifyCandidateType(localType);
	const remote = classifyCandidateType(remoteType);
	if (local === 'unknown' || remote === 'unknown') return 'unknown';
	const rank: Record<Exclude<DeviceCandidateType, 'unknown'>, number> = {
		lan: 0,
		stun: 1,
		relay: 2,
	};
	return rank[local] >= rank[remote] ? local : remote;
}

/**
 * Addresses a device could be told to try, best first.
 *
 * Includes overlay-network addresses (Tailscale hands out 100.64.0.0/10) as
 * first-class entries rather than filtering them out as "not a real LAN": an
 * overlay is exactly the zero-infrastructure remote case this transport is
 * happiest on, and a QR code that omitted the Tailscale address would send a
 * user to TURN for a connection they could have had directly.
 */
export function listHostCandidates(): string[] {
	const primary = getLocalIpAddressSync();
	const all = listLocalIpv4Addresses();
	const ordered = [primary, ...all].filter((ip) => ip && ip !== 'localhost');
	return Array.from(new Set(ordered));
}

/** True for the CGNAT block Tailscale and friends allocate out of. */
export function isOverlayAddress(ip: string): boolean {
	const parts = ip.split('.').map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
	return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}
