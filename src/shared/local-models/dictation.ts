/**
 * Dictation - the wire shapes between a text box and the main process.
 *
 * Dictation records one clip of speech and returns its transcript, with no
 * voice session behind it: nothing is routed, nothing is spoken back, and the
 * voice floor is never opened. The recording happens in the main process (the
 * app window has no microphone; see `src/main/local-models/dictation.ts`), so a
 * renderer only ever says start, stop, or cancel and reads these answers.
 *
 * Every refusal carries a closed `code` a surface can switch on and a `message`
 * written for a person. There is no bare "failed".
 */

/** The longest clip one dictation records. Past it the recording ends itself. */
export const DICTATION_MAX_CLIP_MS = 5 * 60_000;

/**
 * Why a microphone would not open, or stopped. Each has a different recovery
 * (grant access, plug a microphone in, pick another device), which is why they
 * are kept apart rather than collapsed into one "audio broke".
 *
 * Declared here rather than imported from the capture device's own vocabulary:
 * the core does not know who supplies the microphone (see
 * `registerDictationMicrophone`), and the supplier maps its failures onto these.
 */
export type DictationCaptureFailure =
	| 'permission-denied'
	| 'no-device'
	| 'device-lost'
	| 'unsupported'
	| 'audio-init-failed';

/**
 * Why a dictation did not start.
 *
 *   - `task-off`             - the Dictation task has no source assigned.
 *   - `task-unavailable`     - its assigned source cannot run (model not
 *                              downloaded, runtime missing, endpoint down).
 *   - `busy`                 - a dictation is already recording, or another
 *                              feature is borrowing the microphone.
 *   - `voice-session-active` - a voice session holds the microphone; speech is
 *                              already going to it.
 *   - `no-microphone`        - this process (or this client) has no capture
 *                              device to record through.
 *   - `timeout`              - the microphone did not open in time.
 *   - `cancelled`            - stopped or cancelled before recording began.
 *   - a {@link DictationCaptureFailure}: the microphone would not open.
 */
export type DictationRefusalCode =
	| 'task-off'
	| 'task-unavailable'
	| 'busy'
	| 'voice-session-active'
	| 'no-microphone'
	| 'timeout'
	| 'cancelled'
	| DictationCaptureFailure;

export type DictationStartResult =
	| { started: true }
	| { started: false; code: DictationRefusalCode; message: string };

/**
 * Why a recording ended before the user stopped it. The audio captured up to
 * that point is kept: stopping still returns its transcript.
 */
export interface DictationInterruption {
	code: 'max-duration' | DictationCaptureFailure;
	message: string;
}

/**
 * What stopping a dictation answers.
 *
 *   - `ok`          - the transcript. `text` is empty when the clip held no
 *                     speech (a tap, a quiet room).
 *   - `off`         - the Dictation task was switched off while recording.
 *   - `unavailable` - the assigned source could not transcribe the clip.
 *   - `cancelled`   - cancelled, or stopped before recording began.
 *   - `idle`        - this client had no dictation recording.
 */
export type DictationResult =
	| {
			status: 'ok';
			text: string;
			/** Length of the recorded clip, in milliseconds. */
			audioMs: number;
			/** Present when the recording ended on its own before it was stopped. */
			interruption?: DictationInterruption;
	  }
	| { status: 'off' }
	| { status: 'unavailable'; reason: string; code: string }
	| { status: 'cancelled' }
	| { status: 'idle' };
