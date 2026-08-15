/**
 * The A Cappella data-channel protocol: what a paired device and the desktop say
 * to each other over the WebRTC peer connection, alongside the audio.
 *
 * Two channels, because the two kinds of message have opposite failure
 * preferences:
 *
 *   - **reliable, ordered** ({@link RELIABLE_CHANNEL_LABEL}) carries state: the
 *     agent roster that fills the phone's project wheel, tab state, route
 *     decisions, dispatches, session errors. A dropped roster leaves the phone
 *     showing agents that no longer exist, so these are worth waiting for.
 *   - **unreliable, unordered** ({@link UNRELIABLE_CHANNEL_LABEL}) carries the
 *     chatty realtime traffic: the audio meter, partial transcripts, the
 *     push-to-talk press and release, and barge-in. Every one of these is
 *     superseded within about 50 ms, so a retransmission arriving late is worse
 *     than the loss it repaired - it would draw a meter bar from the past and
 *     delay every message queued behind it.
 *
 * **This file defines no new vocabulary for anything Phase 01 already named.**
 * The session events travel as {@link DeviceVoiceEventMessage}, which is a
 * `VoiceEvent` in an envelope - the same object graph the desktop renderer and
 * the CLI read. Only the things a peer connection genuinely adds (the version
 * handshake, floor control from a remote device, link quality) are defined here.
 *
 * Transport-agnostic and dependency-free: no DOM, no Electron, no Node. The
 * desktop encodes with it in the hidden audio window, the phone decodes with it
 * in Swift-adjacent JavaScript or a port of the same table.
 */

import type { VoiceEvent, VoiceEventType, VoiceScope } from './protocol';

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** `RTCDataChannel.label` for the ordered, reliable state channel. */
export const RELIABLE_CHANNEL_LABEL = 'acappella-state';

/** `RTCDataChannel.label` for the lossy realtime channel. */
export const UNRELIABLE_CHANNEL_LABEL = 'acappella-live';

export type DeviceChannelKind = 'reliable' | 'unreliable';

/**
 * `RTCDataChannelInit` for the unreliable channel, as a plain object so this
 * module stays free of DOM types.
 *
 * `maxRetransmits: 0` with `ordered: false` is partial reliability: send once,
 * deliver whenever it lands, never hold a later message back for an earlier one.
 */
export const UNRELIABLE_CHANNEL_INIT = {
	ordered: false,
	maxRetransmits: 0,
} as const;

/** `RTCDataChannelInit` for the state channel. SCTP's default is exactly right. */
export const RELIABLE_CHANNEL_INIT = { ordered: true } as const;

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/**
 * The version this build speaks. Bump on any breaking change to the message
 * shapes below.
 */
export const DEVICE_PROTOCOL_VERSION = 1;

/**
 * The oldest version this build still understands.
 *
 * Two numbers rather than one because "too old" and "from the future" need
 * different messages: a phone below the floor has to update, a phone above the
 * ceiling means the DESKTOP has to update, and telling a user to update the
 * wrong end of the pair is worse than saying nothing.
 */
export const MIN_SUPPORTED_DEVICE_PROTOCOL_VERSION = 1;

export type VersionNegotiation =
	| { ok: true; version: number }
	| { ok: false; reason: 'client-too-old' | 'client-too-new' | 'malformed'; message: string };

/**
 * Agree on a version, or refuse with a sentence a human can act on.
 *
 * Refusing loudly is the entire point. An old client against a new desktop that
 * merely ignores unknown fields is the worst outcome available: it half works,
 * the failure shows up as a feature quietly doing nothing, and nobody connects
 * that to a version at all.
 */
export function negotiateProtocolVersion(
	clientVersion: unknown,
	/**
	 * The window this build supports. A parameter rather than a closed-over
	 * constant so the too-old branch stays exercisable while the floor and the
	 * ceiling happen to be the same number - which they are on day one, and which
	 * is exactly when the branch is easiest to get wrong and hardest to notice.
	 */
	range: { min: number; max: number } = {
		min: MIN_SUPPORTED_DEVICE_PROTOCOL_VERSION,
		max: DEVICE_PROTOCOL_VERSION,
	}
): VersionNegotiation {
	if (typeof clientVersion !== 'number' || !Number.isInteger(clientVersion) || clientVersion < 1) {
		return {
			ok: false,
			reason: 'malformed',
			message: 'This device did not report a usable A Cappella protocol version.',
		};
	}
	if (clientVersion < range.min) {
		return {
			ok: false,
			reason: 'client-too-old',
			message: `This device speaks A Cappella protocol v${clientVersion}; this desktop needs v${range.min} or newer. Update the app on the device.`,
		};
	}
	if (clientVersion > range.max) {
		return {
			ok: false,
			reason: 'client-too-new',
			message: `This device speaks A Cappella protocol v${clientVersion}; this desktop only speaks v${range.max}. Update Maestro on the desktop.`,
		};
	}
	// The lower of the two, which for `clientVersion <= ours` is the client's.
	return { ok: true, version: clientVersion };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Every message on the wire carries the negotiated version, so a mismatch is
 * never silent.
 *
 * Optional in the TYPE and mandatory on the WIRE: {@link encodeDeviceMessage}
 * stamps it on the way out and {@link decodeDeviceMessage} rejects anything that
 * arrives without one. Making producers write `v` themselves would put the
 * negotiated version at forty construction sites, one of which would eventually
 * hard-code a stale number.
 */
export interface DeviceMessageBase {
	v?: number;
}

/** How the device describes itself. Shown verbatim in the paired-device list. */
export interface DeviceIdentity {
	deviceId: string;
	/** User-facing, e.g. "Pedram's iPhone". */
	name: string;
	/** `ios`, `android`, `browser`, `macos`, ... Free text; only displayed. */
	platform: string;
	/** The client build, for a support answer that is not a guess. */
	appVersion?: string;
}

/** Device -> desktop, first message on the reliable channel. */
export interface DeviceHelloMessage extends DeviceMessageBase {
	type: 'hello';
	identity: DeviceIdentity;
}

/** Desktop -> device, the accepted handshake. */
export interface DeviceWelcomeMessage extends DeviceMessageBase {
	type: 'welcome';
	/** The version BOTH ends will now use, which may be below the desktop's own. */
	version: number;
	/** Desktop app version, so the device can say what it is talking to. */
	appVersion: string;
	/** Live voice session id, or null when the desktop is idle. */
	sessionId: string | null;
}

/** Desktop -> device, the refused handshake. The connection closes after this. */
export interface DeviceVersionRejectedMessage extends DeviceMessageBase {
	type: 'version-rejected';
	reason: 'client-too-old' | 'client-too-new' | 'malformed';
	message: string;
	desktopVersion: number;
	minimumVersion: number;
}

/**
 * Desktop -> device: one Phase 01 protocol event, unchanged.
 *
 * The envelope exists only so the channel can carry more than one kind of thing.
 * Everything inside it is the vocabulary every other client already reads.
 */
export interface DeviceVoiceEventMessage extends DeviceMessageBase {
	type: 'voice-event';
	event: VoiceEvent;
}

/**
 * Device -> desktop: the push-to-talk button.
 *
 * Not a `wake` event, because a press and a release are two halves of one
 * gesture and `wake` has no release. It maps straight onto
 * `FloorController.press()` / `.release()`, which is the same object the desktop
 * hotkey and the HUD button drive.
 */
export interface DeviceFloorMessage extends DeviceMessageBase {
	type: 'floor';
	action: 'press' | 'release';
	/** What a floor opened by this device binds to. Defaults to the conductor. */
	scope?: VoiceScope;
}

/**
 * Device -> desktop: the user talked over the reply, or hit the stop button.
 *
 * Separate from a `barge-in` VoiceEvent on the wire because the device is
 * REQUESTING one; the authoritative `barge-in` comes back as a
 * {@link DeviceVoiceEventMessage} once the session actually cancelled speech.
 */
export interface DeviceInterruptMessage extends DeviceMessageBase {
	type: 'interrupt';
	kind: 'barge-in' | 'stop-word';
}

/**
 * Device -> desktop, ~20/s while the floor is open: the local input level.
 *
 * The desktop draws the same meter for a remote talker as for a local one, and
 * the level has to come from the device because that is where the microphone is.
 */
export interface DeviceAudioLevelMessage extends DeviceMessageBase {
	type: 'audio-level';
	/** RMS over the window, 0 to 1. */
	level: number;
	/** Whether the device's own detector thinks a person is talking. */
	speech: boolean;
}

/** Either end: a throttled `getStats()` reading, so both can show a real signal bar. */
export interface DeviceLinkQualityMessage extends DeviceMessageBase {
	type: 'link-quality';
	/** Round trip, ms. Null before the first complete pair report. */
	rttMs: number | null;
	jitterMs: number | null;
	/** 0 to 1, over the whole connection, not the last window. */
	packetLoss: number;
	/** Which ICE candidate pair actually won. The honest answer to "how am I connected". */
	candidateType: DeviceCandidateType;
}

/** Desktop -> device: the floor moved, and to whom. Drives the phone's mic button. */
export interface DeviceFloorStateMessage extends DeviceMessageBase {
	type: 'floor-state';
	/** The device holding the floor, `local` for the desktop, null when nobody is. */
	holder: string | null;
	/** True when the holder is THIS device. Saves the phone an id comparison. */
	isSelf: boolean;
	/** Set when this device was pushed off the floor by another one. */
	takenOverBy?: string;
}

/** Desktop -> device: this pairing is finished. Sent before the connection closes. */
export interface DeviceRevokedMessage extends DeviceMessageBase {
	type: 'revoked';
	message: string;
}

export type DeviceMessage =
	| DeviceHelloMessage
	| DeviceWelcomeMessage
	| DeviceVersionRejectedMessage
	| DeviceVoiceEventMessage
	| DeviceFloorMessage
	| DeviceInterruptMessage
	| DeviceAudioLevelMessage
	| DeviceLinkQualityMessage
	| DeviceFloorStateMessage
	| DeviceRevokedMessage;

export type DeviceMessageType = DeviceMessage['type'];

/**
 * How the ICE pair that won is described everywhere: the settings row, the
 * device list, the connection matrix in the docs.
 *
 *   - `lan` - a host candidate. Same network or an overlay like Tailscale, with
 *     no infrastructure in the path at all.
 *   - `stun` - server-reflexive or peer-reflexive: both ends punched through
 *     their NATs and the media is still direct.
 *   - `relay` - a TURN server is forwarding every packet. Works everywhere,
 *     costs latency and someone's bandwidth.
 *   - `unknown` - no pair has been selected yet.
 */
export type DeviceCandidateType = 'lan' | 'stun' | 'relay' | 'unknown';

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Which VoiceEvents ride the lossy channel.
 *
 * Exactly the two that are superseded faster than a retransmission could
 * arrive. Everything else - including `listen-start`, `speak-sentence`, and
 * every error - is state the far end must not miss.
 */
const UNRELIABLE_VOICE_EVENTS: ReadonlySet<VoiceEventType> = new Set<VoiceEventType>([
	'audio-level',
	'partial-transcript',
]);

/** Which channel one wrapped `VoiceEvent` belongs on. */
export function deviceChannelForVoiceEvent(type: VoiceEventType): DeviceChannelKind {
	return UNRELIABLE_VOICE_EVENTS.has(type) ? 'unreliable' : 'reliable';
}

/**
 * Which channel a message belongs on.
 *
 * One table rather than a decision at each send site: the two channels are only
 * safe because the split is total and stated in one place. A `revoked` that went
 * out lossy is a device that keeps its microphone; an `audio-level` that went out
 * reliable is a meter that lags a walk down the street.
 *
 * Push-to-talk deliberately rides the unreliable channel with the rest of the
 * gesture traffic, per the design note in this file's header. A dropped RELEASE
 * cannot leave a hot microphone: the floor's idle timeout
 * (`audio/floor-control.ts`) closes it, the next press is idempotent, and the
 * device re-sends the floor state it observes.
 */
export function deviceChannelForMessage(message: DeviceMessage): DeviceChannelKind {
	switch (message.type) {
		case 'voice-event':
			return deviceChannelForVoiceEvent(message.event.type);
		case 'audio-level':
		case 'floor':
		case 'interrupt':
		case 'link-quality':
			return 'unreliable';
		case 'hello':
		case 'welcome':
		case 'version-rejected':
		case 'floor-state':
		case 'revoked':
			return 'reliable';
	}
}

/** The label of the channel a message goes out on. */
export function deviceChannelLabel(kind: DeviceChannelKind): string {
	return kind === 'reliable' ? RELIABLE_CHANNEL_LABEL : UNRELIABLE_CHANNEL_LABEL;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Stamp the negotiated version and serialise. */
export function encodeDeviceMessage(
	message: DeviceMessage,
	version = DEVICE_PROTOCOL_VERSION
): string {
	return JSON.stringify({ ...message, v: version });
}

/**
 * Parse one inbound frame.
 *
 * Returns null rather than throwing for anything malformed: this runs on data
 * arriving from another machine, at up to fifty messages a second, and a peer
 * sending junk must degrade to "that message did not exist" rather than to fifty
 * unhandled exceptions a second inside a data-channel handler.
 */
export function decodeDeviceMessage(raw: unknown): DeviceMessage | null {
	if (typeof raw !== 'string') return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const message = parsed as Partial<DeviceMessage>;
	if (typeof message.type !== 'string') return null;
	if (typeof message.v !== 'number') return null;
	if (!isKnownDeviceMessageType(message.type)) return null;
	if (message.type === 'voice-event') {
		const event = (message as Partial<DeviceVoiceEventMessage>).event;
		if (!event || typeof event !== 'object' || typeof (event as VoiceEvent).type !== 'string') {
			return null;
		}
	}
	if (message.type === 'floor') {
		const action = (message as Partial<DeviceFloorMessage>).action;
		if (action !== 'press' && action !== 'release') return null;
	}
	return message as DeviceMessage;
}

const DEVICE_MESSAGE_TYPES: ReadonlySet<string> = new Set<DeviceMessageType>([
	'hello',
	'welcome',
	'version-rejected',
	'voice-event',
	'floor',
	'interrupt',
	'audio-level',
	'link-quality',
	'floor-state',
	'revoked',
]);

function isKnownDeviceMessageType(type: string): type is DeviceMessageType {
	return DEVICE_MESSAGE_TYPES.has(type);
}

/** The messages a DEVICE is allowed to originate. Anything else from a device is dropped. */
export const DEVICE_ORIGINATED_MESSAGES: readonly DeviceMessageType[] = [
	'hello',
	'floor',
	'interrupt',
	'audio-level',
	'link-quality',
] as const;

export function isDeviceOriginatedMessage(message: DeviceMessage): boolean {
	return DEVICE_ORIGINATED_MESSAGES.includes(message.type);
}
