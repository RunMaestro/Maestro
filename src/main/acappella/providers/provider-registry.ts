/**
 * A Cappella provider registry - the one place that decides what a session runs
 * on.
 *
 * This is the ONLY module allowed to import a concrete provider. Everything
 * downstream takes a `VoicePipeline` at construction, so if resolution lived
 * anywhere else the rules below would be decided by an import rather than by a
 * policy.
 *
 * The rules, in full:
 *
 *   1. **A slot resolves to what was asked for, or to nothing.** There is no
 *      fallback engine. Not to the cloud, which would spend the user's money and
 *      send their microphone somewhere they did not choose; and not to the mock
 *      either, because a session that transcribes nothing while looking healthy
 *      hides the reason. An unbuildable slot becomes an `Unresolved*` provider
 *      that refuses BY NAME the first time it is used (see `./unresolved.ts`).
 *   2. **The mock tier is selected, never substituted.** It exists for tests and
 *      the dev harness, and it is what an unconfigured install runs on purpose.
 *      Nothing ever lands on it because something else was missing.
 *   3. **Exactly two pipeline shapes.** `CascadePipeline` (three independent
 *      engines) and `RealtimePipeline` (one fused speech-to-speech adapter). The
 *      choice is made here, once, and nothing downstream branches on it.
 *   4. **A swap is refused mid-utterance.** Changing providers while a turn is in
 *      flight would splice two engines into one exchange: a sentence transcribed
 *      by Whisper, routed by a model that never heard it, spoken in a different
 *      voice. The swap waits for the floor.
 *
 * The STT slot defaults to the microphone check in EVERY build. It consumes real
 * PCM and reports the speech it heard without transcribing it. That default used
 * to be the mock in a packaged app, which opened no device at all, so a user with
 * no configuration had a session that said "Listening" and could not possibly
 * hear them - and no way to tell that apart from a broken microphone.
 */

import type { BackgroundAnnouncementSetting } from '../../../shared/acappella/announcements';
import type { ProviderSlotState } from '../../../shared/acappella/protocol';
import { clampTtsVolume } from '../../../shared/acappella/voice-controls';
import {
	summariseVoiceEgress,
	OPENAI_REALTIME_PROVIDER_ID,
} from '../../../shared/acappella/provider-catalog';
import type {
	BrainProvider,
	SttProvider,
	TtsProvider,
	VoicePipeline,
	VoicePipelineShape,
	VoiceProviderRole,
	VoiceProviderSubstitution,
	VoiceProviderSubstitutionReason,
	VoiceProviderTier,
	VoiceProviderTrio,
} from '../../../shared/acappella/providers';
import { logger } from '../../utils/logger';
import { CascadePipeline } from './cascade-pipeline';
import { ECHO_STT_PROVIDER_ID, EchoSttProvider } from './echo-stt';
import { AnthropicBrainProvider } from './hosted/anthropic-brain';
import { ElevenLabsTtsProvider } from './hosted/elevenlabs-tts';
import { OpenAiBrainProvider } from './hosted/openai-brain';
import { OpenAiSttProvider } from './hosted/openai-stt';
import { KokoroTtsProvider } from './local/kokoro-tts';
import { LlamaBrainProvider } from './local/llama-brain';
import { WhisperSttProvider } from './local/whisper-stt';
import { MockBrainProvider, MockSttProvider, MockTtsProvider } from './mock';
import type { MockProviderOptions } from './mock';
import { createRealtimePipeline } from './realtime/realtime-session';
import {
	UnresolvedBrainProvider,
	UnresolvedSttProvider,
	UnresolvedTtsProvider,
	unresolvedMessage,
	type UnresolvedReason,
} from './unresolved';

const LOG_CONTEXT = 'ACappella';

/** Settings key holding everything A Cappella persists. */
export const ACAPPELLA_SETTINGS_KEY = 'acappella';

// Re-exported so existing importers keep their one import site. The shapes
// themselves live in shared/ because they travel to the renderer and, later, to
// the phone.
export type { VoiceProviderRole, VoiceProviderSubstitution, VoiceProviderSubstitutionReason };

/** The provider type each role resolves to. */
interface VoiceProviderByRole {
	stt: SttProvider;
	tts: TtsProvider;
	brain: BrainProvider;
}

/** What the user picked in Voice Setup. Absent means "whatever is default". */
export interface VoiceProviderSettings {
	stt?: string;
	tts?: string;
	brain?: string;
	/** Cascade unless the user opted into the realtime tier. */
	pipeline?: VoicePipelineShape;
	/** Which realtime provider, when the shape is `realtime`. */
	realtime?: string;
	/** Voice id for the TTS slot, when its provider offers a choice. */
	voiceId?: string;
	/** Speech rate. 1 is the provider's natural pace. */
	rate?: number;
	/** Output volume for the assistant's voice, 0 to 1. */
	volume?: number;
	/**
	 * Whether an agent finishing in the background is spoken about.
	 *
	 * Defaults to `auto`, which is on for the Conductor scope and off inside a
	 * focused agent session. See `src/shared/acappella/announcements.ts`.
	 */
	speakBackgroundCompletions?: BackgroundAnnouncementSetting;
	/**
	 * Which microphone to open. Undefined follows the system default.
	 *
	 * Deliberately NOT part of {@link pipelineKey}: changing the input device is
	 * not a provider change, and treating it as one would tear down and rebuild
	 * a loaded Whisper model to swap a headset.
	 */
	inputDeviceId?: string;
}

export interface VoiceProviderRegistration<R extends VoiceProviderRole = VoiceProviderRole> {
	role: R;
	/** Stable id, the same one that travels in `listen-start` / `speak-start`. */
	id: string;
	label: string;
	tier: VoiceProviderTier;
	/**
	 * False when the provider is registered but cannot run in this build at all
	 * (a development-only provider in a packaged app). It is deliberately NOT the
	 * place to check for a downloaded model or a stored key: that is the capability
	 * gate's job, and answering it here would mean two subsystems deciding
	 * readiness with two different answers.
	 */
	isAvailable?: () => boolean;
	create: (options: VoiceProviderCreateOptions) => VoiceProviderByRole[R];
}

/** What a factory is told about the configuration it is being built for. */
export interface VoiceProviderCreateOptions {
	settings: VoiceProviderSettings;
	/** Timing overrides for the mock tier, so tests can run without timers. */
	mock?: MockProviderOptions;
}

export interface VoiceProviderResolution {
	pipeline: VoicePipeline;
	shape: VoicePipelineShape;
	/** The trio the session service is handed. Same object for a realtime shape. */
	providers: VoiceProviderTrio;
	/** Empty on the happy path. Anything here belongs in front of the user. */
	substitutions: VoiceProviderSubstitution[];
	/** What each role actually resolved to, for the HUD and for `get-state`. */
	resolvedIds: Record<VoiceProviderRole, string>;
}

/** The mock tier's ids. Selected explicitly; never a fallback. */
export const MOCK_PROVIDER_IDS: Record<VoiceProviderRole, string> = {
	stt: 'mock-stt',
	tts: 'mock-tts',
	brain: 'mock-brain',
};

/**
 * What a role resolves to when the user has picked nothing.
 *
 * Identical to {@link MOCK_PROVIDER_IDS} except for STT, which defaults to the
 * microphone check. That default is deliberate: out of the box the one thing a
 * user needs to establish is that their microphone reaches the app, and a
 * default that cannot hear makes that impossible to tell from a broken device.
 */
export const DEFAULT_PROVIDER_IDS: Record<VoiceProviderRole, string> = {
	stt: ECHO_STT_PROVIDER_ID,
	tts: MOCK_PROVIDER_IDS.tts,
	brain: MOCK_PROVIDER_IDS.brain,
};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const catalog: { [R in VoiceProviderRole]: Map<string, VoiceProviderRegistration<R>> } = {
	stt: new Map(),
	tts: new Map(),
	brain: new Map(),
};

/**
 * Add a provider to the catalog. Exported so a later phase can register one
 * without this file learning about it.
 */
export function registerVoiceProvider<R extends VoiceProviderRole>(
	registration: VoiceProviderRegistration<R>
): void {
	catalog[registration.role].set(registration.id, registration);
}

/** Everything selectable for a role, for the settings panel to list. */
export function listVoiceProviders(
	role: VoiceProviderRole
): Array<Pick<VoiceProviderRegistration, 'id' | 'label' | 'tier'> & { available: boolean }> {
	return [...catalog[role].values()].map((entry) => ({
		id: entry.id,
		label: entry.label,
		tier: entry.tier,
		available: entry.isAvailable?.() ?? true,
	}));
}

// -- The mock tier ----------------------------------------------------------

registerVoiceProvider({
	role: 'stt',
	id: MOCK_PROVIDER_IDS.stt,
	label: 'Mock (typed input)',
	tier: 'mock',
	create: ({ mock }) => new MockSttProvider(mock?.stt),
});

registerVoiceProvider({
	role: 'stt',
	id: ECHO_STT_PROVIDER_ID,
	// Named for what it is FOR, not for the build it came from. It answers one
	// question - "is my microphone reaching Maestro at all?" - and the label has
	// to say it transcribes nothing, because a row called "Echo" that produces no
	// words reads as a broken recogniser rather than a working meter.
	label: 'Microphone check (no transcription)',
	tier: 'mock',
	// Available in EVERY build, deliberately. It used to be development-only, and
	// the result was a packaged app with no provider that consumes audio at all:
	// the microphone was never opened, the HUD said "Listening", and there was no
	// way to tell a dead device from a missing model from a wrong input. This is
	// the one provider that can answer that, so it ships.
	create: () => new EchoSttProvider(),
});

registerVoiceProvider({
	role: 'tts',
	id: MOCK_PROVIDER_IDS.tts,
	label: 'Mock (silent)',
	tier: 'mock',
	create: ({ mock }) => new MockTtsProvider(mock?.tts),
});

registerVoiceProvider({
	role: 'brain',
	id: MOCK_PROVIDER_IDS.brain,
	label: 'Mock (keyword routing)',
	tier: 'mock',
	create: () => new MockBrainProvider(),
});

// -- The local tier ---------------------------------------------------------

registerVoiceProvider({
	role: 'stt',
	id: 'whisper-local',
	label: 'Whisper (local)',
	tier: 'local',
	create: () => new WhisperSttProvider(),
});

registerVoiceProvider({
	role: 'tts',
	id: 'kokoro-local',
	label: 'Kokoro (local)',
	tier: 'local',
	// No voice id is threaded through: Kokoro ships exactly one voice pack in the
	// model catalog, and handing it an id chosen for ElevenLabs would point it at
	// a pack that was never downloaded.
	create: () => new KokoroTtsProvider(),
});

registerVoiceProvider({
	role: 'brain',
	id: 'qwen3-local',
	label: 'Qwen3 1.7B (local)',
	tier: 'local',
	create: () => new LlamaBrainProvider(),
});

// -- The hosted tier --------------------------------------------------------

registerVoiceProvider({
	role: 'stt',
	id: 'openai-stt',
	label: 'OpenAI (hosted)',
	tier: 'cloud',
	create: () => new OpenAiSttProvider(),
});

registerVoiceProvider({
	role: 'tts',
	id: 'elevenlabs-tts',
	label: 'ElevenLabs (hosted)',
	tier: 'cloud',
	create: ({ settings }) => new ElevenLabsTtsProvider({ voiceId: settings.voiceId }),
});

registerVoiceProvider({
	role: 'brain',
	id: 'openai-brain',
	label: 'OpenAI (hosted)',
	tier: 'cloud',
	create: () => new OpenAiBrainProvider(),
});

registerVoiceProvider({
	role: 'brain',
	id: 'anthropic-brain',
	label: 'Anthropic (hosted)',
	tier: 'cloud',
	create: () => new AnthropicBrainProvider(),
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveVoiceProvidersOptions {
	/** Provider ids from settings. Omitted roles take {@link DEFAULT_PROVIDER_IDS}. */
	settings?: VoiceProviderSettings;
	/** Timing overrides for the mock tier, so tests can run without timers. */
	mock?: MockProviderOptions;
}

/**
 * Build the pipeline a session will run on, plus anything the user has to be
 * told about it.
 */
export function resolveVoicePipeline(
	options: ResolveVoiceProvidersOptions = {}
): VoiceProviderResolution {
	const settings = options.settings ?? {};

	if (settings.pipeline === 'realtime') return resolveRealtime(settings);
	return resolveCascade(settings, options.mock);
}

/**
 * Backwards-compatible entry point: the trio only.
 *
 * Kept because the audio bridge and the tests care about the providers and not
 * about the pipeline that owns them, and a second call site rebuilding the whole
 * pipeline to read `.providers` would construct two of everything.
 */
export function resolveVoiceProviders(options: ResolveVoiceProvidersOptions = {}): {
	providers: VoiceProviderTrio;
	substitutions: VoiceProviderSubstitution[];
	resolvedIds: Record<VoiceProviderRole, string>;
} {
	const { providers, substitutions, resolvedIds } = resolveVoicePipeline(options);
	return { providers, substitutions, resolvedIds };
}

function resolveCascade(
	settings: VoiceProviderSettings,
	mock: MockProviderOptions | undefined
): VoiceProviderResolution {
	const substitutions: VoiceProviderSubstitution[] = [];
	const createOptions: VoiceProviderCreateOptions = { settings, mock };

	const stt = resolveRole('stt', settings.stt, substitutions, createOptions);
	const tts = resolveRole('tts', settings.tts, substitutions, createOptions);
	const brain = resolveRole('brain', settings.brain, substitutions, createOptions);

	const providers: VoiceProviderTrio = {
		stt: stt.provider,
		tts: tts.provider,
		brain: brain.provider,
	};

	return {
		pipeline: new CascadePipeline(providers),
		shape: 'cascade',
		providers,
		substitutions,
		resolvedIds: { stt: stt.id, tts: tts.id, brain: brain.id },
	};
}

/**
 * The realtime shape. One adapter fills all three slots, so there is nothing to
 * resolve per role and nothing that could be substituted per role either.
 */
function resolveRealtime(settings: VoiceProviderSettings): VoiceProviderResolution {
	const requestedId = settings.realtime ?? OPENAI_REALTIME_PROVIDER_ID;

	if (requestedId !== OPENAI_REALTIME_PROVIDER_ID) {
		// Exactly one realtime provider exists. An unknown one becomes three
		// refusing slots rather than quietly becoming the one that does exist.
		const substitutions: VoiceProviderSubstitution[] = [];
		const providers: VoiceProviderTrio = {
			stt: unresolved('stt', requestedId, 'unknown-provider', substitutions).provider,
			tts: unresolved('tts', requestedId, 'unknown-provider', substitutions).provider,
			brain: unresolved('brain', requestedId, 'unknown-provider', substitutions).provider,
		};
		return {
			pipeline: new CascadePipeline(providers),
			shape: 'cascade',
			providers,
			substitutions,
			resolvedIds: { stt: providers.stt.id, tts: providers.tts.id, brain: providers.brain.id },
		};
	}

	const pipeline = createRealtimePipeline({ voice: settings.voiceId });
	return {
		pipeline,
		shape: 'realtime',
		providers: pipeline.providers,
		substitutions: [],
		resolvedIds: {
			stt: OPENAI_REALTIME_PROVIDER_ID,
			tts: OPENAI_REALTIME_PROVIDER_ID,
			brain: OPENAI_REALTIME_PROVIDER_ID,
		},
	};
}

function resolveRole<R extends VoiceProviderRole>(
	role: R,
	requestedId: string | undefined,
	substitutions: VoiceProviderSubstitution[],
	createOptions: VoiceProviderCreateOptions
): { id: string; provider: VoiceProviderByRole[R] } {
	// No selection is the documented default, not a substitution: A Cappella ships
	// on the mock tier until the user picks something, with the one per-build
	// exception in DEFAULT_PROVIDER_IDS.
	const selectedId = requestedId ?? DEFAULT_PROVIDER_IDS[role];
	const registration = catalog[role].get(selectedId) as VoiceProviderRegistration<R> | undefined;

	if (!registration) {
		return unresolved(role, selectedId, 'unknown-provider', substitutions);
	}

	if (registration.isAvailable && !registration.isAvailable()) {
		// A DEFAULT this build cannot run falls back to the mock rather than
		// refusing something nobody chose - but it is REPORTED, which it did not
		// used to be. "Nobody asked for it, so say nothing" is how a packaged build
		// ended up on a text-only recogniser that opens no device: the session read
		// "Listening", the microphone was never touched, and the one fact that
		// explained it existed only in this function. Rule 2 above says the mock is
		// selected and never substituted; landing here IS a substitution, so it
		// travels like one.
		if (!requestedId) {
			const fallback = catalog[role].get(MOCK_PROVIDER_IDS[role]) as VoiceProviderRegistration<R>;
			const message = `${role.toUpperCase()}: '${selectedId}' cannot run in this build, so this slot fell back to '${fallback.id}'.`;
			logger.warn(message, LOG_CONTEXT);
			substitutions.push({
				role,
				requestedId: selectedId,
				resolvedId: fallback.id,
				reason: 'unavailable',
				message,
			});
			return { id: fallback.id, provider: fallback.create(createOptions) };
		}
		return unresolved(role, selectedId, 'unavailable', substitutions);
	}

	return { id: registration.id, provider: registration.create(createOptions) };
}

/**
 * Build the refusing provider for a slot and record why.
 *
 * The only path that does not construct what was asked for, and it deliberately
 * constructs nothing that WORKS: there is no lookup here that could land on
 * another engine.
 */
function unresolved<R extends VoiceProviderRole>(
	role: R,
	requestedId: string,
	reason: UnresolvedReason,
	substitutions: VoiceProviderSubstitution[]
): { id: string; provider: VoiceProviderByRole[R] } {
	const message = unresolvedMessage(role, requestedId, reason);
	logger.warn(message, LOG_CONTEXT);

	const provider = (role === 'stt'
		? new UnresolvedSttProvider(requestedId, reason)
		: role === 'tts'
			? new UnresolvedTtsProvider(requestedId, reason)
			: new UnresolvedBrainProvider(requestedId, reason)) as unknown as VoiceProviderByRole[R]; // cannot narrow a generic role parameter through it. // The ternary provably picks the right class for each `role`, but TypeScript

	substitutions.push({
		role,
		requestedId,
		resolvedId: provider.id,
		reason,
		message,
	});

	return { id: provider.id, provider };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Read the persisted provider selection. Anything malformed reads as unset. */
export function readVoiceProviderSettings(store: {
	get: (key: string, defaultValue: unknown) => unknown;
}): VoiceProviderSettings {
	const stored = store.get(ACAPPELLA_SETTINGS_KEY, {}) as
		| {
				providers?: unknown;
				pipeline?: unknown;
				voice?: unknown;
				speech?: unknown;
				audio?: unknown;
		  }
		| undefined;
	const providers = (stored?.providers ?? {}) as Record<string, unknown>;
	const voice = (stored?.voice ?? {}) as Record<string, unknown>;
	const speech = (stored?.speech ?? {}) as Record<string, unknown>;
	const audio = (stored?.audio ?? {}) as Record<string, unknown>;

	return {
		speakBackgroundCompletions: asAnnouncementSetting(speech.speakBackgroundCompletions),
		inputDeviceId: asProviderId(audio.inputDeviceId),
		stt: asProviderId(providers.stt),
		tts: asProviderId(providers.tts),
		brain: asProviderId(providers.brain),
		pipeline: stored?.pipeline === 'realtime' ? 'realtime' : 'cascade',
		realtime: asProviderId(providers.realtime),
		voiceId: asProviderId(voice.voiceId),
		rate: typeof voice.rate === 'number' && voice.rate > 0 ? voice.rate : undefined,
		// Clamped rather than passed through: this number becomes a gain on a live
		// output node, and a stored NaN or a 40 from a hand-edited settings file
		// would be a burst of distortion in the user's headphones.
		volume: clampTtsVolume(voice.volume),
	};
}

/**
 * A stable identity for a selection, so a caller can tell whether the live
 * pipeline still matches settings without rebuilding it to find out.
 */
export function pipelineKey(settings: VoiceProviderSettings): string {
	return [
		settings.pipeline ?? 'cascade',
		settings.realtime ?? '',
		settings.stt ?? '',
		settings.tts ?? '',
		settings.brain ?? '',
		settings.voiceId ?? '',
		settings.rate ?? '',
	].join('|');
}

function asProviderId(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Anything unrecognised reads as unset, which resolves to the scope default. */
function asAnnouncementSetting(value: unknown): BackgroundAnnouncementSetting | undefined {
	return value === 'on' || value === 'off' || value === 'auto' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Provider state
// ---------------------------------------------------------------------------

/** The `provider-state` event body for a resolution. */
export function buildProviderState(resolution: VoiceProviderResolution): {
	pipeline: VoicePipelineShape;
	slots: ProviderSlotState[];
	egressStatement: string;
	audioLeavesMachine: boolean;
} {
	const roles: VoiceProviderRole[] = ['stt', 'tts', 'brain'];
	const substitutionByRole = new Map(resolution.substitutions.map((entry) => [entry.role, entry]));

	const slots: ProviderSlotState[] = roles.map((role) => {
		const provider = resolution.providers[role];
		return {
			role,
			providerId: provider.id,
			label: provider.label,
			tier: provider.tier,
			substitutedFor: substitutionByRole.get(role)?.requestedId,
			// Read off the resolved provider rather than inferred from its id or
			// tier: whether a recogniser consumes PCM is its own declaration, and a
			// list of "ids that hear" here would drift the first time one is added.
			hearsAudio: role === 'stt' ? resolution.providers.stt.acceptsAudio : undefined,
		};
	});

	// Computed from what RESOLVED, not from what was configured: a slot that fell
	// through to a refusing provider sends nothing anywhere, and saying otherwise
	// would be the one sentence in this feature that must never be wrong.
	const egress = summariseVoiceEgress(slots.map((slot) => slot.providerId));

	return {
		pipeline: resolution.shape,
		slots,
		egressStatement: egress.statement,
		audioLeavesMachine: egress.audioLeaves,
	};
}

// ---------------------------------------------------------------------------
// Hot swap
// ---------------------------------------------------------------------------

export type PipelineSwapStatus = 'swapped' | 'unchanged' | 'refused';

export interface PipelineSwapResult {
	status: PipelineSwapStatus;
	/** Present when the swap happened. */
	resolution?: VoiceProviderResolution;
	/** Present when refused, written for the user. */
	reason?: string;
}

export interface PipelineSwapRequest {
	settings: VoiceProviderSettings;
	/** The live pipeline and the key it was built from, or null on first build. */
	current: { pipeline: VoicePipeline; key: string } | null;
	/**
	 * True while a turn is in flight. A swap is refused rather than queued: the
	 * user is mid-sentence, and the honest answer is "not now", not a silent change
	 * of voice halfway through a reply.
	 */
	isBusy: boolean;
	mock?: MockProviderOptions;
}

/**
 * Apply a settings change to the live pipeline.
 *
 * Tears the old one down BEFORE returning the new one, so two llama contexts are
 * never resident at the same time; a swap on a machine that could only just fit
 * one model would otherwise fail by running out of memory rather than by saying
 * no.
 */
export async function swapVoicePipeline(request: PipelineSwapRequest): Promise<PipelineSwapResult> {
	const key = pipelineKey(request.settings);
	if (request.current && request.current.key === key) return { status: 'unchanged' };

	if (request.isBusy) {
		return {
			status: 'refused',
			reason:
				'Voice providers cannot change in the middle of a turn. Finish speaking, then try again.',
		};
	}

	await request.current?.pipeline.dispose();
	return {
		status: 'swapped',
		resolution: resolveVoicePipeline({ settings: request.settings, mock: request.mock }),
	};
}
