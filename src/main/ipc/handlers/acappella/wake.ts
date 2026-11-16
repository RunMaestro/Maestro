/**
 * Always-on hands-free wake listener, wake-word tuning, wake phrase enrollment,
 * and global voice hotkeys for A Cappella IPC handlers.
 */

import { logger } from '../../../utils/logger';
import { withIpcErrorLogging } from '../../../utils/ipcHandler';
import { isACappellaEnabled } from '../../../../shared/acappella/feature-flag';
import type { GlobalHotkeyStatus } from '../../../../shared/global-hotkeys';
import { DEFAULT_WAKE_PHRASE } from '../../../../shared/acappella/voice-controls';
import type { WakeEnrollmentReply } from '../../../../shared/acappella/wake-enrollment';
import { ensureAcappellaAudioHostWindow, getVoiceSessionService } from '../../../acappella';
import {
	ACAPPELLA_SETTINGS_KEY,
	readVoiceProviderSettings,
} from '../../../acappella/providers/provider-registry';
import { requestMicPermission } from '../../../acappella/permissions/mic-permission';
import { readVoiceReadiness } from '../acappella-models';
import { installVoiceHotkeys, type VoiceHotkeyInstallation } from '../../../acappella/hotkeys';
import { describePressHoldCapability } from '../../../acappella/hotkeys/press-hold';
import type { FloorControlSession } from '../../../acappella/audio/floor-control';
import { HandsFreeListener } from '../../../acappella/wake/hands-free';
import { enrolledWakeRevision } from '../../../acappella/wake/wake-enrollment-store';
import {
	registerWakeEnrollmentService,
	runWakeEnrollmentRequest,
	WakeEnrollmentService,
} from '../../../acappella/wake/wake-enrollment-service';
import { wakeScorerFactory } from '../../../acappella/wake/transcription-wake';
import {
	createWakeDetector,
	globalWakePhrase,
	type WakeDetection,
	type WakePhrase,
} from '../../../acappella/wake/wake-detector';
import { startWakeTestCapture } from './audio-host';
import {
	ACAPPELLA_EVENT_CHANNEL,
	ACAPPELLA_WAKE_ENROLLMENT_CHANNEL,
	ACAPPELLA_WAKE_TEST_CHANNEL,
	handlerOpts,
	isRecord,
	LOG_CONTEXT,
	sendAudioHostCommand,
	type ACappellaHandlerDependencies,
	type WakeTestEvent,
	type WakeTestStartResult,
} from './shared';
import { sharedState } from './state';

/**
 * The global voice hotkeys. Module state because they outlive any one session
 * (their job is to start one) and must be disposed on `resetACappellaHandlerState`.
 */
let voiceHotkeys: VoiceHotkeyInstallation | null = null;
let releaseWakeEnrollment: (() => void) | null = null;

export function syncVoiceHotkeys(): void {
	voiceHotkeys?.sync();
}

export function disposeVoiceHotkeys(): void {
	voiceHotkeys?.dispose();
	voiceHotkeys = null;
}

export function releaseWakeEnrollmentRegistration(): void {
	releaseWakeEnrollment?.();
	releaseWakeEnrollment = null;
}

/**
 * Start a wake-word tuning run: open the microphone and push every detection
 * event on `acappella:wake-test` so the Settings UI can light up.
 */
async function startWakeTest(
	deps: ACappellaHandlerDependencies,
	payload: unknown
): Promise<WakeTestStartResult> {
	await stopWakeTest();
	// One microphone, one consumer: the Test borrows it from the always-on wake word.
	await sharedState.handsFree?.suspend();
	const state = getVoiceSessionService()?.getState();
	if (state && state !== 'idle') {
		return { started: false, reason: 'End the voice session first, then test the wake word.' };
	}
	if (sharedState.clipCapture?.isActive) {
		return { started: false, reason: 'Finish the dictation first, then test the wake word.' };
	}
	if (sharedState.wakeEnrollment?.isRecording) {
		return { started: false, reason: 'Finish recording the phrase first, then test it.' };
	}
	if (!deps.audioHostDeps) {
		return { started: false, reason: 'There is no audio host to capture the microphone through.' };
	}

	const readiness = await readVoiceReadiness(deps.settingsStore);
	const wakeSlot = readiness.slots.find((slot) => slot.slot === 'wake-word');
	if (wakeSlot && !wakeSlot.satisfied) {
		return {
			started: false,
			reason: [wakeSlot.detail, wakeSlot.suggestedAction].filter(Boolean).join(' '),
		};
	}

	const body = isRecord(payload) ? payload : {};
	const phrase =
		typeof body.phrase === 'string' && body.phrase.trim() ? body.phrase.trim() : undefined;
	const sensitivity = typeof body.sensitivity === 'number' ? body.sensitivity : undefined;
	const phrases: WakePhrase[] = [globalWakePhrase(phrase, sensitivity)];

	await requestMicPermission();
	ensureAcappellaAudioHostWindow(deps.audioHostDeps);

	const detector = createWakeDetector({
		// The same engine the always-on listener uses, so the Test tunes what will
		// actually run.
		createScorer: wakeScorerFactory(
			readVoiceProviderSettings(deps.settingsStore).wakeEngine ?? 'classifier'
		),
		getPhrases: () => phrases,
		onWake: (detection: WakeDetection) => {
			const event: WakeTestEvent = {
				phraseId: detection.phraseId,
				phrase: detection.phrase,
				score: detection.score,
				at: detection.at,
			};
			deps.safeSend(ACAPPELLA_WAKE_TEST_CHANNEL, event);
			for (const tap of sharedState.wakeTestTaps) tap(event);
		},
	});
	await detector.start();
	if (!detector.isArmed) {
		// The gate said yes and the scorer still would not build: report it rather
		// than listening with nothing behind the microphone.
		await detector.stop();
		return {
			started: false,
			reason: 'The wake word model could not be loaded. Check System Logs.',
		};
	}
	sharedState.wakeTestDetector = detector;
	startWakeTestCapture(deps);
	return { started: true };
}

/** End a tuning run and close the microphone it opened. Safe when none is running. */
export async function stopWakeTest(): Promise<void> {
	const detector = sharedState.wakeTestDetector;
	if (!detector) return;
	sharedState.wakeTestDetector = null;
	// Logged because a run that never fires is otherwise indistinguishable from
	// one that never heard anything: zero frames is a capture problem, frames with
	// a low peak is a phrase or sensitivity problem.
	const stats = detector.getStats();
	logger.info(
		`Wake test ended: ${stats.framesReceived} frames, peak level ${stats.peakLevel.toFixed(3)}, ${stats.hopsScored} windows scored, ${stats.detections} detections, peak score ${stats.peakScore.toFixed(3)}`,
		LOG_CONTEXT
	);
	await detector.stop();
	// Only when no session owns the device: a tuning run that ended while a
	// session was starting must not close that session's microphone.
	const state = getVoiceSessionService()?.getState() ?? 'idle';
	if (state === 'idle') sendAudioHostCommand({ kind: 'stop-capture' });
	void sharedState.handsFree?.resume();
}

export function initHandsFree(
	deps: ACappellaHandlerDependencies,
	floorSession: FloorControlSession
): void {
	const { settingsStore } = deps;

	sharedState.handsFree ??= new HandsFreeListener({
		readSettings: () => {
			const settings = readVoiceProviderSettings(settingsStore);
			return {
				// The Encore flag gates it too: switching A Cappella off must close an
				// always-on microphone even though the wake toggle is still stored on.
				enabled: isACappellaEnabled(settingsStore) && settings.wakeWordEnabled === true,
				phrase: settings.wakePhrase,
				sensitivity: settings.wakeSensitivity,
				debounceMs: settings.wakeDebounceMs,
				engine: settings.wakeEngine,
				// Retraining the phrase replaces the model the armed detector loaded.
				modelRevision: enrolledWakeRevision(settings.wakePhrase ?? DEFAULT_WAKE_PHRASE),
			};
		},
		canRunHandsFree: async () => (await readVoiceReadiness(settingsStore)).canRunHandsFree,
		getSessionState: () => getVoiceSessionService()?.getState() ?? 'idle',
		isMicrophoneBorrowed: () =>
			(sharedState.clipCapture?.isActive ?? false) ||
			(sharedState.wakeEnrollment?.isRecording ?? false),
		startSession: () =>
			floorSession.startSession({ scope: { kind: 'conductor' }, source: 'wake-word' }),
		ensureAudioHost: () => {
			if (deps.audioHostDeps) ensureAcappellaAudioHostWindow(deps.audioHostDeps);
		},
		requestMicPermission,
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
	});
	settingsStore.onDidChange?.(ACAPPELLA_SETTINGS_KEY, () => void sharedState.handsFree?.sync());
	settingsStore.onDidChange?.('encoreFeatures', () => void sharedState.handsFree?.sync());
	// Armed at launch when the toggle was left on: that is what "always listening" means.
	void sharedState.handsFree.sync();
}

export function initWakeEnrollment(deps: ACappellaHandlerDependencies): void {
	const { settingsStore } = deps;

	// Wake phrase enrollment borrows the same microphone, under the same rules:
	// one consumer at a time, and never out from under a live session.
	sharedState.wakeEnrollment ??= new WakeEnrollmentService({
		emit: (event) => deps.safeSend(ACAPPELLA_WAKE_ENROLLMENT_CHANNEL, event),
		microphoneBusyReason: () => {
			if ((getVoiceSessionService()?.getState() ?? 'idle') !== 'idle') {
				return 'End the voice session first, then record the phrase.';
			}
			if (sharedState.clipCapture?.isActive)
				return 'Finish the dictation first, then record the phrase.';
			if (sharedState.wakeTestDetector)
				return 'Stop the wake word Test first, then record the phrase.';
			if (!deps.audioHostDeps) return 'There is no audio host to capture the microphone through.';
			return null;
		},
		openMicrophone: async () => {
			await requestMicPermission();
			if (deps.audioHostDeps) ensureAcappellaAudioHostWindow(deps.audioHostDeps);
			startWakeTestCapture(deps);
			// The always-on wake word reads `isRecording` and stands down.
			void sharedState.handsFree?.sync();
		},
		closeMicrophone: async () => {
			// Never close a microphone a session is using.
			if ((getVoiceSessionService()?.getState() ?? 'idle') === 'idle') {
				sendAudioHostCommand({ kind: 'stop-capture' });
			}
			void sharedState.handsFree?.sync();
		},
		// A newly trained phrase may be the one hands-free is waiting to arm on.
		onModelChanged: () => void sharedState.handsFree?.sync(),
	});
	releaseWakeEnrollment ??= registerWakeEnrollmentService(sharedState.wakeEnrollment, () =>
		isACappellaEnabled(settingsStore)
	);
}

export function initVoiceHotkeys(
	deps: ACappellaHandlerDependencies,
	floorSession: FloorControlSession
): VoiceHotkeyInstallation {
	const { settingsStore } = deps;

	return (voiceHotkeys ??= installVoiceHotkeys({
		settingsStore,
		session: floorSession,
		getMainWindow: deps.getMainWindow,
		getFocusedAgentSessionId: deps.getFocusedAgentSessionId ?? (() => null),
		// Two halves of one gesture, and both are needed. The bridge owns the
		// recogniser handle, so the flush goes through it; the session owns the
		// composer, which would otherwise buffer the resulting final and sit out a
		// settle window the user already answered by letting go of the key.
		endUtterance: () => {
			sharedState.audioBridge?.endUtterance();
			getVoiceSessionService()?.endUtteranceNow();
		},
		// Broadcast rather than logged: a hotkey that did nothing has to say why,
		// or the user concludes the key is broken.
		onRefused: (info) => deps.safeSend(ACAPPELLA_EVENT_CHANNEL + ':hotkey-refused', info),
	}));
}

export function createWakeHandlers(deps: ACappellaHandlerDependencies) {
	const wrappedHotkeyStatus = withIpcErrorLogging(
		handlerOpts('hotkeyStatus'),
		async (): Promise<{ statuses: GlobalHotkeyStatus[]; capability: string; note: string }> => ({
			statuses: voiceHotkeys?.statuses() ?? [],
			capability: voiceHotkeys?.controller.capability ?? 'tap-only',
			note: describePressHoldCapability(voiceHotkeys?.controller.capability ?? 'tap-only'),
		})
	);

	const beginWakeTest = async (payload: unknown): Promise<WakeTestStartResult> => {
		const result = await startWakeTest(deps, payload);
		// A refused Test borrowed nothing; give the always-on wake word its microphone back.
		if (!result.started) void sharedState.handsFree?.resume();
		return result;
	};
	const wrappedWakeTest = withIpcErrorLogging(handlerOpts('wakeTest'), beginWakeTest);

	const wrappedWakeTestStop = withIpcErrorLogging(
		handlerOpts('wakeTestStop'),
		async (): Promise<void> => stopWakeTest()
	);

	const wrappedWakeEnrollment = withIpcErrorLogging(
		handlerOpts('wakeEnrollment'),
		async (request: unknown): Promise<WakeEnrollmentReply> => runWakeEnrollmentRequest(request)
	);

	return {
		beginWakeTest,
		wrappedHotkeyStatus,
		wrappedWakeTest,
		wrappedWakeTestStop,
		wrappedWakeEnrollment,
	};
}
