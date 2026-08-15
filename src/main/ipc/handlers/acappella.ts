/**
 * A Cappella IPC Handlers
 *
 * The Electron transport in front of the headless voice session service. Thin
 * on purpose: every rule that matters (state machine, provider substitution,
 * dispatch) lives in `src/main/acappella/`, and this file only translates
 * channels into calls and protocol events into a push.
 *
 * Three properties this module is responsible for:
 *   - **Nothing runs until a session is started.** Enabling the Encore Feature
 *     opens no device, downloads nothing, and constructs no provider: the
 *     service is built lazily on the first `acappella:start-session`.
 *   - **Provider resolution goes through the registry, always.** No concrete
 *     provider is imported here, so "never silently substitute a cloud provider
 *     for a missing local one" stays a property of the registry rather than of
 *     an import in the transport layer.
 *   - **Every client sees the same stream.** Protocol events are BROADCAST on
 *     `acappella:event` (all windows plus the web-desktop bridge), matching the
 *     multi-window invariant in `src/main/utils/safe-send.ts`. There is no
 *     per-window subscription list: the session is a single-floor thing, and a
 *     client that does not want the events simply does not listen.
 *
 * Gated at the handler on `encoreFeatures.aCappella`, following the Pianola
 * precedent: when the flag is off every channel throws 'ACappellaDisabled' so
 * the renderer can tell "feature off" from "no session". The one exception is
 * `acappella:stop-session`, which stays callable so toggling the feature off
 * mid-session can still release the floor.
 */

import { app, ipcMain, shell, type BrowserWindow } from 'electron';

import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import type { SafeSendFn } from '../../utils/safe-send';
import type { InterruptSource, RosterAgent, VoiceScope } from '../../../shared/acappella/protocol';
import { micSettingsUrl } from '../../../shared/acappella/mic-settings';
import {
	ACAPPELLA_AUDIO_COMMAND_CHANNEL,
	ACAPPELLA_AUDIO_FRAME_CHANNEL,
	ACAPPELLA_AUDIO_STATUS_CHANNEL,
	type AudioFrame,
	type AudioHostCommand,
	type AudioHostStatus,
} from '../../../shared/acappella/audio-host';
import {
	closeAcappellaAudioHostWindow,
	createRendererVoiceBridge,
	createVoiceAudioBridge,
	createVoiceRouteExecutor,
	disposeVoiceSessionService,
	ensureAcappellaAudioHostWindow,
	getAcappellaAudioHostWindow,
	getVoiceSessionService,
	initVoiceSessionService,
	isAcappellaAudioHostContents,
	readAgentRoster,
	type AudioHostWindowDeps,
	type VoiceAudioBridge,
	type VoiceSessionService,
	type VoiceSessionSnapshot,
} from '../../acappella';
import { readVoiceReadiness } from './acappella-models';
import {
	readVoiceProviderSettings,
	resolveVoiceProviders,
	type VoiceProviderSettings,
	type VoiceProviderSubstitution,
} from '../../acappella/providers/provider-registry';

const LOG_CONTEXT = '[ACappella]';

/** The push channel every protocol event goes out on. */
export const ACAPPELLA_EVENT_CHANNEL = 'acappella:event';

/**
 * What a start returns: the session snapshot plus anything the user needs to be
 * told about the trio they are actually running. Substitutions travel with the
 * start rather than only being logged - a silent downgrade to the mock tier is
 * exactly the failure the registry exists to prevent.
 */
export interface VoiceStartSessionResult {
	snapshot: VoiceSessionSnapshot;
	substitutions: VoiceProviderSubstitution[];
}

export interface ACappellaHandlerDependencies {
	settingsStore: {
		get: (key: string, defaultValue?: unknown) => unknown;
	};
	/** The window the dispatch executor talks to. Main has no tab authority. */
	getMainWindow: () => BrowserWindow | null;
	/** Broadcasts to every window and to the web-desktop bridge. */
	safeSend: SafeSendFn;
	/**
	 * What the hidden audio host window needs to load the renderer bundle. Absent
	 * only in tests, which never want a real `BrowserWindow`; when it is absent
	 * the session runs without audio I/O rather than failing to start.
	 */
	audioHostDeps?: AudioHostWindowDeps;
}

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * The provider selection the live service was built from. A change here means
 * the next start rebuilds the service, which is how a Voice Setup change takes
 * effect without an app restart.
 */
let activeProviderKey: string | null = null;
let activeSubstitutions: VoiceProviderSubstitution[] = [];

/**
 * The audio bridge for the live service. Module state for the same reason the
 * service is: the frame and status listeners are registered once, for the life of
 * the app, while the thing behind them is rebuilt whenever the provider trio
 * changes.
 */
let audioBridge: VoiceAudioBridge | null = null;

/** Push one command to the hidden audio host. A window that is not open is a no-op. */
function sendAudioHostCommand(command: AudioHostCommand): void {
	const win = getAcappellaAudioHostWindow();
	if (!win || win.webContents.isDestroyed()) return;
	win.webContents.send(ACAPPELLA_AUDIO_COMMAND_CHANNEL, command);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True only when `encoreFeatures.aCappella` is explicitly on. Read on every call
 * so a toggle takes effect without a restart.
 */
function isACappellaEnabled(settingsStore: ACappellaHandlerDependencies['settingsStore']): boolean {
	const flags = (settingsStore.get('encoreFeatures', {}) ?? {}) as Record<string, unknown>;
	return flags.aCappella === true;
}

function requireEnabled(settingsStore: ACappellaHandlerDependencies['settingsStore']): void {
	if (!isACappellaEnabled(settingsStore)) throw new Error('ACappellaDisabled');
}

/** An unrecognised scope is conductor scope; a malformed AGENT scope is not. */
function parseScope(raw: unknown): VoiceScope {
	if (!isRecord(raw)) return { kind: 'conductor' };
	if (raw.kind !== 'agent') return { kind: 'conductor' };
	// Falling back to the conductor here would send a spoken instruction to
	// whichever agent happens to be active, which is the one outcome worse than
	// an error.
	if (typeof raw.sessionId !== 'string' || !raw.sessionId) {
		throw new Error('InvalidVoiceScope');
	}
	return { kind: 'agent', sessionId: raw.sessionId };
}

/** An IPC caller is a client by definition, so a bare request is a button press. */
function parseInterruptSource(raw: unknown): InterruptSource {
	return raw === 'voice' ? 'voice' : 'client-button';
}

function providerKey(settings: VoiceProviderSettings): string {
	return `${settings.stt ?? ''}|${settings.tts ?? ''}|${settings.brain ?? ''}`;
}

/**
 * The live service, built on first use. Rebuilt when the provider selection has
 * changed since it was constructed; `initVoiceSessionService` disposes the old
 * instance, which drops its subscribers, so the fan-out is re-registered here
 * rather than accumulating a second copy.
 */
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
function ensureAudioBridge(service: VoiceSessionService, deps: ACappellaHandlerDependencies): void {
	if (audioBridge || !deps.audioHostDeps) return;
	audioBridge = createVoiceAudioBridge({ session: service, sendCommand: sendAudioHostCommand });
}

async function ensureService(deps: ACappellaHandlerDependencies): Promise<{
	service: VoiceSessionService;
	substitutions: VoiceProviderSubstitution[];
}> {
	const settings = readVoiceProviderSettings(deps.settingsStore);
	const key = providerKey(settings);

	const existing = getVoiceSessionService();
	if (existing && key === activeProviderKey) {
		// The service survives an Encore toggle but the bridge does not, so a reused
		// service can arrive here with no audio wiring at all.
		ensureAudioBridge(existing, deps);
		return { service: existing, substitutions: activeSubstitutions };
	}

	const { providers, substitutions } = resolveVoiceProviders({ settings });
	audioBridge?.dispose();
	audioBridge = null;

	const service = await initVoiceSessionService({
		providers,
		getRoster: readAgentRoster,
		// The capability gate. The service refuses to start when a required slot is
		// unsatisfied and names the missing piece; it never asks for, and cannot be
		// handed, a replacement provider.
		checkReadiness: () => readVoiceReadiness(deps.settingsStore),
		executeRoute: createVoiceRouteExecutor({
			bridge: createRendererVoiceBridge(deps.getMainWindow),
		}),
		// Read through the module variable rather than captured: the bridge cannot
		// exist yet (it takes the service), and the two are replaced together.
		onSpeechChunk: (chunk) => audioBridge?.handleSpeechChunk(chunk),
	});
	service.subscribe((event) => deps.safeSend(ACAPPELLA_EVENT_CHANNEL, event));

	ensureAudioBridge(service, deps);

	activeProviderKey = key;
	activeSubstitutions = substitutions;
	return { service, substitutions };
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

	const wrappedStart = withIpcErrorLogging(
		handlerOpts('startSession'),
		async (rawScope: unknown): Promise<VoiceStartSessionResult> => {
			const scope = parseScope(rawScope);
			// First start is what pays for the audio host: enabling the Encore
			// Feature opens no device and builds no second renderer.
			if (deps.audioHostDeps) ensureAcappellaAudioHostWindow(deps.audioHostDeps);
			const { service, substitutions } = await ensureService(deps);
			const snapshot = await service.startSession({ scope, source: 'client-button' });
			return { snapshot, substitutions };
		}
	);

	const wrappedStop = withIpcErrorLogging(handlerOpts('stopSession'), async (): Promise<void> => {
		await getVoiceSessionService()?.stopSession('user');
	});

	const wrappedSubmitUtterance = withIpcErrorLogging(
		handlerOpts('submitUtterance'),
		// Returns false when the session cannot take an utterance right now, so a
		// stray Send in the dev harness is a no-op rather than a thrown error.
		async (text: unknown): Promise<boolean> => {
			if (typeof text !== 'string') throw new Error('InvalidUtterance');
			return getVoiceSessionService()?.submitUtterance(text) ?? false;
		}
	);

	const wrappedInterrupt = withIpcErrorLogging(
		handlerOpts('interrupt'),
		// Barge-in: cancels speech and KEEPS the floor. Distinct from the stop word
		// on purpose - talking over the assistant must not hang up on it.
		async (source: unknown): Promise<boolean> =>
			getVoiceSessionService()?.interrupt(parseInterruptSource(source)) ?? false
	);

	const wrappedStopWord = withIpcErrorLogging(
		handlerOpts('stopWord'),
		async (payload: unknown): Promise<void> => {
			const body = isRecord(payload) ? payload : {};
			const phrase = typeof body.phrase === 'string' ? body.phrase : undefined;
			await getVoiceSessionService()?.hardStop(parseInterruptSource(body.source), phrase);
		}
	);

	const wrappedSubmitAgentReply = withIpcErrorLogging(
		handlerOpts('submitAgentReply'),
		// The reply seam. Phase 05 wires real agent output straight into the
		// service in-process; until then this is how anything outside main gets a
		// session past `dispatching`, which is what makes the dev harness able to
		// demonstrate speech, barge-in, and the difference between the two.
		async (payload: unknown): Promise<boolean> => {
			if (!isRecord(payload)) throw new Error('InvalidAgentReply');
			const { agentSessionId, tabId, text } = payload;
			if (
				typeof agentSessionId !== 'string' ||
				!agentSessionId ||
				typeof tabId !== 'string' ||
				!tabId ||
				typeof text !== 'string'
			) {
				throw new Error('InvalidAgentReply');
			}
			return (
				(await getVoiceSessionService()?.submitAgentReply({ agentSessionId, tabId, text })) ?? false
			);
		}
	);

	const wrappedOpenMicSettings = withIpcErrorLogging(
		handlerOpts('openMicSettings'),
		// Its own channel rather than `shell:openExternal`, which allows only
		// http/https/mailto. Widening that allowlist so one button can open one
		// hard-coded URL would trade a real security property for nothing; here the
		// URL is a constant the caller cannot influence.
		async (): Promise<boolean> => {
			const url = micSettingsUrl(process.platform);
			if (!url) return false;
			await shell.openExternal(url);
			return true;
		}
	);

	const wrappedGetRoster = withIpcErrorLogging(
		handlerOpts('getRoster'),
		async (): Promise<RosterAgent[]> => readAgentRoster()
	);

	const wrappedGetState = withIpcErrorLogging(
		handlerOpts('getState'),
		// Null means the service has never been built, so no provider is resolved
		// yet. Synthesising an idle snapshot here would have to name provider ids
		// that nothing has resolved, and reporting a requested-but-unavailable
		// provider as running is the substitution lie in a different costume.
		async (): Promise<VoiceSessionSnapshot | null> =>
			getVoiceSessionService()?.getSnapshot() ?? null
	);

	ipcMain.handle(
		'acappella:start-session',
		async (event, scope: unknown): Promise<VoiceStartSessionResult> => {
			requireEnabled(settingsStore);
			return wrappedStart(event, scope);
		}
	);

	// Deliberately ungated: turning the Encore Feature off while a session is
	// live must still be able to release the floor.
	ipcMain.handle('acappella:stop-session', wrappedStop);

	ipcMain.handle('acappella:submit-utterance', async (event, text: unknown): Promise<boolean> => {
		requireEnabled(settingsStore);
		return wrappedSubmitUtterance(event, text);
	});

	ipcMain.handle('acappella:interrupt', async (event, source: unknown): Promise<boolean> => {
		requireEnabled(settingsStore);
		return wrappedInterrupt(event, source);
	});

	ipcMain.handle('acappella:stop-word', async (event, payload: unknown): Promise<void> => {
		requireEnabled(settingsStore);
		return wrappedStopWord(event, payload);
	});

	ipcMain.handle(
		'acappella:submit-agent-reply',
		async (event, payload: unknown): Promise<boolean> => {
			requireEnabled(settingsStore);
			return wrappedSubmitAgentReply(event, payload);
		}
	);

	// Ungated, like `stop-session`: a user whose microphone was denied has to be
	// able to reach the OS setting, and a session that could not open a device is
	// exactly the situation in which the feature may already have been turned off.
	ipcMain.handle('acappella:open-mic-settings', wrappedOpenMicSettings);

	ipcMain.handle('acappella:get-roster', async (event): Promise<RosterAgent[]> => {
		requireEnabled(settingsStore);
		return wrappedGetRoster(event);
	});

	ipcMain.handle('acappella:get-state', async (event): Promise<VoiceSessionSnapshot | null> => {
		requireEnabled(settingsStore);
		return wrappedGetState(event);
	});

	// The audio host's own control link. `on`, not `handle`: frames arrive fifty
	// times a second and nothing about them needs a reply, so a promise round trip
	// per 20 ms of audio would be pure overhead.
	//
	// Both listeners check the sender. The preload exposes `voiceAudioHost` to every
	// window because it is one shared preload, so "only the audio host may speak
	// here" has to be enforced at the receiving end - a browser tab that found the
	// channel must not be able to inject PCM into a live voice session.
	ipcMain.on(ACAPPELLA_AUDIO_FRAME_CHANNEL, (event, frame: unknown) => {
		if (!isAcappellaAudioHostContents(event.sender)) return;
		if (!isAudioFrame(frame)) return;
		audioBridge?.handleFrame(frame);
	});

	ipcMain.on(ACAPPELLA_AUDIO_STATUS_CHANNEL, (event, status: unknown) => {
		if (!isAcappellaAudioHostContents(event.sender)) return;
		if (!status || typeof (status as AudioHostStatus).kind !== 'string') return;
		audioBridge?.handleStatus(status as AudioHostStatus);
	});

	// Release the floor on the way out, and with it the microphone: the audio host
	// window holds a real capture device, and a session left running would keep it
	// open past the last app window. Fire-and-forget: `will-quit` is synchronous,
	// and this is the last thing the session will ever do.
	app.on('will-quit', () => {
		void disposeVoiceSessionService();
		closeAcappellaAudioHostWindow();
		resetACappellaHandlerState();
	});
}

/**
 * Stop capture and drop the audio wiring, leaving the session service alone.
 *
 * Called when the Encore Feature is switched off: the audio host window goes
 * away with it, so a bridge still holding a running pipeline would be counting
 * frames from a device nobody owns.
 */
export function disposeACappellaAudioBridge(): void {
	audioBridge?.dispose();
	audioBridge = null;
}

/**
 * Drop the cached provider selection. Test-only seam: the service singleton is
 * module state in `src/main/acappella/index.ts`, and this file's memo of what it
 * was built from has to be cleared alongside it.
 */
export function resetACappellaHandlerState(): void {
	activeProviderKey = null;
	activeSubstitutions = [];
	audioBridge?.dispose();
	audioBridge = null;
}
