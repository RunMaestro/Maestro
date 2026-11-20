/**
 * The A Cappella reference client: the whole device half of the protocol, with
 * no DOM in it.
 *
 * This is not a demo. It is the second endpoint the desktop is tested against,
 * and it is the executable answer to "what exactly does a phone have to send".
 * A Swift developer reads this file next to
 * `docs/ios-client/protocol-conformance.md`; the conformance suite at
 * `src/__tests__/acappella/conformance/` drives this class against fakes. Both
 * of those only work because everything here is injectable: the socket, the peer
 * connection, the microphone, the clock, and the token store are all seams.
 *
 * It imports the wire vocabulary from `shared/acappella/device-protocol.ts` and
 * the SDP/stats helpers from `shared/acappella/peer-tuning.ts` rather than
 * restating either, so the reference client and the desktop cannot drift into
 * disagreeing about the protocol they are supposed to be proving.
 *
 * What it deliberately does NOT own: gesture classification (tap versus hold),
 * the level meter, playback volume, and anything that draws. Those are DOM work
 * and they live in `main.ts` and `ui.ts`. The rule for what belongs here is
 * whether the desktop can observe it.
 */

import {
	DEVICE_PROTOCOL_VERSION,
	RELIABLE_CHANNEL_INIT,
	RELIABLE_CHANNEL_LABEL,
	UNRELIABLE_CHANNEL_INIT,
	UNRELIABLE_CHANNEL_LABEL,
	decodeDeviceMessage,
	deviceChannelForMessage,
	encodeDeviceMessage,
	type DeviceChannelKind,
	type DeviceMessage,
	type DeviceIdentity,
} from '../../shared/acappella/device-protocol';
import {
	PEER_STATS_INTERVAL_MS,
	applyOpusPreferences,
	summarizeStats,
} from '../../shared/acappella/peer-tuning';
import {
	isContiguousVoiceSeq,
	type VoiceEvent,
	type VoiceScope,
} from '../../shared/acappella/protocol';
import type {
	SignalingClientMessage,
	SignalingServerMessage,
} from '../../shared/acappella/signaling-protocol';
import type {
	IceCandidatePayload,
	IceServerConfig,
	RemoteAudioConfig,
} from '../../shared/acappella/webrtc-host';
import { DEFAULT_REMOTE_AUDIO_CONFIG } from '../../shared/acappella/webrtc-host';

// ---------------------------------------------------------------------------
// Constants the client owns
// ---------------------------------------------------------------------------

/** How often `pair-poll` runs while a human is being asked. C-03. */
export const PAIR_POLL_INTERVAL_MS = 1000;

/** `audio-level` cadence while the floor is open. C-39. */
export const AUDIO_LEVEL_INTERVAL_MS = 50;

/**
 * How long a local duck survives without the desktop confirming it.
 *
 * The duck is lifted by `barge-in` or `speak-end`, and by this timer when
 * neither arrives. A duck that never lifts is a session that appears to have
 * died, which is worse than one that briefly talks over itself. C-45.
 */
export const DUCK_TIMEOUT_MS = 500;

/** Reconnect backoff, in order. The last value repeats. */
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

/**
 * The desktop allows 6 offers per 60 s. The client stays under it by counting,
 * because the window it would blow is exactly the network handover it was
 * trying to survive. C-08.
 */
const OFFER_BUDGET = 5;
const OFFER_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** One open signaling socket, from this client's point of view. */
export interface SignalingSocket {
	send(message: SignalingClientMessage): void;
	close(): void;
}

export interface SignalingSocketHandlers {
	onOpen(): void;
	onMessage(message: SignalingServerMessage): void;
	onClose(): void;
}

/** What the desktop QR code says, plus the code a user can type instead. */
export interface PairingTarget {
	host: string;
	port: number;
	/** The web server's security token. What gets a frame looked at at all. */
	token: string;
	/** The six-character pairing code. Only needed while unpaired. */
	code?: string;
	/** True when the desktop is reachable over TLS. Rare on a LAN. */
	secure?: boolean;
}

/** A pairing this client has already completed, as stored between runs. */
export interface StoredPairing {
	deviceId: string;
	token: string;
	/** Which desktop it belongs to, so a second machine does not reuse it. */
	fingerprint: string;
}

/** The Keychain, in browser terms. Injected so a test needs no storage at all. */
export interface PairingStore {
	read(): StoredPairing | null;
	write(pairing: StoredPairing): void;
	clear(): void;
}

export interface ReferenceClientOptions {
	identity: Omit<DeviceIdentity, 'deviceId'>;
	store: PairingStore;
	openSocket: (url: string, handlers: SignalingSocketHandlers) => SignalingSocket;
	createPeerConnection: (config: RTCConfiguration) => RTCPeerConnection;
	/** Opened when, and only when, the floor is this client's. C-37. */
	openMicrophone: () => Promise<MediaStream>;
	now?: () => number;
}

// ---------------------------------------------------------------------------
// Outward state and events
// ---------------------------------------------------------------------------

/**
 * Where the client is.
 *
 * `terminal` is its own phase rather than a flag because everything that lands
 * there - a revoked pairing, a version mismatch, a `closed` frame - must not
 * reconnect, and a boolean gets forgotten in one branch eventually.
 */
export type ClientPhase =
	| 'idle'
	| 'pairing'
	| 'awaiting-approval'
	| 'authenticating'
	| 'connecting'
	| 'connected'
	| 'terminal';

export interface FloorView {
	holder: string | null;
	isSelf: boolean;
	takenOverBy?: string;
}

export interface ClientState {
	phase: ClientPhase;
	/** The desktop's sentence when there is one, shown verbatim. C-05. */
	message: string;
	deviceId: string | null;
	/** What `v` every outbound frame carries. From `authenticated`, not a constant. C-35. */
	protocolVersion: number;
	floor: FloorView;
	/** True while this client's microphone is actually open and transmitting. */
	sending: boolean;
	/** The desktop's app version, once `welcome` arrives. It does not today. */
	desktopVersion: string | null;
	quality: { rttMs: number | null; packetLoss: number; candidateType: string } | null;
	/** Set when a `seq` gap was seen on the reliable channel. C-29. */
	transcriptSuspect: boolean;
	/** True once the client refuses to retry: revoked, closed, or version-rejected. */
	canRetry: boolean;
}

export type ClientEvent =
	| { type: 'state'; state: ClientState }
	| { type: 'voice-event'; event: VoiceEvent; channel: DeviceChannelKind }
	/** The assistant's voice. The DOM layer attaches this to an audio element. */
	| { type: 'remote-track'; stream: MediaStream }
	/** Local playback should duck, or stop ducking. Applied within one frame. C-44. */
	| { type: 'duck'; ducked: boolean }
	| { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class ACappellaReferenceClient {
	private readonly options: ReferenceClientOptions;
	private readonly listeners = new Set<(event: ClientEvent) => void>();
	private readonly now: () => number;

	private target: PairingTarget | null = null;
	private socket: SignalingSocket | null = null;
	private pc: RTCPeerConnection | null = null;
	private reliable: RTCDataChannel | null = null;
	private unreliable: RTCDataChannel | null = null;
	private sender: RTCRtpSender | null = null;
	private micStream: MediaStream | null = null;

	private audio: RemoteAudioConfig = DEFAULT_REMOTE_AUDIO_CONFIG;
	private pairRequestId: string | null = null;
	private pairExpiresAt = 0;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private statsTimer: ReturnType<typeof setInterval> | null = null;
	private duckTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;
	private offerTimes: number[] = [];
	private lastBytes: { bytesReceived: number; at: number } | undefined;
	private lastLevelSentAt = 0;
	/** Last seen `seq` per voice session, for the gap check. */
	private lastSeq = new Map<string, number>();
	private ducked = false;
	/** One `auth` per socket, then a new socket. C-09. */
	private authSent = false;

	private state: ClientState = {
		phase: 'idle',
		message: '',
		deviceId: null,
		protocolVersion: DEVICE_PROTOCOL_VERSION,
		floor: { holder: null, isSelf: false },
		sending: false,
		desktopVersion: null,
		quality: null,
		transcriptSuspect: false,
		canRetry: true,
	};

	constructor(options: ReferenceClientOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	subscribe(listener: (event: ClientEvent) => void): () => void {
		this.listeners.add(listener);
		listener({ type: 'state', state: this.snapshot() });
		return () => this.listeners.delete(listener);
	}

	snapshot(): ClientState {
		return { ...this.state, floor: { ...this.state.floor } };
	}

	// -- Lifecycle ------------------------------------------------------------

	/**
	 * Point at a desktop and go.
	 *
	 * One entry point for both halves of the story: a stored pairing skips
	 * straight to `auth`, and everything else claims the code first. The phone
	 * makes the same choice on every launch.
	 */
	connect(target: PairingTarget): void {
		this.target = target;
		this.reconnectAttempt = 0;
		this.openSocket();
	}

	/** A deliberate teardown. `bye` first, so the desktop is not left to ICE. C-14. */
	disconnect(reason = 'the reference client disconnected'): void {
		this.socket?.send({ op: 'bye' });
		this.teardown(reason, { terminal: true, canRetry: true });
	}

	/** Forget the pairing. The next connect claims a fresh code. */
	forget(): void {
		this.options.store.clear();
		this.log('info', 'Stored pairing cleared. Pair again with a new code.');
	}

	// -- Floor ----------------------------------------------------------------

	/**
	 * Push-to-talk, pressed.
	 *
	 * Sent on touch-down, before tap-versus-hold has been classified, because the
	 * desktop's press is idempotent and waiting 300 ms to decide would put 300 ms
	 * in front of every single utterance. C-47.
	 *
	 * The button is NOT drawn from this call. It is drawn from the `floor-state`
	 * that comes back, because the press is a request and another device may hold
	 * the floor. C-48.
	 */
	pressFloor(scope?: VoiceScope): void {
		this.send({ type: 'floor', action: 'press', scope });
	}

	releaseFloor(): void {
		this.send({ type: 'floor', action: 'release' });
	}

	/**
	 * The user talked over the reply.
	 *
	 * Ducks local playback FIRST and sends second, in that order and in the same
	 * turn: a phone on a relayed path is 150 ms from the desktop and back, and the
	 * user has already decided the reply is wrong. C-44.
	 */
	requestBargeIn(): void {
		this.setDucked(true);
		this.send({ type: 'interrupt', kind: 'barge-in' });
	}

	/** The stop word, or the stop button. Ends the session and releases the floor. */
	requestStop(): void {
		this.setDucked(true);
		this.send({ type: 'interrupt', kind: 'stop-word' });
	}

	/**
	 * One reading from the DOM layer's level meter.
	 *
	 * Throttled to roughly 20 a second here rather than at the caller, and gated
	 * on the floor: a meter running with the floor closed is a client measuring a
	 * microphone it should not have open. C-39.
	 */
	reportAudioLevel(level: number, speech: boolean): void {
		if (!this.state.floor.isSelf) return;
		const at = this.now();
		if (at - this.lastLevelSentAt < AUDIO_LEVEL_INTERVAL_MS) return;
		this.lastLevelSentAt = at;
		this.send({ type: 'audio-level', level, speech });
	}

	// -- Signaling ------------------------------------------------------------

	private socketUrl(target: PairingTarget): string {
		const scheme = target.secure ? 'wss' : 'ws';
		return `${scheme}://${target.host}:${target.port}/${target.token}/ws`;
	}

	private openSocket(): void {
		const target = this.target;
		if (!target) return;
		this.clearReconnect();
		this.authSent = false;
		const stored = this.options.store.read();
		this.setState({
			phase: stored ? 'authenticating' : 'pairing',
			message: stored ? 'Authenticating...' : 'Claiming the pairing code...',
			canRetry: true,
		});

		this.socket = this.options.openSocket(this.socketUrl(target), {
			onOpen: () => this.handleSocketOpen(),
			onMessage: (message) => this.handleServerMessage(message),
			onClose: () => this.handleSocketClose(),
		});
	}

	private handleSocketOpen(): void {
		const stored = this.options.store.read();
		if (stored) {
			this.sendAuth(stored);
			return;
		}
		const code = this.target?.code?.trim();
		if (!code) {
			this.fail('No pairing code. Show one on the desktop and enter it here.', { canRetry: true });
			return;
		}
		// `name` and `platform` are silently coerced to the empty string when they
		// are not strings, which produces a nameless row in the approval sheet.
		// Always send both. C-02.
		this.socket?.send({
			op: 'pair-claim',
			code,
			name: this.options.identity.name,
			platform: this.options.identity.platform,
			appVersion: this.options.identity.appVersion,
		});
	}

	private sendAuth(stored: StoredPairing): void {
		if (this.authSent) return;
		this.authSent = true;
		this.setState({ phase: 'authenticating', message: 'Authenticating...' });
		this.socket?.send({
			op: 'auth',
			deviceId: stored.deviceId,
			token: stored.token,
			// Always an integer >= 1. Absent is not "unversioned"; it is "too old". C-06.
			protocolVersion: DEVICE_PROTOCOL_VERSION,
		});
	}

	private handleServerMessage(message: SignalingServerMessage): void {
		switch (message.op) {
			case 'pair-pending':
				// Only the FIRST pair-pending carries a real deadline; the one answering
				// a poll carries `expiresAt: 0`. Overwriting it here is how a pairing
				// screen's countdown jumps to 1970.
				if (!this.pairRequestId) {
					this.pairRequestId = message.requestId;
					this.pairExpiresAt = message.expiresAt;
					this.startPolling();
				}
				this.setState({
					phase: 'awaiting-approval',
					message: 'Waiting for someone to approve this device on the desktop.',
				});
				return;

			case 'pair-approved': {
				this.stopPolling();
				// Written before any UI state changes, so a crash between the two leaves
				// a usable pairing rather than a token the desktop thinks it issued. C-04.
				this.options.store.write({
					deviceId: message.deviceId,
					token: message.token,
					fingerprint: this.target?.token.slice(0, 8) ?? '',
				});
				this.pairRequestId = null;
				this.log('info', 'Paired. Authenticating with the stored token.');
				this.sendAuth({ deviceId: message.deviceId, token: message.token, fingerprint: '' });
				return;
			}

			case 'pair-denied':
				this.stopPolling();
				this.pairRequestId = null;
				this.fail('The desktop denied this device.', { canRetry: true });
				return;

			case 'pair-rejected':
				this.stopPolling();
				this.pairRequestId = null;
				// Verbatim, with nothing appended. C-05.
				this.fail(message.message, { canRetry: true });
				return;

			case 'authenticated':
				this.setState({
					deviceId: message.deviceId,
					// The lower of the two ends, which may be below our own constant. C-35.
					protocolVersion: message.protocolVersion,
					phase: 'connecting',
					message: 'Negotiating the media connection...',
				});
				this.audio = message.audio ?? DEFAULT_REMOTE_AUDIO_CONFIG;
				void this.startPeer(message.iceServers, message.iceTransportPolicy);
				return;

			case 'auth-failed':
				// Unknown device, wrong token, and revoked device are one answer on
				// purpose. All three are terminal for the stored token. C-13.
				this.options.store.clear();
				this.fail(message.message, { canRetry: true });
				return;

			case 'answer':
				void this.pc?.setRemoteDescription({ type: 'answer', sdp: message.sdp.sdp });
				return;

			case 'ice-candidate':
				void this.pc
					?.addIceCandidate(message.candidate as RTCIceCandidateInit)
					.catch((error: unknown) => {
						// Trickle traffic that arrives before the remote description, or
						// for an m-line ICE has given up on, is normal.
						this.log('info', `Discarded a candidate: ${errorText(error)}`);
					});
				return;

			case 'closed':
				// Terminal. A `closed` is the desktop saying this session is over, which
				// includes being displaced by the same device connecting from elsewhere.
				this.teardown(message.reason, { terminal: true, canRetry: true });
				return;

			case 'error':
				this.handleSignalingError(message.code, message.message);
				return;
		}
	}

	private handleSignalingError(code: string, message: string): void {
		switch (code) {
			case 'protocol-version':
				// Terminal, and the stored token stays: this is not an authentication
				// failure, the pairing is still valid, and deleting it here would turn a
				// five-minute update into a re-pair. C-33, C-34.
				this.teardown(message, { terminal: true, canRetry: false });
				return;
			case 'peer-failed':
				// The desktop's peer died. Restart ICE and re-offer under the budget
				// rather than re-pairing. C-15.
				this.log('warn', message);
				void this.renegotiate(true);
				return;
			case 'rate-limited':
				// A new socket after backoff, never a tighter loop.
				this.teardown(message, { terminal: false, canRetry: true });
				return;
			default:
				// `not-authenticated` and `malformed` are bugs in this client. Say so
				// loudly rather than retrying the same bytes.
				this.log('error', `Signaling error (${code}): ${message}`);
				return;
		}
	}

	private handleSocketClose(): void {
		this.socket = null;
		this.stopPolling();
		if (this.state.phase === 'terminal') return;
		this.scheduleReconnect('The connection to the desktop dropped.');
	}

	private startPolling(): void {
		this.stopPolling();
		this.pollTimer = setInterval(() => {
			if (!this.pairRequestId) return;
			// Stop at the deadline from the FIRST pair-pending rather than polling a
			// code that cannot be approved any more. C-03.
			if (this.pairExpiresAt > 0 && this.now() > this.pairExpiresAt) {
				this.stopPolling();
				this.pairRequestId = null;
				this.fail('That pairing code expired. Show a new one on the desktop.', { canRetry: true });
				return;
			}
			this.socket?.send({ op: 'pair-poll', requestId: this.pairRequestId });
		}, PAIR_POLL_INTERVAL_MS);
	}

	private stopPolling(): void {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = null;
	}

	// -- Peer connection ------------------------------------------------------

	/**
	 * Build the peer and offer.
	 *
	 * The client is the offerer, so the client creates both data channels, with
	 * the exact labels and inits the desktop binds on. A label the desktop does
	 * not recognise is closed without a word, so a typo here is a dead channel
	 * rather than an error. C-16, C-17.
	 */
	private async startPeer(iceServers: IceServerConfig[], policy: 'all' | 'relay'): Promise<void> {
		this.closePeer();
		const pc = this.options.createPeerConnection({
			// As sent. There is no hard-coded STUN server in this client. C-10.
			iceServers: iceServers as RTCIceServer[],
			iceTransportPolicy: policy,
			iceCandidatePoolSize: 2,
		});
		this.pc = pc;

		pc.onicecandidate = (event) => {
			if (!event.candidate) return;
			this.socket?.send({
				op: 'ice-candidate',
				candidate: {
					candidate: event.candidate.candidate,
					sdpMid: event.candidate.sdpMid,
					sdpMLineIndex: event.candidate.sdpMLineIndex,
					usernameFragment: event.candidate.usernameFragment,
				} as IceCandidatePayload,
			});
		};
		pc.ontrack = (event) => {
			const stream = event.streams[0] ?? new MediaStream([event.track]);
			this.emit({ type: 'remote-track', stream });
		};
		pc.onconnectionstatechange = () => this.handlePeerState(pc.connectionState);

		this.reliable = pc.createDataChannel(RELIABLE_CHANNEL_LABEL, { ...RELIABLE_CHANNEL_INIT });
		this.unreliable = pc.createDataChannel(UNRELIABLE_CHANNEL_LABEL, {
			...UNRELIABLE_CHANNEL_INIT,
		});
		this.bindChannel(this.reliable, 'reliable');
		this.bindChannel(this.unreliable, 'unreliable');

		// A sendrecv audio transceiver with no track yet: the m-line exists from the
		// first offer, so opening the microphone later is a `replaceTrack` rather
		// than a renegotiation, and nothing is captured until the floor opens. C-37.
		const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
		this.sender = transceiver.sender;

		await this.renegotiate(false);
		this.startStatsPolling();
	}

	/** Create an offer, tune it, and send it - if the budget allows. */
	private async renegotiate(restartIce: boolean): Promise<void> {
		const pc = this.pc;
		if (!pc) return;
		if (!this.consumeOfferBudget()) {
			this.log('warn', 'Offer budget exhausted. Backing off rather than being rate limited.');
			return;
		}
		try {
			const offer = await pc.createOffer({ iceRestart: restartIce });
			// The desktop's `authenticated.audio` applied to the outgoing encoder:
			// FEC, DTX, and the target bitrate. C-11.
			const sdp = offer.sdp ? applyOpusPreferences(offer.sdp, this.audio) : offer.sdp;
			await pc.setLocalDescription({ type: 'offer', sdp });
			this.applySenderBitrate();
			this.socket?.send({ op: 'offer', sdp: { type: 'offer', sdp: sdp ?? '' } });
		} catch (error) {
			this.log('error', `Could not offer: ${errorText(error)}`);
		}
	}

	private consumeOfferBudget(): boolean {
		const at = this.now();
		this.offerTimes = this.offerTimes.filter((time) => at - time < OFFER_WINDOW_MS);
		if (this.offerTimes.length >= OFFER_BUDGET) return false;
		this.offerTimes.push(at);
		return true;
	}

	private applySenderBitrate(): void {
		const sender = this.sender;
		if (!sender) return;
		const parameters = sender.getParameters();
		if (!parameters.encodings || parameters.encodings.length === 0) {
			parameters.encodings = [{}];
		}
		for (const encoding of parameters.encodings) {
			encoding.maxBitrate = this.audio.maxAverageBitrate;
			encoding.networkPriority = 'high';
		}
		void sender.setParameters(parameters).catch(() => {
			// Some parameter sets are refused depending on what was negotiated. The
			// SDP already carries the target, so this is the second of two belts.
		});
	}

	private handlePeerState(state: RTCPeerConnectionState): void {
		if (state === 'connected') {
			this.reconnectAttempt = 0;
			this.setState({ phase: 'connected', message: 'Connected.' });
			return;
		}
		if (state === 'failed') {
			this.log('warn', 'The peer connection failed. Restarting ICE.');
			void this.renegotiate(true);
		}
		// `disconnected` is ICE noticing a network change, and a walk out of WiFi
		// range recovers from it within seconds. It is deliberately not a teardown.
	}

	// -- Data channels --------------------------------------------------------

	private bindChannel(channel: RTCDataChannel, kind: DeviceChannelKind): void {
		channel.onopen = () => {
			if (kind !== 'reliable') return;
			// `hello` is the first frame on the state channel, and the client does NOT
			// block on `welcome`: desktop v1 settles the version at `auth` and never
			// sends one. Gating the UI on a reply that will not arrive is the failure
			// this note exists to prevent. C-19, C-31.
			this.send({
				type: 'hello',
				identity: {
					deviceId: this.state.deviceId ?? '',
					name: this.options.identity.name,
					platform: this.options.identity.platform,
					appVersion: this.options.identity.appVersion,
				},
			});
		};
		channel.onmessage = (event) => {
			const raw = typeof event.data === 'string' ? event.data : String(event.data);
			const message = decodeDeviceMessage(raw);
			// Malformed and unknown frames are dropped individually. They never close
			// the channel or the peer. C-22.
			if (!message) return;
			this.handleDeviceMessage(message, kind);
		};
	}

	/**
	 * Send one protocol message on the channel the routing table names.
	 *
	 * The reliable channel is the fallback for a lossy message whose channel is
	 * not open yet - late beats never for the first frames - and `v` is stamped
	 * from the NEGOTIATED version, not from this build's constant. A frame without
	 * a numeric `v` is dropped by the desktop in complete silence. C-18, C-21.
	 */
	private send(message: DeviceMessage): void {
		const kind = deviceChannelForMessage(message);
		const preferred = kind === 'reliable' ? this.reliable : this.unreliable;
		const channel = preferred?.readyState === 'open' ? preferred : this.reliable;
		if (!channel || channel.readyState !== 'open') return;
		try {
			channel.send(encodeDeviceMessage(message, this.state.protocolVersion));
		} catch (error) {
			this.log('warn', `Data channel send failed: ${errorText(error)}`);
		}
	}

	private handleDeviceMessage(message: DeviceMessage, channel: DeviceChannelKind): void {
		switch (message.type) {
			case 'floor-state': {
				const wasSelf = this.state.floor.isSelf;
				this.setState({
					floor: {
						holder: message.holder,
						// Trust `isSelf`: it saves an id comparison and it is the desktop's
						// own answer to a question only the desktop can settle. C-48.
						isSelf: message.isSelf,
						takenOverBy: message.takenOverBy,
					},
				});
				if (message.isSelf && !wasSelf) void this.openFloorAudio();
				if (!message.isSelf && wasSelf) this.closeFloorAudio();
				if (message.takenOverBy) {
					this.log('info', `${message.takenOverBy} took the floor.`);
				}
				return;
			}

			case 'voice-event':
				this.noteSequence(message.event, channel);
				this.reactToVoiceEvent(message.event);
				this.emit({ type: 'voice-event', event: message.event, channel });
				return;

			case 'welcome':
				// Not sent by desktop v1. Handled anyway, because it will be, and a
				// client that treated it as unknown would drop the sessionId. C-32.
				this.setState({
					protocolVersion: message.version,
					desktopVersion: message.appVersion,
				});
				return;

			case 'version-rejected':
				this.teardown(message.message, { terminal: true, canRetry: false });
				return;

			case 'revoked':
				// The last frame before teardown. Terminal, and the stored pairing is
				// worthless now. C-12.
				this.options.store.clear();
				this.teardown(message.message, { terminal: true, canRetry: true });
				return;

			case 'link-quality':
				this.setState({
					quality: {
						rttMs: message.rttMs,
						packetLoss: message.packetLoss,
						candidateType: message.candidateType,
					},
				});
				return;

			default:
				// `hello`, `floor`, `interrupt`, `audio-level` from the desktop are not
				// things the desktop sends. Ignored rather than trusted.
				return;
		}
	}

	/**
	 * Track `seq` per voice session on the reliable channel only.
	 *
	 * A gap there means frames were lost and the transcript is suspect. Gaps on
	 * the lossy channel are the design working: `audio-level` and
	 * `partial-transcript` ride it precisely because a late retransmission is
	 * worse than the loss it repaired. C-29.
	 */
	private noteSequence(event: VoiceEvent, channel: DeviceChannelKind): void {
		if (channel !== 'reliable') return;
		const previous = this.lastSeq.get(event.sessionId);
		this.lastSeq.set(event.sessionId, event.seq);
		// A new session restarts at 1, which is not a gap.
		if (previous === undefined) return;
		if (!isContiguousVoiceSeq(previous, event.seq) && event.seq > previous) {
			this.setState({ transcriptSuspect: true });
			this.log('warn', `Lost ${event.seq - previous - 1} event(s). The transcript is suspect.`);
		}
	}

	/** The few session events that change what this client is doing, not just showing. */
	private reactToVoiceEvent(event: VoiceEvent): void {
		switch (event.type) {
			case 'barge-in':
			case 'speak-end':
				// The authoritative confirmation. Barge-in KEEPS the floor; only the
				// stop word releases it, and the desktop enforces that distinction. C-46.
				this.setDucked(false);
				return;
			case 'stop-word':
				this.setDucked(false);
				return;
			default:
				return;
		}
	}

	// -- Microphone -----------------------------------------------------------

	/**
	 * Open the microphone, because the floor is now genuinely ours.
	 *
	 * The track is attached with `replaceTrack`, which needs no renegotiation, and
	 * it is released the moment the floor closes. This is the browser's honest
	 * equivalent of `RTCAudioSession.useManualAudio` on iOS: the recording
	 * indicator then tracks the floor exactly, which is the property the whole
	 * "nothing before the floor" rule exists to give the user. C-37, C-38.
	 */
	private async openFloorAudio(): Promise<void> {
		if (this.micStream) return;
		try {
			const stream = await this.options.openMicrophone();
			// The floor can close while getUserMedia is resolving.
			if (!this.state.floor.isSelf) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			this.micStream = stream;
			const track = stream.getAudioTracks()[0] ?? null;
			await this.sender?.replaceTrack(track);
			this.setState({ sending: true });
		} catch (error) {
			this.log('error', `Could not open the microphone: ${errorText(error)}`);
			this.releaseFloor();
		}
	}

	private closeFloorAudio(): void {
		void this.sender?.replaceTrack(null);
		for (const track of this.micStream?.getTracks() ?? []) track.stop();
		this.micStream = null;
		this.setState({ sending: false });
	}

	/** The live microphone stream, for the DOM layer's meter. Null when closed. */
	get microphone(): MediaStream | null {
		return this.micStream;
	}

	// -- Stats ----------------------------------------------------------------

	/**
	 * Read `getStats()` on the same 2 s cadence the desktop uses and send the same
	 * four numbers back, so both ends draw one bar from one measurement. C-40.
	 */
	private startStatsPolling(): void {
		this.stopStatsPolling();
		this.statsTimer = setInterval(() => void this.pollStats(), PEER_STATS_INTERVAL_MS);
	}

	private stopStatsPolling(): void {
		if (this.statsTimer) clearInterval(this.statsTimer);
		this.statsTimer = null;
	}

	private async pollStats(): Promise<void> {
		const pc = this.pc;
		if (!pc) return;
		try {
			const report = await pc.getStats();
			const reports: Array<Record<string, unknown>> = [];
			report.forEach((value) => reports.push(value as unknown as Record<string, unknown>));
			const at = this.now();
			const { bytesReceived, ...stats } = summarizeStats(
				this.state.deviceId ?? '',
				reports,
				this.lastBytes,
				at
			);
			this.lastBytes = { bytesReceived, at };
			this.setState({
				quality: {
					rttMs: stats.rttMs,
					packetLoss: stats.packetLoss,
					candidateType: stats.candidateType,
				},
			});
			this.send({
				type: 'link-quality',
				rttMs: stats.rttMs,
				jitterMs: stats.jitterMs,
				packetLoss: stats.packetLoss,
				candidateType: stats.candidateType,
			});
		} catch (error) {
			this.log('info', `Stats poll failed: ${errorText(error)}`);
		}
	}

	// -- Ducking --------------------------------------------------------------

	private setDucked(ducked: boolean): void {
		if (this.duckTimer) clearTimeout(this.duckTimer);
		this.duckTimer = null;
		if (this.ducked === ducked) return;
		this.ducked = ducked;
		this.emit({ type: 'duck', ducked });
		if (!ducked) return;
		// Lift the duck if the desktop never confirms. The floor is kept either
		// way: a duck that never lifts reads as a dead session. C-45.
		this.duckTimer = setTimeout(() => {
			this.duckTimer = null;
			if (!this.ducked) return;
			this.ducked = false;
			this.emit({ type: 'duck', ducked: false });
		}, DUCK_TIMEOUT_MS);
	}

	// -- Teardown -------------------------------------------------------------

	private scheduleReconnect(reason: string): void {
		this.closePeer();
		// Start closed after every reconnect and wait for `floor-state`. A client
		// that assumes it still holds the floor is a hot microphone the desktop does
		// not know about. C-49.
		this.setState({
			phase: 'idle',
			message: reason,
			floor: { holder: null, isSelf: false },
		});
		const delay =
			RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
		this.reconnectAttempt += 1;
		this.log('info', `Reconnecting in ${Math.round(delay / 1000)}s.`);
		this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
	}

	private clearReconnect(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
	}

	private teardown(message: string, options: { terminal: boolean; canRetry: boolean }): void {
		this.clearReconnect();
		this.stopPolling();
		this.closePeer();
		this.socket?.close();
		this.socket = null;
		this.setState({
			phase: options.terminal ? 'terminal' : 'idle',
			message,
			floor: { holder: null, isSelf: false },
			canRetry: options.canRetry,
		});
		if (!options.terminal) this.scheduleReconnect(message);
	}

	private closePeer(): void {
		this.stopStatsPolling();
		this.closeFloorAudio();
		this.reliable?.close();
		this.unreliable?.close();
		this.reliable = null;
		this.unreliable = null;
		this.sender = null;
		if (this.pc) {
			this.pc.onicecandidate = null;
			this.pc.ontrack = null;
			this.pc.onconnectionstatechange = null;
			this.pc.close();
		}
		this.pc = null;
		this.lastBytes = undefined;
	}

	private fail(message: string, options: { canRetry: boolean }): void {
		this.teardown(message, { terminal: true, canRetry: options.canRetry });
	}

	// -- Plumbing -------------------------------------------------------------

	private setState(patch: Partial<ClientState>): void {
		this.state = { ...this.state, ...patch };
		this.emit({ type: 'state', state: this.snapshot() });
	}

	private log(level: 'info' | 'warn' | 'error', text: string): void {
		this.emit({ type: 'log', level, text });
	}

	private emit(event: ClientEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
