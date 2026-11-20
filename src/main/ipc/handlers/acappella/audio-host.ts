/**
 * Audio host bridge, microphone permissions, input devices, volume,
 * dictation clip capture, spoken notices, and high-frequency audio/WebRTC
 * `ipcMain.on` handlers for A Cappella.
 */

import type { IpcMainEvent } from 'electron';

import { logger } from '../../../utils/logger';
import type { SafeSendFn } from '../../../utils/safe-send';
import {
	ACAPPELLA_SYSTEM_DEFAULT_INPUT,
	type AudioDeviceInfo,
	type AudioFrame,
	type AudioHostStatus,
} from '../../../../shared/acappella/audio-host';
import type { WebRtcHostEvent } from '../../../../shared/acappella/webrtc-host';
import { DEFAULT_TTS_VOLUME } from '../../../../shared/acappella/voice-controls';
import type { TtsProvider } from '../../../../shared/acappella/providers';
import { buildSpeechVocabulary } from '../../../../shared/acappella/speech-vocabulary';
import { ClipCapture } from '../../../../shared/local-models/clip-capture';
import { withIpcErrorLogging } from '../../../utils/ipcHandler';
import {
	createVoiceAudioBridge,
	ensureAcappellaAudioHostWindow,
	getAcappellaAudioHostWindow,
	getACappellaTransport,
	getVoiceSessionService,
	isAcappellaAudioHostContents,
	isAcappellaAudioHostReady,
	markAcappellaAudioHostReady,
	readAgentRoster,
	type VoiceSessionService,
} from '../../../acappella';
import {
	ACAPPELLA_SETTINGS_KEY,
	createNoticeTtsProvider,
	noticeTtsProviderId,
	readVoiceProviderSettings,
	type VoiceProviderSettings,
} from '../../../acappella/providers/provider-registry';
import {
	getMicPermission,
	noteCaptureFailure,
	noteCaptureStarted,
	openMicSystemSettings,
	requestMicPermission,
	type MicPermissionInfo,
} from '../../../acappella/permissions/mic-permission';
import { NoticeSpeech } from '../../../acappella/audio/notice-speech';
import { registerDictationMicrophone } from '../../../local-models/dictation';
import { registerNoticeSpeaker } from '../../../local-models/spoken-notices';
import { VOICE_SESSION_NOTICE_REFUSAL } from './providers';
import {
	ACAPPELLA_INPUT_DEVICES_CHANNEL,
	handlerOpts,
	LOG_CONTEXT,
	sendAudioHostCommand,
	type ACappellaHandlerDependencies,
} from './shared';
import { sharedState } from './state';

/**
 * The latest microphone list the hidden audio host reported.
 *
 * Kept at module scope so `acappella:input-devices` can answer immediately even
 * when no voice session (and thus no audio host window) is open.
 */
let inputDevices: AudioDeviceInfo[] = [];

let releaseDictationMicrophone: (() => void) | null = null;
let noticeSpeech: NoticeSpeech | null = null;
let releaseNoticeSpeaker: (() => void) | null = null;
let noticeTts: { id: string; provider: TtsProvider } | null = null;

/**
 * The voice provider a notice speaks with, kept between notices so the system
 * voice's installed-voice list is read once. Rebuilt when the Text-to-Speech
 * choice moves to a different local voice.
 */
function noticeTtsFor(settings: VoiceProviderSettings): TtsProvider {
	const id = noticeTtsProviderId(settings);
	if (noticeTts?.id === id) return noticeTts.provider;
	disposeNoticeTts();
	noticeTts = { id, provider: createNoticeTtsProvider(settings) };
	return noticeTts.provider;
}

function disposeNoticeTts(): void {
	const previous = noticeTts?.provider as
		| (TtsProvider & { dispose?: () => Promise<void> })
		| undefined;
	noticeTts = null;
	void previous?.dispose?.();
}

export function releaseDictationRegistration(): void {
	releaseDictationMicrophone?.();
	releaseDictationMicrophone = null;
}

export function releaseNoticeSpeakerAndTts(): void {
	releaseNoticeSpeaker?.();
	releaseNoticeSpeaker = null;
	noticeSpeech = null;
	disposeNoticeTts();
}

/**
 * Shape guard for an inbound frame.
 *
 * The sender check is the real security boundary; this is a crash guard. Frames
 * arrive fifty times a second, so a malformed one must not become fifty identical
 * unhandled exceptions a second inside an `ipcMain` listener.
 */
function isAudioFrame(value: unknown): value is AudioFrame {
	const frame = value as AudioFrame | null;
	return (
		!!frame &&
		typeof frame.seq === 'number' &&
		typeof frame.rms === 'number' &&
		frame.pcm instanceof ArrayBuffer
	);
}

/**
 * Teach the permission tracker what the device just did.
 *
 * Windows and Linux have no usable permission query, so a failed capture is the
 * only evidence there is, and a successful one is the only proof of a grant that
 * exists on any platform: Chromium hands over a live track only after the user
 * agrees. Kept here, at the one place host statuses arrive, so the tracker
 * cannot fall out of step with the microphone the user is actually looking at.
 */
function notePermissionFromStatus(status: AudioHostStatus): void {
	if (status.kind === 'capture-start') {
		noteCaptureStarted();
		return;
	}
	if (status.kind === 'mic-error') noteCaptureFailure(status.code);
}

/**
 * Cache the host's device list and tell every client it changed.
 *
 * Broadcast rather than request-only because the list changes for reasons no
 * renderer initiated: a headset is unplugged, or a first capture finally reveals
 * the labels Chromium had redacted. A picker that only ever pulled would keep
 * showing a device that is now gone.
 */
function noteInputDevices(status: AudioHostStatus, safeSend: SafeSendFn): void {
	if (status.kind !== 'input-devices') return;
	inputDevices = status.devices;
	safeSend(ACAPPELLA_INPUT_DEVICES_CHANNEL, inputDevices);
}

/**
 * Record the audio host's capture lifecycle. These are rare events and the only
 * evidence of which device actually opened, at what rate, or why it would not:
 * without them a silent capture is a guess.
 */
function logAudioHostStatus(status: AudioHostStatus): void {
	if (status.kind === 'capture-start') {
		logger.info(
			`Microphone capture started on "${status.device.label || status.device.deviceId}" at ${status.contextSampleRate} Hz`,
			LOG_CONTEXT
		);
	} else if (status.kind === 'capture-stop') {
		logger.info(`Microphone capture stopped (${status.reason})`, LOG_CONTEXT);
	} else if (status.kind === 'mic-error') {
		logger.warn(`Microphone error (${status.code}): ${status.message}`, LOG_CONTEXT);
	}
}

/**
 * Open the microphone on the device the user picked.
 *
 * Shared by wake-word tuning/enrollment and the `ready` replay when the audio
 * host window finishes booting.
 */
export function startWakeTestCapture(deps: ACappellaHandlerDependencies): void {
	sendAudioHostCommand({
		kind: 'start-capture',
		deviceId: readVoiceProviderSettings(deps.settingsStore).inputDeviceId,
	});
}

/**
 * Attach audio wiring to a service that has none.
 *
 * Audio is wired only when there is a host window to wire it to. Without one
 * (tests, and any path that did not pass `audioHostDeps`) the session still
 * runs: it is simply text-in, which is exactly the mock tier's contract.
 *
 * Called from BOTH paths in `ensureService`, because the two lifetimes differ:
 * switching the Encore Feature off disposes the bridge and deliberately leaves
 * the session service alone, so the next start reuses a live service that has
 * no audio at all. That failure is silent and total - the host window opens, the
 * device is captured, and every frame lands on a null bridge - which is why it
 * cannot be left to the fresh-service path.
 */
export function ensureAudioBridge(
	service: VoiceSessionService,
	deps: ACappellaHandlerDependencies
): void {
	if (sharedState.audioBridge || !deps.audioHostDeps) return;
	sharedState.audioBridge = createVoiceAudioBridge({
		session: service,
		sendCommand: sendAudioHostCommand,
		// The host may have booted before this bridge (the always-on wake word, a
		// wake test, or a previous bridge rebuilt on a provider change).
		hostAlreadyReady: isAcappellaAudioHostReady(),
		// Read at each capture start rather than captured here, so picking a
		// different microphone takes effect on the next session without rebuilding
		// the provider pipeline.
		getInputDeviceId: () => readVoiceProviderSettings(deps.settingsStore).inputDeviceId,
	});
	// The user's volume applies from the FIRST sentence, not from the first time
	// they touch the slider. A fresh bridge that defaulted to full output would
	// undo a quiet setting (or a mute) every time the Encore Feature was toggled.
	sharedState.audioBridge.setPlaybackVolume(
		readVoiceProviderSettings(deps.settingsStore).volume ?? DEFAULT_TTS_VOLUME
	);
}

/**
 * Stop capture and drop the audio wiring, leaving the session service alone.
 *
 * Called when the Encore Feature is switched off: the audio host window goes
 * away with it, so a bridge still holding a running pipeline would be counting
 * frames from a device nobody owns.
 */
export function disposeACappellaAudioBridge(): void {
	sharedState.audioBridge?.dispose();
	sharedState.audioBridge = null;
}

export function initClipCapture(deps: ACappellaHandlerDependencies): void {
	const { settingsStore } = deps;

	// Dictation's microphone. Not gated on the Encore flag (dictation is a core
	// Local Models feature), and it never reaches the session service: it only
	// reads the session's state, to refuse while one is live.
	sharedState.clipCapture ??= new ClipCapture({
		refusal: () => {
			if ((getVoiceSessionService()?.getState() ?? 'idle') !== 'idle') {
				return {
					code: 'voice-session-active',
					message: 'A voice session is using the microphone. End it, then dictate.',
				};
			}
			if (sharedState.wakeTestDetector) {
				return {
					code: 'busy',
					message: 'The wake word Test is using the microphone. Stop it, then dictate.',
				};
			}
			if (sharedState.wakeEnrollment?.isRecording) {
				return {
					code: 'busy',
					message: 'A wake phrase is being recorded. Finish that, then dictate.',
				};
			}
			return null;
		},
		// The always-on wake word reads `isActive` and stands down or re-arms.
		onActiveChange: () => sharedState.handsFree?.sync(),
		requestMicPermission,
		ensureAudioHost: () => {
			if (!deps.audioHostDeps) return false;
			ensureAcappellaAudioHostWindow(deps.audioHostDeps);
			return true;
		},
		// The device the user picked for voice: one microphone setting, not two.
		startCapture: () =>
			sendAudioHostCommand({
				kind: 'start-capture',
				deviceId: readVoiceProviderSettings(settingsStore).inputDeviceId,
			}),
		stopCapture: () => {
			// Never close a microphone a session is using.
			if ((getVoiceSessionService()?.getState() ?? 'idle') === 'idle') {
				sendAudioHostCommand({ kind: 'stop-capture' });
			}
		},
		log: (message) => logger.info(message, LOG_CONTEXT),
	});
	releaseDictationMicrophone ??= registerDictationMicrophone(sharedState.clipCapture, async () =>
		buildSpeechVocabulary(
			await readAgentRoster(),
			readVoiceProviderSettings(settingsStore).vocabulary
		)
	);
}

export function initNoticeSpeech(deps: ACappellaHandlerDependencies): void {
	const { settingsStore } = deps;

	// Spoken notices' speaker. Not gated on the Encore flag either, and like the
	// dictation microphone it only READS the session's state, to stay silent
	// while one is live.
	noticeSpeech ??= new NoticeSpeech({
		refusal: () =>
			(getVoiceSessionService()?.getState() ?? 'idle') !== 'idle'
				? VOICE_SESSION_NOTICE_REFUSAL
				: null,
		// The voice the user picked for A Cappella: one voice setting, not two.
		readVoice: () => {
			const settings = readVoiceProviderSettings(settingsStore);
			return {
				tts: noticeTtsFor(settings),
				voiceId: settings.voiceId,
				rate: settings.rate,
				volume: settings.volume ?? DEFAULT_TTS_VOLUME,
			};
		},
		ensureAudioHost: () => {
			if (!deps.audioHostDeps) return false;
			ensureAcappellaAudioHostWindow(deps.audioHostDeps);
			return true;
		},
		isAudioHostReady: isAcappellaAudioHostReady,
		sendCommand: sendAudioHostCommand,
	});
	releaseNoticeSpeaker ??= registerNoticeSpeaker(noticeSpeech);
}

export function createAudioHostHandlers(deps: ACappellaHandlerDependencies) {
	const { settingsStore } = deps;

	const wrappedOpenMicSettings = withIpcErrorLogging(
		handlerOpts('openMicSettings'),
		// Its own channel rather than `shell:openExternal`, which allows only
		// http/https/mailto. Widening that allowlist so one button can open one
		// hard-coded URL would trade a real security property for nothing; here the
		// URL is a constant the caller cannot influence.
		async (): Promise<boolean> => openMicSystemSettings()
	);

	const wrappedMicPermission = withIpcErrorLogging(
		handlerOpts('micPermission'),
		async (): Promise<MicPermissionInfo> => getMicPermission()
	);

	/**
	 * Apply an output volume to whatever is playing RIGHT NOW.
	 *
	 * Deliberately does NOT persist: the caller has already written the setting
	 * (or is muting, which is session-scoped and must not survive a restart), and
	 * a channel that both saved and applied would make a mute permanent the first
	 * time somebody used it.
	 *
	 * Resolves false when there is no audio host to apply it to, which the HUD
	 * treats as "nothing is playing" rather than as a failure.
	 */
	const applyVolume = async (volume: unknown): Promise<boolean> => {
		if (typeof volume !== 'number' || !Number.isFinite(volume)) {
			throw new Error('InvalidVolume');
		}
		if (!sharedState.audioBridge) return false;
		// Zero is legal here and only here: mute is a real state the HUD owns,
		// while the SLIDER floors above zero so it cannot become a silent mute.
		sharedState.audioBridge.setPlaybackVolume(Math.min(1, Math.max(0, volume)));
		return true;
	};
	const wrappedSetVolume = withIpcErrorLogging(handlerOpts('setVolume'), applyVolume);

	/**
	 * The microphones this machine offers, plus which one is selected.
	 *
	 * Serves the cache and asks the host to refresh in the background rather than
	 * awaiting it: only a renderer can enumerate devices, so a caller that waited
	 * would hang whenever the audio host is not open - which is most of the time,
	 * since nothing opens it until a session starts.
	 */
	const readInputDevices = async (): Promise<{
		devices: AudioDeviceInfo[];
		selectedId: string;
	}> => {
		if (getAcappellaAudioHostWindow()) sendAudioHostCommand({ kind: 'list-input-devices' });
		return {
			devices: inputDevices,
			selectedId:
				readVoiceProviderSettings(settingsStore).inputDeviceId ?? ACAPPELLA_SYSTEM_DEFAULT_INPUT,
		};
	};
	const wrappedInputDevices = withIpcErrorLogging(handlerOpts('inputDevices'), readInputDevices);

	/**
	 * Choose the microphone.
	 *
	 * Takes effect on the NEXT capture rather than mid-utterance: swapping the
	 * device under a live recogniser would splice two rooms into one sentence, and
	 * the pre-roll buffer in front of it belongs to the old one.
	 */
	const chooseInputDevice = async (rawId: unknown): Promise<boolean> => {
		if (typeof rawId !== 'string' || !rawId) throw new Error('InvalidInputDevice');
		const stored = (settingsStore.get(ACAPPELLA_SETTINGS_KEY, {}) ?? {}) as Record<string, unknown>;
		const audio = (stored.audio ?? {}) as Record<string, unknown>;
		if (!settingsStore.set) throw new Error('SettingsNotWritable');
		settingsStore.set(ACAPPELLA_SETTINGS_KEY, {
			...stored,
			audio: {
				...audio,
				// The sentinel is stored as "no preference" so the setting keeps
				// following the OS rather than pinning today's default device.
				inputDeviceId: rawId === ACAPPELLA_SYSTEM_DEFAULT_INPUT ? undefined : rawId,
			},
		});
		return true;
	};
	const wrappedSetInputDevice = withIpcErrorLogging(
		handlerOpts('setInputDevice'),
		chooseInputDevice
	);

	const handleAudioFrame = (event: IpcMainEvent, frame: unknown): void => {
		if (!isAcappellaAudioHostContents(event.sender)) return;
		if (!isAudioFrame(frame)) return;
		sharedState.audioBridge?.handleFrame(frame);
		// The tuning run taps the same frames rather than opening a second capture:
		// there is one microphone, and two consumers of it is one device conflict.
		if (sharedState.wakeTestDetector)
			sharedState.wakeTestDetector.pushFrame(new Int16Array(frame.pcm));
		else if (sharedState.wakeEnrollment?.isRecording) {
			sharedState.wakeEnrollment.pushFrame(new Int16Array(frame.pcm));
		} else sharedState.handsFree?.pushFrame(new Int16Array(frame.pcm));
		// A dictated clip taps them too, for the same reason.
		if (sharedState.clipCapture?.isActive)
			sharedState.clipCapture.pushFrame(new Int16Array(frame.pcm));
	};

	const handleAudioStatus = (event: IpcMainEvent, status: unknown): void => {
		if (!isAcappellaAudioHostContents(event.sender)) return;
		if (!status || typeof (status as AudioHostStatus).kind !== 'string') return;
		notePermissionFromStatus(status as AudioHostStatus);
		noteInputDevices(status as AudioHostStatus, deps.safeSend);
		sharedState.audioBridge?.handleStatus(status as AudioHostStatus);
		sharedState.clipCapture?.handleStatus(status as AudioHostStatus);
		noticeSpeech?.handleStatus(status as AudioHostStatus);
		logAudioHostStatus(status as AudioHostStatus);
		// A tuning run started before the host finished booting; see startWakeTestCapture.
		if ((status as AudioHostStatus).kind === 'ready') {
			markAcappellaAudioHostReady();
			// So did a wake phrase recording: same command, same replay.
			if (sharedState.wakeTestDetector || sharedState.wakeEnrollment?.isRecording) {
				startWakeTestCapture(deps);
			} else {
				sharedState.handsFree?.onAudioHostReady();
			}
		}
	};

	const handleWebRtcEvent = (event: IpcMainEvent, hostEvent: unknown): void => {
		if (!isAcappellaAudioHostContents(event.sender)) return;
		if (!hostEvent || typeof (hostEvent as WebRtcHostEvent).kind !== 'string') return;
		getACappellaTransport()?.handleHostEvent(hostEvent as WebRtcHostEvent);
	};

	return {
		applyVolume,
		readInputDevices,
		chooseInputDevice,
		wrappedOpenMicSettings,
		wrappedMicPermission,
		wrappedSetVolume,
		wrappedInputDevices,
		wrappedSetInputDevice,
		handleAudioFrame,
		handleAudioStatus,
		handleWebRtcEvent,
	};
}
