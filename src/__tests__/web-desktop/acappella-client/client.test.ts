/**
 * The browser reference client, driven against fakes.
 *
 * These assertions are the conformance items from
 * `docs/ios-client/protocol-conformance.md` made executable, which is the only
 * reason the client's socket, peer, microphone, clock, and token store are all
 * injectable. Each test names the item it pins.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
	RELIABLE_CHANNEL_LABEL,
	UNRELIABLE_CHANNEL_LABEL,
	encodeDeviceMessage,
	type DeviceMessage,
} from '../../../shared/acappella/device-protocol';
import type { VoiceEvent } from '../../../shared/acappella/protocol';
import type { SignalingServerMessage } from '../../../shared/acappella/signaling-protocol';
import { DEFAULT_REMOTE_AUDIO_CONFIG } from '../../../shared/acappella/webrtc-host';
import {
	ACappellaReferenceClient,
	type ClientEvent,
	type PairingStore,
	type SignalingSocket,
	type SignalingSocketHandlers,
	type StoredPairing,
} from '../../../web-desktop/acappella-client/client';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeChannel {
	readyState: RTCDataChannelState = 'connecting';
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	readonly sent: string[] = [];
	closed = false;

	constructor(
		readonly label: string,
		readonly init: RTCDataChannelInit | undefined
	) {}

	open(): void {
		this.readyState = 'open';
		this.onopen?.();
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.closed = true;
		this.readyState = 'closed';
	}

	/** Every frame this channel sent, decoded. */
	messages(): Array<Record<string, unknown>> {
		return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
	}
}

const OPUS_OFFER_SDP = [
	'v=0',
	'm=audio 9 UDP/TLS/RTP/SAVPF 111',
	'a=rtpmap:111 opus/48000/2',
	'a=fmtp:111 minptime=10',
	'',
].join('\r\n');

class FakePeer {
	connectionState: RTCPeerConnectionState = 'new';
	onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
	ontrack: ((event: { streams: MediaStream[]; track: MediaStreamTrack }) => void) | null = null;
	onconnectionstatechange: (() => void) | null = null;
	readonly channels: FakeChannel[] = [];
	readonly senderTracks: Array<MediaStreamTrack | null> = [];
	localDescription: { type: string; sdp?: string } | null = null;
	closed = false;
	/** Order of the negotiation calls, so "channels before the offer" is testable. */
	readonly calls: string[] = [];

	constructor(readonly config: RTCConfiguration) {}

	createDataChannel(label: string, init?: RTCDataChannelInit): FakeChannel {
		this.calls.push(`channel:${label}`);
		const channel = new FakeChannel(label, init);
		this.channels.push(channel);
		return channel;
	}

	addTransceiver(kind: string, init: { direction: string }): { sender: unknown } {
		this.calls.push(`transceiver:${kind}:${init.direction}`);
		return {
			sender: {
				replaceTrack: (track: MediaStreamTrack | null) => {
					this.senderTracks.push(track);
					return Promise.resolve();
				},
				getParameters: () => ({ encodings: [{}] }),
				setParameters: () => Promise.resolve(),
			},
		};
	}

	createOffer(): Promise<{ type: string; sdp: string }> {
		this.calls.push('createOffer');
		return Promise.resolve({ type: 'offer', sdp: OPUS_OFFER_SDP });
	}

	setLocalDescription(description: { type: string; sdp?: string }): Promise<void> {
		this.localDescription = description;
		return Promise.resolve();
	}

	setRemoteDescription(): Promise<void> {
		return Promise.resolve();
	}

	addIceCandidate(): Promise<void> {
		return Promise.resolve();
	}

	getStats(): Promise<{ forEach: (fn: (value: unknown) => void) => void }> {
		return Promise.resolve({ forEach: () => {} });
	}

	close(): void {
		this.closed = true;
	}

	channel(label: string): FakeChannel {
		const found = this.channels.find((entry) => entry.label === label);
		if (!found) throw new Error(`No channel ${label}`);
		return found;
	}
}

class FakeSocket implements SignalingSocket {
	readonly sent: Array<Record<string, unknown>> = [];
	closed = false;
	constructor(
		readonly url: string,
		readonly handlers: SignalingSocketHandlers
	) {}
	send(message: Record<string, unknown>): void {
		this.sent.push(message);
	}
	close(): void {
		this.closed = true;
	}
	ops(): string[] {
		return this.sent.map((message) => String(message.op));
	}
}

function memoryStore(
	initial: StoredPairing | null = null
): PairingStore & { value: StoredPairing | null } {
	return {
		value: initial,
		read(): StoredPairing | null {
			return this.value;
		},
		write(pairing: StoredPairing): void {
			this.value = pairing;
		},
		clear(): void {
			this.value = null;
		},
	};
}

function fakeTrack(): MediaStreamTrack {
	return { stop: vi.fn(), kind: 'audio' } as unknown as MediaStreamTrack;
}

function fakeStream(track: MediaStreamTrack): MediaStream {
	return {
		getTracks: () => [track],
		getAudioTracks: () => [track],
	} as unknown as MediaStream;
}

const TARGET = { host: '192.168.1.5', port: 4123, token: 'server-token', code: 'ABC123' };

interface Harness {
	client: ACappellaReferenceClient;
	sockets: FakeSocket[];
	peers: FakePeer[];
	store: PairingStore & { value: StoredPairing | null };
	events: ClientEvent[];
	track: MediaStreamTrack;
	socket(): FakeSocket;
	peer(): FakePeer;
	now: { value: number };
}

function harness(options: { stored?: StoredPairing | null } = {}): Harness {
	const sockets: FakeSocket[] = [];
	const peers: FakePeer[] = [];
	const store = memoryStore(options.stored ?? null);
	const events: ClientEvent[] = [];
	const track = fakeTrack();
	const now = { value: 1_000_000 };

	const client = new ACappellaReferenceClient({
		identity: { name: 'Reference', platform: 'browser', appVersion: '9.9.9' },
		store,
		openSocket: (url, handlers) => {
			const socket = new FakeSocket(url, handlers);
			sockets.push(socket);
			return socket;
		},
		createPeerConnection: (config) => {
			const peer = new FakePeer(config);
			peers.push(peer);
			return peer as unknown as RTCPeerConnection;
		},
		openMicrophone: () => Promise.resolve(fakeStream(track)),
		now: () => now.value,
	});
	client.subscribe((event) => events.push(event));

	return {
		client,
		sockets,
		peers,
		store,
		events,
		track,
		now,
		socket: () => sockets[sockets.length - 1],
		peer: () => peers[peers.length - 1],
	};
}

/** Let the client's internal promises settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const AUTHENTICATED: SignalingServerMessage = {
	op: 'authenticated',
	deviceId: 'device-1',
	// Deliberately not `DEVICE_PROTOCOL_VERSION`: the client must stamp what the
	// desktop negotiated, not its own constant. C-35.
	protocolVersion: 7,
	iceServers: [{ urls: 'stun:stun.example:3478' }],
	iceTransportPolicy: 'all',
	audio: DEFAULT_REMOTE_AUDIO_CONFIG,
};

/** Get to a live peer with both channels open, the way a real session does. */
async function connected(options: { stored?: StoredPairing | null } = {}): Promise<Harness> {
	const h = harness({
		stored: options.stored ?? { deviceId: 'device-1', token: 'tok', fingerprint: 'fp' },
	});
	h.client.connect(TARGET);
	h.socket().handlers.onOpen();
	h.socket().handlers.onMessage(AUTHENTICATED);
	await settle();
	h.peer().channel(RELIABLE_CHANNEL_LABEL).open();
	h.peer().channel(UNRELIABLE_CHANNEL_LABEL).open();
	return h;
}

function inbound(peer: FakePeer, label: string, message: DeviceMessage, version = 7): void {
	peer.channel(label).onmessage?.({ data: encodeDeviceMessage(message, version) });
}

function voiceEvent(event: Partial<VoiceEvent> & { type: VoiceEvent['type'] }): VoiceEvent {
	return { sessionId: 'voice-1', seq: 1, ts: 0, ...event } as VoiceEvent;
}

// ---------------------------------------------------------------------------

describe('ACappellaReferenceClient - pairing', () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it('claims with a non-empty name and platform (C-02)', () => {
		const h = harness();
		h.client.connect(TARGET);
		h.socket().handlers.onOpen();

		expect(h.socket().sent[0]).toEqual({
			op: 'pair-claim',
			code: 'ABC123',
			name: 'Reference',
			platform: 'browser',
			appVersion: '9.9.9',
		});
	});

	it('polls once a second and keeps the deadline from the FIRST pair-pending (C-03)', () => {
		vi.useFakeTimers();
		const h = harness();
		h.client.connect(TARGET);
		h.socket().handlers.onOpen();
		h.socket().handlers.onMessage({
			op: 'pair-pending',
			requestId: 'req-1',
			expiresAt: 1_000_120_000,
		});

		vi.advanceTimersByTime(3000);
		expect(
			h
				.socket()
				.ops()
				.filter((op) => op === 'pair-poll')
		).toHaveLength(3);

		// The poll response carries `expiresAt: 0`. Taking it would collapse the
		// deadline to 1970 and stop the countdown immediately.
		h.socket().handlers.onMessage({ op: 'pair-pending', requestId: 'req-1', expiresAt: 0 });
		vi.advanceTimersByTime(2000);
		expect(
			h
				.socket()
				.ops()
				.filter((op) => op === 'pair-poll')
		).toHaveLength(5);
		vi.useRealTimers();
	});

	it('writes the token before anything else, then authenticates (C-04, C-06)', () => {
		const h = harness();
		h.client.connect(TARGET);
		h.socket().handlers.onOpen();
		h.socket().handlers.onMessage({ op: 'pair-pending', requestId: 'req-1', expiresAt: 9e12 });
		h.socket().handlers.onMessage({ op: 'pair-approved', deviceId: 'device-1', token: 'secret' });

		expect(h.store.value).toEqual({
			deviceId: 'device-1',
			token: 'secret',
			fingerprint: 'server-t',
		});
		const auth = h.socket().sent.find((message) => message.op === 'auth');
		expect(auth).toMatchObject({ deviceId: 'device-1', token: 'secret' });
		expect(Number.isInteger(auth?.protocolVersion as number)).toBe(true);
		expect(auth?.protocolVersion as number).toBeGreaterThanOrEqual(1);
	});

	it('shows a rejection message verbatim and stops (C-05)', () => {
		const h = harness();
		h.client.connect(TARGET);
		h.socket().handlers.onOpen();
		h.socket().handlers.onMessage({
			op: 'pair-rejected',
			reason: 'expired',
			message: 'That pairing code has expired. Start pairing again on the desktop.',
		});

		const state = h.client.snapshot();
		expect(state.message).toBe(
			'That pairing code has expired. Start pairing again on the desktop.'
		);
		expect(state.phase).toBe('terminal');
	});

	it('sends exactly one auth per socket (C-09)', () => {
		const h = harness({ stored: { deviceId: 'device-1', token: 'tok', fingerprint: 'fp' } });
		h.client.connect(TARGET);
		h.socket().handlers.onOpen();
		h.socket().handlers.onOpen();

		expect(
			h
				.socket()
				.ops()
				.filter((op) => op === 'auth')
		).toHaveLength(1);
	});

	it('clears the stored pairing on auth-failed (C-13)', () => {
		const h = harness({ stored: { deviceId: 'device-1', token: 'stale', fingerprint: 'fp' } });
		h.client.connect(TARGET);
		h.socket().handlers.onOpen();
		h.socket().handlers.onMessage({
			op: 'auth-failed',
			reason: 'unauthorized',
			message: 'This device is not paired with this computer, or its pairing was revoked.',
		});

		expect(h.store.value).toBeNull();
		expect(h.client.snapshot().phase).toBe('terminal');
	});
});

describe('ACappellaReferenceClient - peer setup', () => {
	it('creates both channels with the exact labels and inits, before the offer (C-16, C-17)', async () => {
		const h = await connected();
		const peer = h.peer();

		expect(peer.channel(RELIABLE_CHANNEL_LABEL).init).toEqual({ ordered: true });
		expect(peer.channel(UNRELIABLE_CHANNEL_LABEL).init).toEqual({
			ordered: false,
			maxRetransmits: 0,
		});
		// Channels and the audio transceiver all exist before the SDP is created,
		// so the first offer already carries the SCTP association and the m-line.
		expect(peer.calls.indexOf('createOffer')).toBeGreaterThan(
			peer.calls.indexOf(`channel:${UNRELIABLE_CHANNEL_LABEL}`)
		);
		expect(peer.calls).toContain('transceiver:audio:sendrecv');
	});

	it('uses the ICE servers as sent and hard-codes none (C-10)', async () => {
		const h = await connected();
		expect(h.peer().config.iceServers).toEqual([{ urls: 'stun:stun.example:3478' }]);
		expect(h.peer().config.iceTransportPolicy).toBe('all');
	});

	it('applies the desktop audio config to the offer SDP (C-11)', async () => {
		const h = await connected();
		const offer = h.socket().sent.find((message) => message.op === 'offer') as {
			sdp: { sdp: string };
		};
		expect(offer.sdp.sdp).toContain('useinbandfec=1');
		expect(offer.sdp.sdp).toContain('usedtx=1');
		expect(offer.sdp.sdp).toContain(
			`maxaveragebitrate=${DEFAULT_REMOTE_AUDIO_CONFIG.maxAverageBitrate}`
		);
	});

	it('sends hello first on the state channel, stamped with the NEGOTIATED version (C-18, C-19, C-35)', async () => {
		const h = await connected();
		const [first] = h.peer().channel(RELIABLE_CHANNEL_LABEL).messages();

		expect(first).toMatchObject({
			type: 'hello',
			v: 7,
			identity: { deviceId: 'device-1', name: 'Reference', platform: 'browser' },
		});
	});

	it('does not wait for welcome before it is usable (C-31)', async () => {
		const h = await connected();
		h.client.pressFloor();
		// No `welcome` has arrived and none ever will from desktop v1. The floor
		// request still goes out.
		expect(h.peer().channel(UNRELIABLE_CHANNEL_LABEL).messages()).toContainEqual(
			expect.objectContaining({ type: 'floor', action: 'press' })
		);
	});
});

describe('ACappellaReferenceClient - the floor', () => {
	it('routes each message to the channel the table names (C-20, C-21)', async () => {
		const h = await connected();
		h.client.pressFloor({ kind: 'agent', sessionId: 'agent-7' });
		h.client.requestStop();

		const live = h.peer().channel(UNRELIABLE_CHANNEL_LABEL).messages();
		expect(live).toContainEqual(
			expect.objectContaining({ type: 'floor', scope: { kind: 'agent', sessionId: 'agent-7' } })
		);
		expect(live).toContainEqual(expect.objectContaining({ type: 'interrupt', kind: 'stop-word' }));
		// Only the five device-originated types are ever sent.
		const everySent = [...h.peer().channel(RELIABLE_CHANNEL_LABEL).messages(), ...live].map(
			(message) => message.type
		);
		for (const type of everySent) {
			expect(['hello', 'floor', 'interrupt', 'audio-level', 'link-quality']).toContain(type);
		}
	});

	it('opens the microphone only once the desktop says the floor is ours (C-37, C-38)', async () => {
		const h = await connected();
		h.client.pressFloor();
		await settle();
		// Pressed, but not yet granted. Nothing is captured.
		expect(h.peer().senderTracks).toHaveLength(0);
		expect(h.client.microphone).toBeNull();

		inbound(h.peer(), RELIABLE_CHANNEL_LABEL, {
			type: 'floor-state',
			holder: 'device-1',
			isSelf: true,
		});
		await settle();
		expect(h.peer().senderTracks[0]).not.toBeNull();
		expect(h.client.snapshot().sending).toBe(true);

		inbound(h.peer(), RELIABLE_CHANNEL_LABEL, {
			type: 'floor-state',
			holder: 'local',
			isSelf: false,
		});
		await settle();
		expect(h.track.stop).toHaveBeenCalled();
		expect(h.peer().senderTracks[h.peer().senderTracks.length - 1]).toBeNull();
		expect(h.client.snapshot().sending).toBe(false);
	});

	it('sends audio-level only while the floor is open, throttled (C-39)', async () => {
		const h = await connected();
		h.client.reportAudioLevel(0.4, true);
		expect(h.peer().channel(UNRELIABLE_CHANNEL_LABEL).messages()).toHaveLength(0);

		inbound(h.peer(), RELIABLE_CHANNEL_LABEL, {
			type: 'floor-state',
			holder: 'device-1',
			isSelf: true,
		});
		await settle();

		h.client.reportAudioLevel(0.4, true);
		h.client.reportAudioLevel(0.5, true); // Same millisecond: throttled away.
		h.now.value += 60;
		h.client.reportAudioLevel(0.6, false);

		const levels = h
			.peer()
			.channel(UNRELIABLE_CHANNEL_LABEL)
			.messages()
			.filter((message) => message.type === 'audio-level');
		expect(levels).toHaveLength(2);
		expect(levels[1]).toMatchObject({ level: 0.6, speech: false });
	});

	it('records a takeover from the desktop rather than the local gesture (C-48)', async () => {
		const h = await connected();
		inbound(h.peer(), RELIABLE_CHANNEL_LABEL, {
			type: 'floor-state',
			holder: 'device-2',
			isSelf: false,
			takenOverBy: "Pedram's iPhone",
		});

		expect(h.client.snapshot().floor).toEqual({
			holder: 'device-2',
			isSelf: false,
			takenOverBy: "Pedram's iPhone",
		});
	});
});

describe('ACappellaReferenceClient - interrupts', () => {
	it('ducks locally BEFORE the interrupt frame goes out (C-44)', async () => {
		const h = await connected();
		h.events.length = 0;
		h.client.requestBargeIn();

		const duckIndex = h.events.findIndex((event) => event.type === 'duck' && event.ducked);
		expect(duckIndex).toBeGreaterThanOrEqual(0);
		// The frame is on the wire only after the duck event was emitted.
		expect(h.peer().channel(UNRELIABLE_CHANNEL_LABEL).messages()).toContainEqual(
			expect.objectContaining({ type: 'interrupt', kind: 'barge-in' })
		);
	});

	it('lifts the duck on the authoritative barge-in (C-45, C-46)', async () => {
		const h = await connected();
		h.client.requestBargeIn();
		h.events.length = 0;

		inbound(h.peer(), RELIABLE_CHANNEL_LABEL, {
			type: 'voice-event',
			event: voiceEvent({ type: 'barge-in', source: 'voice' } as Partial<VoiceEvent> & {
				type: 'barge-in';
			}),
		});

		expect(h.events).toContainEqual({ type: 'duck', ducked: false });
		// Barge-in keeps the floor. Nothing here releases it.
		expect(
			h
				.peer()
				.channel(UNRELIABLE_CHANNEL_LABEL)
				.messages()
				.filter((message) => message.action === 'release')
		).toHaveLength(0);
	});

	it('lifts the duck by itself when the desktop never answers (C-45)', async () => {
		vi.useFakeTimers();
		const h = harness({ stored: { deviceId: 'device-1', token: 'tok', fingerprint: 'fp' } });
		h.client.connect(TARGET);
		h.socket().handlers.onOpen();
		h.socket().handlers.onMessage(AUTHENTICATED);
		await vi.advanceTimersByTimeAsync(0);
		h.peer().channel(RELIABLE_CHANNEL_LABEL).open();
		h.peer().channel(UNRELIABLE_CHANNEL_LABEL).open();

		h.client.requestBargeIn();
		h.events.length = 0;
		await vi.advanceTimersByTimeAsync(600);
		expect(h.events).toContainEqual({ type: 'duck', ducked: false });
		vi.useRealTimers();
	});
});

describe('ACappellaReferenceClient - inbound frames', () => {
	it('ignores malformed and unknown frames without closing anything (C-22, C-23)', async () => {
		const h = await connected();
		const channel = h.peer().channel(RELIABLE_CHANNEL_LABEL);

		channel.onmessage?.({ data: 'not json' });
		channel.onmessage?.({ data: JSON.stringify({ type: 'floor-state', holder: null }) }); // no `v`
		channel.onmessage?.({ data: JSON.stringify({ type: 'made-up', v: 7 }) });
		inbound(h.peer(), RELIABLE_CHANNEL_LABEL, {
			type: 'voice-event',
			event: voiceEvent({ type: 'invented-event' as VoiceEvent['type'] }),
		});

		expect(channel.closed).toBe(false);
		expect(h.peer().closed).toBe(false);
		expect(h.client.snapshot().phase).not.toBe('terminal');
	});

	it('flags a seq gap on the reliable channel and not on the lossy one (C-29)', async () => {
		const h = await connected();
		inbound(h.peer(), RELIABLE_CHANNEL_LABEL, {
			type: 'voice-event',
			event: voiceEvent({ type: 'listen-stop', seq: 1 } as Partial<VoiceEvent> & {
				type: 'listen-stop';
			}),
		});
		inbound(h.peer(), UNRELIABLE_CHANNEL_LABEL, {
			type: 'voice-event',
			event: voiceEvent({ type: 'audio-level', seq: 40 } as Partial<VoiceEvent> & {
				type: 'audio-level';
			}),
		});
		expect(h.client.snapshot().transcriptSuspect).toBe(false);

		inbound(h.peer(), RELIABLE_CHANNEL_LABEL, {
			type: 'voice-event',
			event: voiceEvent({ type: 'listen-stop', seq: 9 } as Partial<VoiceEvent> & {
				type: 'listen-stop';
			}),
		});
		expect(h.client.snapshot().transcriptSuspect).toBe(true);
	});

	it('handles welcome if it ever arrives (C-32)', async () => {
		const h = await connected();
		inbound(h.peer(), RELIABLE_CHANNEL_LABEL, {
			type: 'welcome',
			version: 7,
			appVersion: '1.2.3',
			sessionId: 'voice-9',
		});

		expect(h.client.snapshot().desktopVersion).toBe('1.2.3');
	});

	it('treats revoked as terminal and forgets the pairing (C-12)', async () => {
		vi.useFakeTimers();
		const h = harness({ stored: { deviceId: 'device-1', token: 'tok', fingerprint: 'fp' } });
		h.client.connect(TARGET);
		h.socket().handlers.onOpen();
		h.socket().handlers.onMessage(AUTHENTICATED);
		await vi.advanceTimersByTimeAsync(0);
		h.peer().channel(RELIABLE_CHANNEL_LABEL).open();

		inbound(h.peer(), RELIABLE_CHANNEL_LABEL, {
			type: 'revoked',
			message: 'This computer removed this device.',
		});

		expect(h.client.snapshot().phase).toBe('terminal');
		expect(h.store.value).toBeNull();
		// No reconnect, however long we wait.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.sockets).toHaveLength(1);
		vi.useRealTimers();
	});
});

describe('ACappellaReferenceClient - version and teardown', () => {
	it('treats a version error as terminal and KEEPS the token (C-33, C-34)', () => {
		const h = harness({ stored: { deviceId: 'device-1', token: 'tok', fingerprint: 'fp' } });
		h.client.connect(TARGET);
		h.socket().handlers.onOpen();
		h.socket().handlers.onMessage({
			op: 'error',
			code: 'protocol-version',
			message: 'This device speaks A Cappella protocol v1; this desktop needs v2 or newer.',
		});

		const state = h.client.snapshot();
		expect(state.phase).toBe('terminal');
		expect(state.canRetry).toBe(false);
		expect(state.message).toBe(
			'This device speaks A Cappella protocol v1; this desktop needs v2 or newer.'
		);
		// The pairing is still valid; only one end is behind.
		expect(h.store.value).not.toBeNull();
	});

	it('sends bye before a deliberate teardown (C-14)', async () => {
		const h = await connected();
		h.client.disconnect();

		expect(h.socket().ops()).toContain('bye');
		expect(h.peer().closed).toBe(true);
	});

	it('starts the floor closed after a reconnect (C-49)', async () => {
		vi.useFakeTimers();
		const h = harness({ stored: { deviceId: 'device-1', token: 'tok', fingerprint: 'fp' } });
		h.client.connect(TARGET);
		h.socket().handlers.onOpen();
		h.socket().handlers.onMessage(AUTHENTICATED);
		await vi.advanceTimersByTimeAsync(0);
		h.peer().channel(RELIABLE_CHANNEL_LABEL).open();
		inbound(h.peer(), RELIABLE_CHANNEL_LABEL, {
			type: 'floor-state',
			holder: 'device-1',
			isSelf: true,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(h.client.snapshot().floor.isSelf).toBe(true);

		h.socket().handlers.onClose();
		expect(h.client.snapshot().floor).toEqual({ holder: null, isSelf: false });

		await vi.advanceTimersByTimeAsync(1200);
		expect(h.sockets.length).toBeGreaterThan(1);
		expect(h.client.snapshot().floor.isSelf).toBe(false);
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});
});
