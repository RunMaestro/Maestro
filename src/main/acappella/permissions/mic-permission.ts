/**
 * The microphone permission, kept strictly separate from everything else that
 * can make voice mode unavailable.
 *
 * A denied microphone and a missing model are not the same failure and must
 * never be reported as one. "Voice unavailable" in front of a user who has
 * already downloaded 1.4 GB of models, when the real problem is a TCC checkbox,
 * is a support ticket the app could have answered itself. So this module answers
 * exactly one question, the capability gate turns it into its own slot with its
 * own reason code, and the two can never be collapsed.
 *
 * **When the prompt happens.** Never at app launch, and never when the Encore
 * Feature is switched on. An app that asks for the microphone on first run, for
 * a feature the user has not turned on, has spent trust it did not earn. The ask
 * happens at the first real session start, which is the moment the user has
 * asked for something that genuinely needs a microphone. {@link getMicPermission}
 * is a pure query and NEVER prompts, which is what makes it safe to call from
 * the capability gate on every Settings render.
 *
 * **Per platform.** macOS has a real TCC state and a real prompt, so it gets
 * both. Windows has a queryable state but no in-app prompt: the OS setting is
 * the only recovery. Linux has neither, so the state stays `unknown` until a
 * `getUserMedia` call fails and {@link noteGetUserMediaFailure} records what it
 * failed with. That failure path is the only permission signal Linux has, which
 * is why it is a first-class input here rather than a special case buried in the
 * audio host.
 */

import { shell, systemPreferences } from 'electron';

import type { AudioHostErrorCode } from '../../../shared/acappella/audio-host';
import { micSettingsLabel, micSettingsUrl } from '../../../shared/acappella/mic-settings';
import type { MicPermission } from '../../../shared/acappella/protocol';
import { isLinux, isMacOS } from '../../../shared/platformDetection';

/** The permission, plus everything a caller needs to decide what to render. */
export interface MicPermissionInfo {
	readonly state: MicPermission;
	/**
	 * Whether asking would actually show the OS prompt. False once the user has
	 * answered, and false everywhere except macOS: a "Grant access" button that
	 * silently does nothing is worse than no button.
	 */
	readonly canPrompt: boolean;
	/** Deep link to the OS privacy pane, or null where none exists (Linux). */
	readonly settingsUrl: string | null;
	/** Button text naming the place the user is being sent. */
	readonly settingsLabel: string;
	readonly platform: string;
}

/**
 * What a capture attempt taught us, on a platform that cannot be asked.
 *
 * Remembered because Chromium reports the denial once, at the moment of the
 * failed call, and the Linux query will keep saying `unknown` forever after.
 * Forgetting it immediately would mean the gate says "microphone: fine" one
 * second after the session died because the microphone was not fine.
 *
 * It is deliberately NOT permanent, and deliberately NOT authoritative over the
 * OS. Both would deadlock: a denial that outranks a `granted` query, or that
 * survives the user fixing the setting, blocks every future session through the
 * capability gate, and the only thing that could clear it is the successful
 * capture the gate is now preventing. So the OS wins wherever it has an answer,
 * and a fresh session start clears the observation (see
 * {@link requestMicPermission}) because a retry is the user telling us the old
 * evidence is stale.
 */
let observedDenial: MicPermission | null = null;

/** Clear the remembered `getUserMedia` denial. Tests, and after a granted capture. */
export function resetMicPermissionObservation(): void {
	observedDenial = null;
}

/**
 * Record what a capture attempt reported.
 *
 * This IS the `getUserMedia` failure path, one step downstream: the audio host
 * classifies the DOMException with `classifyCaptureError()` and main receives
 * the code. Feeding the classified code rather than re-parsing the exception
 * here keeps one mapping from browser error to meaning, in the process that
 * actually saw the exception.
 *
 * On Windows and Linux this is the ONLY permission signal there is, which is why
 * it is a first-class input to this module rather than something the audio
 * bridge quietly knows on its own.
 *
 * @returns The permission state after folding the failure in.
 */
export function noteCaptureFailure(code: AudioHostErrorCode): MicPermission {
	// `no-device` and `device-lost` mean there is no microphone, which is a
	// completely different problem with a completely different recovery. Recording
	// them as a denial would send a user to a privacy pane that has nothing wrong
	// with it.
	if (code === 'permission-denied') observedDenial = 'denied';
	return observedDenial ?? 'unknown';
}

/** Record that capture actually started, which is the only proof of a grant. */
export function noteCaptureStarted(): void {
	observedDenial = null;
}

/**
 * The current permission. Pure query: this never prompts and never opens a
 * device, so it is safe on any render path.
 */
export function getMicPermission(): MicPermissionInfo {
	return buildInfo(readPlatformState());
}

/**
 * Ask the OS for microphone access.
 *
 * Only macOS has an in-app prompt. Everywhere else this resolves to the current
 * state without side effects rather than pretending to ask, because a caller
 * that believes it prompted will show the wrong recovery when it did not.
 *
 * Safe to call repeatedly: macOS shows the prompt once and returns the recorded
 * answer thereafter, so "ask at first session start" does not become "nag on
 * every session start".
 */
export async function requestMicPermission(): Promise<MicPermissionInfo> {
	if (!isMacOS()) {
		// A new session start voids what a previous failed capture taught us. On
		// Linux that observation is the only permission signal there is, so leaving
		// it in place would mean one denial blocks every future session forever,
		// including after the user granted access, with no way back: the capture
		// that would clear it is the one the gate is refusing to allow.
		resetMicPermissionObservation();
		return getMicPermission();
	}

	const current = readPlatformState();
	// Asking again after an answer is a no-op at the OS level, but skipping it
	// keeps a denied state from looking like an attempted re-prompt in logs.
	if (current !== 'not-determined') return buildInfo(current);

	try {
		const granted = await systemPreferences.askForMediaAccess('microphone');
		if (granted) observedDenial = null;
		return buildInfo(granted ? 'granted' : 'denied');
	} catch {
		// A throw here means the API is unavailable, not that the user said no.
		// Reporting a denial would send them to a settings pane to fix a checkbox
		// that is already correct.
		return buildInfo(readPlatformState());
	}
}

/**
 * Open the OS microphone privacy settings.
 *
 * @returns false on a platform with no such link, so the caller can offer words
 *          instead of a button that does nothing.
 */
export async function openMicSystemSettings(): Promise<boolean> {
	const url = micSettingsUrl(process.platform);
	if (!url) return false;
	await shell.openExternal(url);
	return true;
}

/**
 * The OS's answer, falling back to what a failed capture told us.
 *
 * The OS wins wherever it has one. It is the thing that will actually decide
 * whether the next capture works, and it updates the moment the user changes the
 * setting, whereas the observation is a memory of one past attempt. The
 * observation fills the gap where there is no query at all: Linux, and any
 * platform where the API is missing or throws.
 */
function readPlatformState(): MicPermission {
	// Electron only implements this on macOS and Windows. On Linux it is absent
	// entirely, and calling it would throw rather than return a state.
	if (!isLinux()) {
		try {
			const status = normalize(systemPreferences.getMediaAccessStatus('microphone'));
			if (status !== 'unknown') return status;
		} catch {
			// Fall through to the observation: an API that is not there tells us
			// nothing, and a failed capture tells us something.
		}
	}

	return observedDenial ?? 'unknown';
}

/**
 * Electron's four states, kept as four states.
 *
 * `not-determined` is deliberately NOT folded into `denied`: one means "we have
 * not asked yet", which is the normal state of a first run and blocks nothing,
 * and the other means the user said no and only they can undo it.
 */
function normalize(status: string): MicPermission {
	switch (status) {
		case 'granted':
			return 'granted';
		case 'denied':
			return 'denied';
		case 'restricted':
			return 'restricted';
		case 'not-determined':
			return 'not-determined';
		default:
			return 'unknown';
	}
}

function buildInfo(state: MicPermission): MicPermissionInfo {
	return {
		state,
		canPrompt: isMacOS() && state === 'not-determined',
		settingsUrl: micSettingsUrl(process.platform),
		settingsLabel: micSettingsLabel(process.platform),
		platform: process.platform,
	};
}
