/**
 * A Cappella IPC Handlers
 *
 * The Electron transport in front of the headless voice session service. Thin
 * on purpose: every rule that matters (state machine, provider substitution,
 * dispatch) lives in `src/main/acappella/`, and this layer only translates
 * channels into calls and protocol events into a push.
 *
 * Domain modules live under `src/main/ipc/handlers/acappella/`:
 *   - `shared.ts`: shared types, channel constants, and small stateless helpers
 *   - `state.ts`: cross-module mutable state and its reset
 *   - `session.ts`: session lifecycle, floor control, send-wait, teardown
 *   - `providers.ts`: pipeline resolution, credentials, Voice Studio, voices
 *   - `audio-host.ts`: audio host bridge, mic permissions, devices, dictation/notices
 *   - `wake.ts`: hands-free wake word, wake test, wake enrollment, hotkeys
 *   - `routing.ts`: conductor routing outcome log, corrections, roster
 *   - `voice-control.ts`: paired-device transport and `maestro-cli voice` service
 */

import { app, ipcMain } from 'electron';

import type { RosterAgent } from '../../../shared/acappella/protocol';
import type { VoiceSendWait } from '../../../shared/acappella/listen-mode';
import {
	ACAPPELLA_AUDIO_FRAME_CHANNEL,
	ACAPPELLA_AUDIO_STATUS_CHANNEL,
} from '../../../shared/acappella/audio-host';
import { ACAPPELLA_WEBRTC_EVENT_CHANNEL } from '../../../shared/acappella/webrtc-host';
import {
	disposeVoiceSessionService,
	closeAcappellaAudioHostWindow,
	getVoiceSessionService,
	type VoiceSessionSnapshot,
} from '../../acappella';
import { migrateLegacyVoiceProviders } from '../../acappella/providers/provider-registry';
import { flushRoutingLog } from '../../acappella/router/routing-log';
import type { TurnBreakdown } from '../../acappella/telemetry/turn-metrics';
import {
	createAudioHostHandlers,
	disposeACappellaAudioBridge,
	ensureAudioBridge,
	initClipCapture,
	initNoticeSpeech,
	releaseDictationRegistration,
	releaseNoticeSpeakerAndTts,
} from './acappella/audio-host';
import {
	applyACappellaProvidersWithCallbacks,
	createProviderHandlers,
	resetProvidersState,
} from './acappella/providers';
import { createRoutingHandlers, resetRoutingState, watchRosterChanges } from './acappella/routing';
import {
	createSessionHandlers,
	readSendWait,
	resetSessionState,
	shutdownACappellaForDisable,
	stopVoiceSessionForWindow,
} from './acappella/session';
import {
	ACAPPELLA_EVENT_CHANNEL,
	ACAPPELLA_INPUT_DEVICES_CHANNEL,
	ACAPPELLA_WAKE_ENROLLMENT_CHANNEL,
	ACAPPELLA_WAKE_TEST_CHANNEL,
	requireEnabled,
	type ACappellaHandlerDependencies,
	type VoiceStartSessionResult,
	type WakeTestEvent,
	type WakeTestStartResult,
} from './acappella/shared';
import {
	clearActiveProviderKey,
	clearClipCapture,
	clearWakeTestTaps,
	disposeActivePipelineAndBridge,
	disposeHandsFree,
	disposeWakeEnrollment,
	sharedState,
} from './acappella/state';
import {
	disposeTransport,
	initTransportAndDevices,
	registerVoiceControl,
	releaseVoiceControlRegistration,
} from './acappella/voice-control';
import {
	createWakeHandlers,
	disposeVoiceHotkeys,
	initHandsFree,
	initVoiceHotkeys,
	initWakeEnrollment,
	releaseWakeEnrollmentRegistration,
	stopWakeTest,
	syncVoiceHotkeys,
} from './acappella/wake';

export {
	ACAPPELLA_EVENT_CHANNEL,
	ACAPPELLA_INPUT_DEVICES_CHANNEL,
	ACAPPELLA_WAKE_ENROLLMENT_CHANNEL,
	ACAPPELLA_WAKE_TEST_CHANNEL,
	disposeACappellaAudioBridge,
	shutdownACappellaForDisable,
	stopVoiceSessionForWindow,
	type ACappellaHandlerDependencies,
	type VoiceStartSessionResult,
	type WakeTestEvent,
	type WakeTestStartResult,
};

/**
 * Apply a provider change to the running app.
 */
export async function applyACappellaProviders(
	deps: ACappellaHandlerDependencies
): Promise<{ status: 'swapped' | 'unchanged' | 'refused'; reason?: string }> {
	return applyACappellaProvidersWithCallbacks(deps, { ensureAudioBridge, readSendWait });
}

/**
 * Bring the voice machinery up to date after the settings FILE changed.
 *
 * Everything in this layer that follows settings does it from the store's
 * change event, and that event fires only for a write made inside the app. A
 * write from outside (`maestro-cli settings set acappella.controls...`, a hand
 * edit) changes the file and tells the renderer, and would otherwise leave the
 * always-on wake word armed on the old phrase and the hotkeys on the old
 * timing until the next restart. Called from the settings watcher's
 * `onSettingsChangedExternally`. A no-op before the handlers are registered.
 */
export function syncACappellaAfterExternalSettingsChange(): void {
	void sharedState.handsFree?.sync();
	syncVoiceHotkeys();
}

/**
 * Register the A Cappella IPC handlers.
 *
 * Wired from `setupIpcHandlers()` (src/main/ipc/bootstrap/index.ts), which is
 * what the running app calls. A handler registered only through
 * `registerAllHandlers()` in handlers/index.ts would be dead.
 */
export function registerACappellaHandlers(deps: ACappellaHandlerDependencies): void {
	const { settingsStore } = deps;

	// Before anything reads a provider id: an upgraded install can still hold the
	// mock trio an early build persisted, and it outranks every default.
	migrateLegacyVoiceProviders(settingsStore);
	watchRosterChanges();

	const session = createSessionHandlers(deps);
	initHandsFree(deps, session.floorSession);
	initClipCapture(deps);
	initWakeEnrollment(deps);
	initNoticeSpeech(deps);
	const hotkeys = initVoiceHotkeys(deps, session.floorSession);
	initTransportAndDevices(deps, hotkeys);

	const audio = createAudioHostHandlers(deps);
	const routing = createRoutingHandlers();
	const providers = createProviderHandlers(deps, { ensureAudioBridge, readSendWait });
	const wake = createWakeHandlers(deps);

	ipcMain.handle(
		'acappella:start-session',
		async (event, scope: unknown, options: unknown): Promise<VoiceStartSessionResult> => {
			requireEnabled(settingsStore);
			// Resolved HERE rather than inside the wrapped handler, because
			// `withIpcErrorLogging` strips the event and the sender is the only
			// evidence of which window the user actually clicked in.
			return session.wrappedStart(
				event,
				scope,
				deps.resolveVoiceWindowId?.(event?.sender) ?? null,
				// Only a literal `true` opens gated: an absent or malformed option must
				// not produce a session that looks live and hears nothing.
				(options as { paused?: unknown } | null | undefined)?.paused === true
			);
		}
	);

	// Deliberately ungated: turning the Encore Feature off while a session is
	// live must still be able to release the floor.
	ipcMain.handle('acappella:stop-session', session.wrappedStop);

	ipcMain.handle('acappella:submit-utterance', async (event, text: unknown): Promise<boolean> => {
		requireEnabled(settingsStore);
		return session.wrappedSubmitUtterance(event, text);
	});

	ipcMain.handle('acappella:set-scope', async (_event, rawScope: unknown): Promise<boolean> => {
		requireEnabled(settingsStore);
		return session.setScope(rawScope);
	});

	ipcMain.handle('acappella:end-utterance', async (): Promise<void> => {
		requireEnabled(settingsStore);
		session.sendNow();
	});

	ipcMain.handle('acappella:set-listening', async (_event, payload: unknown): Promise<boolean> => {
		requireEnabled(settingsStore);
		return session.setListening(payload);
	});

	// Ungated read: the HUD draws the wait chip from it, and a chip that threw
	// while the feature was being switched off would blank the control row.
	ipcMain.handle('acappella:get-send-wait', async (): Promise<VoiceSendWait> => readSendWait(deps));

	ipcMain.handle(
		'acappella:set-send-wait',
		async (_event, waitMs: unknown): Promise<VoiceSendWait> => {
			requireEnabled(settingsStore);
			return session.setSendWait(waitMs);
		}
	);

	ipcMain.handle('acappella:set-force-send', async (_event, enabled: unknown): Promise<boolean> => {
		requireEnabled(settingsStore);
		return (
			typeof enabled === 'boolean' && (getVoiceSessionService()?.setForceSend(enabled) ?? false)
		);
	});

	ipcMain.handle('acappella:interrupt', async (event, source: unknown): Promise<boolean> => {
		requireEnabled(settingsStore);
		return session.wrappedInterrupt(event, source);
	});

	ipcMain.handle('acappella:stop-word', async (event, payload: unknown): Promise<void> => {
		requireEnabled(settingsStore);
		return session.wrappedStopWord(event, payload);
	});

	ipcMain.handle(
		'acappella:submit-agent-reply',
		async (event, payload: unknown): Promise<boolean> => {
			requireEnabled(settingsStore);
			return session.wrappedSubmitAgentReply(event, payload);
		}
	);

	ipcMain.handle('acappella:open-mic-settings', audio.wrappedOpenMicSettings);
	ipcMain.handle('acappella:mic-permission', audio.wrappedMicPermission);

	ipcMain.handle('acappella:get-roster', async (event): Promise<RosterAgent[]> => {
		requireEnabled(settingsStore);
		return routing.wrappedGetRoster(event);
	});

	ipcMain.handle('acappella:get-state', async (event): Promise<VoiceSessionSnapshot | null> => {
		requireEnabled(settingsStore);
		return session.wrappedGetState(event);
	});

	ipcMain.handle('acappella:correct-route', async (event, agentSessionId: unknown) => {
		requireEnabled(settingsStore);
		return routing.wrappedCorrectRoute(event, agentSessionId);
	});

	ipcMain.handle('acappella:routing-log', routing.wrappedRoutingLog);

	ipcMain.handle('acappella:list-credentials', providers.wrappedListCredentials);
	ipcMain.handle('acappella:voice-studio-status', providers.wrappedVoiceStudioStatus);
	ipcMain.handle('acappella:set-credential', providers.wrappedSetCredential);
	ipcMain.handle('acappella:validate-credential', providers.wrappedValidateCredential);

	ipcMain.handle('acappella:apply-providers', async (event) => {
		requireEnabled(settingsStore);
		return providers.wrappedApplyProviders(event);
	});

	ipcMain.handle('acappella:list-voices', async (event) => {
		requireEnabled(settingsStore);
		return providers.wrappedListVoices(event);
	});

	ipcMain.handle(
		'acappella:preview-voice',
		async (event, text: unknown, voiceId: unknown): Promise<boolean> => {
			requireEnabled(settingsStore);
			return providers.wrappedPreviewVoice(event, text, voiceId);
		}
	);

	ipcMain.handle('acappella:set-volume', async (event, volume: unknown): Promise<boolean> => {
		requireEnabled(settingsStore);
		return audio.wrappedSetVolume(event, volume);
	});

	ipcMain.handle('acappella:input-devices', audio.wrappedInputDevices);
	ipcMain.handle('acappella:set-input-device', audio.wrappedSetInputDevice);

	ipcMain.handle('acappella:last-turn', async (event): Promise<TurnBreakdown | null> => {
		requireEnabled(settingsStore);
		return session.wrappedLastTurn(event);
	});

	ipcMain.handle('acappella:hotkey-status', wake.wrappedHotkeyStatus);

	ipcMain.handle(
		'acappella:wake-test',
		async (event, payload: unknown): Promise<WakeTestStartResult> => {
			requireEnabled(settingsStore);
			return wake.wrappedWakeTest(event, payload);
		}
	);

	// Ungated, like `stop-session`: a tuning run has an open microphone, and
	// switching the feature off must still be able to close it.
	ipcMain.handle('acappella:wake-test-stop', wake.wrappedWakeTestStop);

	// One channel for every enrollment verb, and no gate here: the entry point
	// decides which verbs need voice switched on, so `maestro-cli voice wake`
	// reaching it over the bridge is held to exactly the same rule.
	ipcMain.handle('acappella:wake-enrollment', wake.wrappedWakeEnrollment);

	// The audio host's own control link. `on`, not `handle`: frames arrive fifty
	// times a second and nothing about them needs a reply, so a promise round trip
	// per 20 ms of audio would be pure overhead.
	ipcMain.on(ACAPPELLA_AUDIO_FRAME_CHANNEL, audio.handleAudioFrame);
	ipcMain.on(ACAPPELLA_AUDIO_STATUS_CHANNEL, audio.handleAudioStatus);
	ipcMain.on(ACAPPELLA_WEBRTC_EVENT_CHANNEL, audio.handleWebRtcEvent);

	registerVoiceControl(deps, {
		ensureService: session.ensureService,
		startSession: session.startSession,
		setScope: session.setScope,
		sendNow: session.sendNow,
		setListening: session.setListening,
		setSendWait: session.setSendWait,
		applyVolume: audio.applyVolume,
		readInputDevices: audio.readInputDevices,
		chooseInputDevice: audio.chooseInputDevice,
		beginWakeTest: wake.beginWakeTest,
	});

	// Release the floor on the way out, and with it the microphone: the audio host
	// window holds a real capture device, and a session left running would keep it
	// open past the last app window. Fire-and-forget: `will-quit` is synchronous,
	// and this is the last thing the session will ever do.
	app.on('will-quit', () => {
		void disposeVoiceSessionService();
		closeAcappellaAudioHostWindow();
		// The log is written on a debounce, so the last few turns of a session are
		// still in memory when the app is told to quit.
		void flushRoutingLog();
		resetACappellaHandlerState();
	});
}

/**
 * Tear down all voice handler state and registrations.
 *
 * Runs on `app.on('will-quit')` as the voice stack's quit teardown as well as
 * in tests, so the sequence below preserves the exact dependency order
 * (e.g. disposing `handsFree` and `wakeEnrollment` before releasing their
 * registrations and stopping any active wake test).
 */
export function resetACappellaHandlerState(): void {
	clearActiveProviderKey();
	resetProvidersState();
	resetSessionState();
	disposeVoiceHotkeys();
	disposeTransport();
	disposeHandsFree();
	disposeWakeEnrollment();
	releaseWakeEnrollmentRegistration();
	releaseVoiceControlRegistration();
	clearWakeTestTaps();
	releaseDictationRegistration();
	clearClipCapture();
	releaseNoticeSpeakerAndTts();
	void stopWakeTest();
	disposeActivePipelineAndBridge();
	resetRoutingState();
}
