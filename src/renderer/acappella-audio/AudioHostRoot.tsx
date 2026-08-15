/**
 * AudioHostRoot - render entry for A Cappella's hidden audio window.
 *
 * The main process loads the ordinary renderer bundle with `?acappellaAudio`
 * (see `src/main/acappella/audio-host-window.ts`) and `main.tsx` mounts this
 * instead of the app. It renders nothing: the window exists only because
 * `AudioContext`, `getUserMedia`, and `AudioWorklet` live in a renderer and the
 * main process has none of them.
 *
 * The controller is a plain object rather than a hook so the audio lifecycle is
 * not tangled with React's. A microphone and an `AudioContext` are OS resources;
 * they need one owner with an explicit start and stop, not something that
 * re-runs when a dependency array changes.
 */

import { useEffect } from 'react';

import type { AudioHostCommand, AudioHostStatus } from '../../shared/acappella/audio-host';
import type { WebRtcHostCommand, WebRtcHostEvent } from '../../shared/acappella/webrtc-host';
import { logger } from '../utils/logger';
import { createAudioHostBridge, type AudioHostBridge } from './bridge';
import { MicCapture } from './capture';
import { PeerRegistry, type PeerAudioBinding } from './peer-connection';
import { TtsPlayback } from './playback';
import { pcmWorkletUrl } from './worklet-url';

const LOG_CONTEXT = 'ACappellaAudioHost';

export interface AudioHostController {
	handleCommand(command: AudioHostCommand): void;
	/** Peer lifecycle and signaling, for the paired-device leg. */
	handleWebRtcCommand(command: WebRtcHostCommand): void;
	dispose(): void;
}

export interface CreateAudioHostControllerOptions {
	bridge?: AudioHostBridge;
	workletUrl?: string;
	/** Seam for tests; production always wants a real `AudioContext`. */
	createContext?: () => AudioContext;
	/** Seam for tests; production constructs a real `RTCPeerConnection`. */
	createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

/**
 * Wire the bridge to a capture and a playback over one shared `AudioContext`.
 *
 * The context is created on the first command that needs it, not here: the
 * window is built when a session starts, but a session that only speaks (or one
 * the user abandons) should never open an audio device.
 */
export function createAudioHostController(
	options: CreateAudioHostControllerOptions = {}
): AudioHostController {
	const bridge = options.bridge ?? createAudioHostBridge();
	const workletUrl = options.workletUrl ?? pcmWorkletUrl;
	const createContext = options.createContext ?? (() => new AudioContext());

	let context: AudioContext | null = null;
	let capture: MicCapture | null = null;
	let playback: TtsPlayback | null = null;
	let disposed = false;

	/** The device whose microphone is currently feeding the capture pipeline. */
	let remoteCaptureDeviceId: string | null = null;
	/** The tap that turns the shared playback output into a sendable track. */
	let outboundDestination: MediaStreamAudioDestinationNode | null = null;

	const onStatus = (status: AudioHostStatus) => bridge.sendStatus(status);

	const ensureContext = (): AudioContext => {
		if (!context) context = createContext();
		return context;
	};

	const ensureCapture = (): MicCapture => {
		if (!capture) {
			capture = new MicCapture({
				context: ensureContext(),
				workletUrl,
				onFrame: (frame) => bridge.sendFrame(frame),
				onStatus,
			});
		}
		return capture;
	};

	const ensurePlayback = (): TtsPlayback => {
		if (!playback) playback = new TtsPlayback({ context: ensureContext(), onStatus });
		return playback;
	};

	const handleCommand = (command: AudioHostCommand): void => {
		if (disposed) return;
		switch (command.kind) {
			case 'start-capture':
				void ensureCapture().start();
				break;
			case 'stop-capture':
				capture?.stop('requested');
				break;
			case 'play':
				void ensurePlayback().enqueue({
					utteranceId: command.utteranceId,
					format: command.format,
					sampleRate: command.sampleRate,
					data: command.data,
				});
				break;
			case 'end-utterance':
				playback?.endUtterance(command.utteranceId);
				break;
			case 'flush':
				// Barge-in. Nothing to flush when playback was never built, and
				// building one here just to empty it would open an audio device.
				playback?.flush();
				break;
			case 'duck':
				playback?.duck(command.gain, command.ms);
				break;
			case 'set-volume':
				// Built on demand, unlike `flush` and `duck`: the volume has to be in
				// place BEFORE the first chunk arrives, or the opening sentence of a
				// session comes out at the previous level.
				ensurePlayback().setVolume(command.volume);
				break;
		}
	};

	/**
	 * How a peer reaches the audio graph.
	 *
	 * Both directions are TAPS on the existing pipeline rather than new ones: the
	 * remote microphone goes into the same worklet a local microphone does, and
	 * the outbound voice comes off the same node the speakers hear. That is what
	 * makes a remote turn byte-for-byte identical to a local one downstream.
	 */
	const peerAudio: PeerAudioBinding = {
		attachRemoteStream: (stream, deviceId) => {
			remoteCaptureDeviceId = deviceId;
			void ensureCapture().startWithStream(stream, { deviceId });
		},
		detachRemoteStream: (deviceId) => {
			// Only the device that actually holds the capture may close it: a
			// detach from a device that already lost the floor would shut the
			// microphone of the one that just took it.
			if (remoteCaptureDeviceId !== deviceId) return;
			remoteCaptureDeviceId = null;
			capture?.stop('requested');
		},
		getOutboundTrack: () => {
			const ctx = ensureContext();
			if (!outboundDestination) {
				outboundDestination = ctx.createMediaStreamDestination();
				ensurePlayback().outputNode.connect(outboundDestination);
			}
			return outboundDestination.stream.getAudioTracks()[0] ?? null;
		},
	};

	const peers = new PeerRegistry({
		audio: peerAudio,
		createPeerConnection: options.createPeerConnection,
		callbacks: {
			onAnswer: (deviceId, answer) => sendPeerEvent({ kind: 'answer', deviceId, answer }),
			onIceCandidate: (deviceId, candidate) =>
				sendPeerEvent({ kind: 'ice-candidate', deviceId, candidate }),
			onConnectionState: (deviceId, state) =>
				sendPeerEvent({ kind: 'connection-state', deviceId, state }),
			onStats: (stats) => sendPeerEvent({ kind: 'stats', stats }),
			onMessage: (deviceId, message) => sendPeerEvent({ kind: 'message', deviceId, message }),
			onError: (deviceId, message) => sendPeerEvent({ kind: 'peer-error', deviceId, message }),
		},
	});

	function sendPeerEvent(event: WebRtcHostEvent): void {
		if (disposed) return;
		bridge.sendWebRtcEvent(event);
	}

	const handleWebRtcCommand = (command: WebRtcHostCommand): void => {
		if (disposed) return;
		switch (command.kind) {
			case 'accept-offer':
				void peers.acceptOffer({
					deviceId: command.deviceId,
					offer: command.offer,
					iceServers: command.iceServers,
					audio: command.audio,
				});
				break;
			case 'add-ice-candidate':
				peers.addIceCandidate(command.deviceId, command.candidate);
				break;
			case 'close-peer':
				peers.close(command.deviceId, command.reason);
				break;
			case 'send':
				peers.send(command.deviceId, command.message);
				break;
			case 'broadcast':
				peers.broadcast(command.message);
				break;
			case 'set-floor-holder':
				peers.setFloorHolder(command.deviceId);
				break;
			case 'probe-ice':
				void peers
					.probeIce(command.iceServers, command.timeoutMs)
					.then((result) =>
						sendPeerEvent({ kind: 'ice-probe-result', probeId: command.probeId, result })
					);
				break;
		}
	};

	const unsubscribe = bridge.onCommand(handleCommand);
	const unsubscribeWebRtc = bridge.onWebRtcCommand(handleWebRtcCommand);
	bridge.sendStatus({ kind: 'ready' });
	logger.info('A Cappella audio host ready', LOG_CONTEXT);

	return {
		handleCommand,
		handleWebRtcCommand,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			unsubscribeWebRtc();
			peers.closeAll('the desktop closed the audio host');
			capture?.dispose();
			playback?.dispose();
			// Closing the context releases the output device too; a hidden window
			// holding one open is invisible and therefore never noticed.
			void context?.close();
			capture = null;
			playback = null;
			outboundDestination = null;
			context = null;
		},
	};
}

export function AudioHostRoot(): null {
	useEffect(() => {
		const controller = createAudioHostController();
		return () => controller.dispose();
	}, []);

	return null;
}
