/**
 * WebRTC signaling for A Cappella, carried on the existing authenticated
 * WebSocket at `/$TOKEN/ws`.
 *
 * There is no second port and no second auth surface. A device reaches the same
 * socket the browser interface uses, so it has already cleared the server token
 * before a single A Cappella message is looked at; this service adds the
 * per-device layer on top of that:
 *
 *   1. **Pairing** (`pair-claim`, `pair-poll`) is the only thing an unpaired
 *      device may say. It buys a request that a human on the desktop has to
 *      approve. See `../pairing/pairing-service.ts`.
 *   2. **Authentication** (`auth`) exchanges the long-lived device token for a
 *      signaling session. A revoked device fails here, every time, because the
 *      check is a lookup rather than a cached decision.
 *   3. **Signaling** (`offer`, `ice-candidate`) is refused outright until step 2
 *      has succeeded on THIS socket. A connection is never inherited.
 *
 * Renegotiation is a first-class path, not an edge case. A phone walking from
 * WiFi to LTE re-offers on the same authenticated socket and the peer is updated
 * in place, so the media leg survives the handover. That is also why offers are
 * rate limited rather than allowed once: the legitimate case sends several over
 * a session, and the abusive case sends hundreds.
 *
 * Free of Fastify and of Electron. The socket is a `send` callback, the peer is
 * an injected {@link SignalingPeerHost}, and the clock is an option, so the
 * whole protocol runs in a test with no network at all.
 */

import type {
	IceCandidatePayload,
	SessionDescriptionPayload,
} from '../../../shared/acappella/webrtc-host';
import type { RemoteAudioConfig } from '../../../shared/acappella/webrtc-host';
import { DEFAULT_REMOTE_AUDIO_CONFIG } from '../../../shared/acappella/webrtc-host';
import {
	DEVICE_PROTOCOL_VERSION,
	MIN_SUPPORTED_DEVICE_PROTOCOL_VERSION,
	negotiateProtocolVersion,
} from '../../../shared/acappella/device-protocol';
import { logger } from '../../utils/logger';
import type { PairingService } from '../pairing/pairing-service';
import { buildIceServers, type IceTransportSettings } from './ice-config';

const LOG_CONTEXT = 'ACappella';

/** The WebSocket message type this service owns. One envelope, many payloads. */
export const ACAPPELLA_SIGNAL_MESSAGE = 'acappella_signal';

/**
 * How many offers one device may send per {@link OFFER_RATE_WINDOW_MS}.
 *
 * Sized for the real workload: an initial offer plus a renegotiation on every
 * network change. Six a minute covers a bus ride through four cell handovers and
 * still stops a client stuck in a reconnect loop from rebuilding a peer
 * connection fifty times a second.
 */
export const OFFER_RATE_LIMIT = 6;
export const OFFER_RATE_WINDOW_MS = 60_000;

/**
 * How many failed `auth` attempts one socket gets before it is cut off.
 *
 * The token is 32 random bytes, so this is not really about guessing; it is
 * about a client with a stale credential retrying in a tight loop.
 */
export const AUTH_ATTEMPT_LIMIT = 5;

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

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
			iceServers: ReturnType<typeof buildIceServers>;
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

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The peer connection, wherever it actually lives. In production this forwards
 * to the hidden audio window over `acappella:webrtc-command`.
 */
export interface SignalingPeerHost {
	acceptOffer(params: {
		deviceId: string;
		offer: SessionDescriptionPayload;
		iceServers: ReturnType<typeof buildIceServers>;
		audio: RemoteAudioConfig;
	}): void;
	addIceCandidate(deviceId: string, candidate: IceCandidatePayload): void;
	closePeer(deviceId: string, reason: string): void;
}

export interface SignalingServiceOptions {
	pairing: PairingService;
	peerHost: SignalingPeerHost;
	/** Read fresh per offer, so a settings change applies to the next connection. */
	getIceSettings: () => IceTransportSettings;
	getAudioConfig?: () => RemoteAudioConfig;
	now?: () => number;
	/** A device authenticated. The remote-session coordinator binds here. */
	onDeviceOnline?: (deviceId: string) => void;
	/** A device's signaling session ended, for any reason. */
	onDeviceOffline?: (deviceId: string, reason: string) => void;
}

/** One connected socket, from this service's point of view. */
interface SignalingSession {
	clientId: string;
	send: (message: SignalingServerMessage) => void;
	deviceId: string | null;
	protocolVersion: number;
	remoteAddress?: string;
	authAttempts: number;
	/** Epoch ms of each accepted offer inside the current window. */
	offerTimes: number[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SignalingService {
	private readonly options: SignalingServiceOptions;
	private readonly sessions = new Map<string, SignalingSession>();
	/** deviceId -> clientId. One live signaling session per device. */
	private readonly byDevice = new Map<string, string>();
	private readonly disposers: Array<() => void> = [];

	constructor(options: SignalingServiceOptions) {
		this.options = options;
		// Revocation has to reach a LIVE connection, which is the whole reason the
		// pairing service publishes it as an event instead of a flag.
		this.disposers.push(
			options.pairing.onRevoke((deviceId, reason) => this.closeDevice(deviceId, reason))
		);
	}

	dispose(): void {
		for (const dispose of this.disposers) dispose();
		this.disposers.length = 0;
		for (const clientId of [...this.sessions.keys()]) {
			this.handleDisconnect(clientId);
		}
	}

	/**
	 * A socket connected. Nothing is trusted yet beyond the server token.
	 *
	 * Idempotent: the WebSocket route registers lazily, on the first A Cappella
	 * message rather than on connect, so this runs again for every message on an
	 * already-registered socket. Rebuilding the session there would silently
	 * discard the device it had authenticated.
	 */
	register(params: {
		clientId: string;
		send: (message: SignalingServerMessage) => void;
		remoteAddress?: string;
	}): void {
		const existing = this.sessions.get(params.clientId);
		if (existing) {
			existing.send = params.send;
			return;
		}
		this.sessions.set(params.clientId, {
			clientId: params.clientId,
			send: params.send,
			deviceId: null,
			protocolVersion: DEVICE_PROTOCOL_VERSION,
			remoteAddress: params.remoteAddress,
			authAttempts: 0,
			offerTimes: [],
		});
	}

	/** A socket went away. */
	handleDisconnect(clientId: string): void {
		const session = this.sessions.get(clientId);
		if (!session) return;
		this.sessions.delete(clientId);
		if (!session.deviceId) return;
		if (this.byDevice.get(session.deviceId) === clientId) {
			this.byDevice.delete(session.deviceId);
		}
		this.options.peerHost.closePeer(session.deviceId, 'signaling closed');
		this.options.onDeviceOffline?.(session.deviceId, 'disconnected');
	}

	/** Is this device currently signaling? Used by the device list. */
	isOnline(deviceId: string): boolean {
		return this.byDevice.has(deviceId);
	}

	onlineDeviceIds(): string[] {
		return [...this.byDevice.keys()];
	}

	/**
	 * End a device's session now: peer down, socket told, coordinator informed.
	 *
	 * The order matters. The device is told BEFORE the peer is closed so the
	 * message goes out over a socket that is still open; a `closed` frame written
	 * after the teardown is a frame nobody receives.
	 */
	closeDevice(deviceId: string, reason: string): void {
		const clientId = this.byDevice.get(deviceId);
		this.byDevice.delete(deviceId);
		if (clientId) {
			const session = this.sessions.get(clientId);
			if (session) {
				session.send({ op: 'closed', reason });
				session.deviceId = null;
				session.offerTimes = [];
			}
		}
		this.options.peerHost.closePeer(deviceId, reason);
		this.options.onDeviceOffline?.(deviceId, reason);
	}

	// -- Inbound -------------------------------------------------------------

	/** One `acappella_signal` payload from a client. */
	async handleMessage(clientId: string, payload: unknown): Promise<void> {
		const session = this.sessions.get(clientId);
		if (!session) return;
		const message = parseClientMessage(payload);
		if (!message) {
			session.send({ op: 'error', code: 'malformed', message: 'Unrecognised signaling message.' });
			return;
		}

		switch (message.op) {
			case 'pair-claim':
				this.handlePairClaim(session, message);
				return;
			case 'pair-poll':
				this.handlePairPoll(session, message);
				return;
			case 'auth':
				await this.handleAuth(session, message);
				return;
			case 'offer':
				this.handleOffer(session, message);
				return;
			case 'ice-candidate':
				this.handleIceCandidate(session, message);
				return;
			case 'bye':
				if (session.deviceId) this.closeDevice(session.deviceId, 'the device disconnected');
				return;
		}
	}

	/** The peer answered. Forwarded to whichever socket owns that device. */
	deliverAnswer(deviceId: string, sdp: SessionDescriptionPayload): void {
		this.sendToDevice(deviceId, { op: 'answer', sdp });
	}

	/** A locally gathered candidate, trickled out as soon as it exists. */
	deliverIceCandidate(deviceId: string, candidate: IceCandidatePayload): void {
		this.sendToDevice(deviceId, { op: 'ice-candidate', candidate });
	}

	/** The peer failed in a way the device needs to hear about. */
	deliverPeerError(deviceId: string, message: string): void {
		this.sendToDevice(deviceId, { op: 'error', code: 'peer-failed', message });
	}

	// -- Handlers ------------------------------------------------------------

	private handlePairClaim(
		session: SignalingSession,
		message: Extract<SignalingClientMessage, { op: 'pair-claim' }>
	): void {
		const result = this.options.pairing.claim({
			code: message.code,
			name: message.name,
			platform: message.platform,
			appVersion: message.appVersion,
			remoteAddress: session.remoteAddress,
		});
		if (result.status === 'rejected') {
			session.send({
				op: 'pair-rejected',
				reason: result.reason,
				message: pairingRejectionMessage(result.reason),
			});
			return;
		}
		session.send({
			op: 'pair-pending',
			requestId: result.requestId,
			expiresAt: result.expiresAt,
		});
	}

	private handlePairPoll(
		session: SignalingSession,
		message: Extract<SignalingClientMessage, { op: 'pair-poll' }>
	): void {
		const result = this.options.pairing.redeem(message.requestId);
		switch (result.status) {
			case 'pending':
				session.send({ op: 'pair-pending', requestId: message.requestId, expiresAt: 0 });
				return;
			case 'approved':
				session.send({ op: 'pair-approved', deviceId: result.deviceId, token: result.token });
				return;
			case 'denied':
				session.send({ op: 'pair-denied' });
				return;
			case 'expired':
				session.send({
					op: 'pair-rejected',
					reason: 'expired',
					message: pairingRejectionMessage('expired'),
				});
				return;
		}
	}

	private async handleAuth(
		session: SignalingSession,
		message: Extract<SignalingClientMessage, { op: 'auth' }>
	): Promise<void> {
		const negotiation = negotiateProtocolVersion(message.protocolVersion);
		if (!negotiation.ok) {
			// Version first, before the credential is even looked at: a client that
			// cannot be talked to correctly should be told THAT, rather than being
			// authenticated into a session where it will misbehave silently.
			session.send({ op: 'error', code: 'protocol-version', message: negotiation.message });
			return;
		}

		if (session.authAttempts >= AUTH_ATTEMPT_LIMIT) {
			session.send({ op: 'error', code: 'rate-limited', message: 'Too many failed attempts.' });
			return;
		}

		const device = await this.options.pairing.authenticate(message.deviceId, message.token);
		if (!device) {
			session.authAttempts += 1;
			session.send({
				op: 'auth-failed',
				reason: 'unauthorized',
				message: 'This device is not paired with this computer, or its pairing was revoked.',
			});
			return;
		}

		// One live signaling session per device. A second login displaces the first
		// rather than running two, because two sockets claiming one device would
		// both be told to hold the floor.
		const previous = this.byDevice.get(device.id);
		if (previous && previous !== session.clientId) {
			const stale = this.sessions.get(previous);
			if (stale) {
				stale.send({ op: 'closed', reason: 'this device connected again from somewhere else' });
				stale.deviceId = null;
			}
			this.options.peerHost.closePeer(device.id, 'replaced by a newer connection');
		}

		session.deviceId = device.id;
		session.protocolVersion = negotiation.version;
		session.authAttempts = 0;
		session.offerTimes = [];
		this.byDevice.set(device.id, session.clientId);

		const iceSettings = this.options.getIceSettings();
		session.send({
			op: 'authenticated',
			deviceId: device.id,
			protocolVersion: negotiation.version,
			iceServers: buildIceServers(iceSettings),
			iceTransportPolicy: iceSettings.forceRelay ? 'relay' : 'all',
			audio: this.options.getAudioConfig?.() ?? DEFAULT_REMOTE_AUDIO_CONFIG,
		});
		this.options.onDeviceOnline?.(device.id);
		logger.info(`Device '${device.name}' authenticated for A Cappella signaling`, LOG_CONTEXT);
	}

	private handleOffer(
		session: SignalingSession,
		message: Extract<SignalingClientMessage, { op: 'offer' }>
	): void {
		if (!session.deviceId) {
			session.send({
				op: 'error',
				code: 'not-authenticated',
				message: 'Authenticate this device before sending an offer.',
			});
			return;
		}
		if (!this.consumeOfferAllowance(session)) {
			session.send({
				op: 'error',
				code: 'rate-limited',
				message: `Too many connection attempts. Wait a moment and try again.`,
			});
			return;
		}

		const iceSettings = this.options.getIceSettings();
		this.options.peerHost.acceptOffer({
			deviceId: session.deviceId,
			offer: message.sdp,
			iceServers: buildIceServers(iceSettings),
			audio: this.options.getAudioConfig?.() ?? DEFAULT_REMOTE_AUDIO_CONFIG,
		});
	}

	private handleIceCandidate(
		session: SignalingSession,
		message: Extract<SignalingClientMessage, { op: 'ice-candidate' }>
	): void {
		if (!session.deviceId) {
			session.send({
				op: 'error',
				code: 'not-authenticated',
				message: 'Authenticate this device before trickling candidates.',
			});
			return;
		}
		this.options.peerHost.addIceCandidate(session.deviceId, message.candidate);
	}

	// -- Internals -----------------------------------------------------------

	/**
	 * Sliding window rather than a fixed one: a fixed window lets a client send
	 * its whole allowance at 59 s and again at 61 s, which is exactly the burst
	 * the limit exists to stop.
	 */
	private consumeOfferAllowance(session: SignalingSession): boolean {
		const now = (this.options.now ?? Date.now)();
		session.offerTimes = session.offerTimes.filter((at) => now - at < OFFER_RATE_WINDOW_MS);
		if (session.offerTimes.length >= OFFER_RATE_LIMIT) return false;
		session.offerTimes.push(now);
		return true;
	}

	private sendToDevice(deviceId: string, message: SignalingServerMessage): void {
		const clientId = this.byDevice.get(deviceId);
		if (!clientId) return;
		this.sessions.get(clientId)?.send(message);
	}
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an inbound payload into a message, or null.
 *
 * Everything here arrives from another machine, so nothing is trusted: an
 * unknown `op`, a missing field, or a wrong type all produce null and one
 * `malformed` reply rather than an exception inside a socket handler.
 */
export function parseClientMessage(payload: unknown): SignalingClientMessage | null {
	if (!isRecord(payload)) return null;
	switch (payload.op) {
		case 'pair-claim':
			if (typeof payload.code !== 'string') return null;
			return {
				op: 'pair-claim',
				code: payload.code,
				name: typeof payload.name === 'string' ? payload.name : '',
				platform: typeof payload.platform === 'string' ? payload.platform : '',
				appVersion: typeof payload.appVersion === 'string' ? payload.appVersion : undefined,
			};
		case 'pair-poll':
			if (typeof payload.requestId !== 'string') return null;
			return { op: 'pair-poll', requestId: payload.requestId };
		case 'auth':
			if (typeof payload.deviceId !== 'string' || typeof payload.token !== 'string') return null;
			return {
				op: 'auth',
				deviceId: payload.deviceId,
				token: payload.token,
				protocolVersion:
					typeof payload.protocolVersion === 'number'
						? payload.protocolVersion
						: MIN_SUPPORTED_DEVICE_PROTOCOL_VERSION - 1,
			};
		case 'offer': {
			const sdp = payload.sdp;
			if (!isRecord(sdp) || typeof sdp.sdp !== 'string') return null;
			return { op: 'offer', sdp: { type: 'offer', sdp: sdp.sdp } };
		}
		case 'ice-candidate': {
			const candidate = payload.candidate;
			if (!isRecord(candidate) || typeof candidate.candidate !== 'string') return null;
			return {
				op: 'ice-candidate',
				candidate: {
					candidate: candidate.candidate,
					sdpMid: typeof candidate.sdpMid === 'string' ? candidate.sdpMid : null,
					sdpMLineIndex:
						typeof candidate.sdpMLineIndex === 'number' ? candidate.sdpMLineIndex : null,
					usernameFragment:
						typeof candidate.usernameFragment === 'string' ? candidate.usernameFragment : null,
				},
			};
		}
		case 'bye':
			return { op: 'bye' };
		default:
			return null;
	}
}

function pairingRejectionMessage(reason: string): string {
	switch (reason) {
		case 'unknown-code':
			return 'That pairing code does not match the one on the desktop.';
		case 'already-used':
			return 'That pairing code has already been used. Start pairing again on the desktop.';
		case 'busy':
			return 'Another device is already waiting to be approved on the desktop.';
		default:
			return 'That pairing code has expired. Start pairing again on the desktop.';
	}
}
