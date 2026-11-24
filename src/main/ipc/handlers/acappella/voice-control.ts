/**
 * Paired-device transport initialization and the headless voice control service
 * (`maestro-cli voice`) for A Cappella IPC handlers.
 */

import { app } from 'electron';
import { hostname } from 'os';

import { isACappellaEnabled } from '../../../../shared/acappella/feature-flag';
import type { AudioDeviceInfo } from '../../../../shared/acappella/audio-host';
import type { VoiceOrigin, VoiceWindowId, WakeSource } from '../../../../shared/acappella/protocol';
import type { VoiceSendWait } from '../../../../shared/acappella/listen-mode';
import { scopeRebindBlocker } from '../../../../shared/acappella/quick-chat-scope';
import {
	VOICE_PREVIEW_LINE,
	type VoiceSessionView,
	type VoiceWakeHit,
} from '../../../../shared/acappella/voice-control';
import type { VoiceCredentialService } from '../../../../shared/acappella/provider-catalog';
import { ACAPPELLA_WEBRTC_COMMAND_CHANNEL } from '../../../../shared/acappella/webrtc-host';
import {
	disposeACappellaTransport,
	getAcappellaAudioHostWindow,
	getACappellaTransport,
	getVoiceSessionService,
	initACappellaTransport,
} from '../../../acappella';
import type { ACappellaTransport } from '../../../acappella/transport';
import type { VoiceHotkeyInstallation } from '../../../acappella/hotkeys';
import { readVoiceProviderSettings } from '../../../acappella/providers/provider-registry';
import {
	clearCredential,
	listCredentialStates,
	setCredential,
	validateCredential,
} from '../../../acappella/providers/credentials';
import { formatTurnBreakdown, lastTurn } from '../../../acappella/telemetry/turn-metrics';
import { formatVoiceSelfTestReport, runVoiceSelfTest } from '../../../acappella/voice-self-test';
import {
	registerVoiceControlService,
	VoiceControlRefusal,
	type VoiceControlHandlers,
} from '../../../acappella/voice-control-service';
import {
	ACAPPELLA_DEVICES_CHANNEL,
	ACAPPELLA_PAIRING_REQUEST_CHANNEL,
	registerACappellaDeviceHandlers,
	setVoiceDiscovery,
	testVoiceConnection,
} from '../acappella-devices';
import { readVoiceReadiness } from '../acappella-models';
import { ensureAudioBridge } from './audio-host';
import {
	applyACappellaProvidersWithCallbacks,
	listVoiceOptions,
	previewVoiceLine,
} from './providers';
import { cancelPendingVoiceStart, readSendWait } from './session';
import {
	toVoiceSessionView,
	type ACappellaHandlerDependencies,
	type VoiceStartSessionResult,
	type WakeTestEvent,
	type WakeTestStartResult,
} from './shared';
import { sharedState } from './state';
import { stopWakeTest } from './wake';

/**
 * The registration of this layer's functions as the one voice control service
 * (`acappella/voice-control-service.ts`), which `maestro-cli voice` reaches.
 */
let releaseVoiceControl: (() => void) | null = null;

/**
 * The paired-device transport. Module state alongside the hotkeys and for the
 * same reason: it holds live signaling sessions and a Bonjour advert, both of
 * which outlive any one voice session.
 */
let transport: ACappellaTransport | null = null;

export function disposeTransport(): void {
	disposeACappellaTransport();
	transport = null;
}

export function releaseVoiceControlRegistration(): void {
	releaseVoiceControl?.();
	releaseVoiceControl = null;
}

export function initTransportAndDevices(
	deps: ACappellaHandlerDependencies,
	hotkeys: VoiceHotkeyInstallation
): void {
	const { settingsStore } = deps;

	/**
	 * The paired-device transport.
	 *
	 * Built here, next to the floor, because it presses the SAME controller a
	 * hotkey does: a phone's talk button and a keyboard chord are two surfaces
	 * over one state machine, not two ways to open a microphone. Constructed
	 * eagerly and cheaply - it opens no socket and advertises nothing until a user
	 * asks it to.
	 */
	transport ??= initACappellaTransport({
		settingsStore,
		userDataPath: app.getPath('userData'),
		sendToAudioHost: (command) => {
			const win = getAcappellaAudioHostWindow();
			if (!win || win.webContents.isDestroyed()) return;
			win.webContents.send(ACAPPELLA_WEBRTC_COMMAND_CHANNEL, command);
		},
		acquireFloor: (scope, origin) => hotkeys.acquireFloor(scope, origin),
		getSession: () => getVoiceSessionService(),
		getServerToken: () => deps.getWebServer?.()?.getSecurityToken() ?? null,
		getServerPort: () => deps.getWebServer?.()?.getPort() ?? null,
		getAppVersion: () => app.getVersion(),
		getMachineName: () => hostname(),
		onDevicesChanged: () => deps.safeSend(ACAPPELLA_DEVICES_CHANNEL, null),
		onPairingRequest: (request) => deps.safeSend(ACAPPELLA_PAIRING_REQUEST_CHANNEL, request),
	});

	registerACappellaDeviceHandlers({ settingsStore });
}

export interface VoiceControlSessionActions {
	startSession: (
		rawScope: unknown,
		windowId: VoiceWindowId,
		paused: boolean,
		source?: WakeSource,
		origin?: VoiceOrigin,
		onSessionError?: (message: string) => void
	) => Promise<VoiceStartSessionResult>;
	setScope: (rawScope: unknown) => boolean;
	sendNow: () => void;
	setListening: (payload: unknown) => boolean;
	setSendWait: (waitMs: unknown) => VoiceSendWait;
	applyVolume: (volume: unknown) => Promise<boolean>;
	readInputDevices: () => Promise<{ devices: AudioDeviceInfo[]; selectedId: string }>;
	chooseInputDevice: (rawId: unknown) => Promise<boolean>;
	beginWakeTest: (payload: unknown) => Promise<WakeTestStartResult>;
}

export function registerVoiceControl(
	deps: ACappellaHandlerDependencies,
	actions: VoiceControlSessionActions
): void {
	const { settingsStore } = deps;
	const callbacks = { ensureAudioBridge, readSendWait };

	// `maestro-cli voice` reaches the functions above through one entry point
	// (`runVoiceControlRequest`). Every handler is the body of a button: the same
	// function, on the same session, under the same rules. What differs from a
	// click is only what a caller with no window can supply: the HUD of a session
	// it starts belongs to the window the user is looking at, as it does for a
	// global hotkey, and a refusal comes back as a sentence.
	const sessionView = (): VoiceSessionView | null =>
		toVoiceSessionView(getVoiceSessionService()?.getSnapshot() ?? null);
	const requireDevice = (changed: boolean, deviceId: string): void => {
		if (!changed) throw new VoiceControlRefusal(`No paired device has the id "${deviceId}".`);
	};
	const requireKeySaved = (result: { ok: boolean; error?: string }): void => {
		if (!result.ok) throw new VoiceControlRefusal(result.error ?? 'The key could not be saved.');
	};
	const isConfigured = (service: VoiceCredentialService): boolean =>
		listCredentialStates().some((state) => state.service === service && state.configured);

	const controlHandlers: VoiceControlHandlers = {
		status: async () => {
			const enabled = isACappellaEnabled(settingsStore);
			return {
				enabled,
				session: sessionView(),
				// The gate is not asked while voice is off, as `models:readiness` is not.
				readiness: enabled ? await readVoiceReadiness(settingsStore) : null,
				sendWait: readSendWait(deps),
			};
		},
		start: async ({ scope, paused }) => {
			// A start that cannot run says so on the event stream, which a caller
			// with no HUD never sees. The message is caught here for the refusal.
			let failure: string | null = null;
			const { snapshot, substitutions } = await actions.startSession(
				scope,
				deps.resolveVoiceWindowId?.() ?? null,
				paused === true,
				undefined,
				undefined,
				(message) => {
					failure = message;
				}
			);
			if (snapshot.state === 'idle' || snapshot.state === 'error') {
				throw new VoiceControlRefusal(
					failure ??
						(snapshot.state === 'idle'
							? 'The voice start was cancelled.'
							: 'The voice session could not start.')
				);
			}
			return { session: toVoiceSessionView(snapshot) as VoiceSessionView, substitutions };
		},
		stop: async () => {
			cancelPendingVoiceStart();
			await getVoiceSessionService()?.stopSession('user');
			return { session: sessionView() };
		},
		listen: async ({ listening, send }) => ({
			applied: actions.setListening({ listening, send }),
			listening,
		}),
		send: async () => {
			actions.sendNow();
			return { session: sessionView() };
		},
		'stop-reply': async () => ({
			interrupted: getVoiceSessionService()?.interrupt('client-button') ?? false,
		}),
		scope: async ({ scope }) => {
			// A locked binding is a refusal with its own sentence. Without this the
			// caller is told there is no session, which is not what happened.
			const live = getVoiceSessionService()?.getSnapshot();
			const blocker = live && live.state !== 'idle' ? scopeRebindBlocker(live.scope, scope) : null;
			if (blocker) throw new VoiceControlRefusal(blocker);
			return { applied: actions.setScope(scope), scope };
		},
		wait: async ({ waitMs }) => actions.setSendWait(waitMs),
		volume: async ({ volume }) => ({ applied: await actions.applyVolume(volume), volume }),
		inputs: async () => actions.readInputDevices(),
		'set-input': async ({ deviceId }) => {
			await actions.chooseInputDevice(deviceId);
			return { selectedId: (await actions.readInputDevices()).selectedId };
		},
		'apply-providers': async () => applyACappellaProvidersWithCallbacks(deps, callbacks),
		voices: async () => ({ voices: await listVoiceOptions(deps) }),
		preview: async ({ text, voiceId }) => ({
			spoke: await previewVoiceLine(deps, callbacks, text ?? VOICE_PREVIEW_LINE, voiceId),
		}),
		credentials: async () => ({ credentials: listCredentialStates() }),
		'set-credential': async ({ service, key }) => {
			requireKeySaved(setCredential(service, key));
			return { service, configured: isConfigured(service) };
		},
		'clear-credential': async ({ service }) => {
			requireKeySaved(clearCredential(service));
			return { service, configured: isConfigured(service) };
		},
		'test-credential': async ({ service, key }) => validateCredential(service, key),
		devices: async () => {
			const live = getACappellaTransport();
			return {
				devices: (await live?.listDevices()) ?? [],
				discovery: live?.discoveryStatus() ?? null,
			};
		},
		'rename-device': async ({ deviceId, name }) => {
			requireDevice(
				(await getACappellaTransport()?.pairing.rename(deviceId, name)) ?? false,
				deviceId
			);
			return { deviceId, name: name.trim() };
		},
		'revoke-device': async ({ deviceId }) => {
			requireDevice((await getACappellaTransport()?.revokeDevice(deviceId)) ?? false, deviceId);
			return { deviceId };
		},
		'forget-device': async ({ deviceId }) => {
			requireDevice((await getACappellaTransport()?.pairing.forget(deviceId)) ?? false, deviceId);
			return { deviceId };
		},
		'revoke-all-devices': async () => ({
			revoked: (await getACappellaTransport()?.revokeAllDevices()) ?? 0,
		}),
		'disconnect-devices': async () => {
			getACappellaTransport()?.disconnectAll();
			return {};
		},
		discovery: async ({ enabled }) => ({ discovery: await setVoiceDiscovery(enabled) }),
		'test-connection': async () => testVoiceConnection(),
		latency: async () => {
			const turn = lastTurn();
			return {
				turn: turn as unknown as Record<string, unknown> | null,
				text: turn ? formatTurnBreakdown(turn) : null,
			};
		},
		'self-test': async () => {
			const report = await runVoiceSelfTest();
			return {
				report: report as unknown as Record<string, unknown>,
				text: formatVoiceSelfTestReport(report),
			};
		},
		'wake-test': async ({ phrase, sensitivity, seconds }) => {
			const hits: VoiceWakeHit[] = [];
			const tap = (event: WakeTestEvent): void => {
				hits.push({ phrase: event.phrase, score: event.score, at: event.at });
			};
			const started = await actions.beginWakeTest({ phrase, sensitivity });
			if (!started.started) throw new VoiceControlRefusal(started.reason);
			sharedState.wakeTestTaps.add(tap);
			try {
				await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
			} finally {
				sharedState.wakeTestTaps.delete(tap);
				// The run opened a microphone; it closes whether or not anything fired.
				await stopWakeTest();
			}
			return {
				phrase: phrase ?? readVoiceProviderSettings(settingsStore).wakePhrase ?? null,
				seconds,
				hits,
			};
		},
	};
	releaseVoiceControl?.();
	releaseVoiceControl = registerVoiceControlService(controlHandlers, () =>
		isACappellaEnabled(settingsStore)
	);
}
