/**
 * The wire contract between the main process and the hidden audio window for the
 * WebRTC media leg.
 *
 * The peer connection lives in the audio host renderer for the same reason the
 * microphone does: `RTCPeerConnection` is a DOM object, Electron's main process
 * has no libwebrtc binding, and the one window that already owns the
 * `AudioContext` is the only place a remote track can be spliced into the same
 * capture graph a local microphone feeds. Main keeps the authority - who is
 * paired, who holds the floor, which ICE servers are allowed - and the renderer
 * keeps the sockets.
 *
 * Three channels, mirroring `audio-host.ts`:
 *
 *   - `acappella:webrtc-command`  main -> host, one {@link WebRtcHostCommand}
 *   - `acappella:webrtc-event`    host -> main, one {@link WebRtcHostEvent}
 *
 * Free of Electron and DOM types on purpose, so both ends and the tests can
 * import it.
 */

import type { DeviceCandidateType, DeviceMessage } from './device-protocol';

/** Main -> host. Peer lifecycle, signaling, and outbound data-channel traffic. */
export const ACAPPELLA_WEBRTC_COMMAND_CHANNEL = 'acappella:webrtc-command';

/** Host -> main. Answers, candidates, connection state, stats, inbound messages. */
export const ACAPPELLA_WEBRTC_EVENT_CHANNEL = 'acappella:webrtc-event';

/**
 * One ICE server, in `RTCIceServer` shape but as a plain object.
 *
 * Declared here rather than imported from `lib.dom` so the main process, which
 * builds these from settings, does not need DOM types to do it.
 */
export interface IceServerConfig {
	urls: string | string[];
	username?: string;
	credential?: string;
}

/** A trickled ICE candidate, in `RTCIceCandidateInit` shape. */
export interface IceCandidatePayload {
	candidate: string;
	sdpMid?: string | null;
	sdpMLineIndex?: number | null;
	usernameFragment?: string | null;
}

/** An SDP blob with its type, in `RTCSessionDescriptionInit` shape. */
export interface SessionDescriptionPayload {
	type: 'offer' | 'answer' | 'pranswer' | 'rollback';
	sdp?: string;
}

export type WebRtcHostCommand =
	/**
	 * Build (or rebuild) the peer for `deviceId` and answer `offer`.
	 *
	 * Renegotiation is the same command with a new offer: a phone moving from
	 * WiFi to LTE re-offers, and the host applies it to the EXISTING peer so the
	 * media path survives the handover rather than being torn down and rebuilt.
	 */
	| {
			kind: 'accept-offer';
			deviceId: string;
			offer: SessionDescriptionPayload;
			iceServers: IceServerConfig[];
			/** Opus tuning for this peer. Resolved in main from settings. */
			audio: RemoteAudioConfig;
	  }
	| { kind: 'add-ice-candidate'; deviceId: string; candidate: IceCandidatePayload }
	/** Tear the peer down. `reason` is sent to the device first when it can be. */
	| { kind: 'close-peer'; deviceId: string; reason: string }
	/** Send one protocol message to a device, on whichever channel it belongs to. */
	| { kind: 'send'; deviceId: string; message: DeviceMessage }
	/** Send one protocol message to every connected device. */
	| { kind: 'broadcast'; message: DeviceMessage }
	/**
	 * Who holds the floor now.
	 *
	 * The host uses it to gate which peer's audio reaches the capture pipeline:
	 * exactly one remote microphone is consumed at a time, and the rest are
	 * received but discarded rather than mixed.
	 */
	| { kind: 'set-floor-holder'; deviceId: string | null }
	/**
	 * Gather ICE candidates against the configured servers and report what came
	 * back. The Test Connection button.
	 *
	 * It answers the question the settings pane otherwise cannot: whether the
	 * STUN server is reachable and whether the TURN credentials are real. A
	 * `relay` candidate can only be gathered by successfully authenticating to
	 * the TURN server, so its presence is proof rather than configuration.
	 */
	| { kind: 'probe-ice'; probeId: string; iceServers: IceServerConfig[]; timeoutMs: number };

/**
 * How the remote audio leg is configured. One object so the desktop cannot end
 * up with FEC on and DTX off through two independent code paths.
 */
export interface RemoteAudioConfig {
	/** Opus in-band forward error correction. On: it is what survives 5% loss. */
	fec: boolean;
	/** Discontinuous transmission: stop sending during silence. Saves a radio. */
	dtx: boolean;
	/** Target bitrate for speech, bits per second. */
	maxAverageBitrate: number;
	/**
	 * Ask the far end to run echo cancellation on ITS capture.
	 *
	 * The desktop cannot cancel an echo that happens in the phone's room - the
	 * reference signal is the phone's own speaker output, which only the phone
	 * has. So this is a request carried in the offer answer's constraints, not
	 * something the desktop can apply to a track that has already been encoded.
	 * The desktop applies its own AEC to its own microphone, where it works.
	 */
	requestRemoteEchoCancellation: boolean;
}

/** Voice-tuned defaults. Speech at 24 kbps in Opus is transparent enough to route on. */
export const DEFAULT_REMOTE_AUDIO_CONFIG: RemoteAudioConfig = {
	fec: true,
	dtx: true,
	maxAverageBitrate: 24000,
	requestRemoteEchoCancellation: true,
};

/** How a peer connection is doing, as `RTCPeerConnectionState` names it. */
export type PeerConnectionState =
	| 'new'
	| 'connecting'
	| 'connected'
	| 'disconnected'
	| 'failed'
	| 'closed';

/** A throttled `getStats()` reading for one peer. */
export interface PeerQualityStats {
	deviceId: string;
	rttMs: number | null;
	jitterMs: number | null;
	/** 0 to 1 over the life of the connection. */
	packetLoss: number;
	candidateType: DeviceCandidateType;
	/** Bits per second, inbound audio. Null until the second reading. */
	inboundBitrate: number | null;
}

export type WebRtcHostEvent =
	| { kind: 'answer'; deviceId: string; answer: SessionDescriptionPayload }
	| { kind: 'ice-candidate'; deviceId: string; candidate: IceCandidatePayload }
	| { kind: 'connection-state'; deviceId: string; state: PeerConnectionState }
	| { kind: 'stats'; stats: PeerQualityStats }
	/** One protocol message arrived from a device, on either channel. */
	| { kind: 'message'; deviceId: string; message: DeviceMessage }
	/** The peer failed in a way the device has to be told about. */
	| { kind: 'peer-error'; deviceId: string; message: string }
	| { kind: 'ice-probe-result'; probeId: string; result: IceProbeResult };

/** What a Test Connection run actually gathered. */
export interface IceProbeResult {
	/** A local interface address was found. Always true on a machine with a network. */
	host: boolean;
	/** A STUN server answered, so the public mapping is known. */
	stun: boolean;
	/** A TURN server accepted the credentials and allocated a relay. */
	relay: boolean;
	/** The best path this configuration could produce, for the one-line verdict. */
	best: DeviceCandidateType;
	/** Set when gathering failed outright (bad URL, no network). */
	error?: string;
}

/**
 * True when a connection state means media has stopped and the session behind it
 * must be closed.
 *
 * `disconnected` is deliberately NOT terminal: ICE reports it during an ordinary
 * network change, and a walk from WiFi to LTE recovers on its own within a few
 * seconds. Ending the session there would hang up on every user who left the
 * house.
 */
export function isTerminalPeerState(state: PeerConnectionState): boolean {
	return state === 'failed' || state === 'closed';
}
