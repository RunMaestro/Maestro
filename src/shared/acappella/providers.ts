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
 */
export type VoiceProviderTier = 'mock' | 'local' | 'cloud';

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
}

export interface VoiceConverseContext {
	/** The agent whose text is being reshaped. */
	agentSessionId: string;
	tabId: string;
	/** Rough budget for the spoken form. Reading a diff aloud is useless. */
	maxSentences?: number;
}

export interface BrainProvider extends VoiceProviderInfo {
	/** Resolve an utterance into a target, a tab action, and a prompt. */
	route(input: string, context: VoiceRouteContext): Promise<RouteDecision>;
	/** Reshape an agent's terminal-shaped answer into spoken-form text. */
	converse(agentText: string, context: VoiceConverseContext): Promise<string>;
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
