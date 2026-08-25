/**
 * The WebRTC peer, as terminated in the hidden audio window.
 *
 * `RTCPeerConnection` is mocked, so this runs in jsdom with no network and no
 * audio device. What is asserted is the contract the rest of the feature leans
 * on:
 *
 *   - Opus is negotiated with in-band FEC and DTX at a voice bitrate, because
 *     that is what makes 5% packet loss sound like nothing and stops a phone in
 *     a pocket transmitting silence over a metered radio;
 *   - exactly one device's microphone reaches the capture pipeline, and a
 *     takeover is a graph reconnection rather than a renegotiation;
 *   - a stats reading collapses to the four numbers a signal bar needs, with the
 *     WORSE end of the candidate pair deciding what to call the path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	PeerRegistry,
	applyOpusPreferences,
	summarizeStats,
	type PeerAudioBinding,
} from '../../../renderer/acappella-audio/peer-connection';
import { DEFAULT_REMOTE_AUDIO_CONFIG } from '../../../shared/acappella/webrtc-host';
import {
	RELIABLE_CHANNEL_LABEL,
	UNRELIABLE_CHANNEL_LABEL,
	encodeDeviceMessage,
} from '../../../shared/acappella/device-protocol';

vi.mock('../../../renderer/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const OFFER_SDP = [
	'v=0',
	'm=audio 9 UDP/TLS/RTP/SAVPF 111',
	'a=rtpmap:111 opus/48000/2',
	'a=fmtp:111 minptime=10;useinbandfec=0',
].join('\r\n');

class FakeDataChannel {
	readyState = 'open';
	sent: string[] = [];
	onmessage: ((event: { data: string }) => void) | null = null;
	closed = false;

	constructor(public label: string) {}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.closed = true;
	}
}

class FakePeerConnection {
	static instances: FakePeerConnection[] = [];

	connectionState = 'new';
	localDescription: { type: string; sdp?: string } | null = null;
	remoteDescription: { type: string; sdp?: string } | null = null;
	addedTracks: unknown[] = [];
	candidates: unknown[] = [];
	closed = false;
	statsReports: Array<Record<string, unknown>> = [];
	senderParameters: Record<string, unknown> = {};

	onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
	onconnectionstatechange: (() => void) | null = null;
	ontrack: ((event: { streams: MediaStream[]; track: unknown }) => void) | null = null;
	ondatachannel: ((event: { channel: FakeDataChannel }) => void) | null = null;

	constructor(public config: RTCConfiguration) {
		FakePeerConnection.instances.push(this);
	}

	async setRemoteDescription(description: { type: string; sdp?: string }): Promise<void> {
		this.remoteDescription = description;
	}

	async setLocalDescription(description: { type: string; sdp?: string }): Promise<void> {
		this.localDescription = description;
	}

	async createAnswer(): Promise<{ type: string; sdp: string }> {
		return { type: 'answer', sdp: OFFER_SDP };
	}

	async createOffer(): Promise<{ type: string; sdp: string }> {
		return { type: 'offer', sdp: OFFER_SDP };
	}

	addTrack(track: unknown): void {
		this.addedTracks.push(track);
	}

	getSenders(): Array<{
		track: { kind: string } | null;
		getParameters: () => Record<string, unknown>;
		setParameters: (parameters: Record<string, unknown>) => Promise<void>;
	}> {
		return this.addedTracks.map((track) => ({
			track: track as { kind: string },
			getParameters: () => ({ encodings: [{}] }),
			setParameters: async (parameters: Record<string, unknown>) => {
				this.senderParameters = parameters;
			},
		}));
	}

	async addIceCandidate(candidate: unknown): Promise<void> {
		this.candidates.push(candidate);
	}

	createDataChannel(label: string): FakeDataChannel {
		return new FakeDataChannel(label);
	}

	async getStats(): Promise<{ forEach: (fn: (value: unknown) => void) => void }> {
		const reports = this.statsReports;
		return { forEach: (fn) => reports.forEach(fn) };
	}

	close(): void {
		this.closed = true;
	}

	/** Open both protocol channels, as a real client would on connect. */
	openChannels(): { reliable: FakeDataChannel; unreliable: FakeDataChannel } {
		const reliable = new FakeDataChannel(RELIABLE_CHANNEL_LABEL);
		const unreliable = new FakeDataChannel(UNRELIABLE_CHANNEL_LABEL);
		this.ondatachannel?.({ channel: reliable });
		this.ondatachannel?.({ channel: unreliable });
		return { reliable, unreliable };
	}
}

/** The shared outbound voice track, tapped off playback in production. */
const outboundTrack = { kind: 'audio' } as unknown as MediaStreamTrack;

let audio: PeerAudioBinding & {
	attachRemoteStream: ReturnType<typeof vi.fn>;
	detachRemoteStream: ReturnType<typeof vi.fn>;
};
let registry: PeerRegistry;
let callbacks: Record<string, ReturnType<typeof vi.fn>>;

function createRegistry(): PeerRegistry {
	return new PeerRegistry({
		audio,
		callbacks: callbacks as never,
		createPeerConnection: (config) =>
			new FakePeerConnection(config) as unknown as RTCPeerConnection,
		// Long enough that no timer fires during a test; polling is driven by hand.
		statsIntervalMs: 1_000_000,
	});
}

async function acceptOffer(deviceId: string): Promise<FakePeerConnection> {
	await registry.acceptOffer({
		deviceId,
		offer: { type: 'offer', sdp: OFFER_SDP },
		iceServers: [{ urls: 'stun:stun.example.com:3478' }],
		audio: DEFAULT_REMOTE_AUDIO_CONFIG,
	});
	return FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
}

beforeEach(() => {
	FakePeerConnection.instances = [];
	audio = {
		attachRemoteStream: vi.fn(),
		detachRemoteStream: vi.fn(),
		// The same track object every time, as the real binding returns: one
		// destination node tapped off playback, shared by every peer.
		getOutboundTrack: () => outboundTrack,
	} as unknown as typeof audio;
	callbacks = {
		onAnswer: vi.fn(),
		onIceCandidate: vi.fn(),
		onConnectionState: vi.fn(),
		onStats: vi.fn(),
		onMessage: vi.fn(),
		onError: vi.fn(),
	};
	registry = createRegistry();
});

describe('applyOpusPreferences', () => {
	it('turns FEC and DTX on and sets a voice bitrate', () => {
		const sdp = applyOpusPreferences(OFFER_SDP, DEFAULT_REMOTE_AUDIO_CONFIG);
		expect(sdp).toContain('useinbandfec=1');
		expect(sdp).toContain('usedtx=1');
		expect(sdp).toContain(`maxaveragebitrate=${DEFAULT_REMOTE_AUDIO_CONFIG.maxAverageBitrate}`);
		// Mono: the pipeline downmixes anyway, and stereo doubles the bitrate to
		// carry a duplicate of the same voice.
		expect(sdp).toContain('stereo=0');
	});

	it('overwrites a value the far end asked for rather than appending a second one', () => {
		const sdp = applyOpusPreferences(OFFER_SDP, DEFAULT_REMOTE_AUDIO_CONFIG);
		expect(sdp).not.toContain('useinbandfec=0');
		expect(sdp.match(/useinbandfec/g)).toHaveLength(1);
		// And keeps parameters it does not own.
		expect(sdp).toContain('minptime=10');
	});

	it('adds an fmtp line when the offer names Opus without one', () => {
		const bare = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2';
		expect(applyOpusPreferences(bare, DEFAULT_REMOTE_AUDIO_CONFIG)).toContain('a=fmtp:111 ');
	});

	it('leaves an SDP with no Opus in it alone rather than throwing', () => {
		const noOpus = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=rtpmap:8 PCMA/8000';
		expect(applyOpusPreferences(noOpus, DEFAULT_REMOTE_AUDIO_CONFIG)).toBe(noOpus);
	});

	it('honours a configuration with FEC and DTX off', () => {
		const sdp = applyOpusPreferences(OFFER_SDP, {
			...DEFAULT_REMOTE_AUDIO_CONFIG,
			fec: false,
			dtx: false,
		});
		expect(sdp).toContain('useinbandfec=0');
		expect(sdp).toContain('usedtx=0');
	});
});

describe('answering an offer', () => {
	it('answers with the tuned SDP and caps the sender bitrate', async () => {
		const pc = await acceptOffer('phone');

		expect(callbacks.onAnswer).toHaveBeenCalledWith(
			'phone',
			expect.objectContaining({ type: 'answer' })
		);
		expect(pc.localDescription?.sdp).toContain('usedtx=1');
		// Both the encoder target and the sender cap, because either one alone is
		// routinely ignored depending on which end negotiated what.
		expect(pc.senderParameters.encodings).toEqual([
			expect.objectContaining({ maxBitrate: DEFAULT_REMOTE_AUDIO_CONFIG.maxAverageBitrate }),
		]);
	});

	it('adds the shared outbound voice track exactly once across renegotiations', async () => {
		const pc = await acceptOffer('phone');
		await acceptOffer('phone');
		expect(pc.addedTracks).toHaveLength(1);
		expect(FakePeerConnection.instances).toHaveLength(1);
	});

	it('reuses the peer on a renegotiation, so a network change is not a new call', async () => {
		await acceptOffer('phone');
		const before = FakePeerConnection.instances.length;
		await acceptOffer('phone');
		expect(FakePeerConnection.instances).toHaveLength(before);
	});

	it('trickles local candidates out as they are gathered', async () => {
		const pc = await acceptOffer('phone');
		pc.onicecandidate?.({
			candidate: {
				candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host',
				sdpMid: '0',
				sdpMLineIndex: 0,
				usernameFragment: 'abc',
			},
		});
		expect(callbacks.onIceCandidate).toHaveBeenCalledWith(
			'phone',
			expect.objectContaining({ sdpMid: '0' })
		);
	});

	it('reports a connection state change', async () => {
		const pc = await acceptOffer('phone');
		pc.connectionState = 'connected';
		pc.onconnectionstatechange?.();
		expect(callbacks.onConnectionState).toHaveBeenCalledWith('phone', 'connected');
	});
});

describe('one floor across several peers', () => {
	it('only routes the holder"s microphone into the capture pipeline', async () => {
		const phone = await acceptOffer('phone');
		const laptop = await acceptOffer('laptop');
		const stream = { id: 'remote' } as unknown as MediaStream;

		registry.setFloorHolder('phone');
		phone.ontrack?.({ streams: [stream], track: {} });
		laptop.ontrack?.({ streams: [stream], track: {} });

		expect(audio.attachRemoteStream).toHaveBeenCalledTimes(1);
		expect(audio.attachRemoteStream).toHaveBeenCalledWith(stream, 'phone');
	});

	it('makes a takeover a graph reconnection rather than a renegotiation', async () => {
		const phone = await acceptOffer('phone');
		const laptop = await acceptOffer('laptop');
		const stream = { id: 'remote' } as unknown as MediaStream;
		registry.setFloorHolder('phone');
		phone.ontrack?.({ streams: [stream], track: {} });
		laptop.ontrack?.({ streams: [stream], track: {} });

		registry.setFloorHolder('laptop');

		expect(audio.detachRemoteStream).toHaveBeenCalledWith('phone');
		expect(audio.attachRemoteStream).toHaveBeenLastCalledWith(stream, 'laptop');
		// Nothing was renegotiated: the tracks were already flowing.
		expect(FakePeerConnection.instances).toHaveLength(2);
	});

	it('releases the capture when the holder is closed', async () => {
		const phone = await acceptOffer('phone');
		registry.setFloorHolder('phone');
		phone.ontrack?.({ streams: [{ id: 'r' } as unknown as MediaStream], track: {} });

		registry.close('phone', 'revoked');
		expect(audio.detachRemoteStream).toHaveBeenCalledWith('phone');
		expect(phone.closed).toBe(true);
	});
});

describe('data channels', () => {
	it('routes each message onto the channel the protocol table names', async () => {
		const pc = await acceptOffer('phone');
		const { reliable, unreliable } = pc.openChannels();

		registry.send('phone', { type: 'floor-state', holder: 'phone', isSelf: true });
		registry.send('phone', { type: 'audio-level', level: 0.5, speech: true });

		expect(reliable.sent).toHaveLength(1);
		expect(JSON.parse(reliable.sent[0]).type).toBe('floor-state');
		expect(unreliable.sent).toHaveLength(1);
		expect(JSON.parse(unreliable.sent[0]).type).toBe('audio-level');
	});

	it('hands an inbound message to the callback, decoded', async () => {
		const pc = await acceptOffer('phone');
		const { unreliable } = pc.openChannels();
		unreliable.onmessage?.({ data: encodeDeviceMessage({ type: 'floor', action: 'press' }) });
		expect(callbacks.onMessage).toHaveBeenCalledWith(
			'phone',
			expect.objectContaining({ type: 'floor', action: 'press' })
		);
	});

	it('drops a malformed frame rather than throwing inside a channel handler', async () => {
		const pc = await acceptOffer('phone');
		const { reliable } = pc.openChannels();
		expect(() => reliable.onmessage?.({ data: 'not json' })).not.toThrow();
		expect(callbacks.onMessage).not.toHaveBeenCalled();
	});

	it('closes a channel it did not name', async () => {
		const pc = await acceptOffer('phone');
		const rogue = new FakeDataChannel('exfiltrate');
		pc.ondatachannel?.({ channel: rogue });
		expect(rogue.closed).toBe(true);
	});

	it('broadcasts to every peer', async () => {
		const phone = await acceptOffer('phone');
		const laptop = await acceptOffer('laptop');
		const a = phone.openChannels();
		const b = laptop.openChannels();

		registry.broadcast({ type: 'revoked', message: 'all devices disconnected' });
		expect(a.reliable.sent).toHaveLength(1);
		expect(b.reliable.sent).toHaveLength(1);
	});
});

describe('summarizeStats', () => {
	it('reduces a report to the four numbers a signal bar needs', () => {
		const stats = summarizeStats('phone', [
			{
				type: 'candidate-pair',
				selected: true,
				currentRoundTripTime: 0.042,
				localCandidateId: 'L',
				remoteCandidateId: 'R',
			},
			{ type: 'local-candidate', id: 'L', candidateType: 'host' },
			{ type: 'remote-candidate', id: 'R', candidateType: 'host' },
			{
				type: 'inbound-rtp',
				kind: 'audio',
				jitter: 0.005,
				packetsReceived: 990,
				packetsLost: 10,
				bytesReceived: 1000,
			},
		]);

		expect(stats.rttMs).toBe(42);
		expect(stats.jitterMs).toBe(5);
		expect(stats.packetLoss).toBeCloseTo(0.01);
		expect(stats.candidateType).toBe('lan');
	});

	it('calls the path relayed when EITHER end is a relay', () => {
		const stats = summarizeStats('phone', [
			{
				type: 'candidate-pair',
				selected: true,
				localCandidateId: 'L',
				remoteCandidateId: 'R',
			},
			// Our end gathered a host candidate; the phone is on a relay. Saying
			// "direct" here would describe a path the audio is not taking.
			{ type: 'local-candidate', id: 'L', candidateType: 'host' },
			{ type: 'remote-candidate', id: 'R', candidateType: 'relay' },
		]);
		expect(stats.candidateType).toBe('relay');
	});

	it('folds prflx in with srflx, because the difference is ICE trivia', () => {
		const stats = summarizeStats('phone', [
			{ type: 'candidate-pair', selected: true, localCandidateId: 'L', remoteCandidateId: 'R' },
			{ type: 'local-candidate', id: 'L', candidateType: 'prflx' },
			{ type: 'remote-candidate', id: 'R', candidateType: 'srflx' },
		]);
		expect(stats.candidateType).toBe('stun');
	});

	it('reports unknown before a pair has been selected', () => {
		const stats = summarizeStats('phone', []);
		expect(stats.candidateType).toBe('unknown');
		expect(stats.rttMs).toBeNull();
		expect(stats.packetLoss).toBe(0);
		expect(stats.inboundBitrate).toBeNull();
	});

	it('derives a bitrate from the delta between two readings', () => {
		const first = summarizeStats('phone', [
			{ type: 'inbound-rtp', kind: 'audio', bytesReceived: 1000 },
		]);
		const second = summarizeStats(
			'phone',
			[{ type: 'inbound-rtp', kind: 'audio', bytesReceived: 4000 }],
			{ bytesReceived: first.bytesReceived, at: performance.now() - 1000 }
		);
		// 3000 bytes in about a second is about 24 kbps, which is the voice target.
		expect(second.inboundBitrate).toBeGreaterThan(20_000);
		expect(second.inboundBitrate).toBeLessThan(28_000);
	});
});

describe('probeIce', () => {
	it('reports a relay as the best path and stops there', async () => {
		const probe = registry.probeIce([{ urls: 'turn:relay.example.com' }], 50);
		const pc = FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
		await Promise.resolve();
		pc.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ host' } });
		pc.onicecandidate?.({ candidate: { candidate: 'candidate:2 1 udp 1 5.6.7.8 1 typ relay' } });

		const result = await probe;
		expect(result).toMatchObject({ host: true, relay: true, best: 'relay' });
		expect(pc.closed).toBe(true);
	});

	it('reports what it got when gathering finishes without a relay', async () => {
		const probe = registry.probeIce([{ urls: 'stun:stun.example.com' }], 50);
		const pc = FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
		await Promise.resolve();
		pc.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ srflx' } });
		// A null candidate is the end of gathering.
		pc.onicecandidate?.({ candidate: null });

		expect(await probe).toMatchObject({ stun: true, relay: false, best: 'stun' });
	});
});
