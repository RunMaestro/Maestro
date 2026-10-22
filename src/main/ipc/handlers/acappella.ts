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

import { readVoiceUiPrefs } from '../../../shared/acappella/ui-prefs';
import { getGroupChatState } from '../../group-chat/emitters';
import { isAgentBusy, isAiTabProcessActive } from '../../utils/agent-busy';
import { voiceScopeAgentId } from '../../../shared/acappella/document-scope';
import type { ProcessLivenessProbe } from '../../utils/agent-busy';
import { VoiceStudioClient } from '../../acappella/providers/local/voice-studio-tts';
import {
	readVoiceStudioConfig,
	voiceStudioConfigProblem,
} from '../../../shared/acappella/voice-studio';
import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { hostname } from 'os';

import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import { logger } from '../../utils/logger';
import type { SafeSendFn } from '../../utils/safe-send';
import type {
	InterruptSource,
	RosterAgent,
	VoiceEvent,
	VoiceScope,
	VoiceWindowId,
} from '../../../shared/acappella/protocol';
import { getSessionsStore } from '../../stores/getters';
import { correctSpeechVocabulary } from '../../local-models/speech-vocabulary';
import { buildSpeechVocabulary } from '../../../shared/acappella/speech-vocabulary';
import { withSystemOneRouting } from '../../acappella/providers/system-one-brain';
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
	ACAPPELLA_SYSTEM_DEFAULT_INPUT,
	type AudioDeviceInfo,
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
	isAcappellaAudioHostReady,
	markAcappellaAudioHostReady,
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
import {
	DEFAULT_SEND_PHRASES,
	DEFAULT_TTS_VOLUME,
	DEFAULT_WAKE_PHRASE,
} from '../../../shared/acappella/voice-controls';
import type { WakeEnrollmentReply } from '../../../shared/acappella/wake-enrollment';
import {
	clampSendWaitOverrideMs,
	resolveSendWait,
	type VoiceSendWait,
} from '../../../shared/acappella/listen-mode';
import {
	isACappellaEnabled,
	requireACappellaEnabled,
} from '../../../shared/acappella/feature-flag';
import {
	ACAPPELLA_SETTINGS_KEY,
	buildProviderState,
	createNoticeTtsProvider,
	migrateLegacyVoiceProviders,
	noticeTtsProviderId,
	pipelineKey,
	readVoiceProviderSettings,
	resolveVoicePipeline,
	swapVoicePipeline,
	type VoiceProviderResolution,
	type VoiceProviderSettings,
	type VoiceProviderSubstitution,
} from '../../acappella/providers/provider-registry';
import type { TtsProvider } from '../../../shared/acappella/providers';
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
import {
	formatTurnBreakdown,
	lastTurn,
	type TurnBreakdown,
} from '../../acappella/telemetry/turn-metrics';
import { installVoiceHotkeys, type VoiceHotkeyInstallation } from '../../acappella/hotkeys';
import { HandsFreeListener } from '../../acappella/wake/hands-free';
import {
	WakeEnrollmentService,
	registerWakeEnrollmentService,
	runWakeEnrollmentRequest,
} from '../../acappella/wake/wake-enrollment-service';
import { enrolledWakeRevision } from '../../acappella/wake/wake-enrollment-store';
import { ClipCapture } from '../../acappella/audio/clip-capture';
import { NoticeSpeech } from '../../acappella/audio/notice-speech';
import { registerDictationMicrophone } from '../../local-models/dictation';
import { cancelSpokenNotices, registerNoticeSpeaker } from '../../local-models/spoken-notices';
import { isScopeRouterId } from '../../../shared/acappella/voice-mode';
import {
	QUICK_CHAT_VOICE_SCOPE,
	isQuickChatScope,
	scopeRebindBlocker,
} from '../../../shared/acappella/quick-chat-scope';
import {
	QUICK_CHAT_VOICE_UNAVAILABLE,
	type QuickChatVoiceHost,
} from '../../acappella/dispatch/quick-chat-dispatch';
import { wakeScorerFactory } from '../../acappella/wake/transcription-wake';
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
	setVoiceDiscovery,
	testVoiceConnection,
} from './acappella-devices';
import {
	VoiceControlRefusal,
	registerVoiceControlService,
	type VoiceControlHandlers,
} from '../../acappella/voice-control-service';
import {
	VOICE_PREVIEW_LINE,
	parseVoiceControlScope,
	type VoiceSessionView,
	type VoiceWakeHit,
} from '../../../shared/acappella/voice-control';
import { formatVoiceSelfTestReport, runVoiceSelfTest } from '../../acappella/voice-self-test';

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

/**
 * Push channel for the microphone list.
 *
 * Its own channel rather than a protocol event: the list exists with no session
 * running (a settings panel has to draw the picker before anyone has spoken),
 * and inventing a voice session id so Settings can populate a dropdown would put
 * a fake session in every client's event stream.
 */
export const ACAPPELLA_INPUT_DEVICES_CHANNEL = 'acappella:input-devices';

/**
 * The wake phrase enrollment channel: recording progress, microphone level, and
 * training progress for a phrase the user is teaching the wake word. Events are
 * `WakeEnrollmentEvent` from `shared/acappella/wake-enrollment`.
 */
export const ACAPPELLA_WAKE_ENROLLMENT_CHANNEL = 'acappella:wake-enrollment';

/** What the wake-word tuning affordance pushes while it is running. */
export interface WakeTestEvent {
	phraseId: string;
	phrase: string;
	score: number;
	at: number;
}

/**
 * What starting a wake-word tuning run returns. A refusal carries the sentence
 * to show, because "nothing lit up" is otherwise indistinguishable between a
 * quiet phrase, a missing runtime, and a phrase no detector was trained for.
 */
export type WakeTestStartResult = { started: true } | { started: false; reason: string };

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
		 * Persist a setting. Optional for the same reason `onDidChange` is: tests
		 * pass a plain object. Without it the microphone choice cannot be saved, and
		 * `acappella:set-input-device` says so rather than reporting a success that
		 * would be forgotten on the next read.
		 */
		set?: (key: string, value: unknown) => void;
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
	/**
	 * Which window's HUD a session started from THIS trigger belongs to.
	 *
	 * `sender` is the IPC sender for a click (composer microphone, palette, Left
	 * Bar menu); it is absent for a trigger that has no window behind it - a
	 * global hotkey, a wake word, a paired phone - and the implementation then
	 * answers with the focused window.
	 *
	 * Every main -> renderer push is broadcast to all windows, so without this the
	 * same HUD rendered in every window at once and one microphone looked like
	 * several. Absent in tests and in any single-window host, where null means the
	 * primary window shows it, which is the only window there is.
	 */
	resolveVoiceWindowId?: (sender?: WebContents | null) => VoiceWindowId;
	/**
	 * Quick Chat, for a session bound to it: its window is the session's surface
	 * and its `send` delivers each turn. A getter because the controller is built
	 * after these handlers are registered. Absent in tests and in a host with no
	 * Quick Chat, where a Quick Chat session is refused by name.
	 */
	getQuickChat?: () => QuickChatVoiceHost | null;
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
	getProcessManager?: () => (AgentOutputSource & Partial<ProcessLivenessProbe>) | null;
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
 * The microphones the audio host last reported.
 *
 * Cached because main cannot enumerate them itself: `enumerateDevices` is a DOM
 * API, and a settings panel that had to open a hidden window and wait for a
 * round trip just to draw a list would either block or render empty. The host
 * republishes on boot, on device change, and after each capture starts (which is
 * when Chromium stops redacting the labels).
 *
 * This is a CACHE, not the source of truth, and it is empty until the audio host
 * first opens - which nothing does before a session starts. A picker must
 * therefore enumerate in its own renderer (see `useVoiceInputDevices`) rather
 * than wait on this; serving it as the list is what left Voice Setup offering
 * the system default and nothing else.
 */
let inputDevices: AudioDeviceInfo[] = [];

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
 * Wake phrase enrollment: recording a phrase the user wants to wake on, and
 * training it. Module state because a capture run holds the one microphone, and
 * every other borrower of it has to be able to ask whether one is live. See
 * `acappella/wake/wake-enrollment-service.ts`.
 */
let wakeEnrollment: WakeEnrollmentService | null = null;
let releaseWakeEnrollment: (() => void) | null = null;

/**
 * Listeners on the tuning run's hits, beside the broadcast to the Settings dot.
 * `maestro-cli voice wake test` has no window to light up, so it counts the
 * hits of its own run here.
 */
const wakeTestTaps = new Set<(event: WakeTestEvent) => void>();

/**
 * The registration of this layer's functions as the one voice control service
 * (`acappella/voice-control-service.ts`), which `maestro-cli voice` reaches.
 */
let releaseVoiceControl: (() => void) | null = null;

/**
 * The always-on wake word behind the Voice Controls toggle. Module state for the
 * same reason as the hotkeys: it outlives any one session and re-arms between
 * them. See `acappella/wake/hands-free.ts`.
 */
let handsFree: HandsFreeListener | null = null;

/**
 * The session-less microphone dictation records through, and its registration
 * with the core Local Models dictation service.
 *
 * Module state like the wake word, and built whether or not the A Cappella
 * Encore Feature is on: dictation is a core feature that only borrows this
 * capture path. Building it opens no device; a clip does, when a user asks for
 * one. See `acappella/audio/clip-capture.ts`.
 */
let clipCapture: ClipCapture | null = null;
let releaseDictationMicrophone: (() => void) | null = null;

/**
 * The session-less speaker spoken notices play through, its registration with
 * the core Local Models notice service, and the voice it last spoke with.
 *
 * Module state like the dictation microphone, and for the same reason built
 * whether or not the A Cappella Encore Feature is on: a notice is a core
 * feature that only borrows this playback path. Building it opens nothing; a
 * notice does, when the user has asked for them. See
 * `acappella/audio/notice-speech.ts`.
 */
let noticeSpeech: NoticeSpeech | null = null;
let releaseNoticeSpeaker: (() => void) | null = null;
let noticeTts: { id: string; provider: TtsProvider } | null = null;

/** Why a notice may not be spoken over a live voice session. */
const VOICE_SESSION_NOTICE_REFUSAL = Object.freeze({
	code: 'voice-session-active' as const,
	message: 'A voice session is live, so the notice was not spoken.',
});

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

/** The Encore gate. See `src/shared/acappella/feature-flag.ts`. */
const requireEnabled = requireACappellaEnabled;

/** An unrecognised scope is conductor scope; a malformed BOUND scope is not. */
function parseScope(raw: unknown): VoiceScope {
	if (!isRecord(raw)) return { kind: 'conductor' };
	if (raw.kind === 'group-chat') {
		const scope = parseVoiceControlScope(raw);
		if (!scope) throw new Error('InvalidVoiceScope');
		return scope;
	}
	// Quick Chat carries no ids, so there is nothing about it to be malformed.
	if (raw.kind === 'quick-chat') return { ...QUICK_CHAT_VOICE_SCOPE };
	if (raw.kind !== 'agent' && raw.kind !== 'document') return { kind: 'conductor' };
	// Falling back to the conductor here would send a spoken instruction to
	// whichever agent happens to be active, which is the one outcome worse than
	// an error.
	if (typeof raw.sessionId !== 'string' || !raw.sessionId) {
		throw new Error('InvalidVoiceScope');
	}
	if (raw.kind === 'agent') {
		// A tab pin is Tab mode; anything that is not a non-empty string is Agent
		// mode rather than an error, because the agent binding itself is valid.
		return typeof raw.tabId === 'string' && raw.tabId
			? { kind: 'agent', sessionId: raw.sessionId, tabId: raw.tabId }
			: { kind: 'agent', sessionId: raw.sessionId };
	}
	// Same rule for the path: a document scope with no document would open a
	// session that names a file in the HUD and hands the agent nothing.
	if (typeof raw.path !== 'string' || !raw.path) {
		throw new Error('InvalidVoiceScope');
	}
	return { kind: 'document', sessionId: raw.sessionId, path: raw.path };
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
	audioBridge = createVoiceAudioBridge({
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
			// refusal to guess below the confidence threshold. Inside it, the
			// `voice-routing` task assigned to System One hands the routing decision
			// to that engine; on any other assignment the Brain routes untouched.
			brain: createConductorRouter({ brain: withSystemOneRouting(resolution.providers.brain) }),
		},
		pipelineShape: resolution.shape,
		getRoster: readAgentRoster,
		getHoldWhileBusy: () =>
			readVoiceUiPrefs(
				(deps.settingsStore.get('acappella', {}) as { ui?: Record<string, unknown> }).ui
			).holdWhileBusy,
		isScopeBusy: (scope) => {
			if (scope.kind === 'group-chat') return getGroupChatState(scope.groupChatId) !== 'idle';
			const id = voiceScopeAgentId(scope);
			const manager = deps.getProcessManager?.();
			if (!id || !manager?.get) return false;
			const probe = { get: manager.get.bind(manager) };
			const session = getSessionsStore()
				.get('sessions', [])
				.find((entry) => entry.id === id);
			if (!session) return false;
			return scope.kind === 'agent' && scope.tabId
				? isAiTabProcessActive(probe, id, scope.tabId, session.activeTabId === scope.tabId)
				: isAgentBusy(session, probe);
		},
		getVocabulary: () => readVoiceProviderSettings(deps.settingsStore).vocabulary ?? [],
		refineTranscript: correctSpeechVocabulary,
		getForceSendAllowed: () => deps.settingsStore.get('forcedParallelExecution', false) === true,
		// The capability gate. The service refuses to start when a required slot is
		// unsatisfied and names the missing piece; it never asks for, and cannot be
		// handed, a replacement provider.
		checkReadiness: () => readVoiceReadiness(deps.settingsStore),
		// What is actually running, including any slot that could not be built. The
		// service cannot derive this: it is handed a trio and never learns what was
		// requested.
		getProviderState: () => buildProviderState(resolution),
		// How long a sentence is held before it counts as a finished thought. Read
		// through the getter so tuning it lands on the next thought rather than the
		// next session. `resolveSendWait` is the one place the stored default
		// (settle, or the long hold-until-send backstop) meets the HUD's override,
		// so the wait the HUD shows is the wait the composer runs.
		getUtteranceComposerConfig: () => {
			const settings = readVoiceProviderSettings(deps.settingsStore);
			return {
				settleMs: readSendWait(deps).waitMs,
				sendPhrases: settings.sendPhrases,
			};
		},
		// Read per turn, so switching modes applies to the next thing said rather
		// than to the next session.
		getConversationalMode: () =>
			readVoiceProviderSettings(deps.settingsStore).conversationalMode === true,
		executeRoute: createVoiceRouteExecutor({
			bridge: createRendererVoiceBridge(deps.getMainWindow, deps.getWindowForSession),
			getQuickChat: deps.getQuickChat,
			getProcessManager: () => {
				const manager = deps.getProcessManager?.();
				return manager?.get ? { get: manager.get.bind(manager) } : null;
			},
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
	// The wake word re-arms when a session ends and stands down when one starts.
	// Deferred a tick: `listen-stop` is emitted just BEFORE the state reaches
	// `idle`, so a synchronous re-check would still see a live session and the
	// listener would stay deaf after every conversation.
	service.subscribe((event) => {
		if (event.type === 'wake' || event.type === 'listen-stop' || event.type === 'session-error') {
			setTimeout(() => void handsFree?.sync(), 0);
		}
	});
	// From the moment the floor opens the session owns the speakers: a notice
	// being spoken is cut off and the ones waiting behind it are dropped.
	service.subscribe((event) => {
		if (event.type === 'listen-start') {
			cancelSpokenNotices(
				VOICE_SESSION_NOTICE_REFUSAL.code,
				'A voice session started, so the notice was cut off.'
			);
		}
	});
	ensureAudioBridge(service, deps);
	return service;
}

/**
 * The send wait the HUD picked, or null to use the stored default.
 *
 * In memory on purpose. Settings holds the default; this is the "just for now"
 * on top of it, so a wait stretched for one long dictation does not quietly
 * become the wait every later conversation gets. The HUD clears it when it is
 * closed, and a restart clears it regardless.
 */
let sendWaitOverrideMs: number | null = null;

/** The send wait in force, and where it came from. */
function readSendWait(deps: ACappellaHandlerDependencies): VoiceSendWait {
	return resolveSendWait(
		readVoiceProviderSettings(deps.settingsStore),
		sendWaitOverrideMs,
		DEFAULT_SEND_PHRASES
	);
}

/** Whether the latest `route-decision` came from a Brain (false in Tab mode). */
let lastDecisionWasRouted = true;

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
	// Tab mode and a Quick Chat session route nothing, so their dispatch is not an
	// outcome of any logged turn; recording it would overwrite the verdict of the
	// last real one.
	if (event.type === 'route-decision') {
		lastDecisionWasRouted = !isScopeRouterId(event.brainProviderId);
		return;
	}
	if (!lastDecisionWasRouted) return;

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

/** The snapshot fields a caller outside the app is shown. */
function toVoiceSessionView(snapshot: VoiceSessionSnapshot | null): VoiceSessionView | null {
	if (!snapshot) return null;
	return {
		sessionId: snapshot.sessionId,
		state: snapshot.state,
		scope: snapshot.scope,
		origin: snapshot.origin,
		windowId: snapshot.windowId,
		listenPaused: snapshot.listenPaused,
		startedAt: snapshot.startedAt,
		providerIds: snapshot.providerIds,
	};
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
	void handsFree?.sync();
	voiceHotkeys?.sync();
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

	// The handler bodies below are named rather than written inline in their
	// `ipcMain.handle`, because each has a second caller: the voice control
	// service registered at the end of this function, which is how `maestro-cli
	// voice` presses the same button.
	/**
	 * Put the Quick Chat window on screen and return its id, the owner of a
	 * session bound to Quick Chat. A session whose only surface cannot be shown
	 * is refused, never opened in some other window: the HUD's mode switch there
	 * would offer a re-binding this session does not allow.
	 */
	const claimQuickChatWindow = (): string => {
		const windowId = deps.getQuickChat?.()?.showForVoice() ?? null;
		if (!windowId) throw new VoiceControlRefusal(QUICK_CHAT_VOICE_UNAVAILABLE);
		return windowId;
	};
	/** The window that shows a session on `scope`: Quick Chat's own, or `fallback`. */
	const ownerWindowFor = (scope: VoiceScope, fallback: VoiceWindowId): VoiceWindowId =>
		isQuickChatScope(scope) ? claimQuickChatWindow() : fallback;

	const startSession = async (
		rawScope: unknown,
		windowId: VoiceWindowId,
		paused: boolean
	): Promise<VoiceStartSessionResult> => {
		const scope = parseScope(rawScope);
		// A Quick Chat session is shown by the Quick Chat window and by no other,
		// whoever asked for it (the window's own microphone, or `maestro-cli voice
		// start --quick-chat` with no window behind it). Claimed before the
		// microphone is asked for, so a refusal costs the user no permission prompt.
		const owner = ownerWindowFor(scope, windowId);
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
		const snapshot = await service.startSession({
			scope,
			source: 'client-button',
			windowId: owner,
			paused,
		});
		return { snapshot, substitutions };
	};
	const wrappedStart = withIpcErrorLogging(handlerOpts('startSession'), startSession);

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
	const wrappedVoiceStudioStatus = withIpcErrorLogging(
		handlerOpts('voiceStudioStatus'),
		async (value: unknown) => {
			const config = readVoiceStudioConfig(value);
			const problem = voiceStudioConfigProblem(config);
			if (problem) return { connected: false, message: problem };
			return new VoiceStudioClient(config).status();
		}
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
	const applyVolume = async (volume: unknown): Promise<boolean> => {
		if (typeof volume !== 'number' || !Number.isFinite(volume)) {
			throw new Error('InvalidVolume');
		}
		if (!audioBridge) return false;
		// Zero is legal here and only here: mute is a real state the HUD owns,
		// while the SLIDER floors above zero so it cannot become a silent mute.
		audioBridge.setPlaybackVolume(Math.min(1, Math.max(0, volume)));
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
				readVoiceProviderSettings(deps.settingsStore).inputDeviceId ??
				ACAPPELLA_SYSTEM_DEFAULT_INPUT,
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
		const stored = (deps.settingsStore.get(ACAPPELLA_SETTINGS_KEY, {}) ?? {}) as Record<
			string,
			unknown
		>;
		const audio = (stored.audio ?? {}) as Record<string, unknown>;
		if (!deps.settingsStore.set) throw new Error('SettingsNotWritable');
		deps.settingsStore.set(ACAPPELLA_SETTINGS_KEY, {
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
			return service.startSession({
				scope,
				source,
				origin,
				// No IPC sender to resolve: a global hotkey, a wake word, and a paired
				// phone all arrive with no window behind them, so the HUD belongs to
				// the window the user is looking at.
				windowId: ownerWindowFor(scope, deps.resolveVoiceWindowId?.() ?? null),
			});
		},
		stopSession: async (reason) => {
			await getVoiceSessionService()?.stopSession(reason);
		},
		interrupt: (source) => getVoiceSessionService()?.interrupt(source) ?? false,
	};

	handsFree ??= new HandsFreeListener({
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
			(clipCapture?.isActive ?? false) || (wakeEnrollment?.isRecording ?? false),
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
	settingsStore.onDidChange?.(ACAPPELLA_SETTINGS_KEY, () => void handsFree?.sync());
	settingsStore.onDidChange?.('encoreFeatures', () => void handsFree?.sync());
	// Armed at launch when the toggle was left on: that is what "always listening" means.
	void handsFree.sync();

	// Dictation's microphone. Not gated on the Encore flag (dictation is a core
	// Local Models feature), and it never reaches the session service: it only
	// reads the session's state, to refuse while one is live.
	clipCapture ??= new ClipCapture({
		refusal: () => {
			if ((getVoiceSessionService()?.getState() ?? 'idle') !== 'idle') {
				return {
					code: 'voice-session-active',
					message: 'A voice session is using the microphone. End it, then dictate.',
				};
			}
			if (wakeTestDetector) {
				return {
					code: 'busy',
					message: 'The wake word Test is using the microphone. Stop it, then dictate.',
				};
			}
			if (wakeEnrollment?.isRecording) {
				return {
					code: 'busy',
					message: 'A wake phrase is being recorded. Finish that, then dictate.',
				};
			}
			return null;
		},
		// The always-on wake word reads `isActive` and stands down or re-arms.
		onActiveChange: () => handsFree?.sync(),
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
	});
	releaseDictationMicrophone ??= registerDictationMicrophone(clipCapture, async () =>
		buildSpeechVocabulary(
			await readAgentRoster(),
			readVoiceProviderSettings(settingsStore).vocabulary
		)
	);

	// Wake phrase enrollment borrows the same microphone, under the same rules:
	// one consumer at a time, and never out from under a live session.
	wakeEnrollment ??= new WakeEnrollmentService({
		emit: (event) => deps.safeSend(ACAPPELLA_WAKE_ENROLLMENT_CHANNEL, event),
		microphoneBusyReason: () => {
			if ((getVoiceSessionService()?.getState() ?? 'idle') !== 'idle') {
				return 'End the voice session first, then record the phrase.';
			}
			if (clipCapture?.isActive) return 'Finish the dictation first, then record the phrase.';
			if (wakeTestDetector) return 'Stop the wake word Test first, then record the phrase.';
			if (!deps.audioHostDeps) return 'There is no audio host to capture the microphone through.';
			return null;
		},
		openMicrophone: async () => {
			await requestMicPermission();
			if (deps.audioHostDeps) ensureAcappellaAudioHostWindow(deps.audioHostDeps);
			startWakeTestCapture(deps);
			// The always-on wake word reads `isRecording` and stands down.
			void handsFree?.sync();
		},
		closeMicrophone: async () => {
			// Never close a microphone a session is using.
			if ((getVoiceSessionService()?.getState() ?? 'idle') === 'idle') {
				sendAudioHostCommand({ kind: 'stop-capture' });
			}
			void handsFree?.sync();
		},
		// A newly trained phrase may be the one hands-free is waiting to arm on.
		onModelChanged: () => void handsFree?.sync(),
	});
	releaseWakeEnrollment ??= registerWakeEnrollmentService(wakeEnrollment, () =>
		isACappellaEnabled(settingsStore)
	);

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

	const hotkeys = (voiceHotkeys ??= installVoiceHotkeys({
		settingsStore,
		session: floorSession,
		getMainWindow: deps.getMainWindow,
		getFocusedAgentSessionId: deps.getFocusedAgentSessionId ?? (() => null),
		// Two halves of one gesture, and both are needed. The bridge owns the
		// recogniser handle, so the flush goes through it; the session owns the
		// composer, which would otherwise buffer the resulting final and sit out a
		// settle window the user already answered by letting go of the key.
		endUtterance: () => {
			audioBridge?.endUtterance();
			getVoiceSessionService()?.endUtteranceNow();
		},
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

	const beginWakeTest = async (payload: unknown): Promise<WakeTestStartResult> => {
		const result = await startWakeTest(deps, payload);
		// A refused Test borrowed nothing; give the always-on wake word its microphone back.
		if (!result.started) void handsFree?.resume();
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
		async (event, scope: unknown, options: unknown): Promise<VoiceStartSessionResult> => {
			requireEnabled(settingsStore);
			// Resolved HERE rather than inside the wrapped handler, because
			// `withIpcErrorLogging` strips the event and the sender is the only
			// evidence of which window the user actually clicked in.
			return wrappedStart(
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
	ipcMain.handle('acappella:stop-session', wrappedStop);

	ipcMain.handle('acappella:submit-utterance', async (event, text: unknown): Promise<boolean> => {
		requireEnabled(settingsStore);
		return wrappedSubmitUtterance(event, text);
	});

	// Tab / Agent / Conductor, switched mid-session from the HUD. Returns false
	// when there is no live session to re-bind.
	const setScope = (rawScope: unknown): boolean =>
		getVoiceSessionService()?.setScope(parseScope(rawScope)) ?? false;
	ipcMain.handle('acappella:set-scope', async (_event, rawScope: unknown): Promise<boolean> => {
		requireEnabled(settingsStore);
		return setScope(rawScope);
	});

	// "Send now": end the held utterance and dispatch it. The same two-part
	// gesture as releasing the push-to-talk key: flush the recogniser so the tail
	// of the sentence is decoded, and settle the composer on it.
	const sendNow = (): void => {
		audioBridge?.endUtterance();
		getVoiceSessionService()?.endUtteranceNow();
	};
	ipcMain.handle('acappella:end-utterance', async (): Promise<void> => {
		requireEnabled(settingsStore);
		sendNow();
	});

	// Open or shut the microphone without ending the session: the HUD's hands-free
	// toggle, and both ends of its push-to-talk hold. Returns false when there is
	// no live session to gate, which is how the HUD knows to start one instead.
	const setListening = (payload: unknown): boolean => {
		const { listening, hold, send } = (payload ?? {}) as Record<string, unknown>;
		if (typeof listening !== 'boolean') throw new Error('InvalidListening');
		const service = getVoiceSessionService();
		if (!service) return false;
		// The release half of push-to-talk is the same two-part gesture as
		// `end-utterance`: flush the recogniser so the tail of the sentence is
		// decoded, then settle the composer on it. Flushed BEFORE the gate shuts,
		// while the audio it needs is still the audio the recogniser holds.
		if (!listening && send === true) audioBridge?.endUtterance();
		return service.setListening(listening, { hold: hold === true, send: send === true });
	};
	ipcMain.handle('acappella:set-listening', async (_event, payload: unknown): Promise<boolean> => {
		requireEnabled(settingsStore);
		return setListening(payload);
	});

	// Ungated read: the HUD draws the wait chip from it, and a chip that threw
	// while the feature was being switched off would blank the control row.
	ipcMain.handle('acappella:get-send-wait', async (): Promise<VoiceSendWait> => readSendWait(deps));

	// The HUD's quick wait picker. Null (or anything malformed) returns to the
	// stored default. Applies from the next fragment: the composer reads it live.
	const setSendWait = (waitMs: unknown): VoiceSendWait => {
		sendWaitOverrideMs = clampSendWaitOverrideMs(waitMs);
		return readSendWait(deps);
	};
	ipcMain.handle(
		'acappella:set-send-wait',
		async (_event, waitMs: unknown): Promise<VoiceSendWait> => {
			requireEnabled(settingsStore);
			return setSendWait(waitMs);
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
	// Sources can be configured before the A Cappella Encore Feature is enabled.
	ipcMain.handle('acappella:voice-studio-status', wrappedVoiceStudioStatus);
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

	// Ungated deliberately: Voice Setup draws the microphone picker while the user
	// is deciding whether to switch the feature on, and a picker that throws until
	// then would make the panel look broken.
	ipcMain.handle('acappella:input-devices', wrappedInputDevices);
	ipcMain.handle('acappella:set-input-device', wrappedSetInputDevice);

	ipcMain.handle('acappella:last-turn', async (event): Promise<TurnBreakdown | null> => {
		requireEnabled(settingsStore);
		return wrappedLastTurn(event);
	});

	// Ungated: the Voice Controls rows show a hotkey's registration state, and the
	// most interesting time to read it is right after the feature was switched
	// off and both combos were released.
	ipcMain.handle('acappella:hotkey-status', wrappedHotkeyStatus);

	ipcMain.handle(
		'acappella:wake-test',
		async (event, payload: unknown): Promise<WakeTestStartResult> => {
			requireEnabled(settingsStore);
			return wrappedWakeTest(event, payload);
		}
	);

	// Ungated, like `stop-session`: a tuning run has an open microphone, and
	// switching the feature off must still be able to close it.
	ipcMain.handle('acappella:wake-test-stop', wrappedWakeTestStop);

	// One channel for every enrollment verb, and no gate here: the entry point
	// decides which verbs need voice switched on, so `maestro-cli voice wake`
	// reaching it over the bridge is held to exactly the same rule.
	ipcMain.handle('acappella:wake-enrollment', wrappedWakeEnrollment);

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
		else if (wakeEnrollment?.isRecording) wakeEnrollment.pushFrame(new Int16Array(frame.pcm));
		else handsFree?.pushFrame(new Int16Array(frame.pcm));
		// A dictated clip taps them too, for the same reason.
		if (clipCapture?.isActive) clipCapture.pushFrame(new Int16Array(frame.pcm));
	});

	ipcMain.on(ACAPPELLA_AUDIO_STATUS_CHANNEL, (event, status: unknown) => {
		if (!isAcappellaAudioHostContents(event.sender)) return;
		if (!status || typeof (status as AudioHostStatus).kind !== 'string') return;
		notePermissionFromStatus(status as AudioHostStatus);
		noteInputDevices(status as AudioHostStatus, deps.safeSend);
		audioBridge?.handleStatus(status as AudioHostStatus);
		clipCapture?.handleStatus(status as AudioHostStatus);
		noticeSpeech?.handleStatus(status as AudioHostStatus);
		logAudioHostStatus(status as AudioHostStatus);
		// A tuning run started before the host finished booting; see startWakeTestCapture.
		if ((status as AudioHostStatus).kind === 'ready') {
			markAcappellaAudioHostReady();
			// So did a wake phrase recording: same command, same replay.
			if (wakeTestDetector || wakeEnrollment?.isRecording) startWakeTestCapture(deps);
			else handsFree?.onAudioHostReady();
		}
	});

	// The peer-connection control plane, from the same window and with the same
	// sender check: an answer or a data-channel message forged by any other
	// renderer would be a paired device's traffic with no pairing behind it.
	ipcMain.on(ACAPPELLA_WEBRTC_EVENT_CHANNEL, (event, hostEvent: unknown) => {
		if (!isAcappellaAudioHostContents(event.sender)) return;
		if (!hostEvent || typeof (hostEvent as WebRtcHostEvent).kind !== 'string') return;
		getACappellaTransport()?.handleHostEvent(hostEvent as WebRtcHostEvent);
	});

	// -- The voice control service -------------------------------------------
	//
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
			const { service } = await ensureService(deps);
			let failure: string | null = null;
			const release = service.subscribe((event) => {
				if (event.type === 'session-error') failure = event.message;
			});
			try {
				const { snapshot, substitutions } = await startSession(
					scope,
					deps.resolveVoiceWindowId?.() ?? null,
					paused === true
				);
				if (snapshot.state === 'idle' || snapshot.state === 'error') {
					throw new VoiceControlRefusal(failure ?? 'The voice session could not start.');
				}
				return { session: toVoiceSessionView(snapshot) as VoiceSessionView, substitutions };
			} finally {
				release();
			}
		},
		stop: async () => {
			await getVoiceSessionService()?.stopSession('user');
			return { session: sessionView() };
		},
		listen: async ({ listening, send }) => ({
			applied: setListening({ listening, send }),
			listening,
		}),
		send: async () => {
			sendNow();
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
			return { applied: setScope(scope), scope };
		},
		wait: async ({ waitMs }) => setSendWait(waitMs),
		volume: async ({ volume }) => ({ applied: await applyVolume(volume), volume }),
		inputs: async () => readInputDevices(),
		'set-input': async ({ deviceId }) => {
			await chooseInputDevice(deviceId);
			return { selectedId: (await readInputDevices()).selectedId };
		},
		'apply-providers': async () => applyACappellaProviders(deps),
		voices: async () => ({ voices: await listVoiceOptions(deps) }),
		preview: async ({ text, voiceId }) => ({
			spoke: await previewVoiceLine(deps, text ?? VOICE_PREVIEW_LINE, voiceId),
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
			const started = await beginWakeTest({ phrase, sensitivity });
			if (!started.started) throw new VoiceControlRefusal(started.reason);
			wakeTestTaps.add(tap);
			try {
				await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
			} finally {
				wakeTestTaps.delete(tap);
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
 * Wind everything down because the Encore Feature was switched off.
 *
 * The switch has to mean what it says. Before this existed, turning A Cappella
 * off released the microphone and closed the audio host, and left three things
 * running that a user would reasonably believe were gone: a live voice session, a
 * loaded inference pipeline holding native runtimes and model files open, and the
 * transport with its Bonjour advert and its connected phones.
 *
 * The pipeline is the one with a second consequence. The reclaim-disk button
 * lives on the Models page precisely so it can be pressed after the feature is
 * off, and on Windows `fs.rm` of a directory whose files are still mapped by a
 * loaded runtime fails outright. Dropping the pipeline here is what makes
 * reclaiming disk work rather than error.
 *
 * What it deliberately does NOT do is dispose the hotkey installation or the
 * transport object. Both are constructed once per process at handler
 * registration, so tearing them down would make switching the feature back on a
 * no-op until the next restart. The hotkeys release their combos through their
 * own settings watcher; the transport stands down and stays reusable.
 */
/**
 * End the session if it belonged to a window that just went away.
 *
 * A session is shown by exactly one window, so closing that window would
 * otherwise leave an open microphone with no surface anywhere - the same
 * "something is listening and nobody can see it" failure the HUD's close button
 * exists to prevent, arrived at by a different route. Closing the window that
 * holds the floor is a clear enough intent to end the session.
 *
 * `hidden` is the same failure for a window that is put away instead of closed:
 * Quick Chat hides on Escape and stays alive, so a session bound to it would
 * otherwise keep listening behind a window nobody can see.
 *
 * A session with no window (null) is deliberately left alone: it is not this
 * window's to end, and the primary window still shows it.
 */
export async function stopVoiceSessionForWindow(
	windowId: string,
	cause: 'closed' | 'hidden' = 'closed'
): Promise<void> {
	const service = getVoiceSessionService();
	if (!service || service.getSnapshot().windowId !== windowId) return;
	logger.info(`Voice session ended: its window (${windowId}) was ${cause}`, LOG_CONTEXT);
	await service.stopSession('shutdown');
}

export async function shutdownACappellaForDisable(): Promise<void> {
	// The advert and the phones go first. A device that still holds the floor
	// would otherwise be able to reopen the microphone during the teardown below.
	getACappellaTransport()?.standDown();
	await stopWakeTest();
	// `shutdown` rather than `user`: nobody pressed stop, and the distinction is
	// what the session's own telemetry and the History entry read.
	await getVoiceSessionService()?.stopSession('shutdown');
	// Order matters, and matches the audio host teardown in main/index.ts: the
	// bridge stops capture through a window it is about to lose.
	disposeACappellaAudioBridge();
	await activePipeline?.pipeline.dispose();
	activePipeline = null;
	// Cleared together. `activeProviderKey` is the memo of what `activePipeline`
	// was built from, so leaving it set would make the next start believe a
	// disposed pipeline still matches settings and reuse it.
	activeProviderKey = null;
	activeSubstitutions = [];
	// A "just for now" wait does not outlive the feature being switched off.
	sendWaitOverrideMs = null;
}

/**
 * Run the wake word with no session behind it, so a user can tune sensitivity by
 * saying the phrase and watching it light up rather than by guessing.
 *
 * Refused while a session is live: the detector would be scoring the same frames
 * the session is already using, and a hit would light the Test dot for a phrase
 * that also just woke the assistant.
 *
 * Refused, with the reason, when the wake word cannot fire at all. The gate is
 * asked rather than the detector because a detector with no model runs INERT by
 * design, and an inert detector behind a Test button is a microphone that
 * listens forever and never lights up.
 */
async function startWakeTest(
	deps: ACappellaHandlerDependencies,
	payload: unknown
): Promise<WakeTestStartResult> {
	await stopWakeTest();
	// One microphone, one consumer: the Test borrows it from the always-on wake word.
	await handsFree?.suspend();
	const state = getVoiceSessionService()?.getState();
	if (state && state !== 'idle') {
		return { started: false, reason: 'End the voice session first, then test the wake word.' };
	}
	if (clipCapture?.isActive) {
		return { started: false, reason: 'Finish the dictation first, then test the wake word.' };
	}
	if (wakeEnrollment?.isRecording) {
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
			for (const tap of wakeTestTaps) tap(event);
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
	wakeTestDetector = detector;
	startWakeTestCapture(deps);
	return { started: true };
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
 * Open the microphone for a tuning run, on the device the user picked.
 *
 * Called on start and again when the audio host reports `ready`: the first Test
 * press creates the host window, and a command sent before its bundle loads has
 * no listener and vanishes. The session's audio bridge already replays on
 * `ready`; the tuning run does not go through the bridge, so it needs the same
 * replay or the first Test listens to nothing. The device id matters for the
 * same reason as in a session: testing on the system default when another
 * microphone is selected tunes the wrong device.
 */
function startWakeTestCapture(deps: ACappellaHandlerDependencies): void {
	sendAudioHostCommand({
		kind: 'start-capture',
		deviceId: readVoiceProviderSettings(deps.settingsStore).inputDeviceId,
	});
}

/** End a tuning run and close the microphone it opened. Safe when none is running. */
async function stopWakeTest(): Promise<void> {
	const detector = wakeTestDetector;
	if (!detector) return;
	wakeTestDetector = null;
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
	void handsFree?.resume();
}

/**
 * Drop the cached provider selection. Test-only seam: the service singleton is
 * module state in `src/main/acappella/index.ts`, and this file's memo of what it
 * was built from has to be cleared alongside it.
 */
export function resetACappellaHandlerState(): void {
	activeProviderKey = null;
	activeSubstitutions = [];
	sendWaitOverrideMs = null;
	agentOutputTap?.dispose();
	agentOutputTap = null;
	voiceHotkeys?.dispose();
	voiceHotkeys = null;
	disposeACappellaTransport();
	transport = null;
	void handsFree?.dispose();
	handsFree = null;
	void wakeEnrollment?.dispose();
	wakeEnrollment = null;
	releaseWakeEnrollment?.();
	releaseWakeEnrollment = null;
	releaseVoiceControl?.();
	releaseVoiceControl = null;
	wakeTestTaps.clear();
	releaseDictationMicrophone?.();
	releaseDictationMicrophone = null;
	clipCapture = null;
	releaseNoticeSpeaker?.();
	releaseNoticeSpeaker = null;
	noticeSpeech = null;
	disposeNoticeTts();
	void stopWakeTest();
	// Fire and forget: this runs from `will-quit`, which is synchronous, and from
	// tests, which do not care how long a model file takes to close.
	void activePipeline?.pipeline.dispose();
	activePipeline = null;
	audioBridge?.dispose();
	audioBridge = null;
}
