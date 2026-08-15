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

import { app, ipcMain, type BrowserWindow } from 'electron';
import { hostname } from 'os';

import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import type { SafeSendFn } from '../../utils/safe-send';
import type {
	InterruptSource,
	RosterAgent,
	VoiceEvent,
	VoiceScope,
} from '../../../shared/acappella/protocol';
import { getSessionsStore } from '../../stores/getters';
import { createConductorRouter } from '../../acappella/router/conductor-router';
import { invalidateRoutingContext } from '../../acappella/router/routing-context';
import {
	flushRoutingLog,
	lastRoutingTurn,
	loadRoutingLog,
	noteRoutingOutcome,
	readRoutingLog,
	routingQuality,
	type RoutingLogEntry,
	type RoutingQuality,
} from '../../acappella/router/routing-log';
import {
	getMicPermission,
	noteCaptureFailure,
	noteCaptureStarted,
	openMicSystemSettings,
	requestMicPermission,
	type MicPermissionInfo,
} from '../../acappella/permissions/mic-permission';
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
import {
	createAgentOutputTap,
	type AgentOutputSource,
	type AgentOutputTap,
} from '../../acappella/speech';
import { readVoiceReadiness } from './acappella-models';
import { DEFAULT_TTS_VOLUME } from '../../../shared/acappella/voice-controls';
import {
	buildProviderState,
	pipelineKey,
	readVoiceProviderSettings,
	resolveVoicePipeline,
	swapVoicePipeline,
	type VoiceProviderResolution,
	type VoiceProviderSubstitution,
} from '../../acappella/providers/provider-registry';
import {
	clearCredential,
	listCredentialStates,
	setCredential,
	validateCredential,
	type CredentialState,
	type CredentialValidation,
} from '../../acappella/providers/credentials';
import {
	VOICE_CREDENTIAL_SERVICES,
	type VoiceCredentialService,
} from '../../../shared/acappella/provider-catalog';
import { lastTurn, type TurnBreakdown } from '../../acappella/telemetry/turn-metrics';
import { installVoiceHotkeys, type VoiceHotkeyInstallation } from '../../acappella/hotkeys';
import { describePressHoldCapability } from '../../acappella/hotkeys/press-hold';
import type { GlobalHotkeyStatus } from '../../../shared/global-hotkeys';
import {
	createWakeDetector,
	globalWakePhrase,
	type WakeDetection,
	type WakeDetector,
	type WakePhrase,
} from '../../acappella/wake/wake-detector';
import type { FloorControlSession } from '../../acappella/audio/floor-control';
import {
	disposeACappellaTransport,
	getACappellaTransport,
	initACappellaTransport,
} from '../../acappella';
import type { ACappellaTransport } from '../../acappella/transport';
import {
	ACAPPELLA_WEBRTC_COMMAND_CHANNEL,
	ACAPPELLA_WEBRTC_EVENT_CHANNEL,
	type WebRtcHostEvent,
} from '../../../shared/acappella/webrtc-host';
import {
	ACAPPELLA_DEVICES_CHANNEL,
	ACAPPELLA_PAIRING_REQUEST_CHANNEL,
	registerACappellaDeviceHandlers,
} from './acappella-devices';

const LOG_CONTEXT = '[ACappella]';

/** The push channel every protocol event goes out on. */
export const ACAPPELLA_EVENT_CHANNEL = 'acappella:event';

/**
 * The wake-word tuning channel.
 *
 * Deliberately NOT a protocol event: the Test button in Settings runs the local
 * detector with no session behind it, and inventing a voice session id so a
 * settings panel can light up a dot would put a fake session in every client's
 * event stream.
 */
export const ACAPPELLA_WAKE_TEST_CHANNEL = 'acappella:wake-test';

/** What the wake-word tuning affordance pushes while it is running. */
export interface WakeTestEvent {
	phraseId: string;
	phrase: string;
	score: number;
	at: number;
}

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
		/**
		 * Live setting changes. Optional because tests pass a plain object; without
		 * it the voice hotkeys bind once at startup and do not follow a rebind.
		 */
		onDidChange?: (key: string, callback: (value: unknown) => void) => void;
	};
	/** The window the dispatch executor talks to. Main has no tab authority. */
	getMainWindow: () => BrowserWindow | null;
	/**
	 * The window that OWNS an agent, for multi-window dispatch.
	 *
	 * Agent ownership is per window while `activeSessionId` is global, so
	 * dispatching to whichever window is "main" would activate an agent that
	 * window does not own - the documented way to make a window render "No
	 * agents". Absent in tests and in any single-window host, where the main
	 * window is the right answer by construction.
	 */
	getWindowForSession?: (agentSessionId: string) => BrowserWindow | null;
	/** Broadcasts to every window and to the web-desktop bridge. */
	safeSend: SafeSendFn;
	/**
	 * What the hidden audio host window needs to load the renderer bundle. Absent
	 * only in tests, which never want a real `BrowserWindow`; when it is absent
	 * the session runs without audio I/O rather than failing to start.
	 */
	audioHostDeps?: AudioHostWindowDeps;
	/**
	 * The agent the user is looking at, for the `voiceCurrentAgent` hotkey. Absent
	 * in tests and in any host with no session store, where the agent hotkey
	 * refuses with a reason rather than binding a session to a guessed agent.
	 */
	getFocusedAgentSessionId?: () => string | null;
	/**
	 * The process manager, as an event source for the agent-output tap.
	 *
	 * This is what makes a spoken reply arrive while the agent is still writing:
	 * the tap rides the SAME `data` / `query-complete` / `agent-error` events the
	 * desktop transcript rides. Absent in tests and before the manager is
	 * constructed, in which case the session falls back to waiting for a whole
	 * reply through `submitAgentReply`.
	 */
	getProcessManager?: () => AgentOutputSource | null;
	/** The agent type behind a session id, for the tap's stream-json parsing. */
	getAgentType?: (agentSessionId: string) => string | undefined;
	/**
	 * The running web server, for the paired-device transport.
	 *
	 * Its security token and port are what a phone needs to reach the signaling
	 * socket, so a QR code cannot be produced without it. Absent in tests and
	 * before the user has ever switched the web interface on, in which case
	 * pairing reports that there is nothing to pair to rather than inventing a
	 * port.
	 */
	getWebServer?: () => { getSecurityToken: () => string; getPort: () => number } | null;
}

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * The provider selection the live service was built from. A change here means
 * the next start rebuilds the service, which is how a Voice Providers change
 * takes effect without an app restart.
 */
let activeProviderKey: string | null = null;
let activeSubstitutions: VoiceProviderSubstitution[] = [];

/**
 * The live pipeline.
 *
 * Held here rather than inside the session service because it outlives one
 * session and because it owns real resources - a Whisper model, an ONNX session,
 * a llama context, a realtime socket. Dropping the reference without calling
 * `dispose()` would leak every one of them.
 */
let activePipeline: VoiceProviderResolution | null = null;

/**
 * The audio bridge for the live service. Module state for the same reason the
 * service is: the frame and status listeners are registered once, for the life of
 * the app, while the thing behind them is rebuilt whenever the provider trio
 * changes.
 */
let audioBridge: VoiceAudioBridge | null = null;

/**
 * The two global voice hotkeys.
 *
 * Installed once, for the life of the app, and NOT rebuilt with the pipeline: a
 * system-wide combo that is released and re-registered every time the user
 * changes a voice would be a combo another app can steal in the gap.
 */
let voiceHotkeys: VoiceHotkeyInstallation | null = null;

/**
 * The wake-word tuning run behind the Test button in Settings.
 *
 * Its own detector rather than the session's, because the point is to run the
 * wake word with NO session: a user tuning sensitivity is asking "would this
 * have fired", not "please start listening to me".
 */
let wakeTestDetector: WakeDetector | null = null;

/**
 * The tap on dispatched agent output.
 *
 * Module state alongside the service and rebuilt with it, because it holds
 * listeners on the process manager: a tap dropped without `dispose()` would keep
 * filtering output for a session that no longer exists, and a second one built
 * over it would speak every chunk twice.
 */
let agentOutputTap: AgentOutputTap | null = null;

/**
 * The paired-device transport. Module state alongside the hotkeys and for the
 * same reason: it holds live signaling sessions and a Bonjour advert, both of
 * which outlive any one voice session.
 */
let transport: ACappellaTransport | null = null;

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

/** An IPC caller is a client by definition, so a bare request is a button press. */
function parseInterruptSource(raw: unknown): InterruptSource {
	return raw === 'voice' ? 'voice' : 'client-button';
}

/**
 * Validate a credential message.
 *
 * The service name is checked against the known set rather than passed through:
 * it becomes a keychain account name, and an arbitrary string from the renderer
 * would let a caller write entries into the user's credential store under any
 * name it liked.
 */
function parseCredentialPayload(raw: unknown): { service: VoiceCredentialService; key: string } {
	if (!isRecord(raw)) throw new Error('InvalidCredential');
	const service = raw.service;
	if (typeof service !== 'string' || !VOICE_CREDENTIAL_SERVICES.includes(service as never)) {
		throw new Error('InvalidCredential');
	}
	return {
		service: service as VoiceCredentialService,
		key: typeof raw.key === 'string' ? raw.key : '',
	};
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
function ensureAudioBridge(service: VoiceSessionService, deps: ACappellaHandlerDependencies): void {
	if (audioBridge || !deps.audioHostDeps) return;
	audioBridge = createVoiceAudioBridge({ session: service, sendCommand: sendAudioHostCommand });
	// The user's volume applies from the FIRST sentence, not from the first time
	// they touch the slider. A fresh bridge that defaulted to full output would
	// undo a quiet setting (or a mute) every time the Encore Feature was toggled.
	audioBridge.setPlaybackVolume(
		readVoiceProviderSettings(deps.settingsStore).volume ?? DEFAULT_TTS_VOLUME
	);
}

/**
 * The live service, built on first use and rebuilt whenever the provider
 * selection changes.
 *
 * `initVoiceSessionService` disposes the old instance, which drops its
 * subscribers, so the fan-out is re-registered here rather than accumulating a
 * second copy.
 */
async function ensureService(deps: ACappellaHandlerDependencies): Promise<{
	service: VoiceSessionService;
	substitutions: VoiceProviderSubstitution[];
}> {
	const settings = readVoiceProviderSettings(deps.settingsStore);
	const key = pipelineKey(settings);

	const existing = getVoiceSessionService();
	if (existing && key === activeProviderKey) {
		// The service survives an Encore toggle but the bridge does not, so a reused
		// service can arrive here with no audio wiring at all.
		ensureAudioBridge(existing, deps);
		return { service: existing, substitutions: activeSubstitutions };
	}

	// The old pipeline is torn down BEFORE the new one is built, so two loaded
	// models are never resident at once.
	await activePipeline?.pipeline.dispose();
	const resolution = resolveVoicePipeline({ settings });
	audioBridge?.dispose();
	audioBridge = null;

	const service = await buildService(resolution, deps);

	activePipeline = resolution;
	activeProviderKey = key;
	activeSubstitutions = resolution.substitutions;
	return { service, substitutions: resolution.substitutions };
}

/**
 * Build the tap for a fresh service, or null when there is no process manager to
 * listen to.
 *
 * The sink reads the service through the module getter rather than closing over
 * the instance: the tap outlives no service, but a chunk can be in flight while
 * one is being replaced, and delivering it into the old instance would speak
 * into a session nobody is subscribed to.
 */
function buildAgentOutputTap(deps: ACappellaHandlerDependencies): AgentOutputTap | null {
	agentOutputTap?.dispose();
	agentOutputTap = null;

	const source = deps.getProcessManager?.();
	if (!source) return null;

	agentOutputTap = createAgentOutputTap({
		source,
		getAgentType: deps.getAgentType,
		onChunk: (chunk) => getVoiceSessionService()?.pushAgentOutput(chunk),
	});
	return agentOutputTap;
}

/** Construct the session service around a resolved pipeline and wire its fan-out. */
async function buildService(
	resolution: VoiceProviderResolution,
	deps: ACappellaHandlerDependencies
): Promise<VoiceSessionService> {
	const tap = buildAgentOutputTap(deps);
	const service = await initVoiceSessionService({
		providers: {
			...resolution.providers,
			// The Conductor router wraps whichever Brain the registry resolved. It
			// keeps that provider's id and tier, so `provider-state` still names the
			// engine that is really running; what it adds is the bounded context, the
			// recall shortlist, roster validation, one constrained retry, and the
			// refusal to guess below the confidence threshold.
			brain: createConductorRouter({ brain: resolution.providers.brain }),
		},
		pipelineShape: resolution.shape,
		getRoster: readAgentRoster,
		// The capability gate. The service refuses to start when a required slot is
		// unsatisfied and names the missing piece; it never asks for, and cannot be
		// handed, a replacement provider.
		checkReadiness: () => readVoiceReadiness(deps.settingsStore),
		// What is actually running, including any slot that could not be built. The
		// service cannot derive this: it is handed a trio and never learns what was
		// requested.
		getProviderState: () => buildProviderState(resolution),
		executeRoute: createVoiceRouteExecutor({
			bridge: createRendererVoiceBridge(deps.getMainWindow, deps.getWindowForSession),
		}),
		// Read through the module variable rather than captured: the bridge cannot
		// exist yet (it takes the service), and the two are replaced together.
		onSpeechChunk: (chunk) => audioBridge?.handleSpeechChunk(chunk),
		// The live tap. With it, a reply is spoken as the agent writes it; without
		// it (no process manager yet, and in tests) the session waits for a whole
		// reply through `submitAgentReply`.
		agentReplyStream: tap ?? undefined,
		// The pipeline ducks on a candidate frame long before this fires. These are
		// the other door: a client button, and the Phase 10 phone.
		duckPlayback: (gain, ms) => audioBridge?.duckPlayback(gain, ms),
		flushPlayback: () => audioBridge?.flushPlayback(),
		// Read per call rather than captured, so switching it in Settings takes
		// effect on the next completion instead of on the next app start. Through
		// the one settings reader, which already knows where the key lives.
		getBackgroundAnnouncementSetting: () =>
			readVoiceProviderSettings(deps.settingsStore).speakBackgroundCompletions,
		// Same reasoning, one turn finer: read per SENTENCE, so a speed slider
		// dragged mid-reply is heard on the next sentence rather than the next
		// session. This is the seam that makes "applies live" true.
		getSpeechOptions: () => {
			const current = readVoiceProviderSettings(deps.settingsStore);
			return { voiceId: current.voiceId, rate: current.rate };
		},
	});
	service.subscribe((event) => deps.safeSend(ACAPPELLA_EVENT_CHANNEL, event));
	service.subscribe(recordRoutingOutcome);
	ensureAudioBridge(service, deps);
	return service;
}

/**
 * Close the routing log's loop from the event stream.
 *
 * The router records what it DECIDED; only the session knows what became of it,
 * and the difference between those two is the entire value of the log. Doing it
 * here rather than inside the service keeps the service free of the router's
 * storage, and doing it from events rather than from call sites means a new
 * failure path cannot forget to report itself.
 */
function recordRoutingOutcome(event: VoiceEvent): void {
	const turnId = lastRoutingTurn()?.id;
	if (!turnId) return;

	if (event.type === 'dispatch') {
		noteRoutingOutcome(turnId, 'dispatched', `${event.agentName} / ${event.action}`);
		return;
	}
	if (event.type === 'route-correction') {
		// The turn being corrected is the one BEFORE this correction's own entry,
		// which is why the correction is matched on the dispatch it replaced.
		const corrected = readRoutingLog()
			.reverse()
			.find((entry) => entry.outcome === 'dispatched');
		if (corrected) {
			noteRoutingOutcome(corrected.id, 'corrected', `moved to ${event.agentName}`);
		}
		return;
	}
	if (event.type === 'session-error' && event.code === 'dispatch-failed') {
		noteRoutingOutcome(turnId, 'failed', event.message);
	}
}

/**
 * Apply a provider change to the running app.
 *
 * Called by the settings panel after it writes a selection. A swap while a turn
 * is in flight is REFUSED rather than queued: splicing two engines into one
 * exchange would transcribe with one model, route with another, and answer in a
 * third voice, and the user would have no idea why.
 */
export async function applyACappellaProviders(
	deps: ACappellaHandlerDependencies
): Promise<{ status: 'swapped' | 'unchanged' | 'refused'; reason?: string }> {
	const settings = readVoiceProviderSettings(deps.settingsStore);
	const service = getVoiceSessionService();

	const result = await swapVoicePipeline({
		settings,
		current: activePipeline
			? { pipeline: activePipeline.pipeline, key: activeProviderKey ?? '' }
			: null,
		isBusy: isTurnInFlight(service),
	});

	if (result.status !== 'swapped' || !result.resolution) {
		return { status: result.status, reason: result.reason };
	}

	audioBridge?.dispose();
	audioBridge = null;

	const rebuilt = await buildService(result.resolution, deps);
	activePipeline = result.resolution;
	activeProviderKey = pipelineKey(settings);
	activeSubstitutions = result.resolution.substitutions;
	// Announce the new engines even though no session is open: a client showing
	// "you are on Whisper" has to stop saying so the moment that stops being true.
	rebuilt.publishProviderState();

	return { status: 'swapped' };
}

/** A provider that can enumerate its voices. Duck-typed: not every one can. */
interface VoiceListingProvider {
	listVoices?: () =>
		| Promise<Array<{ id: string; name: string }>>
		| Array<{ id: string; name: string }>;
}

/**
 * The voices the current TTS provider offers.
 *
 * Empty for a provider with one voice or none, which the picker renders as
 * "Provider default" rather than as an error: a mock has no voices and that is
 * not a failure.
 */
async function listVoiceOptions(
	deps: ACappellaHandlerDependencies
): Promise<Array<{ id: string; name: string }>> {
	const resolution =
		activePipeline ??
		resolveVoicePipeline({
			settings: readVoiceProviderSettings(deps.settingsStore),
		});
	// Not cached into `activePipeline`: this can run before any session has ever
	// been started, and building the live pipeline as a side effect of drawing a
	// settings panel would load models nobody asked for.
	const provider = resolution.providers.tts as VoiceListingProvider;
	if (typeof provider.listVoices !== 'function') return [];
	return provider.listVoices();
}

/**
 * Speak one fixed line through the configured voice.
 *
 * Refused while a session is live: the preview and the assistant would be
 * talking over each other through the same output device, and the user would
 * have no way to tell which voice they were hearing.
 *
 * @returns false when nothing could be spoken (no audio host, or a provider with
 *          no audio behind it).
 */
async function previewVoiceLine(
	deps: ACappellaHandlerDependencies,
	text: string,
	voiceId?: string
): Promise<boolean> {
	const live = getVoiceSessionService();
	if (live && live.getState() !== 'idle') return false;

	if (deps.audioHostDeps) ensureAcappellaAudioHostWindow(deps.audioHostDeps);
	await ensureService(deps);
	if (!activePipeline || !audioBridge) return false;

	const settings = readVoiceProviderSettings(deps.settingsStore);
	let spoke = false;
	for await (const chunk of activePipeline.providers.tts.speak(text, {
		utteranceId: `preview-${Date.now()}`,
		// The caller may name a voice it has NOT selected. That is the point of a
		// per-voice preview: hearing a voice before committing to it beats
		// selecting each one in turn and undoing the ones you did not want.
		voiceId: voiceId ?? settings.voiceId,
		rate: settings.rate,
	})) {
		audioBridge.handleSpeechChunk(chunk);
		spoke = spoke || Boolean(chunk.audio?.byteLength);
	}
	return spoke;
}

/**
 * Whether a turn is mid-flight.
 *
 * `idle` and `listening` are the two safe moments: nothing has been said yet, or
 * everything said has been answered. Every other state has a turn in it.
 */
function isTurnInFlight(service: VoiceSessionService | null): boolean {
	if (!service) return false;
	const state = service.getState();
	return state !== 'idle' && state !== 'listening' && state !== 'error';
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

	watchRosterChanges();

	const wrappedStart = withIpcErrorLogging(
		handlerOpts('startSession'),
		async (rawScope: unknown): Promise<VoiceStartSessionResult> => {
			const scope = parseScope(rawScope);
			// The microphone is asked for HERE and nowhere earlier. Not at app
			// launch, not when the Encore Feature is switched on: a first run that
			// prompts for the microphone for a feature nobody turned on spends trust
			// the app has not earned. This is the first moment the user has asked for
			// something that genuinely needs a device.
			//
			// The result is not branched on. A refusal belongs to the capability
			// gate, which names the microphone as its own blocking slot with its own
			// recovery; throwing a second, differently-worded error from here would
			// give the same problem two voices.
			await requestMicPermission();
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
		async (): Promise<boolean> => openMicSystemSettings()
	);

	const wrappedMicPermission = withIpcErrorLogging(
		handlerOpts('micPermission'),
		// A pure query. It never prompts, which is what lets the HUD and Settings
		// call it on render without the app asking for the microphone behind a user
		// who has not asked for voice.
		async (): Promise<MicPermissionInfo> => getMicPermission()
	);

	const wrappedGetRoster = withIpcErrorLogging(
		handlerOpts('getRoster'),
		async (): Promise<RosterAgent[]> => readAgentRoster()
	);

	const wrappedListCredentials = withIpcErrorLogging(
		handlerOpts('listCredentials'),
		// Configured-or-not, never the key. Nothing in the renderer needs to read a
		// credential back, and a channel that returned one would put it in a
		// renderer heap and in every crash dump taken afterwards.
		async (): Promise<CredentialState[]> => listCredentialStates()
	);

	const wrappedSetCredential = withIpcErrorLogging(
		handlerOpts('setCredential'),
		async (payload: unknown) => {
			const { service, key } = parseCredentialPayload(payload);
			return key ? setCredential(service, key) : clearCredential(service);
		}
	);

	const wrappedValidateCredential = withIpcErrorLogging(
		handlerOpts('validateCredential'),
		// An optional key so Test works before Save: a user should be able to find
		// out a key is wrong without storing it first.
		async (payload: unknown): Promise<CredentialValidation> => {
			const { service, key } = parseCredentialPayload(payload);
			return validateCredential(service, key || undefined);
		}
	);

	const wrappedApplyProviders = withIpcErrorLogging(handlerOpts('applyProviders'), async () =>
		applyACappellaProviders(deps)
	);

	const wrappedListVoices = withIpcErrorLogging(handlerOpts('listVoices'), async () =>
		listVoiceOptions(deps)
	);

	const wrappedPreviewVoice = withIpcErrorLogging(
		handlerOpts('previewVoice'),
		async (text: unknown, voiceId: unknown): Promise<boolean> => {
			if (typeof text !== 'string' || !text.trim()) throw new Error('InvalidPreviewText');
			if (voiceId !== undefined && typeof voiceId !== 'string') throw new Error('InvalidVoiceId');
			return previewVoiceLine(deps, text, voiceId || undefined);
		}
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
	const wrappedSetVolume = withIpcErrorLogging(
		handlerOpts('setVolume'),
		async (volume: unknown): Promise<boolean> => {
			if (typeof volume !== 'number' || !Number.isFinite(volume)) {
				throw new Error('InvalidVolume');
			}
			if (!audioBridge) return false;
			// Zero is legal here and only here: mute is a real state the HUD owns,
			// while the SLIDER floors above zero so it cannot become a silent mute.
			audioBridge.setPlaybackVolume(Math.min(1, Math.max(0, volume)));
			return true;
		}
	);

	const wrappedLastTurn = withIpcErrorLogging(
		handlerOpts('lastTurn'),
		async (): Promise<TurnBreakdown | null> => lastTurn()
	);

	// The floor's view of the session. Narrow by construction: the hotkeys can
	// open, close, and interrupt, and nothing else.
	const floorSession: FloorControlSession = {
		getState: () => getVoiceSessionService()?.getState() ?? 'idle',
		startSession: async ({ scope, source, origin }) => {
			// A remote origin does NOT skip this: the desktop still opens its audio
			// host, because that window is where the peer connection and the playback
			// live. What it skips is nothing at all, which is the point - a remote
			// session takes the same path as a local one.
			await requestMicPermission();
			if (deps.audioHostDeps) ensureAcappellaAudioHostWindow(deps.audioHostDeps);
			const { service } = await ensureService(deps);
			return service.startSession({ scope, source, origin });
		},
		stopSession: async (reason) => {
			await getVoiceSessionService()?.stopSession(reason);
		},
		interrupt: (source) => getVoiceSessionService()?.interrupt(source) ?? false,
	};

	const hotkeys = (voiceHotkeys ??= installVoiceHotkeys({
		settingsStore,
		session: floorSession,
		getMainWindow: deps.getMainWindow,
		getFocusedAgentSessionId: deps.getFocusedAgentSessionId ?? (() => null),
		// The bridge owns the recogniser handle, so the endpoint hint goes through
		// it rather than through the session service.
		endUtterance: () => audioBridge?.endUtterance(),
		// Broadcast rather than logged: a hotkey that did nothing has to say why,
		// or the user concludes the key is broken.
		onRefused: (info) => deps.safeSend(ACAPPELLA_EVENT_CHANNEL + ':hotkey-refused', info),
	}));

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

	const wrappedHotkeyStatus = withIpcErrorLogging(
		handlerOpts('hotkeyStatus'),
		async (): Promise<{ statuses: GlobalHotkeyStatus[]; capability: string; note: string }> => ({
			statuses: voiceHotkeys?.statuses() ?? [],
			capability: voiceHotkeys?.controller.capability ?? 'tap-only',
			note: describePressHoldCapability(voiceHotkeys?.controller.capability ?? 'tap-only'),
		})
	);

	const wrappedWakeTest = withIpcErrorLogging(
		handlerOpts('wakeTest'),
		async (payload: unknown): Promise<boolean> => startWakeTest(deps, payload)
	);

	const wrappedWakeTestStop = withIpcErrorLogging(
		handlerOpts('wakeTestStop'),
		async (): Promise<void> => stopWakeTest()
	);

	const wrappedCorrectRoute = withIpcErrorLogging(
		handlerOpts('correctRoute'),
		// The HUD's "wrong tab" control. Returns false when there is nothing to
		// move, so a stray click is a no-op rather than an error.
		async (agentSessionId: unknown): Promise<boolean> => {
			if (typeof agentSessionId !== 'string' || !agentSessionId) {
				throw new Error('InvalidCorrectionTarget');
			}
			return (
				(await getVoiceSessionService()?.correctLastDispatch(agentSessionId, 'client-button')) ??
				false
			);
		}
	);

	const wrappedRoutingLog = withIpcErrorLogging(
		handlerOpts('routingLog'),
		async (): Promise<{ entries: RoutingLogEntry[]; quality: RoutingQuality }> => {
			await loadRoutingLog();
			return { entries: readRoutingLog(), quality: routingQuality() };
		}
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

	// Ungated for the same reason: a client showing "microphone access denied"
	// must still be able to read the state after the feature was switched off.
	ipcMain.handle('acappella:mic-permission', wrappedMicPermission);

	ipcMain.handle('acappella:get-roster', async (event): Promise<RosterAgent[]> => {
		requireEnabled(settingsStore);
		return wrappedGetRoster(event);
	});

	ipcMain.handle('acappella:get-state', async (event): Promise<VoiceSessionSnapshot | null> => {
		requireEnabled(settingsStore);
		return wrappedGetState(event);
	});

	ipcMain.handle('acappella:correct-route', async (event, agentSessionId: unknown) => {
		requireEnabled(settingsStore);
		return wrappedCorrectRoute(event, agentSessionId);
	});

	// Ungated: the routing log is how somebody works out why yesterday's dispatch
	// went where it did, and switching the feature off is a thing people do
	// BECAUSE of a misroute.
	ipcMain.handle('acappella:routing-log', wrappedRoutingLog);

	// The credential channels are ungated, like the microphone ones: a user has to
	// be able to add or remove a key while the feature is off, and removing one is
	// exactly what somebody switching the feature off may want to do.
	ipcMain.handle('acappella:list-credentials', wrappedListCredentials);
	ipcMain.handle('acappella:set-credential', wrappedSetCredential);
	ipcMain.handle('acappella:validate-credential', wrappedValidateCredential);

	ipcMain.handle('acappella:apply-providers', async (event) => {
		requireEnabled(settingsStore);
		return wrappedApplyProviders(event);
	});

	ipcMain.handle('acappella:list-voices', async (event) => {
		requireEnabled(settingsStore);
		return wrappedListVoices(event);
	});

	ipcMain.handle(
		'acappella:preview-voice',
		async (event, text: unknown, voiceId: unknown): Promise<boolean> => {
			requireEnabled(settingsStore);
			return wrappedPreviewVoice(event, text, voiceId);
		}
	);

	ipcMain.handle('acappella:set-volume', async (event, volume: unknown): Promise<boolean> => {
		requireEnabled(settingsStore);
		return wrappedSetVolume(event, volume);
	});

	ipcMain.handle('acappella:last-turn', async (event): Promise<TurnBreakdown | null> => {
		requireEnabled(settingsStore);
		return wrappedLastTurn(event);
	});

	// Ungated: the Voice Controls rows show a hotkey's registration state, and the
	// most interesting time to read it is right after the feature was switched
	// off and both combos were released.
	ipcMain.handle('acappella:hotkey-status', wrappedHotkeyStatus);

	ipcMain.handle('acappella:wake-test', async (event, payload: unknown): Promise<boolean> => {
		requireEnabled(settingsStore);
		return wrappedWakeTest(event, payload);
	});

	// Ungated, like `stop-session`: a tuning run has an open microphone, and
	// switching the feature off must still be able to close it.
	ipcMain.handle('acappella:wake-test-stop', wrappedWakeTestStop);

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
		// The tuning run taps the same frames rather than opening a second capture:
		// there is one microphone, and two consumers of it is one device conflict.
		if (wakeTestDetector) wakeTestDetector.pushFrame(new Int16Array(frame.pcm));
	});

	ipcMain.on(ACAPPELLA_AUDIO_STATUS_CHANNEL, (event, status: unknown) => {
		if (!isAcappellaAudioHostContents(event.sender)) return;
		if (!status || typeof (status as AudioHostStatus).kind !== 'string') return;
		notePermissionFromStatus(status as AudioHostStatus);
		audioBridge?.handleStatus(status as AudioHostStatus);
	});

	// The peer-connection control plane, from the same window and with the same
	// sender check: an answer or a data-channel message forged by any other
	// renderer would be a paired device's traffic with no pairing behind it.
	ipcMain.on(ACAPPELLA_WEBRTC_EVENT_CHANNEL, (event, hostEvent: unknown) => {
		if (!isAcappellaAudioHostContents(event.sender)) return;
		if (!hostEvent || typeof (hostEvent as WebRtcHostEvent).kind !== 'string') return;
		getACappellaTransport()?.handleHostEvent(hostEvent as WebRtcHostEvent);
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
 * Drop the cached routing context whenever an agent or a tab changes.
 *
 * The cache has a short TTL as a backstop, but a TTL alone is not good enough
 * here: within those seconds the roster can lose the very tab a decision is
 * about to name, and a routing turn is exactly the moment a user has just
 * finished rearranging their workspace.
 *
 * Best-effort by design. A store with no change feed (tests, an older
 * electron-store) simply falls back to the TTL rather than failing registration.
 */
function watchRosterChanges(): void {
	try {
		const store = getSessionsStore() as unknown as {
			onDidChange?: (key: string, callback: () => void) => void;
		};
		store.onDidChange?.('sessions', invalidateRoutingContext);
	} catch {
		/* no store to watch: the context cache falls back to its TTL */
	}
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
 * Run the wake word with no session behind it, so a user can tune sensitivity by
 * saying the phrase and watching it light up rather than by guessing.
 *
 * Refused while a session is live: the detector would be scoring the same frames
 * the session is already using, and a hit would light the Test dot for a phrase
 * that also just woke the assistant.
 *
 * @returns false when there is no audio host to capture through.
 */
async function startWakeTest(
	deps: ACappellaHandlerDependencies,
	payload: unknown
): Promise<boolean> {
	await stopWakeTest();
	if (getVoiceSessionService()?.getState() !== undefined) {
		const state = getVoiceSessionService()?.getState();
		if (state && state !== 'idle') return false;
	}
	if (!deps.audioHostDeps) return false;

	const body = isRecord(payload) ? payload : {};
	const phrase =
		typeof body.phrase === 'string' && body.phrase.trim() ? body.phrase.trim() : undefined;
	const sensitivity = typeof body.sensitivity === 'number' ? body.sensitivity : undefined;
	const phrases: WakePhrase[] = [globalWakePhrase(phrase, sensitivity)];

	await requestMicPermission();
	ensureAcappellaAudioHostWindow(deps.audioHostDeps);

	const detector = createWakeDetector({
		getPhrases: () => phrases,
		onWake: (detection: WakeDetection) => {
			const event: WakeTestEvent = {
				phraseId: detection.phraseId,
				phrase: detection.phrase,
				score: detection.score,
				at: detection.at,
			};
			deps.safeSend(ACAPPELLA_WAKE_TEST_CHANNEL, event);
		},
	});
	await detector.start();
	wakeTestDetector = detector;
	sendAudioHostCommand({ kind: 'start-capture' });
	return true;
}

/** End a tuning run and close the microphone it opened. Safe when none is running. */
async function stopWakeTest(): Promise<void> {
	const detector = wakeTestDetector;
	if (!detector) return;
	wakeTestDetector = null;
	await detector.stop();
	// Only when no session owns the device: a tuning run that ended while a
	// session was starting must not close that session's microphone.
	const state = getVoiceSessionService()?.getState() ?? 'idle';
	if (state === 'idle') sendAudioHostCommand({ kind: 'stop-capture' });
}

/**
 * Drop the cached provider selection. Test-only seam: the service singleton is
 * module state in `src/main/acappella/index.ts`, and this file's memo of what it
 * was built from has to be cleared alongside it.
 */
export function resetACappellaHandlerState(): void {
	activeProviderKey = null;
	activeSubstitutions = [];
	agentOutputTap?.dispose();
	agentOutputTap = null;
	voiceHotkeys?.dispose();
	voiceHotkeys = null;
	disposeACappellaTransport();
	transport = null;
	void stopWakeTest();
	// Fire and forget: this runs from `will-quit`, which is synchronous, and from
	// tests, which do not care how long a model file takes to close.
	void activePipeline?.pipeline.dispose();
	activePipeline = null;
	audioBridge?.dispose();
	audioBridge = null;
}
