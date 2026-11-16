/**
 * Provider resolution, session service construction, credentials, Voice Studio,
 * and TTS voice listing/preview for A Cappella IPC handlers.
 */

import { readVoiceUiPrefs } from '../../../../shared/acappella/ui-prefs';
import { getGroupChatState } from '../../../group-chat/emitters';
import { isAgentBusy, isAiTabProcessActive } from '../../../utils/agent-busy';
import { voiceScopeAgentId } from '../../../../shared/acappella/document-scope';
import { VoiceStudioClient } from '../../../acappella/providers/local/voice-studio-tts';
import {
	readVoiceStudioConfig,
	voiceStudioConfigProblem,
} from '../../../../shared/acappella/voice-studio';
import { withIpcErrorLogging } from '../../../utils/ipcHandler';
import { getSessionsStore } from '../../../stores/getters';
import { correctSpeechVocabulary } from '../../../local-models/speech-vocabulary';
import { withSystemOneRouting } from '../../../acappella/providers/system-one-brain';
import { createConductorRouter } from '../../../acappella/router/conductor-router';
import {
	createRendererVoiceBridge,
	createVoiceRouteExecutor,
	ensureAcappellaAudioHostWindow,
	getVoiceSessionService,
	initVoiceSessionService,
	readAgentRoster,
	type VoiceSessionService,
} from '../../../acappella';
import { createAgentOutputTap, type AgentOutputTap } from '../../../acappella/speech';
import {
	buildProviderState,
	pipelineKey,
	readVoiceProviderSettings,
	resolveVoicePipeline,
	swapVoicePipeline,
	type VoiceProviderResolution,
	type VoiceProviderSubstitution,
} from '../../../acappella/providers/provider-registry';
import type { TtsVoice } from '../../../../shared/acappella/providers';
import {
	clearCredential,
	listCredentialStates,
	setCredential,
	validateCredential,
	type CredentialState,
	type CredentialValidation,
} from '../../../acappella/providers/credentials';
import {
	VOICE_CREDENTIAL_SERVICES,
	type VoiceCredentialService,
} from '../../../../shared/acappella/provider-catalog';
import { readVoiceReadiness } from '../acappella-models';
import type { VoiceSendWait } from '../../../../shared/acappella/listen-mode';
import { cancelSpokenNotices } from '../../../local-models/spoken-notices';
import {
	ACAPPELLA_EVENT_CHANNEL,
	handlerOpts,
	isRecord,
	type ACappellaHandlerDependencies,
} from './shared';
import { sharedState } from './state';
import { recordRoutingOutcome } from './routing';

let activeSubstitutions: VoiceProviderSubstitution[] = [];
let agentOutputTap: AgentOutputTap | null = null;

/** Why a notice may not be spoken over a live voice session. */
export const VOICE_SESSION_NOTICE_REFUSAL = Object.freeze({
	code: 'voice-session-active' as const,
	message: 'A voice session is live, so the notice was not spoken.',
});

export function clearActiveSubstitutions(): void {
	activeSubstitutions = [];
}

export function resetProvidersState(): void {
	activeSubstitutions = [];
	agentOutputTap?.dispose();
	agentOutputTap = null;
}

export interface ProviderServiceCallbacks {
	ensureAudioBridge: (service: VoiceSessionService, deps: ACappellaHandlerDependencies) => void;
	readSendWait: (deps: ACappellaHandlerDependencies) => VoiceSendWait;
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
	deps: ACappellaHandlerDependencies,
	callbacks: ProviderServiceCallbacks
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
				settleMs: callbacks.readSendWait(deps).waitMs,
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
		onSpeechChunk: (chunk) => sharedState.audioBridge?.handleSpeechChunk(chunk),
		// The live tap. With it, a reply is spoken as the agent writes it; without
		// it (no process manager yet, and in tests) the session waits for a whole
		// reply through `submitAgentReply`.
		agentReplyStream: tap ?? undefined,
		// The pipeline ducks on a candidate frame long before this fires. These are
		// the other door: a client button, and the Phase 10 phone.
		duckPlayback: (gain, ms) => sharedState.audioBridge?.duckPlayback(gain, ms),
		flushPlayback: () => sharedState.audioBridge?.flushPlayback(),
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
			setTimeout(() => void sharedState.handsFree?.sync(), 0);
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
	callbacks.ensureAudioBridge(service, deps);
	return service;
}

/**
 * The live service, built on first use and rebuilt whenever the provider
 * selection changes.
 *
 * `initVoiceSessionService` disposes the old instance, which drops its
 * subscribers, so the fan-out is re-registered here rather than accumulating a
 * second copy.
 */
export async function ensureService(
	deps: ACappellaHandlerDependencies,
	callbacks: ProviderServiceCallbacks
): Promise<{
	service: VoiceSessionService;
	substitutions: VoiceProviderSubstitution[];
}> {
	const settings = readVoiceProviderSettings(deps.settingsStore);
	const key = pipelineKey(settings);

	const existing = getVoiceSessionService();
	if (existing && sharedState.activeProviderKey === key) {
		// Reattach the audio bridge if disable tore it down while the service
		// stayed alive, otherwise the next session runs deaf and mute.
		callbacks.ensureAudioBridge(existing, deps);
		return { service: existing, substitutions: activeSubstitutions };
	}

	// The old pipeline is torn down BEFORE the new one is built, so two loaded
	// models are never resident at once.
	await sharedState.activePipeline?.pipeline.dispose();
	const resolution = resolveVoicePipeline({ settings });
	sharedState.audioBridge?.dispose();
	sharedState.audioBridge = null;

	const service = await buildService(resolution, deps, callbacks);

	sharedState.activePipeline = resolution;
	sharedState.activeProviderKey = key;
	activeSubstitutions = resolution.substitutions;
	return { service, substitutions: resolution.substitutions };
}

/**
 * Apply a provider change to the running app.
 *
 * Called by the settings panel after it writes a selection. A swap while a turn
 * is in flight is REFUSED rather than queued: splicing two engines into one
 * live turn would mix audio from two models or drop the reply mid-sentence.
 */
export async function applyACappellaProvidersWithCallbacks(
	deps: ACappellaHandlerDependencies,
	callbacks: ProviderServiceCallbacks
): Promise<{ status: 'swapped' | 'unchanged' | 'refused'; reason?: string }> {
	const settings = readVoiceProviderSettings(deps.settingsStore);
	const service = getVoiceSessionService();

	const result = await swapVoicePipeline({
		settings,
		current: sharedState.activePipeline
			? {
					pipeline: sharedState.activePipeline.pipeline,
					key: sharedState.activeProviderKey ?? '',
				}
			: null,
		isBusy: isTurnInFlight(service),
	});

	if (result.status !== 'swapped' || !result.resolution) {
		return { status: result.status, reason: result.reason };
	}

	sharedState.audioBridge?.dispose();
	sharedState.audioBridge = null;

	const rebuilt = await buildService(result.resolution, deps, callbacks);
	sharedState.activePipeline = result.resolution;
	sharedState.activeProviderKey = pipelineKey(settings);
	activeSubstitutions = result.resolution.substitutions;
	// Announce the new engines even though no session is open: a client showing
	// "you are on Whisper" has to stop saying so the moment that stops being true.
	rebuilt.publishProviderState();

	return { status: 'swapped' };
}

/** A provider that can enumerate its voices. Duck-typed: not every one can. */
interface VoiceListingProvider {
	listVoices?: () => Promise<TtsVoice[]> | TtsVoice[];
}

/**
 * The voices the current TTS provider offers.
 *
 * Empty for a provider with one voice or none, which the picker renders as
 * "Provider default" rather than as an error: a mock has no voices and that is
 * not a failure.
 */
export async function listVoiceOptions(deps: ACappellaHandlerDependencies): Promise<TtsVoice[]> {
	const resolution =
		sharedState.activePipeline ??
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
export async function previewVoiceLine(
	deps: ACappellaHandlerDependencies,
	callbacks: ProviderServiceCallbacks,
	text: string,
	voiceId?: string
): Promise<boolean> {
	const live = getVoiceSessionService();
	if (live && live.getState() !== 'idle') return false;

	if (deps.audioHostDeps) ensureAcappellaAudioHostWindow(deps.audioHostDeps);
	await ensureService(deps, callbacks);
	if (!sharedState.activePipeline || !sharedState.audioBridge) return false;

	const settings = readVoiceProviderSettings(deps.settingsStore);
	let spoke = false;
	for await (const chunk of sharedState.activePipeline.providers.tts.speak(text, {
		utteranceId: `preview-${Date.now()}`,
		// The caller may name a voice it has NOT selected. That is the point of a
		// per-voice preview: hearing a voice before committing to it beats
		// selecting each one in turn and undoing the ones you did not want.
		voiceId: voiceId ?? settings.voiceId,
		rate: settings.rate,
	})) {
		sharedState.audioBridge.handleSpeechChunk(chunk);
		spoke = spoke || Boolean(chunk.audio?.byteLength);
	}
	return spoke;
}

export function createProviderHandlers(
	deps: ACappellaHandlerDependencies,
	callbacks: ProviderServiceCallbacks
) {
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
		applyACappellaProvidersWithCallbacks(deps, callbacks)
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
			return previewVoiceLine(deps, callbacks, text, voiceId || undefined);
		}
	);

	return {
		wrappedListCredentials,
		wrappedSetCredential,
		wrappedValidateCredential,
		wrappedApplyProviders,
		wrappedListVoices,
		wrappedVoiceStudioStatus,
		wrappedPreviewVoice,
	};
}
