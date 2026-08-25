/**
 * A Cappella provider catalog - every engine a slot can be pointed at, and what
 * each one costs the user in downloads, keys, and privacy.
 *
 * This table exists because the same four facts about a provider were about to
 * be written down in four places: the capability gate (what does this need before
 * it can run), the provider registry (what do I construct), the credential layer
 * (whose key is this), and the settings panel (what do I tell the user). Four
 * copies of "elevenlabs-tts needs an ElevenLabs key" is four chances for a build
 * where the gate blocks a slot the panel says is fine.
 *
 * It is deliberately DATA and deliberately `shared/`. The registry cannot own it
 * (the renderer must not import main-process code, and the previous settings hook
 * had already copied the id strings as literals to work around exactly that), and
 * the capability gate cannot own it either, because it reaches for `electron` and
 * the model store the moment it is imported.
 *
 * The one fact this table makes unavoidable: **`egress` is declared per provider,
 * so "where does my audio go" is computed from the user's actual selection rather
 * than written into copy that can drift.** See {@link summariseVoiceEgress}.
 */

import { KOKORO_82M_ID, QWEN3_1_7B_ID, WHISPER_BASE_EN_ID } from './model-catalog';
import type { NativeRuntimeId } from './native-runtimes';
import type { VoiceProviderRole, VoiceProviderTier } from './providers';

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** A service Maestro can hold an API key for. One keychain entry per service. */
export type VoiceCredentialService = 'openai' | 'elevenlabs' | 'anthropic';

export const VOICE_CREDENTIAL_SERVICES: readonly VoiceCredentialService[] = Object.freeze([
	'openai',
	'elevenlabs',
	'anthropic',
]);

export interface VoiceCredentialDescriptor {
	readonly service: VoiceCredentialService;
	/** How the service is named in front of the user. */
	readonly label: string;
	/**
	 * Prefix a real key for this service starts with, or null when the service
	 * does not use one. Used ONLY to catch a pasted-the-wrong-thing mistake before
	 * a network call; it is never a substitute for the validation request, because
	 * a well-formed key can still be revoked.
	 */
	readonly keyPrefix: string | null;
	/** Where the user gets one. Rendered as a link next to the key field. */
	readonly consoleUrl: string;
}

export const VOICE_CREDENTIALS: Readonly<
	Record<VoiceCredentialService, VoiceCredentialDescriptor>
> = Object.freeze({
	openai: Object.freeze({
		service: 'openai' as const,
		label: 'OpenAI',
		keyPrefix: 'sk-',
		consoleUrl: 'https://platform.openai.com/api-keys',
	}),
	elevenlabs: Object.freeze({
		service: 'elevenlabs' as const,
		label: 'ElevenLabs',
		// ElevenLabs keys are a bare hex-ish string with no stable prefix, and
		// guessing one would reject valid keys.
		keyPrefix: null,
		consoleUrl: 'https://elevenlabs.io/app/settings/api-keys',
	}),
	anthropic: Object.freeze({
		service: 'anthropic' as const,
		label: 'Anthropic',
		keyPrefix: 'sk-ant-',
		consoleUrl: 'https://console.anthropic.com/settings/keys',
	}),
});

export function credentialLabel(service: VoiceCredentialService): string {
	return VOICE_CREDENTIALS[service].label;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** What a provider needs before it can run at all. */
export type VoiceProviderRequirement =
	| { readonly kind: 'none' }
	| { readonly kind: 'model'; readonly modelId: string; readonly runtimeId: NativeRuntimeId }
	| { readonly kind: 'api-key'; readonly service: VoiceCredentialService };

/**
 * What leaves this machine when a provider runs.
 *
 * `audio` implies `text`: a service that receives the samples also receives the
 * words. Ordered so a summary can take the maximum across a selection.
 */
export type VoiceDataEgress = 'none' | 'text' | 'audio';

/**
 * A slot a provider can fill. `realtime` is not one of the three seams: it is the
 * fused speech-to-speech tier, which fills all three at once.
 */
export type VoiceProviderSlotKind = VoiceProviderRole | 'realtime';

export interface VoiceProviderDescriptor {
	readonly id: string;
	readonly role: VoiceProviderSlotKind;
	readonly label: string;
	readonly tier: VoiceProviderTier;
	readonly requires: VoiceProviderRequirement;
	readonly egress: VoiceDataEgress;
	/** The service that receives the egress, or null when nothing leaves. */
	readonly egressService: VoiceCredentialService | null;
	/** One sentence for the slot selector. */
	readonly description: string;
}

// -- Ids, exported so nothing has to spell one twice ------------------------

export const LOCAL_STT_PROVIDER_ID = 'whisper-local';
export const LOCAL_TTS_PROVIDER_ID = 'kokoro-local';
export const LOCAL_BRAIN_PROVIDER_ID = 'qwen3-local';

/**
 * The Conductor run as a real Maestro agent rather than as a classifier.
 *
 * `local` tier because it runs whichever agent the user already configured, on
 * their own machine (or their own SSH remote): the egress is whatever that agent
 * was already doing, not a new destination this feature chose for them.
 */
export const CONDUCTOR_AGENT_BRAIN_PROVIDER_ID = 'conductor-agent';

export const OPENAI_STT_PROVIDER_ID = 'openai-stt';
export const OPENAI_BRAIN_PROVIDER_ID = 'openai-brain';
export const ANTHROPIC_BRAIN_PROVIDER_ID = 'anthropic-brain';
export const ELEVENLABS_TTS_PROVIDER_ID = 'elevenlabs-tts';

export const OPENAI_REALTIME_PROVIDER_ID = 'openai-realtime';

/** The local trio, by role. Read by the capability gate and by Voice Setup. */
export const LOCAL_PROVIDER_IDS: Readonly<Record<VoiceProviderRole, string>> = Object.freeze({
	stt: LOCAL_STT_PROVIDER_ID,
	tts: LOCAL_TTS_PROVIDER_ID,
	brain: LOCAL_BRAIN_PROVIDER_ID,
});

/**
 * The hosted provider each role defaults to when a user switches a slot to
 * "hosted" without naming one. A default, never a fallback: nothing resolves to
 * these because something else was missing.
 */
export const HOSTED_PROVIDER_IDS: Readonly<Record<VoiceProviderRole, string>> = Object.freeze({
	stt: OPENAI_STT_PROVIDER_ID,
	tts: ELEVENLABS_TTS_PROVIDER_ID,
	brain: OPENAI_BRAIN_PROVIDER_ID,
});

function defineProvider(descriptor: VoiceProviderDescriptor): VoiceProviderDescriptor {
	return Object.freeze({ ...descriptor, requires: Object.freeze(descriptor.requires) });
}

/**
 * Every provider, in the order a slot selector lists them: mock tier first (it is
 * what an unconfigured install runs), then local, then hosted.
 */
export const VOICE_PROVIDER_CATALOG: readonly VoiceProviderDescriptor[] = Object.freeze([
	// -- Speech to text ------------------------------------------------------
	defineProvider({
		id: 'mock-stt',
		role: 'stt',
		label: 'Mock (typed input)',
		tier: 'mock',
		requires: { kind: 'none' },
		egress: 'none',
		egressService: null,
		description: 'Text in, transcript out. Opens no microphone and needs no model.',
	}),
	defineProvider({
		id: 'echo-stt',
		role: 'stt',
		label: 'Echo (development)',
		tier: 'mock',
		requires: { kind: 'none' },
		egress: 'none',
		egressService: null,
		description: 'Hears audio and reports how much of it was speech. Development builds only.',
	}),
	defineProvider({
		id: LOCAL_STT_PROVIDER_ID,
		role: 'stt',
		label: 'Whisper (local)',
		tier: 'local',
		requires: { kind: 'model', modelId: WHISPER_BASE_EN_ID, runtimeId: 'whisper' },
		egress: 'none',
		egressService: null,
		description: 'Transcribes on this machine. No audio leaves it.',
	}),
	defineProvider({
		id: OPENAI_STT_PROVIDER_ID,
		role: 'stt',
		label: 'OpenAI (hosted)',
		tier: 'cloud',
		requires: { kind: 'api-key', service: 'openai' },
		egress: 'audio',
		egressService: 'openai',
		description: 'Streams your speech to OpenAI for transcription. Needs an OpenAI key.',
	}),

	// -- Text to speech ------------------------------------------------------
	defineProvider({
		id: 'mock-tts',
		role: 'tts',
		label: 'Mock (silent)',
		tier: 'mock',
		requires: { kind: 'none' },
		egress: 'none',
		egressService: null,
		description: 'Emits the sentences it would speak, with no audio behind them.',
	}),
	defineProvider({
		id: LOCAL_TTS_PROVIDER_ID,
		role: 'tts',
		label: 'Kokoro (local)',
		tier: 'local',
		requires: { kind: 'model', modelId: KOKORO_82M_ID, runtimeId: 'onnx' },
		egress: 'none',
		egressService: null,
		description: 'Synthesises replies on this machine.',
	}),
	defineProvider({
		id: ELEVENLABS_TTS_PROVIDER_ID,
		role: 'tts',
		label: 'ElevenLabs (hosted)',
		tier: 'cloud',
		requires: { kind: 'api-key', service: 'elevenlabs' },
		egress: 'text',
		egressService: 'elevenlabs',
		description: 'Streams replies back as speech. The reply text is sent to ElevenLabs.',
	}),

	// -- Brain ---------------------------------------------------------------
	defineProvider({
		id: 'mock-brain',
		role: 'brain',
		label: 'Mock (keyword routing)',
		tier: 'mock',
		requires: { kind: 'none' },
		egress: 'none',
		egressService: null,
		description: 'Deterministic keyword routing. No model, no network.',
	}),
	defineProvider({
		id: LOCAL_BRAIN_PROVIDER_ID,
		role: 'brain',
		label: 'Qwen3 1.7B (local)',
		tier: 'local',
		requires: { kind: 'model', modelId: QWEN3_1_7B_ID, runtimeId: 'llama' },
		egress: 'none',
		egressService: null,
		description: 'Routes and rewrites on this machine.',
	}),
	defineProvider({
		id: OPENAI_BRAIN_PROVIDER_ID,
		role: 'brain',
		label: 'OpenAI (hosted)',
		tier: 'cloud',
		requires: { kind: 'api-key', service: 'openai' },
		egress: 'text',
		egressService: 'openai',
		description: 'Routes with a fast API model. Your transcripts are sent to OpenAI.',
	}),
	defineProvider({
		id: ANTHROPIC_BRAIN_PROVIDER_ID,
		role: 'brain',
		label: 'Anthropic (hosted)',
		tier: 'cloud',
		requires: { kind: 'api-key', service: 'anthropic' },
		egress: 'text',
		egressService: 'anthropic',
		description: 'Routes with a fast Claude model. Your transcripts are sent to Anthropic.',
	}),
	// The Conductor agent brain is NOT listed here on purpose. `ConductorAgentBrain`
	// exists (`main/acappella/router/conductor-agent.ts`) but nothing constructs it:
	// `provider-registry.ts` registers no factory for the id, and it could not, because
	// the class needs a process manager, an agent detector, and a cwd that
	// `VoiceProviderCreateOptions` does not carry. This table is what the slot selector
	// renders, so listing it put a permanently dead choice in the dropdown - picking it
	// made `resolveRole` refuse EVERY session with `unknown-provider`, which reads as
	// "voice is broken" rather than "that option is not wired yet".
	//
	// It comes back in the same commit that registers the factory and threads those
	// dependencies through the IPC layer. Until then the id stays exported for the
	// class and its tests.

	// -- Realtime ------------------------------------------------------------
	defineProvider({
		id: OPENAI_REALTIME_PROVIDER_ID,
		role: 'realtime',
		label: 'OpenAI Realtime',
		tier: 'cloud',
		requires: { kind: 'api-key', service: 'openai' },
		egress: 'audio',
		egressService: 'openai',
		description:
			'Speech to speech in one hop. Lowest latency, but it speaks in the OpenAI voice and your audio goes to their servers.',
	}),
]);

const CATALOG_BY_ID = new Map(VOICE_PROVIDER_CATALOG.map((entry) => [entry.id, entry]));

export function getVoiceProvider(id: string): VoiceProviderDescriptor | undefined {
	return CATALOG_BY_ID.get(id);
}

/** Every provider that can fill a slot, in catalog order. */
export function voiceProvidersForRole(role: VoiceProviderSlotKind): VoiceProviderDescriptor[] {
	return VOICE_PROVIDER_CATALOG.filter((entry) => entry.role === role);
}

/** The requirement for a provider id. An unknown id needs nothing, like the mocks. */
export function voiceProviderRequirement(id: string): VoiceProviderRequirement {
	return CATALOG_BY_ID.get(id)?.requires ?? { kind: 'none' };
}

/** The credential a provider needs, or null when it needs none. */
export function voiceProviderCredential(id: string): VoiceCredentialService | null {
	const requires = voiceProviderRequirement(id);
	return requires.kind === 'api-key' ? requires.service : null;
}

// ---------------------------------------------------------------------------
// Privacy summary
// ---------------------------------------------------------------------------

export interface VoiceEgressSummary {
	/** True when the microphone's samples reach a service. */
	audioLeaves: boolean;
	/** True when transcripts or replies reach a service, audio aside. */
	textLeaves: boolean;
	/** Every service involved, deduped, in the order the slots were given. */
	services: VoiceCredentialService[];
	/**
	 * The sentence to show the user. One fact, stated plainly, because it is the
	 * single thing a person needs to know about a voice configuration and the one
	 * they should never have to infer from a list of provider names.
	 */
	statement: string;
}

const EGRESS_RANK: Record<VoiceDataEgress, number> = { none: 0, text: 1, audio: 2 };

/**
 * Where a given set of providers sends what.
 *
 * Takes ids rather than a role map so it works for both pipeline shapes: the
 * cascade passes its three, and the realtime tier passes its one.
 */
export function summariseVoiceEgress(providerIds: readonly string[]): VoiceEgressSummary {
	let audioLeaves = false;
	let textLeaves = false;
	const services: VoiceCredentialService[] = [];

	for (const id of providerIds) {
		const entry = CATALOG_BY_ID.get(id);
		if (!entry || entry.egress === 'none') continue;
		if (EGRESS_RANK[entry.egress] >= EGRESS_RANK.audio) audioLeaves = true;
		else textLeaves = true;
		if (entry.egressService && !services.includes(entry.egressService)) {
			services.push(entry.egressService);
		}
	}

	return {
		audioLeaves,
		textLeaves,
		services,
		statement: egressStatement(audioLeaves, textLeaves, services),
	};
}

function egressStatement(
	audioLeaves: boolean,
	textLeaves: boolean,
	services: VoiceCredentialService[]
): string {
	if (!audioLeaves && !textLeaves) return 'Audio stays on this machine.';

	const names = formatServiceList(services);
	if (audioLeaves) return `Audio is sent to ${names}.`;
	return `Audio stays on this machine. Text is sent to ${names}.`;
}

function formatServiceList(services: VoiceCredentialService[]): string {
	const labels = services.map(credentialLabel);
	if (labels.length <= 1) return labels[0] ?? 'a hosted service';
	if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
	return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}
