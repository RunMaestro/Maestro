/**
 * The A Cappella signaling wire shapes: what a device and the desktop say to
 * each other over the authenticated WebSocket, before there is a peer
 * connection to say anything over.
 *
 * Shared for the same reason `device-protocol.ts` is shared. Two independent
 * clients already speak this - the browser reference client in
 * `src/web-desktop/acappella-client/` and, later, the iPhone - and a wire
 * contract that lives inside the server that enforces it is a contract only one
 * end can read. The validating parser stays in
 * `main/acappella/transport/signaling.ts`, where the trust boundary is; only the
 * shapes live here.
 *
 * Transport-agnostic and dependency-free: no Fastify, no Electron, no DOM.
 */

import type { IceCandidatePayload, IceServerConfig, RemoteAudioConfig } from './webrtc-host';
import type { SessionDescriptionPayload } from './webrtc-host';

/** The WebSocket message type this protocol rides in. One envelope, many payloads. */
export const ACAPPELLA_SIGNAL_MESSAGE = 'acappella_signal';

export type SignalingClientMessage =
	| { op: 'pair-claim'; code: string; name: string; platform: string; appVersion?: string }
	| { op: 'pair-poll'; requestId: string }
	| { op: 'auth'; deviceId: string; token: string; protocolVersion: number }
	| { op: 'offer'; sdp: SessionDescriptionPayload }
	| { op: 'ice-candidate'; candidate: IceCandidatePayload }
	| { op: 'bye' };

export type SignalingServerMessage =
	| { op: 'pair-pending'; requestId: string; expiresAt: number }
	| { op: 'pair-approved'; deviceId: string; token: string }
	| { op: 'pair-denied' }
	| { op: 'pair-rejected'; reason: string; message: string }
	| {
			op: 'authenticated';
			deviceId: string;
			protocolVersion: number;
			iceServers: IceServerConfig[];
			iceTransportPolicy: 'all' | 'relay';
			audio: RemoteAudioConfig;
	  }
	| { op: 'auth-failed'; reason: string; message: string }
	| { op: 'answer'; sdp: SessionDescriptionPayload }
	| { op: 'ice-candidate'; candidate: IceCandidatePayload }
	| { op: 'closed'; reason: string }
	| { op: 'error'; code: SignalingErrorCode; message: string };

/**
 * Why a signaling message was refused.
 *
 * Classified, and deliberately coarse on the authentication side: `auth-failed`
 * covers unknown device, wrong token, and revoked device alike, because telling
 * a caller which one it was is an enumeration oracle.
 */
export type SignalingErrorCode =
	| 'not-authenticated'
	| 'rate-limited'
	| 'protocol-version'
	| 'malformed'
	| 'peer-failed';
