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

import { WHISPER_BASE_EN_ID } from './model-catalog';
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

/**
 * What a provider needs before it can run at all.
 *
 * `system-voice` is the operating system's speech engine: present on macOS and
 * Windows by construction, and on Linux only when `espeak-ng` is installed. The
 * gate checks it so a machine without one refuses before the microphone opens
 * rather than on the first reply.
 */
export type VoiceProviderRequirement =
	| { readonly kind: 'none' }
	| { readonly kind: 'system-voice' }
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

/**
 * The operating system's own voice: `say`, System.Speech, or `espeak-ng`.
 *
 * The local Text-to-Speech DEFAULT, and the reason it is the default rather
 * than the downloaded neural voice is that the neural voice cannot speak yet
 * (see {@link KOKORO_TTS_PROVIDER_ID}). This one needs no download and no key,
 * and nothing leaves the machine, so "enable the feature and talk" is true on
 * every desktop Maestro ships on.
 */
export const SYSTEM_TTS_PROVIDER_ID = 'system-tts';

/**
 * Kokoro, the downloadable neural voice. Registered and runnable in code, but
 * NOT listed in the catalog below: it takes phoneme ids, and the
 * grapheme-to-phoneme front end it needs is not part of this build, so choosing
 * it refused every reply. It returns to the list in the commit that ships the
 * front end. The id stays exported for the provider class and its tests.
 */
export const KOKORO_TTS_PROVIDER_ID = 'kokoro-local';

/**
 * The built-in keyword router: no model, no network, deterministic.
 *
 * The Conductor Brain DEFAULT. It picks the agent by name, falls back to the
 * agent the session is bound to, and reads the first sentences of a reply back
 * unchanged. The id is the one the mock tier has always used, kept so an
 * existing settings file resolves to the same engine it did before; the LABEL
 * says what it does rather than what test it was written for.
 */
export const BUILTIN_BRAIN_PROVIDER_ID = 'mock-brain';

/**
 * Qwen3 through llama.cpp. Registered and runnable in code, but NOT listed in
 * the catalog below: the runtime payload it downloads carries only the native
 * binary, and the JavaScript half of `node-llama-cpp` (28 packages) is neither
 * bundled nor fetched, so the model could not be opened on any machine. It
 * returns to the list with the commit that ships that runtime properly.
 */
export const QWEN3_BRAIN_PROVIDER_ID = 'qwen3-local';

/**
 * The Conductor run as a real Maestro agent rather than as a classifier.
 *
 * `local` tier because it runs whichever agent the user already configured, on
 * their own machine (or their own SSH remote): the egress is whatever that agent
 * was already doing, not a new destination this feature chose for them.
 */
export const CONDUCTOR_AGENT_BRAIN_PROVIDER_ID = 'conductor-agent';

export const OPENAI_STT_PROVIDER_ID = 'openai-stt';
export const OPENAI_TTS_PROVIDER_ID = 'openai-tts';
export const OPENAI_BRAIN_PROVIDER_ID = 'openai-brain';
export const ANTHROPIC_BRAIN_PROVIDER_ID = 'anthropic-brain';
export const ELEVENLABS_TTS_PROVIDER_ID = 'elevenlabs-tts';

export const OPENAI_REALTIME_PROVIDER_ID = 'openai-realtime';

/**
 * The local trio, by role. Read by the capability gate and by Voice Setup.
 *
 * Also the DEFAULT trio: what an unconfigured install runs. Speech-to-text is
 * the one slot that needs a download (Whisper plus the ONNX runtime, fetched on
 * consent through Voice Setup); the voice and the router need nothing, so a
 * fresh install can speak and route the moment the recogniser is on disk.
 */
export const LOCAL_PROVIDER_IDS: Readonly<Record<VoiceProviderRole, string>> = Object.freeze({
	stt: LOCAL_STT_PROVIDER_ID,
	tts: SYSTEM_TTS_PROVIDER_ID,
	brain: BUILTIN_BRAIN_PROVIDER_ID,
});

/**
 * The hosted provider each role defaults to when a user switches a slot to
 * "hosted" without naming one. A default, never a fallback: nothing resolves to
 * these because something else was missing.
 *
 * All three are OpenAI on purpose: one key, one account, a whole hosted trio.
 * ElevenLabs stays a pick in the Text-to-Speech dropdown for anyone who wants
 * its voices.
 */
export const HOSTED_PROVIDER_IDS: Readonly<Record<VoiceProviderRole, string>> = Object.freeze({
	stt: OPENAI_STT_PROVIDER_ID,
	tts: OPENAI_TTS_PROVIDER_ID,
	brain: OPENAI_BRAIN_PROVIDER_ID,
});

function defineProvider(descriptor: VoiceProviderDescriptor): VoiceProviderDescriptor {
	return Object.freeze({ ...descriptor, requires: Object.freeze(descriptor.requires) });
}

/**
 * Every provider a user can pick, in the order a slot selector lists them: the
 * text-in and diagnostic providers first, then local, then hosted.
 *
 * A provider that exists in code but cannot run in this build is left OUT of
 * this list rather than listed and refused: this table is what the dropdown
 * renders, and a choice that refuses every session reads as "voice is broken"
 * rather than "not wired yet". Each omission is noted where it would sit.
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
		requires: { kind: 'model', modelId: WHISPER_BASE_EN_ID, runtimeId: 'onnx' },
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
		id: SYSTEM_TTS_PROVIDER_ID,
		role: 'tts',
		label: 'System voice (built in)',
		tier: 'local',
		requires: { kind: 'system-voice' },
		egress: 'none',
		egressService: null,
		description:
			"Speaks with your computer's own voice. Nothing to download, and nothing leaves this machine.",
	}),
	// Kokoro (`kokoro-local`) is NOT listed on purpose. See KOKORO_TTS_PROVIDER_ID:
	// it needs a phoneme front end this build does not have, so listing it put a
	// choice in the dropdown that refused every reply. The model stays in the
	// model catalog so an existing download can be seen and removed.
	defineProvider({
		id: OPENAI_TTS_PROVIDER_ID,
		role: 'tts',
		label: 'OpenAI (hosted)',
		tier: 'cloud',
		requires: { kind: 'api-key', service: 'openai' },
		egress: 'text',
		egressService: 'openai',
		description: 'Speaks replies in an OpenAI voice. The reply text is sent to OpenAI.',
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
		id: BUILTIN_BRAIN_PROVIDER_ID,
		role: 'brain',
		label: 'Built-in (keyword routing)',
		tier: 'mock',
		requires: { kind: 'none' },
		egress: 'none',
		egressService: null,
		description:
			'Picks the agent by name, or the one you are talking to, and reads replies back as written. No model, no network.',
	}),
	// Qwen3 (`qwen3-local`) is NOT listed on purpose. See QWEN3_BRAIN_PROVIDER_ID:
	// its runtime payload cannot be imported on any machine yet, so listing it
	// put a choice in the dropdown that could never route.
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
