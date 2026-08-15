/**
 * A desktop, a network, and a phone, in one process.
 *
 * This is the harness the protocol conformance suite runs on. It assembles the
 * REAL desktop stack - `ACappellaTransport` (pairing, signaling, the remote
 * session coordinator) wired to a real `PeerRegistry` through the same
 * `applyWebRtcCommand` switch the hidden audio window uses - and drives it with
 * the REAL browser reference client from `src/web-desktop/acappella-client/`.
 * Nothing between them is stubbed except the two things a test cannot have: a
 * socket and libwebrtc.
 *
 * That is the whole point. A conformance suite that mocked either end would
 * assert that a mock agrees with itself. Here a message leaves
 * `ACappellaReferenceClient.send()`, is JSON, crosses a loopback data channel,
 * and is decoded by `decodeDeviceMessage()` inside the desktop's `DevicePeer` -
 * so a desktop-side change that would break an iOS client fails here rather
 * than at App Store review.
 *
 * What is faked, and how faithfully:
 *
 *   - **The WebSocket** ({@link LoopbackSocket}) carries the real
 *     `{type:'acappella_signal', payload}` envelope over the real `/$TOKEN/ws`
 *     URL shape, mirroring the two lines in
 *     `main/web-server/handlers/messageHandlers/acappellaSignal.ts`. `onClose`
 *     fires in a microtask, as a browser's does, because firing it
 *     synchronously inside `close()` would let a teardown reconnect to itself.
 *   - **The peer connection** ({@link LoopbackPeer}) mirrors data channels
 *     between the two ends, delivers a replaced track to the far side's
 *     `ontrack`, and answers `getStats()`. A channel closed by one end closes
 *     on the other, which is what makes "the desktop closes a label it does not
 *     recognise" observable from the client.
 *
 * Timers are faked by {@link createConformanceWorld} and released by
 * `dispose()`, because the client's pairing poll is a 1 s interval and its
 * reconnect backoff starts at 1 s.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { vi, type Mock } from 'vitest';

import { ACappellaTransport } from '../../../main/acappella/transport';
import type {
	RemoteFloor,
	RemoteVoiceSession,
} from '../../../main/acappella/transport/remote-session';
import {
	PeerRegistry,
	applyWebRtcCommand,
	type PeerAudioBinding,
} from '../../../renderer/acappella-audio/peer-connection';
import {
	decodeDeviceMessage,
	type DeviceChannelKind,
	type DeviceMessage,
	RELIABLE_CHANNEL_LABEL,
	UNRELIABLE_CHANNEL_LABEL,
} from '../../../shared/acappella/device-protocol';
import type { VoiceEvent, VoiceOrigin, VoiceScope } from '../../../shared/acappella/protocol';
import {
	ACAPPELLA_SIGNAL_MESSAGE,
	type SignalingClientMessage,
	type SignalingServerMessage,
} from '../../../shared/acappella/signaling-protocol';
import type {
	IceCandidatePayload,
	WebRtcHostCommand,
	WebRtcHostEvent,
} from '../../../shared/acappella/webrtc-host';
import {
	ACappellaReferenceClient,
	PAIR_POLL_INTERVAL_MS,
	type ClientEvent,
	type ClientState,
	type PairingStore,
	type SignalingSocket,
	type SignalingSocketHandlers,
	type StoredPairing,
} from '../../../web-desktop/acappella-client/client';

/** The web server's security token, which is what gets a frame looked at at all. */
export const SERVER_TOKEN = 'conformance-server-token';
export const SERVER_PORT = 4123;
export const SERVER_HOST = '192.168.1.5';
export const DESKTOP_APP_VERSION = '1.2.3';

/**
 * An SDP with one Opus m-line, which is all `applyOpusPreferences()` reads.
 *
 * Deliberately carries `useinbandfec=0` so an assertion that the tuning was
 * applied cannot pass by accident on an SDP that already said the right thing.
 */
export const OPUS_SDP = [
	'v=0',
	'o=- 0 0 IN IP4 127.0.0.1',
	's=-',
	'm=audio 9 UDP/TLS/RTP/SAVPF 111',
	'a=rtpmap:111 opus/48000/2',
	'a=fmtp:111 minptime=10;useinbandfec=0',
	'',
].join('\r\n');

// ---------------------------------------------------------------------------
// The loopback peer connection
// ---------------------------------------------------------------------------

export class LoopbackChannel {
	readyState: RTCDataChannelState = 'connecting';
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	/** Every frame this end put on the wire, as sent. */
	readonly sent: string[] = [];
	/** The channel at the other end of the SCTP stream. */
	remote: LoopbackChannel | null = null;

	constructor(
		readonly label: string,
		readonly init: RTCDataChannelInit | undefined
	) {}

	open(): void {
		if (this.readyState !== 'connecting') return;
		this.readyState = 'open';
		this.onopen?.();
	}

	send(data: string): void {
		this.sent.push(data);
		const remote = this.remote;
		if (!remote || remote.readyState !== 'open') return;
		remote.onmessage?.({ data });
	}

	close(): void {
		if (this.readyState === 'closed') return;
		this.readyState = 'closed';
		const remote = this.remote;
		this.remote = null;
		this.onclose?.();
		if (remote) {
			remote.remote = null;
			remote.close();
		}
	}

	/** Everything this end sent, decoded through the real protocol decoder. */
	messages(): DeviceMessage[] {
		return this.sent
			.map((raw) => decodeDeviceMessage(raw))
			.filter((message): message is DeviceMessage => message !== null);
	}

	/** Everything this end sent, as raw objects, so a missing `v` is visible. */
	frames(): Array<Record<string, unknown>> {
		return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
	}
}

interface LoopbackSender {
	track: MediaStreamTrack | null;
	replaceTrack(track: MediaStreamTrack | null): Promise<void>;
	getParameters(): { encodings?: Array<Record<string, unknown>> };
	setParameters(parameters: unknown): Promise<void>;
}

/** Enough `RTCPeerConnection` for both ends of this protocol, and no more. */
export class LoopbackPeer {
	connectionState: RTCPeerConnectionState = 'new';
	onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
	ontrack: ((event: { streams: MediaStream[]; track: MediaStreamTrack }) => void) | null = null;
	onconnectionstatechange: (() => void) | null = null;
	ondatachannel: ((event: { channel: LoopbackChannel }) => void) | null = null;

	readonly channels: LoopbackChannel[] = [];
	readonly senders: LoopbackSender[] = [];
	readonly addedTracks: MediaStreamTrack[] = [];
	readonly candidates: IceCandidatePayload[] = [];
	/** What `getStats()` answers. Tests fill this in when they care. */
	statsReports: Array<Record<string, unknown>> = [];
	localDescription: { type: string; sdp?: string } | null = null;
	remoteDescription: { type: string; sdp?: string } | null = null;
	closed = false;
	remote: LoopbackPeer | null = null;

	constructor(
		readonly config: RTCConfiguration,
		readonly role: 'client' | 'desktop'
	) {}

	createDataChannel(label: string, init?: RTCDataChannelInit): LoopbackChannel {
		const channel = new LoopbackChannel(label, init);
		this.channels.push(channel);
		// A channel created after the peers were linked still has to reach the far
		// end, which is how the "unrecognised label" path is exercised.
		if (this.remote) this.remote.acceptChannel(channel);
		return channel;
	}

	/** Mirror a channel the far end created, and open both halves. */
	acceptChannel(theirs: LoopbackChannel): void {
		const mirror = new LoopbackChannel(theirs.label, theirs.init);
		mirror.remote = theirs;
		theirs.remote = mirror;
		this.channels.push(mirror);
		this.ondatachannel?.({ channel: mirror });
		// The far end may have closed it on sight, and a closed channel must not be
		// reopened by the link step.
		if (mirror.readyState === 'closed' || theirs.readyState === 'closed') return;
		mirror.open();
		theirs.open();
	}

	addTransceiver(_kind: string, _init: { direction: string }): { sender: LoopbackSender } {
		return { sender: this.createSender() };
	}

	addTrack(track: MediaStreamTrack): LoopbackSender {
		this.addedTracks.push(track);
		const sender = this.createSender();
		void sender.replaceTrack(track);
		return sender;
	}

	getSenders(): LoopbackSender[] {
		return this.senders;
	}

	createOffer(_options?: { iceRestart?: boolean }): Promise<{ type: string; sdp: string }> {
		return Promise.resolve({ type: 'offer', sdp: OPUS_SDP });
	}

	createAnswer(): Promise<{ type: string; sdp: string }> {
		// Echo whatever was offered, so an assertion about the answer's tuning is
		// about the desktop's shaping rather than about this fake's constant.
		return Promise.resolve({ type: 'answer', sdp: this.remoteDescription?.sdp ?? OPUS_SDP });
	}

	setLocalDescription(description: { type: string; sdp?: string }): Promise<void> {
		this.localDescription = description;
		return Promise.resolve();
	}

	setRemoteDescription(description: { type: string; sdp?: string }): Promise<void> {
		this.remoteDescription = description;
		return Promise.resolve();
	}

	addIceCandidate(candidate: IceCandidatePayload): Promise<void> {
		this.candidates.push(candidate);
		return Promise.resolve();
	}

	getStats(): Promise<{ forEach: (fn: (value: unknown) => void) => void }> {
		const reports = this.statsReports;
		return Promise.resolve({ forEach: (fn) => reports.forEach(fn) });
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const channel of this.channels) channel.close();
	}

	/** One gathered candidate, trickled out the way ICE does. */
	gatherCandidate(candidate: string): void {
		this.onicecandidate?.({
			candidate: {
				candidate,
				sdpMid: '0',
				sdpMLineIndex: 0,
				usernameFragment: 'ufrag',
			} as unknown as RTCIceCandidate,
		});
	}

	setConnectionState(state: RTCPeerConnectionState): void {
		this.connectionState = state;
		this.onconnectionstatechange?.();
	}

	channel(label: string): LoopbackChannel {
		const found = this.channels.find((entry) => entry.label === label);
		if (!found) throw new Error(`No channel '${label}' on the ${this.role} peer`);
		return found;
	}

	private createSender(): LoopbackSender {
		const peer = this;
		const sender: LoopbackSender = {
			track: null,
			replaceTrack(track: MediaStreamTrack | null): Promise<void> {
				sender.track = track;
				// A track attached at this end arrives at the other end's `ontrack`,
				// which is what makes "nothing before the floor opens" observable from
				// the desktop rather than only from the client.
				if (track) peer.remote?.deliverTrack(track);
				return Promise.resolve();
			},
			getParameters: () => ({ encodings: [{}] }),
			setParameters: () => Promise.resolve(),
		};
		this.senders.push(sender);
		return sender;
	}

	private deliverTrack(track: MediaStreamTrack): void {
		const stream = {
			id: `stream-${this.role}`,
			getTracks: () => [track],
		} as unknown as MediaStream;
		this.ontrack?.({ streams: [stream], track });
	}
}

/** Join two peers and open every channel either of them has already created. */
export function linkPeers(client: LoopbackPeer, desktop: LoopbackPeer): void {
	client.remote = desktop;
	desktop.remote = client;
	for (const channel of [...client.channels]) desktop.acceptChannel(channel);
}

// ---------------------------------------------------------------------------
// The loopback socket
// ---------------------------------------------------------------------------

/** One `acappella_signal` envelope, as it would appear on the WebSocket. */
export interface SignalEnvelope {
	type: string;
	payload: SignalingClientMessage | SignalingServerMessage;
}

export class LoopbackSocket implements SignalingSocket {
	/** Envelopes this socket put on the wire, outermost shape included. C-01. */
	readonly outbound: SignalEnvelope[] = [];
	readonly inbound: SignalingServerMessage[] = [];
	closed = false;

	constructor(
		readonly clientId: string,
		readonly url: string,
		readonly handlers: SignalingSocketHandlers,
		private readonly deliver: (payload: unknown) => void,
		private readonly onGone: () => void
	) {}

	send(message: SignalingClientMessage): void {
		if (this.closed) return;
		const envelope: SignalEnvelope = { type: ACAPPELLA_SIGNAL_MESSAGE, payload: message };
		this.outbound.push(envelope);
		// The web-server handler unwraps `payload` and hands it over untouched.
		this.deliver(envelope.payload);
	}

	/** The desktop wrote back. */
	receive(message: SignalingServerMessage): void {
		if (this.closed) return;
		this.inbound.push(message);
		this.handlers.onMessage(message);
	}

	close(): void {
		this.drop();
	}

	/** The socket went away, for any reason. */
	drop(): void {
		if (this.closed) return;
		this.closed = true;
		this.onGone();
		// A browser fires `close` in a later task. Firing it inline would run the
		// client's reconnect logic in the middle of its own teardown.
		queueMicrotask(() => this.handlers.onClose());
	}

	ops(): string[] {
		return this.outbound.map((envelope) => String((envelope.payload as { op: string }).op));
	}
}

// ---------------------------------------------------------------------------
// Desktop-side fakes
// ---------------------------------------------------------------------------

/** The voice session, reduced to what a remote device can observe and drive. */
export interface FakeVoiceSession extends RemoteVoiceSession {
	emit(event: Partial<VoiceEvent> & { type: VoiceEvent['type'] }): void;
	interrupt: Mock<RemoteVoiceSession['interrupt']>;
	hardStop: Mock<RemoteVoiceSession['hardStop']>;
	stopSession: Mock<RemoteVoiceSession['stopSession']>;
	/** Session id and monotonic seq, so a broadcast stream is contiguous. */
	sessionId: string;
	seq: number;
}

export interface FakeFloor extends RemoteFloor {
	readonly presses: Array<{ scope: VoiceScope; origin: VoiceOrigin }>;
	readonly releases: string[];
}

function createFakeSession(): FakeVoiceSession {
	let listeners: Array<(event: VoiceEvent) => void> = [];
	const session = {
		sessionId: 'voice-1',
		seq: 0,
		subscribe(listener: (event: VoiceEvent) => void) {
			listeners.push(listener);
			return () => {
				listeners = listeners.filter((entry) => entry !== listener);
			};
		},
		interrupt: vi.fn(() => true),
		hardStop: vi.fn(async () => {}),
		stopSession: vi.fn(async () => {}),
		getState: () => 'listening',
		emit(event: Partial<VoiceEvent> & { type: VoiceEvent['type'] }) {
			session.seq += 1;
			const full = {
				sessionId: session.sessionId,
				seq: session.seq,
				ts: 0,
				...event,
			} as VoiceEvent;
			for (const listener of [...listeners]) listener(full);
		},
	} as unknown as FakeVoiceSession;
	return session;
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export interface ConformanceClient {
	readonly client: ACappellaReferenceClient;
	readonly deviceId: string;
	readonly name: string;
	readonly store: PairingStore & { value: StoredPairing | null };
	readonly events: ClientEvent[];
	readonly sockets: LoopbackSocket[];
	readonly peers: LoopbackPeer[];
	/** The live signaling socket. */
	socket(): LoopbackSocket;
	/** The client's end of the peer connection. */
	peer(): LoopbackPeer;
	/** The desktop's end of the same connection. */
	desktopPeer(): LoopbackPeer;
	state(): ClientState;
	/** Frames this client put on the wire, on one channel or both. */
	sentFrames(kind?: DeviceChannelKind): DeviceMessage[];
	/** Frames the desktop sent to this client, on one channel or both. */
	receivedFrames(kind?: DeviceChannelKind): DeviceMessage[];
	/** Raw objects this client sent, so a missing `v` is visible. */
	rawSentFrames(): Array<Record<string, unknown>>;
	/** The network went away: media dead, socket dead. */
	dropNetwork(): void;
	/** The microphone stream `openMicrophone()` hands out. */
	readonly micTrack: MediaStreamTrack;
}

/** A device with no client behind it, for the frames a conforming client never sends. */
export interface RawDevice {
	socket: LoopbackSocket;
	send(message: SignalingClientMessage | Record<string, unknown>): Promise<void>;
	received: SignalingServerMessage[];
	last(): SignalingServerMessage | undefined;
	ofType<T extends SignalingServerMessage['op']>(
		op: T
	): Array<Extract<SignalingServerMessage, { op: T }>>;
}

export interface ConformanceWorld {
	readonly transport: ACappellaTransport;
	readonly peers: PeerRegistry;
	readonly session: FakeVoiceSession;
	readonly floor: FakeFloor;
	/** Every command the transport sent to the audio host, in order. */
	readonly hostCommands: WebRtcHostCommand[];
	/**
	 * Every frame the desktop actually DECODED off a data channel.
	 *
	 * The proof that a client's message round-tripped: it left the client as a
	 * string, crossed the channel, and came back out of `decodeDeviceMessage()`
	 * inside the desktop's own peer. A frame the desktop dropped never appears
	 * here, and dropping is silent by design.
	 */
	readonly deviceMessages: Array<{ deviceId: string; message: DeviceMessage }>;
	/** Streams the desktop routed into the capture pipeline, and when. */
	readonly captured: Array<{ deviceId: string }>;
	readonly detached: string[];
	/** Pair, authenticate, and connect one reference client. */
	connectClient(options?: { name?: string; platform?: string }): Promise<ConformanceClient>;
	/** A socket that speaks signaling by hand, with no client behind it. */
	openRawDevice(): RawDevice;
	/** Run every pending microtask and timer up to `ms`. */
	advance(ms?: number): Promise<void>;
	dispose(): Promise<void>;
}

export async function createConformanceWorld(): Promise<ConformanceWorld> {
	const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'acappella-conformance-'));
	vi.useFakeTimers();

	const session = createFakeSession();
	const presses: Array<{ scope: VoiceScope; origin: VoiceOrigin }> = [];
	const releases: string[] = [];
	const floor = {
		presses,
		releases,
		press: vi.fn(async (source?: string) => {
			void source;
		}),
		release: vi.fn(async (source?: string) => {
			releases.push(source ?? 'unknown');
		}),
		close: vi.fn(async () => {}),
		isFloorOpen: false,
	} as unknown as FakeFloor;

	const captured: Array<{ deviceId: string }> = [];
	const detached: string[] = [];
	const audio: PeerAudioBinding = {
		attachRemoteStream: (_stream, deviceId) => captured.push({ deviceId }),
		detachRemoteStream: (deviceId) => detached.push(deviceId),
		getOutboundTrack: () => ({ kind: 'audio', id: 'assistant-voice' }) as MediaStreamTrack,
	};

	const clientsByDevice = new Map<string, ConformanceClient>();
	const desktopPeers = new Map<string, LoopbackPeer>();
	const hostCommands: WebRtcHostCommand[] = [];
	const deviceMessages: Array<{ deviceId: string; message: DeviceMessage }> = [];
	let pendingDeviceId: string | null = null;
	let transport!: ACappellaTransport;

	const peers = new PeerRegistry({
		audio,
		callbacks: {
			onAnswer: (deviceId, answer) =>
				transport.handleHostEvent({ kind: 'answer', deviceId, answer }),
			onIceCandidate: (deviceId, candidate) =>
				transport.handleHostEvent({ kind: 'ice-candidate', deviceId, candidate }),
			onConnectionState: (deviceId, state) =>
				transport.handleHostEvent({ kind: 'connection-state', deviceId, state }),
			onStats: (stats) => transport.handleHostEvent({ kind: 'stats', stats }),
			onMessage: (deviceId, message) => {
				deviceMessages.push({ deviceId, message });
				transport.handleHostEvent({ kind: 'message', deviceId, message });
			},
			onError: (deviceId, message) =>
				transport.handleHostEvent({ kind: 'peer-error', deviceId, message }),
		},
		createPeerConnection: (config) => {
			const peer = new LoopbackPeer(config, 'desktop');
			const deviceId = pendingDeviceId;
			pendingDeviceId = null;
			if (deviceId) {
				desktopPeers.set(deviceId, peer);
				// Linked a microtask later: the `DevicePeer` constructor has not run
				// yet, so `ondatachannel` is not bound at the moment this factory is
				// called and mirroring here would drop both channels on the floor.
				queueMicrotask(() => {
					const client = clientsByDevice.get(deviceId);
					if (!client) return;
					linkPeers(client.peer(), peer);
					peer.setConnectionState('connected');
					client.peer().setConnectionState('connected');
				});
			}
			return peer as unknown as RTCPeerConnection;
		},
		// Long enough that the desktop's own stats poll never fires by surprise;
		// tests that care drive `getStats()` by advancing deliberately.
		statsIntervalMs: 10 * 60_000,
	});

	transport = new ACappellaTransport({
		settingsStore: { get: (_key: string, defaultValue?: unknown) => defaultValue ?? {} },
		userDataPath,
		sendToAudioHost: (command: WebRtcHostCommand) => {
			hostCommands.push(command);
			if (command.kind === 'accept-offer') pendingDeviceId = command.deviceId;
			applyWebRtcCommand(peers, command, (event: WebRtcHostEvent) =>
				transport.handleHostEvent(event)
			);
		},
		acquireFloor: (scope: VoiceScope, origin?: VoiceOrigin) => {
			presses.push({ scope, origin: origin ?? { kind: 'local' } });
			return floor;
		},
		getSession: () => session,
		getServerToken: () => SERVER_TOKEN,
		getServerPort: () => SERVER_PORT,
		getAppVersion: () => DESKTOP_APP_VERSION,
		getMachineName: () => 'Conformance Desktop',
	});

	let socketSeq = 0;
	function openSocket(url: string, handlers: SignalingSocketHandlers): LoopbackSocket {
		socketSeq += 1;
		const clientId = `socket-${socketSeq}`;
		const socket: LoopbackSocket = new LoopbackSocket(
			clientId,
			url,
			handlers,
			(payload) => {
				// Lazy, idempotent registration on the first message, exactly as the
				// WebSocket route does it.
				transport.registerClient({
					clientId,
					send: (message: SignalingServerMessage) => socket.receive(message),
					remoteAddress: '192.168.1.44',
				});
				void transport.handleSignalMessage(clientId, payload);
			},
			() => transport.handleClientDisconnect(clientId)
		);
		queueMicrotask(() => {
			if (!socket.closed) handlers.onOpen();
		});
		return socket;
	}

	async function advance(ms = 0): Promise<void> {
		await vi.advanceTimersByTimeAsync(ms);
		// A couple of extra turns for the promise chains the client runs between
		// `authenticated` and its first offer.
		for (let i = 0; i < 8; i += 1) await Promise.resolve();
	}

	async function connectClient(
		options: { name?: string; platform?: string } = {}
	): Promise<ConformanceClient> {
		const name = options.name ?? `Reference ${clientsByDevice.size + 1}`;
		const platform = options.platform ?? 'ios';
		const offer = transport.startPairing();
		if (!offer) throw new Error('The desktop refused to open a pairing window');

		const sockets: LoopbackSocket[] = [];
		const clientPeers: LoopbackPeer[] = [];
		const events: ClientEvent[] = [];
		const micTrack = { kind: 'audio', id: 'mic', stop: vi.fn() } as unknown as MediaStreamTrack;
		const store: PairingStore & { value: StoredPairing | null } = {
			value: null,
			read() {
				return this.value;
			},
			write(pairing: StoredPairing) {
				this.value = pairing;
			},
			clear() {
				this.value = null;
			},
		};

		const client = new ACappellaReferenceClient({
			identity: { name, platform, appVersion: '9.9.9' },
			store,
			openSocket: (url, handlers) => {
				const socket = openSocket(url, handlers);
				sockets.push(socket);
				return socket;
			},
			createPeerConnection: (config) => {
				const peer = new LoopbackPeer(config, 'client');
				clientPeers.push(peer);
				return peer as unknown as RTCPeerConnection;
			},
			openMicrophone: () =>
				Promise.resolve({
					getTracks: () => [micTrack],
					getAudioTracks: () => [micTrack],
				} as unknown as MediaStream),
		});

		const entry: ConformanceClient = {
			client,
			deviceId: '',
			name,
			store,
			events,
			sockets,
			peers: clientPeers,
			micTrack,
			socket: () => sockets[sockets.length - 1],
			peer: () => clientPeers[clientPeers.length - 1],
			desktopPeer: () => {
				const peer = desktopPeers.get(entry.deviceId);
				if (!peer) throw new Error(`No desktop peer for ${entry.deviceId}`);
				return peer;
			},
			state: () => client.snapshot(),
			sentFrames: (kind?: DeviceChannelKind) => channelFrames(entry.peer(), kind),
			receivedFrames: (kind?: DeviceChannelKind) => channelFrames(entry.desktopPeer(), kind),
			rawSentFrames: () => [
				...entry.peer().channel(RELIABLE_CHANNEL_LABEL).frames(),
				...entry.peer().channel(UNRELIABLE_CHANNEL_LABEL).frames(),
			],
			dropNetwork: () => {
				// A network drop takes the media with it. Dropping only the socket
				// would leave a live data channel the desktop then writes `revoked`
				// down, which is a different failure with a different meaning.
				const peer = entry.peer();
				const desktop = desktopPeers.get(entry.deviceId);
				desktop?.setConnectionState('failed');
				peer.setConnectionState('failed');
				for (const channel of peer.channels) channel.close();
				entry.socket().drop();
			},
		};
		client.subscribe((event) => events.push(event));

		client.connect({ host: SERVER_HOST, port: SERVER_PORT, token: SERVER_TOKEN, code: offer.code });
		await advance();

		// A human approves, which is the only thing a pairing code ever buys.
		const request = transport.pairing.pendingRequest();
		if (!request) throw new Error('The desktop never saw the pairing claim');
		const device = await transport.pairing.approve(request.requestId);
		if (!device) throw new Error('The desktop refused to approve the pairing request');

		// The client collects the token on its next poll, authenticates, offers,
		// and the peers link.
		await advance(PAIR_POLL_INTERVAL_MS + 50);
		await advance(50);

		const deviceId = client.snapshot().deviceId;
		if (!deviceId) throw new Error(`Client '${name}' never authenticated`);
		(entry as { deviceId: string }).deviceId = deviceId;
		clientsByDevice.set(deviceId, entry);
		// The peer for this device was created before the id was known here, so the
		// link runs now rather than in the factory's microtask.
		const desktopPeer = desktopPeers.get(deviceId);
		if (desktopPeer && !desktopPeer.remote) {
			linkPeers(entry.peer(), desktopPeer);
			desktopPeer.setConnectionState('connected');
			entry.peer().setConnectionState('connected');
		}
		await advance(50);
		return entry;
	}

	function openRawDevice(): RawDevice {
		const received: SignalingServerMessage[] = [];
		const socket = openSocket(`ws://${SERVER_HOST}:${SERVER_PORT}/${SERVER_TOKEN}/ws`, {
			onOpen: () => {},
			onMessage: (message) => received.push(message),
			onClose: () => {},
		});
		return {
			socket,
			received,
			send: async (message) => {
				socket.send(message as SignalingClientMessage);
				await advance();
			},
			last: () => received[received.length - 1],
			ofType: <T extends SignalingServerMessage['op']>(op: T) =>
				received.filter(
					(message): message is Extract<SignalingServerMessage, { op: T }> => message.op === op
				),
		};
	}

	return {
		transport,
		peers,
		session,
		floor,
		hostCommands,
		deviceMessages,
		captured,
		detached,
		connectClient,
		openRawDevice,
		advance,
		dispose: async () => {
			transport.dispose();
			peers.closeAll('the conformance world was torn down');
			vi.useRealTimers();
			// `noteConnected()` persists off a peer connecting and nobody awaits it,
			// so a `devices.json` write can still be in flight here. Removing the
			// directory underneath it renames into nothing and fails the run.
			await transport.pairing.whenPersisted();
			await fs.rm(userDataPath, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 20,
			});
		},
	};
}

/** Decoded frames one peer put on the wire, on one channel or across both. */
function channelFrames(peer: LoopbackPeer, kind?: DeviceChannelKind): DeviceMessage[] {
	const labels =
		kind === 'reliable'
			? [RELIABLE_CHANNEL_LABEL]
			: kind === 'unreliable'
				? [UNRELIABLE_CHANNEL_LABEL]
				: [RELIABLE_CHANNEL_LABEL, UNRELIABLE_CHANNEL_LABEL];
	const frames: DeviceMessage[] = [];
	for (const label of labels) {
		const channel = peer.channels.find((entry) => entry.label === label);
		if (channel) frames.push(...channel.messages());
	}
	return frames;
}

/** Every voice event of one type a client received, unwrapped. */
export function voiceEventsFrom(frames: DeviceMessage[], type?: VoiceEvent['type']): VoiceEvent[] {
	return frames
		.filter((frame): frame is Extract<DeviceMessage, { type: 'voice-event' }> => {
			return frame.type === 'voice-event' && (!type || frame.event.type === type);
		})
		.map((frame) => frame.event);
}
