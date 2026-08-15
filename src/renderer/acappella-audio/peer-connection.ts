/**
 * The WebRTC media leg, terminated in the hidden audio window.
 *
 * This is the desktop half of "the phone is a remote microphone and speaker".
 * A paired device offers, this answers, and from that point:
 *
 *   - the device's microphone arrives as a remote track and is spliced into the
 *     SAME capture pipeline the local microphone feeds (`capture.ts`), so there
 *     is one recogniser, one VAD, one router;
 *   - the assistant's voice leaves as an outgoing track tapped off the SAME
 *     playback node the speakers hear (`playback.ts`), so the phone hears the
 *     ElevenLabs voice the user configured rather than a second synthesis;
 *   - two data channels carry the protocol (`shared/acappella/device-protocol.ts`).
 *
 * It lives in a renderer because `RTCPeerConnection` is a DOM object and because
 * an `AudioContext` is the only place a remote track and a local microphone can
 * meet. Electron ships Chromium's libwebrtc, so this needs no native dependency
 * at all.
 *
 * **Exactly one device holds the floor.** Every peer's audio is received, but
 * only the holder's track is connected to the capture pipeline; the rest are
 * parked. Mixing two microphones into one utterance produces a transcript of
 * neither, and picking one silently produces a user who is talking to nothing.
 * The takeover rule itself lives in `main/acappella/transport/remote-session.ts`
 * - this file only obeys `set-floor-holder`.
 */

import {
	RELIABLE_CHANNEL_INIT,
	RELIABLE_CHANNEL_LABEL,
	UNRELIABLE_CHANNEL_INIT,
	UNRELIABLE_CHANNEL_LABEL,
	decodeDeviceMessage,
	deviceChannelForMessage,
	encodeDeviceMessage,
	type DeviceMessage,
} from '../../shared/acappella/device-protocol';
import {
	PEER_STATS_INTERVAL_MS,
	applyOpusPreferences,
	summarizeStats,
} from '../../shared/acappella/peer-tuning';
import type {
	IceCandidatePayload,
	IceProbeResult,
	IceServerConfig,
	PeerConnectionState,
	PeerQualityStats,
	RemoteAudioConfig,
	SessionDescriptionPayload,
} from '../../shared/acappella/webrtc-host';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'ACappellaAudioHost';

export interface PeerConnectionCallbacks {
	onAnswer(deviceId: string, answer: SessionDescriptionPayload): void;
	onIceCandidate(deviceId: string, candidate: IceCandidatePayload): void;
	onConnectionState(deviceId: string, state: PeerConnectionState): void;
	onStats(stats: PeerQualityStats): void;
	onMessage(deviceId: string, message: DeviceMessage): void;
	onError(deviceId: string, message: string): void;
}

/** The capture and playback seams a peer needs. Injected so tests need no audio. */
export interface PeerAudioBinding {
	/** Route this device's microphone into the shared capture pipeline. */
	attachRemoteStream(stream: MediaStream, deviceId: string): void;
	/** Stop consuming a device's microphone. */
	detachRemoteStream(deviceId: string): void;
	/**
	 * A `MediaStreamTrack` carrying the assistant's voice, tapped off playback.
	 *
	 * One track shared by every peer: the output is the same audio, and creating
	 * a destination node per device would mean N copies of one synthesis running
	 * through N resamplers for no benefit.
	 */
	getOutboundTrack(): MediaStreamTrack | null;
}

type RTCFactory = (config: RTCConfiguration) => RTCPeerConnection;

export interface PeerRegistryOptions {
	callbacks: PeerConnectionCallbacks;
	audio: PeerAudioBinding;
	/** Test seam. Production constructs a real `RTCPeerConnection`. */
	createPeerConnection?: RTCFactory;
	statsIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// One peer
// ---------------------------------------------------------------------------

class DevicePeer {
	readonly deviceId: string;
	private readonly pc: RTCPeerConnection;
	private readonly callbacks: PeerConnectionCallbacks;
	private readonly audio: PeerAudioBinding;
	private readonly audioConfig: RemoteAudioConfig;
	private reliable: RTCDataChannel | null = null;
	private unreliable: RTCDataChannel | null = null;
	private remoteStream: MediaStream | null = null;
	private statsTimer: ReturnType<typeof setInterval> | null = null;
	private lastBytes: { bytesReceived: number; at: number } | undefined;
	private holdsFloor = false;
	private closed = false;

	constructor(params: {
		deviceId: string;
		pc: RTCPeerConnection;
		callbacks: PeerConnectionCallbacks;
		audio: PeerAudioBinding;
		audioConfig: RemoteAudioConfig;
		statsIntervalMs: number;
	}) {
		this.deviceId = params.deviceId;
		this.pc = params.pc;
		this.callbacks = params.callbacks;
		this.audio = params.audio;
		this.audioConfig = params.audioConfig;

		this.pc.onicecandidate = (event) => {
			if (!event.candidate) return;
			this.callbacks.onIceCandidate(this.deviceId, {
				candidate: event.candidate.candidate,
				sdpMid: event.candidate.sdpMid,
				sdpMLineIndex: event.candidate.sdpMLineIndex,
				usernameFragment: event.candidate.usernameFragment,
			});
		};
		this.pc.onconnectionstatechange = () => {
			this.callbacks.onConnectionState(
				this.deviceId,
				this.pc.connectionState as PeerConnectionState
			);
		};
		this.pc.ontrack = (event) => {
			this.remoteStream = event.streams[0] ?? new MediaStream([event.track]);
			// Only routed into the pipeline when this device holds the floor. The
			// track is received either way, so a takeover is a graph reconnection
			// rather than a renegotiation.
			if (this.holdsFloor) this.audio.attachRemoteStream(this.remoteStream, this.deviceId);
		};
		this.pc.ondatachannel = (event) => this.bindChannel(event.channel);

		this.statsTimer = setInterval(() => void this.pollStats(), params.statsIntervalMs);
		this.statsTimer.unref?.();
	}

	/**
	 * Apply an offer and produce an answer.
	 *
	 * Also the renegotiation path: a phone changing network re-offers, and
	 * applying it to the existing peer is what makes a WiFi-to-LTE handover a
	 * hiccup rather than a dropped call.
	 */
	async acceptOffer(offer: SessionDescriptionPayload): Promise<void> {
		await this.pc.setRemoteDescription({
			type: 'offer',
			sdp: offer.sdp ? applyOpusPreferences(offer.sdp, this.audioConfig) : offer.sdp,
		});

		// The outbound voice track is added once and reused across renegotiations.
		const outbound = this.audio.getOutboundTrack();
		if (outbound && this.pc.getSenders().every((sender) => sender.track !== outbound)) {
			this.pc.addTrack(outbound);
		}

		const answer = await this.pc.createAnswer();
		const sdp = answer.sdp ? applyOpusPreferences(answer.sdp, this.audioConfig) : answer.sdp;
		await this.pc.setLocalDescription({ type: 'answer', sdp });
		this.applySenderBitrate();
		this.callbacks.onAnswer(this.deviceId, { type: 'answer', sdp });
	}

	async addIceCandidate(candidate: IceCandidatePayload): Promise<void> {
		try {
			await this.pc.addIceCandidate(candidate as RTCIceCandidateInit);
		} catch (error) {
			// A candidate that arrives before the remote description, or one for a
			// bundled m-line ICE has already given up on, is normal trickle traffic.
			// It is not worth failing a connection that is otherwise negotiating.
			logger.debug(
				`Discarded ICE candidate for ${this.deviceId}: ${errorText(error)}`,
				LOG_CONTEXT
			);
		}
	}

	/** Connect or park this device's microphone. */
	setFloor(holdsFloor: boolean): void {
		if (this.holdsFloor === holdsFloor) return;
		this.holdsFloor = holdsFloor;
		if (holdsFloor) {
			if (this.remoteStream) this.audio.attachRemoteStream(this.remoteStream, this.deviceId);
		} else {
			this.audio.detachRemoteStream(this.deviceId);
		}
	}

	send(message: DeviceMessage): void {
		const kind = deviceChannelForMessage(message);
		const channel = kind === 'reliable' ? this.reliable : this.unreliable;
		// The reliable channel is the fallback for a lossy message whose channel is
		// not open yet: late is better than never for the FIRST floor-state a device
		// sees, and by the time the meter is running both channels exist.
		const target = channel ?? this.reliable;
		if (!target || target.readyState !== 'open') return;
		try {
			target.send(encodeDeviceMessage(message));
		} catch (error) {
			logger.warn(`Data channel send failed: ${errorText(error)}`, LOG_CONTEXT);
		}
	}

	close(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.send({ type: 'revoked', message: reason });
		if (this.statsTimer) clearInterval(this.statsTimer);
		this.statsTimer = null;
		this.audio.detachRemoteStream(this.deviceId);
		this.reliable?.close();
		this.unreliable?.close();
		this.pc.onicecandidate = null;
		this.pc.onconnectionstatechange = null;
		this.pc.ontrack = null;
		this.pc.ondatachannel = null;
		this.pc.close();
	}

	private bindChannel(channel: RTCDataChannel): void {
		if (channel.label === RELIABLE_CHANNEL_LABEL) this.reliable = channel;
		else if (channel.label === UNRELIABLE_CHANNEL_LABEL) this.unreliable = channel;
		else {
			// A channel we did not name is a client bug or an attack surface; either
			// way there is nothing correct to do with its traffic.
			channel.close();
			return;
		}
		channel.onmessage = (event) => {
			const message = decodeDeviceMessage(
				typeof event.data === 'string' ? event.data : String(event.data)
			);
			if (!message) return;
			this.callbacks.onMessage(this.deviceId, message);
		};
	}

	/**
	 * Cap the outgoing bitrate.
	 *
	 * `maxaveragebitrate` in the SDP is what the ENCODER aims for; this is what
	 * the sender is allowed to use. Both, because either one alone is routinely
	 * ignored depending on which end negotiated what.
	 */
	private applySenderBitrate(): void {
		for (const sender of this.pc.getSenders()) {
			if (sender.track?.kind !== 'audio') continue;
			const parameters = sender.getParameters();
			if (!parameters.encodings || parameters.encodings.length === 0) {
				parameters.encodings = [{}];
			}
			for (const encoding of parameters.encodings) {
				encoding.maxBitrate = this.audioConfig.maxAverageBitrate;
				encoding.networkPriority = 'high';
			}
			void sender.setParameters(parameters).catch((error: unknown) => {
				logger.debug(`Could not set sender parameters: ${errorText(error)}`, LOG_CONTEXT);
			});
		}
	}

	private async pollStats(): Promise<void> {
		if (this.closed) return;
		try {
			const report = await this.pc.getStats();
			const reports: Array<Record<string, unknown>> = [];
			report.forEach((value) => reports.push(value as unknown as Record<string, unknown>));
			const { bytesReceived, ...stats } = summarizeStats(this.deviceId, reports, this.lastBytes);
			this.lastBytes = { bytesReceived, at: performance.now() };
			this.callbacks.onStats(stats);
			// Both ends draw the same bar from the same numbers rather than each
			// measuring its own half of the link and disagreeing about it.
			this.send({
				type: 'link-quality',
				rttMs: stats.rttMs,
				jitterMs: stats.jitterMs,
				packetLoss: stats.packetLoss,
				candidateType: stats.candidateType,
			});
		} catch (error) {
			logger.debug(`Stats poll failed: ${errorText(error)}`, LOG_CONTEXT);
		}
	}
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Every live peer, and the single-floor rule over them. */
export class PeerRegistry {
	private readonly peers = new Map<string, DevicePeer>();
	private readonly options: PeerRegistryOptions;
	private readonly createPeerConnection: RTCFactory;
	private readonly statsIntervalMs: number;
	private floorHolder: string | null = null;

	constructor(options: PeerRegistryOptions) {
		this.options = options;
		this.createPeerConnection =
			options.createPeerConnection ?? ((config) => new RTCPeerConnection(config));
		this.statsIntervalMs = options.statsIntervalMs ?? PEER_STATS_INTERVAL_MS;
	}

	async acceptOffer(params: {
		deviceId: string;
		offer: SessionDescriptionPayload;
		iceServers: IceServerConfig[];
		audio: RemoteAudioConfig;
	}): Promise<void> {
		let peer = this.peers.get(params.deviceId);
		if (!peer) {
			peer = new DevicePeer({
				deviceId: params.deviceId,
				pc: this.createPeerConnection({
					iceServers: params.iceServers as RTCIceServer[],
					// A small pool so the first candidates exist before the offer is
					// answered, which takes a visible chunk off time-to-first-audio.
					iceCandidatePoolSize: 2,
				}),
				callbacks: this.options.callbacks,
				audio: this.options.audio,
				audioConfig: params.audio,
				statsIntervalMs: this.statsIntervalMs,
			});
			this.peers.set(params.deviceId, peer);
			peer.setFloor(this.floorHolder === params.deviceId);
		}
		try {
			await peer.acceptOffer(params.offer);
		} catch (error) {
			this.options.callbacks.onError(params.deviceId, errorText(error));
			this.close(params.deviceId, 'the connection could not be negotiated');
		}
	}

	addIceCandidate(deviceId: string, candidate: IceCandidatePayload): void {
		void this.peers.get(deviceId)?.addIceCandidate(candidate);
	}

	send(deviceId: string, message: DeviceMessage): void {
		this.peers.get(deviceId)?.send(message);
	}

	broadcast(message: DeviceMessage): void {
		for (const peer of this.peers.values()) peer.send(message);
	}

	/** Exactly one device consumes the microphone. Everyone else is parked. */
	setFloorHolder(deviceId: string | null): void {
		this.floorHolder = deviceId;
		for (const [id, peer] of this.peers) peer.setFloor(id === deviceId);
	}

	close(deviceId: string, reason: string): void {
		const peer = this.peers.get(deviceId);
		if (!peer) return;
		this.peers.delete(deviceId);
		if (this.floorHolder === deviceId) this.floorHolder = null;
		peer.close(reason);
	}

	closeAll(reason: string): void {
		for (const deviceId of [...this.peers.keys()]) this.close(deviceId, reason);
	}

	get size(): number {
		return this.peers.size;
	}

	/**
	 * Gather candidates against a configuration and report what came back: the
	 * Test Connection button.
	 *
	 * A real gather, not a reachability guess. A `relay` candidate can only exist
	 * if the TURN server accepted the credentials, so its presence is proof the
	 * configuration works rather than a claim that it should.
	 */
	async probeIce(iceServers: IceServerConfig[], timeoutMs: number): Promise<IceProbeResult> {
		const result: IceProbeResult = { host: false, stun: false, relay: false, best: 'unknown' };
		let pc: RTCPeerConnection;
		try {
			pc = this.createPeerConnection({ iceServers: iceServers as RTCIceServer[] });
		} catch (error) {
			return { ...result, error: errorText(error) };
		}

		try {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, timeoutMs);
				pc.onicecandidate = (event) => {
					if (!event.candidate) {
						clearTimeout(timer);
						resolve();
						return;
					}
					const type = / typ (\w+)/.exec(event.candidate.candidate)?.[1];
					if (type === 'host') result.host = true;
					else if (type === 'srflx' || type === 'prflx') result.stun = true;
					else if (type === 'relay') {
						result.relay = true;
						// A relay is the last thing that will be gathered and the only
						// thing this test cannot infer any other way. Stop there rather
						// than waiting out the full timeout for candidates nobody reads.
						clearTimeout(timer);
						resolve();
					}
				};
				// A data channel is enough to make ICE gather; no media, no permission
				// prompt, and nothing that could open a microphone during a test.
				pc.createDataChannel('probe');
				void pc
					.createOffer()
					.then((offer) => pc.setLocalDescription(offer))
					.catch(() => {
						clearTimeout(timer);
						resolve();
					});
			});
		} finally {
			pc.onicecandidate = null;
			pc.close();
		}

		result.best = result.relay ? 'relay' : result.stun ? 'stun' : result.host ? 'lan' : 'unknown';
		return result;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export { RELIABLE_CHANNEL_INIT, UNRELIABLE_CHANNEL_INIT };

/**
 * Re-exported from `shared/acappella/peer-tuning.ts`, where they moved when the
 * browser reference client needed the identical SDP shaping and stats
 * reduction from the other side of the wire. Kept exported here because this is
 * the module every desktop-side caller and test already imports them from.
 */
export { PEER_STATS_INTERVAL_MS, applyOpusPreferences, summarizeStats };
