/**
 * The wire contract between A Cappella's hidden audio host renderer and the main
 * process.
 *
 * The main process has no `AudioContext` and no microphone, so all audio I/O
 * happens in the hidden window created by `src/main/acappella/audio-host-window.ts`
 * and reaches main over three channels:
 *
 *   - `acappella:audio-frame`   host -> main, ~50/s, one {@link AudioFrame} each
 *   - `acappella:audio-status`  host -> main, rare, one {@link AudioHostStatus}
 *   - `acappella:audio-command` main -> host, one {@link AudioHostCommand}
 *
 * Frames ride their own channel precisely because they are high-frequency: a
 * status listener should never have to skip 50 PCM buffers a second to find the
 * one message it cares about, and main can attach or drop the frame listener
 * independently of the control plane.
 *
 * This module is transport-agnostic and must stay free of Electron, DOM, and
 * Node imports - the Phase 10 phone terminates the same frame format over
 * WebRTC, and the worklet bundles a couple of these constants into its own
 * chunk.
 */

import type { MicIssue, VoiceSessionErrorCode } from './protocol';

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** Host -> main. High frequency: one message per 20 ms of captured audio. */
export const ACAPPELLA_AUDIO_FRAME_CHANNEL = 'acappella:audio-frame';

/** Host -> main. Control plane: readiness, device state, playback state. */
export const ACAPPELLA_AUDIO_STATUS_CHANNEL = 'acappella:audio-status';

/** Main -> host. Capture and playback commands. */
export const ACAPPELLA_AUDIO_COMMAND_CHANNEL = 'acappella:audio-command';

// ---------------------------------------------------------------------------
// Audio format
// ---------------------------------------------------------------------------

/**
 * 16 kHz mono. Every STT engine A Cappella can plausibly run (Whisper,
 * whisper.cpp, Deepgram, OpenAI Realtime) wants this rate, so the resample
 * happens once, in the worklet, rather than per provider.
 */
export const ACAPPELLA_AUDIO_SAMPLE_RATE = 16000;

/** Frame duration. 20 ms is the standard VAD/codec quantum. */
export const ACAPPELLA_AUDIO_FRAME_MS = 20;

/** Samples in one frame: 320 at 16 kHz. */
export const ACAPPELLA_AUDIO_FRAME_SAMPLES =
	(ACAPPELLA_AUDIO_SAMPLE_RATE * ACAPPELLA_AUDIO_FRAME_MS) / 1000;

/** Name the PCM worklet registers itself under, shared so it cannot drift. */
export const ACAPPELLA_PCM_WORKLET_NAME = 'acappella-pcm-downsample';

/**
 * One 20 ms slice of microphone audio, already downmixed, resampled, and
 * quantised by the worklet.
 */
export interface AudioFrame {
	/**
	 * Monotonic from 1 per capture run. A gap means frames were dropped between
	 * the worklet and main, which is worth counting rather than papering over.
	 */
	seq: number;
	/** Epoch ms, derived from the audio clock rather than from `Date.now()` per frame. */
	capturedAt: number;
	/** Root mean square of the frame, 0 to 1. Computed in the worklet so main never rescans PCM. */
	rms: number;
	/**
	 * {@link ACAPPELLA_AUDIO_FRAME_SAMPLES} signed 16-bit little-endian mono
	 * samples at {@link ACAPPELLA_AUDIO_SAMPLE_RATE}.
	 */
	pcm: ArrayBuffer;
}

// ---------------------------------------------------------------------------
// Status (host -> main)
// ---------------------------------------------------------------------------

/**
 * Why capture failed. Every one of these is a real, reachable condition on a
 * user's machine, which is why they are classified rather than collapsed into
 * one "audio broke" case: the recovery differs (grant permission, plug a mic
 * in, pick a different device).
 */
export type AudioHostErrorCode =
	| 'permission-denied'
	| 'no-device'
	| 'device-lost'
	| 'unsupported'
	| 'audio-init-failed';

/**
 * Codes the user can act on. `unsupported` and `audio-init-failed` are not here:
 * they mean the environment itself is wrong, so retrying changes nothing.
 */
export const RECOVERABLE_AUDIO_HOST_ERRORS: readonly AudioHostErrorCode[] = [
	'permission-denied',
	'no-device',
	'device-lost',
];

export function isRecoverableAudioHostError(code: AudioHostErrorCode): boolean {
	return RECOVERABLE_AUDIO_HOST_ERRORS.includes(code);
}

/** Why capture stopped. `requested` is the only one that is not a fault. */
export type CaptureStopReason = 'requested' | 'device-lost' | 'error';

/** The microphone actually in use, as the OS names it. */
export interface AudioDeviceInfo {
	deviceId: string;
	/** Empty until permission is granted - Chromium redacts labels before that. */
	label: string;
}

export type AudioHostStatus =
	/** The host window booted and is listening for commands. Nothing is open yet. */
	| { kind: 'ready' }
	| { kind: 'capture-start'; device: AudioDeviceInfo; contextSampleRate: number }
	| { kind: 'capture-stop'; reason: CaptureStopReason }
	| { kind: 'mic-error'; code: AudioHostErrorCode; message: string }
	/** A device was added or removed. The current capture may still be fine. */
	| { kind: 'device-change' }
	| {
			kind: 'playback-state';
			playing: boolean;
			utteranceId: string | null;
			/** Audio already scheduled but not yet heard. Barge-in latency is bounded by this. */
			queuedMs: number;
	  };

/**
 * Translate a capture failure into a protocol `session-error`.
 *
 * The point of this function is that a dead microphone must never present as a
 * session that is simply quiet. A user staring at a listening indicator that
 * will never produce a transcript is the worst outcome in the whole feature, so
 * every classified mic failure gets a first-class protocol event.
 */
export function audioHostErrorToSessionError(status: {
	kind: 'mic-error';
	code: AudioHostErrorCode;
	message: string;
}): { code: VoiceSessionErrorCode; message: string; recoverable: boolean } {
	return {
		code: 'audio-capture-failed',
		message: status.message,
		recoverable: isRecoverableAudioHostError(status.code),
	};
}

/**
 * Translate a capture failure into the protocol's `mic-state` issue.
 *
 * Both host-error translations live here, next to each other, so the two facts a
 * failure produces - the session error and the microphone's state - can never
 * disagree about what happened. The two environment failures collapse into
 * `unavailable` because they share the only property a client acts on: there is
 * nothing the user can do about them, so no settings button is offered.
 */
export function audioHostErrorToMicIssue(code: AudioHostErrorCode): MicIssue {
	switch (code) {
		case 'permission-denied':
			return 'permission-denied';
		case 'no-device':
			return 'no-device';
		case 'device-lost':
			return 'device-lost';
		default:
			return 'unavailable';
	}
}

// ---------------------------------------------------------------------------
// Commands (main -> host)
// ---------------------------------------------------------------------------

/**
 * How a playback chunk is encoded.
 *
 * `pcm16` is the streaming path: raw signed 16-bit little-endian mono at
 * `sampleRate`, playable the instant it arrives. `encoded` is a container
 * (wav/mp3/opus) handed to `decodeAudioData`, so each chunk must be
 * independently decodable - half an MP3 frame is not.
 */
export type PlaybackFormat = 'pcm16' | 'encoded';

export type AudioHostCommand =
	| { kind: 'start-capture' }
	| { kind: 'stop-capture' }
	| {
			kind: 'play';
			/** Scopes the chunk to a speech run so a cancelled run's late chunks are droppable. */
			utteranceId: string;
			format: PlaybackFormat;
			/** Required for `pcm16`; ignored for `encoded` (the container says). */
			sampleRate?: number;
			data: ArrayBuffer;
	  }
	/** No more chunks for this utterance: the host may report idle once it drains. */
	| { kind: 'end-utterance'; utteranceId: string }
	/** Barge-in: stop immediately and discard everything queued. */
	| { kind: 'flush' }
	/** Ramp output gain to `gain` (0 to 1) over `ms`. */
	| { kind: 'duck'; gain: number; ms: number };
