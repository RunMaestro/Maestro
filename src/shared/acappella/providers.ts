/**
 * A Cappella provider interfaces - the three seams every speech tier plugs into.
 *
 * The session service never imports a concrete provider; it takes a trio at
 * construction. That is what lets the cascade tier (independent STT / Brain /
 * TTS, individually swappable) and the realtime speech-to-speech tier (one
 * provider wearing all three hats as a fused adapter) look identical from the
 * service's side.
 *
 * See docs/architecture/acappella/system-overview.md, "Provider tiers".
 */

import type { RosterAgent, VoiceScope } from './protocol';
import type { RouteDecision } from './route-decision';

/**
 * Where a provider runs. The registry uses this to enforce the rule that a
 * cloud provider is NEVER silently substituted for a missing local one.
 *
 * `unresolved` is the slot that could not be built at all. It is a tier of its
 * own rather than being folded into `mock` because those two are opposites: the
 * mock is a working tier somebody chose, and an unresolved slot is a refusal.
 * Reporting a refusal as a mock is how a broken configuration ends up looking
 * like a healthy session that happens to say nothing.
 */
export type VoiceProviderTier = 'mock' | 'local' | 'cloud' | 'unresolved';

export interface VoiceProviderInfo {
	/** Stable id carried in the protocol (`mock-stt`, `whisper-local`, ...). */
	readonly id: string;
	/** Human label for the HUD and Voice Setup. */
	readonly label: string;
	readonly tier: VoiceProviderTier;
}

/** The three seams a trio is resolved for. */
export type VoiceProviderRole = 'stt' | 'tts' | 'brain';

/**
 * Why a role is not running what the settings asked for. `not-configured` is
 * the ordinary default path and is deliberately absent: shipping on the mock
 * tier until the user picks something is documented behaviour, not a downgrade.
 */
export type VoiceProviderSubstitutionReason = 'unknown-provider' | 'unavailable';

/**
 * A role that fell back to the mock tier. Lives in `shared/` rather than beside
 * the registry because it travels to every client: `acappella:start-session`
 * returns these so the HUD can say "you are on the mock", which is the whole
 * point of the registry's never-silent rule.
 */
export interface VoiceProviderSubstitution {
	role: VoiceProviderRole;
	requestedId: string;
	resolvedId: string;
	reason: VoiceProviderSubstitutionReason;
	message: string;
}

// ---------------------------------------------------------------------------
// Speech to text
// ---------------------------------------------------------------------------

export interface SttCallbacks {
	/** `text` is the full hypothesis so far, not a delta. `stability` is 0 to 1. */
	onPartial(text: string, stability: number): void;
	onFinal(text: string, confidence: number, durationMs?: number): void;
	/** Known, classified failures only. Anything else should throw and reach Sentry. */
	onError(error: Error): void;
}

export interface SttProvider extends VoiceProviderInfo {
	/** Sample rate `feed()` expects, in Hz. */
	readonly sampleRate: number;
	/**
	 * Whether this provider transcribes audio at all.
	 *
	 * False is the text-only tier: the mock, and a client that did its own
	 * transcription. It is the flag the audio path reads before opening a
	 * microphone, and it exists so the answer is a property of the provider rather
	 * than a list of ids somewhere else. Opening a capture device for a provider
	 * that cannot hear would cost the user an OS permission prompt in exchange for
	 * a level meter over a transcript that is never coming.
	 */
	readonly acceptsAudio: boolean;
	/**
	 * Whether this provider's transcripts are WORDS SOMEONE SAID.
	 *
	 * Absent means true, which is what every real recogniser is. False is the
	 * diagnostic case: a provider that genuinely hears audio but reports a
	 * MEASUREMENT rather than speech (the microphone check reports how long you
	 * talked for). That output is real, useful information - it proves the device,
	 * the capture graph, and the endpointer all work - but nobody said it, so
	 * routing it to an agent would send a live model a sentence no human uttered
	 * and bill the user for the reply.
	 */
	readonly transcribesSpeech?: boolean;
	/** Acquire the device or session. Throws when the provider cannot start. */
	start(callbacks: SttCallbacks): Promise<void>;
	/** Push one buffer of 16-bit mono PCM at `sampleRate`. */
	feed(pcm: Int16Array): void;
	/** Force endpointing of the current utterance. */
	flush(): Promise<void>;
	stop(): Promise<void>;
	/**
	 * Text-in seam for providers with no audio path: the dev harness, and a
	 * client that did its own transcription (on-device iPhone dictation). It
	 * lands on exactly the same callbacks as audio, so nothing downstream can
	 * tell the difference. Audio-only providers omit it.
	 */
	injectUtterance?(text: string): void;
}

// ---------------------------------------------------------------------------
// Brain
// ---------------------------------------------------------------------------

export interface VoiceRouteContext {
	/** The routing context: every agent and its tabs. */
	roster: RosterAgent[];
	/** What the session is bound to. An agent scope biases routing toward it. */
	scope: VoiceScope;
	/** Agent the user is looking at, when a client reported one. */
	activeAgentSessionId?: string | null;
	/** Most recent utterances this session, oldest first, for "back to" style references. */
	recentUtterances?: string[];
	/**
	 * The turn the user is answering.
	 *
	 * Set on the turn AFTER the router asked a disambiguation out loud, so the
	 * model sees the original request and the question alongside the answer. Its
	 * absence is what makes "the API one" an ordinary utterance rather than a
	 * fragment routed on its own, which is how a two-word reply ends up creating a
	 * tab called "the API one".
	 */
	clarification?: {
		/** What the router asked. */
		question: string;
		/** The utterance the question was about. */
		utterance: string;
	};
	/**
	 * Why the previous attempt at this same utterance was rejected.
	 *
	 * Set only on a constrained retry. Telling the model what was wrong is the
	 * difference between a retry and the same wrong answer at the same
	 * temperature: routing runs deterministic, so an unchanged prompt returns an
	 * unchanged decision.
	 */
	retryNotes?: string[];
}

export interface VoiceConverseContext {
	/** The agent whose text is being reshaped. */
	agentSessionId: string;
	tabId: string;
	/** Rough budget for the spoken form. Reading a diff aloud is useless. */
	maxSentences?: number;
	/**
	 * What was actually said out loud earlier in this conversation, oldest first.
	 *
	 * Carried so a spoken reply can refer back ("like I said about the token
	 * check") rather than re-explaining, and so the second chunk of one long agent
	 * answer does not repeat the headline the first chunk already delivered. It is
	 * deliberately what the user HEARD, not what the agent wrote: a sentence that
	 * was queued and then cut off by a barge-in never happened as far as the
	 * listener is concerned, and a model told otherwise would refer back to
	 * something nobody said.
	 */
	recentSpoken?: string[];
	/**
	 * Abort the rewrite. Set when a barge-in cancels the turn mid-stream, so a
	 * hosted call for speech nobody will hear is dropped rather than paid for.
	 */
	signal?: AbortSignal;
}

export interface BrainProvider extends VoiceProviderInfo {
	/** Resolve an utterance into a target, a tab action, and a prompt. */
	route(input: string, context: VoiceRouteContext): Promise<RouteDecision>;
	/** Reshape an agent's terminal-shaped answer into spoken-form text. */
	converse(agentText: string, context: VoiceConverseContext): Promise<string>;
	/**
	 * The same rewrite, delivered as it is written.
	 *
	 * Optional because it is a latency optimisation, not a capability: a provider
	 * without it is driven through `converse()` and the whole rewrite arrives at
	 * once. The chunks are raw text deltas, NOT sentences - the caller owns
	 * segmentation, because `src/shared/acappella/sentences.ts` is the one splitter
	 * every side of the protocol has to agree with.
	 */
	converseStream?(agentText: string, context: VoiceConverseContext): AsyncIterable<string>;
}

// ---------------------------------------------------------------------------
// Text to speech
// ---------------------------------------------------------------------------

/** `none` is the mock tier: sentence text with no audio behind it. */
export type TtsAudioFormat = 'none' | 'pcm16' | 'mp3' | 'opus';

/**
 * One sentence of a speech run. Sentence granularity is what makes barge-in
 * feel instant: the client already knows the boundary it was cut at.
 */
export interface TtsChunk {
	utteranceId: string;
	index: number;
	/** The sentence being spoken, for the transcript UI. */
	text: string;
	format: TtsAudioFormat;
	/** Null in the mock tier, which speaks nothing. */
	audio: Uint8Array | null;
	/**
	 * Sample rate of `audio`, in Hz. Required for `pcm16` and meaningless for the
	 * container formats, which carry their own. Raw samples with no rate attached
	 * are unplayable, and guessing one is how a voice ends up an octave low.
	 */
	sampleRate?: number;
}

export interface TtsSpeakOptions {
	/** Correlates every chunk of one run so a cancelled run's stragglers can be dropped. */
	utteranceId: string;
	voiceId?: string;
	/** 1 is the provider's natural rate. */
	rate?: number;
}

export interface TtsProvider extends VoiceProviderInfo {
	/** Stream a reply. Iteration ends early when `cancel()` is called. */
	speak(text: string, options: TtsSpeakOptions): AsyncIterable<TtsChunk>;
	/** Barge-in. Must cut the current run off mid-sentence, not at the next boundary. */
	cancel(): void;
}

// ---------------------------------------------------------------------------
// Trio
// ---------------------------------------------------------------------------

/** The bag injected into `VoiceSessionService`. Resolved by `provider-registry.ts`. */
export interface VoiceProviderTrio {
	stt: SttProvider;
	tts: TtsProvider;
	brain: BrainProvider;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Which shape the turn takes.
 *
 *   - `cascade`  - three independent engines, speech to text to speech. The
 *                  default, and the only shape a local install or an ElevenLabs
 *                  voice can take.
 *   - `realtime` - one provider's speech-to-speech API, roughly 300 ms instead of
 *                  three serial hops, at the cost of using that provider's voice
 *                  and sending audio to their servers.
 */
export type VoicePipelineShape = 'cascade' | 'realtime';

/**
 * The unit the session service is handed at start.
 *
 * There are exactly two implementations, `CascadePipeline` and `RealtimePipeline`,
 * and the reason they share this interface rather than being two code paths is
 * that everything downstream of the session service - the protocol, the router,
 * the transport, every client - must not be able to tell which one is running. A
 * realtime pipeline satisfies it by being ONE adapter wearing all three hats:
 * `stt`, `tts`, and `brain` are the same object, so the service's turn loop is
 * unchanged and the provider's own endpointing and interruption drive it.
 *
 * Selection happens once, at `resolveVoicePipeline()`. Nothing after that point
 * branches on `shape`, and anything that finds itself wanting to should be asking
 * a provider a question instead.
 */
export interface VoicePipeline {
	readonly shape: VoicePipelineShape;
	/** The three seams. For a realtime pipeline all three are the same instance. */
	readonly providers: VoiceProviderTrio;
	/**
	 * Release everything the pipeline holds: sockets, loaded models, decoders.
	 * Idempotent, because a hot-swap and an app quit can both reach it.
	 */
	dispose(): Promise<void>;
}
