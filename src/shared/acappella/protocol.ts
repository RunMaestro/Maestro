/**
 * A Cappella Voice Session Protocol - the contract between the headless session
 * service in the main process and every client (desktop renderer today, iPhone
 * later, CLI if it ever wants in).
 *
 * The protocol is transport-agnostic on purpose: the same object graph travels
 * over Electron IPC (`acappella:event`) and over the authenticated WebSocket at
 * `/$TOKEN/ws`. Nothing here may refer to a BrowserWindow, a DOM node, or a
 * React store.
 *
 * Full narrative, including the flow diagram and invariants, lives in
 * docs/architecture/acappella/voice-session-protocol.md.
 */

import type { RouteDecision } from './route-decision';

/**
 * What a voice session is bound to. The `sessionId` inside an agent scope is an
 * AGENT id; the envelope's `sessionId` is the voice session id. They are never
 * the same value and are never interchangeable.
 */
export type VoiceScope = { kind: 'conductor' } | { kind: 'agent'; sessionId: string };

/** Every event carries the same three fields. */
export interface VoiceEventBase {
	/** The voice session this event belongs to. Not an agent id. */
	sessionId: string;
	/** Monotonic per voice session, starting at 1. A gap means events were lost. */
	seq: number;
	/** Emission time, epoch ms. */
	ts: number;
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/** One AI tab, compact enough to push on every change and to feed a model. */
export interface RosterTab {
	id: string;
	name: string | null;
	lastActiveAt: number | null;
}

/** One agent as the Brain sees it, and later as the phone's project wheel shows it. */
export interface RosterAgent {
	sessionId: string;
	name: string;
	agentType: string;
	cwd: string;
	tabs: RosterTab[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** How a session was woken. */
export type WakeSource = 'wake-word' | 'hotkey' | 'client-button';

/**
 * Inbound, requests a session in `scope`. Outbound, announces `idle -> arming`.
 */
export interface WakeEvent extends VoiceEventBase {
	type: 'wake';
	source: WakeSource;
	scope: VoiceScope;
}

/** The floor is open and audio is being consumed. */
export interface ListenStartEvent extends VoiceEventBase {
	type: 'listen-start';
	scope: VoiceScope;
	/** Named so provider substitution can never be silent. */
	sttProviderId: string;
}

export type ListenStopReason = 'endpoint' | 'stopped' | 'interrupted' | 'error';

/** The floor closed: endpointed, stopped, or interrupted. */
export interface ListenStopEvent extends VoiceEventBase {
	type: 'listen-stop';
	reason: ListenStopReason;
}

/** An interim STT hypothesis. */
export interface PartialTranscriptEvent extends VoiceEventBase {
	type: 'partial-transcript';
	/** The full hypothesis so far, not a delta, so a missed partial is harmless. */
	text: string;
	/** 0 to 1. Rises across successive partials for the same utterance. */
	stability: number;
}

/**
 * A settled utterance. Inbound when the client owns transcription (on-device
 * iPhone dictation); either way it lands on the same seam as
 * `submitUtterance(text)`, so a real microphone and the dev harness are
 * indistinguishable downstream.
 */
export interface FinalTranscriptEvent extends VoiceEventBase {
	type: 'final-transcript';
	text: string;
	confidence: number;
	durationMs?: number;
}

/** The Brain resolved a target, a tab action, and a prompt. */
export interface RouteDecisionEvent extends VoiceEventBase {
	type: 'route-decision';
	decision: RouteDecision;
	brainProviderId: string;
	latencyMs: number;
}

export type DispatchAction = 'focused' | 'created' | 'recalled';

/**
 * The decision was executed against a real agent and tab. Emitted AFTER the
 * renderer confirms, never when the operation is requested: main has no tab
 * authority and the round trip can time out.
 */
export interface DispatchEvent extends VoiceEventBase {
	type: 'dispatch';
	agentSessionId: string;
	agentName: string;
	tabId: string;
	tabName?: string;
	action: DispatchAction;
	promptSent: boolean;
}

/** The agent produced text worth speaking. */
export interface AgentReplyEvent extends VoiceEventBase {
	type: 'agent-reply';
	agentSessionId: string;
	tabId: string;
	/** What the agent actually wrote. Show this. */
	text: string;
	/** `BrainProvider.converse()` output, reshaped for the ear. Speak this. */
	spokenText: string;
}

export interface SpeakStartEvent extends VoiceEventBase {
	type: 'speak-start';
	/** Scopes a speech run so late sentences from a cancelled run can be dropped. */
	utteranceId: string;
	sentenceCount: number;
	ttsProviderId: string;
}

export interface SpeakSentenceEvent extends VoiceEventBase {
	type: 'speak-sentence';
	utteranceId: string;
	index: number;
	text: string;
}

export type SpeakEndReason = 'complete' | 'cancelled' | 'error';

export interface SpeakEndEvent extends VoiceEventBase {
	type: 'speak-end';
	utteranceId: string;
	reason: SpeakEndReason;
}

export type InterruptSource = 'voice' | 'client-button';

/**
 * The user spoke or clicked over active speech. Cancels TTS and KEEPS the
 * floor (`speaking -> interrupted -> listening`). It never ends the session.
 */
export interface BargeInEvent extends VoiceEventBase {
	type: 'barge-in';
	source: InterruptSource;
	cancelledUtteranceId?: string;
}

/** Ends the session from any state. TTS is cancelled and the floor is released. */
export interface StopWordEvent extends VoiceEventBase {
	type: 'stop-word';
	phrase?: string;
	source: InterruptSource;
}

/**
 * Closed on purpose. Only classified, known failure modes become events;
 * anything else bubbles to Sentry per the repo error policy.
 */
export const VOICE_SESSION_ERROR_CODES = [
	'provider-unavailable',
	'no-agent-matched',
	'dispatch-failed',
	/**
	 * The microphone could not be opened or was taken away mid-session. Its own
	 * code because the recovery is the user's, not the app's: grant permission,
	 * plug a device back in, pick another input. See
	 * `audioHostErrorToSessionError` in `./audio-host.ts`.
	 */
	'audio-capture-failed',
] as const;

export type VoiceSessionErrorCode = (typeof VOICE_SESSION_ERROR_CODES)[number];

export interface SessionErrorEvent extends VoiceEventBase {
	type: 'session-error';
	code: VoiceSessionErrorCode;
	message: string;
	recoverable: boolean;
	providerId?: string;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/**
 * A downsampled input level, so a client can draw a live meter without ever
 * receiving PCM.
 *
 * Roughly 20 a second rather than one per 20 ms frame. That is the rate a meter
 * is actually read at, and the difference matters on the wire: 50 messages a
 * second of a number nobody can perceive changing is a busy IPC channel and,
 * over the Phase 10 WebSocket, a busy radio.
 */
export interface AudioLevelEvent extends VoiceEventBase {
	type: 'audio-level';
	/** Root mean square over the window, 0 to 1. Linear, not perceptual: the meter picks the curve. */
	level: number;
	/**
	 * Whether the detector held the floor open across the window. A meter can
	 * therefore show the difference between a room that is loud and a person who
	 * is talking, which is the one thing a bare level cannot say.
	 */
	speech: boolean;
}

/**
 * Whether the OS lets Maestro open the microphone.
 *
 * Four real states plus `unknown`, because collapsing them loses the user's next
 * action every time:
 *
 *   - `unknown` - nobody has asked and the platform cannot say (Linux, and any
 *     state before the first query). Blocks nothing.
 *   - `not-determined` - macOS has a TCC record slot for us and it is empty. The
 *     prompt has not been shown yet, which is the normal state of a first run
 *     and is NOT a denial.
 *   - `granted` / `denied` - the user answered.
 *   - `restricted` - policy (parental controls, MDM) forbids it. Distinct from
 *     `denied` because the user cannot fix it in the privacy pane, so sending
 *     them there would be a dead end.
 */
export type MicPermission = 'unknown' | 'not-determined' | 'granted' | 'denied' | 'restricted';

/**
 * Why the microphone is unusable, or null when it is fine.
 *
 * Classified rather than collapsed into one "audio broke" case because the
 * recovery differs per code and the recovery is the user's: grant permission,
 * plug a device back in, restart the app. `unavailable` is the one with no user
 * recovery, so it is the one the HUD must not offer a settings button for.
 */
export type MicIssue = 'permission-denied' | 'no-device' | 'device-lost' | 'unavailable';

/** The microphone as the session currently sees it. */
export interface MicState {
	permission: MicPermission;
	/** True while a capture run is live. */
	capturing: boolean;
	deviceId: string | null;
	/** As the OS names it. Null before permission is granted: Chromium redacts labels until then. */
	deviceLabel: string | null;
	issue: MicIssue | null;
	/**
	 * This update was caused by the device SET changing (something plugged in or
	 * pulled out), not by our own capture starting or stopping.
	 */
	deviceChanged: boolean;
}

/**
 * The microphone changed state.
 *
 * Emitted on every transition, including the benign ones, because the failure
 * this exists to prevent is a client showing a listening indicator over a
 * microphone that will never produce a transcript. A denied permission is a
 * fact the user has to be told, not a session that is merely quiet.
 */
export interface MicStateEvent extends VoiceEventBase, MicState {
	type: 'mic-state';
}

/** The bound agent's tab set or active tab changed. */
export interface TabStateEvent extends VoiceEventBase {
	type: 'tab-state';
	agentSessionId: string;
	tabs: RosterTab[];
	activeTabId: string | null;
}

/** Roster snapshot, sent on subscribe and on change. */
export interface AgentRosterEvent extends VoiceEventBase {
	type: 'agent-roster';
	agents: RosterAgent[];
}

/** The whole protocol, discriminated on `type`. */
export type VoiceEvent =
	| WakeEvent
	| ListenStartEvent
	| ListenStopEvent
	| PartialTranscriptEvent
	| FinalTranscriptEvent
	| RouteDecisionEvent
	| DispatchEvent
	| AgentReplyEvent
	| SpeakStartEvent
	| SpeakSentenceEvent
	| SpeakEndEvent
	| BargeInEvent
	| StopWordEvent
	| SessionErrorEvent
	| AudioLevelEvent
	| MicStateEvent
	| TabStateEvent
	| AgentRosterEvent;

export type VoiceEventType = VoiceEvent['type'];

/** The payload of an event before the service stamps `sessionId`, `seq`, and `ts`. */
export type VoiceEventPayload<T extends VoiceEventType = VoiceEventType> = Omit<
	Extract<VoiceEvent, { type: T }>,
	keyof VoiceEventBase
>;

// ---------------------------------------------------------------------------
// Direction
// ---------------------------------------------------------------------------

/**
 * `client-to-service` events are commands; the service validates one against
 * the state machine and, if legal, echoes it outward with a fresh `seq` so every
 * other client sees it. The echo is authoritative: a client renders its own
 * optimistic state only until the echo lands.
 */
export type VoiceEventDirection = 'service-to-client' | 'both';

export const VOICE_EVENT_DIRECTIONS: Record<VoiceEventType, VoiceEventDirection> = {
	wake: 'both',
	'listen-start': 'service-to-client',
	'listen-stop': 'service-to-client',
	'partial-transcript': 'service-to-client',
	'final-transcript': 'both',
	'route-decision': 'service-to-client',
	dispatch: 'service-to-client',
	'agent-reply': 'service-to-client',
	'speak-start': 'service-to-client',
	'speak-sentence': 'service-to-client',
	'speak-end': 'service-to-client',
	'barge-in': 'both',
	'stop-word': 'both',
	'session-error': 'service-to-client',
	'audio-level': 'service-to-client',
	'mic-state': 'service-to-client',
	'tab-state': 'service-to-client',
	'agent-roster': 'service-to-client',
};

/** The four events a client is allowed to originate. */
export type ClientVoiceEvent = Extract<
	VoiceEvent,
	{ type: 'wake' | 'final-transcript' | 'barge-in' | 'stop-word' }
>;

export function isClientVoiceEvent(event: VoiceEvent): event is ClientVoiceEvent {
	return VOICE_EVENT_DIRECTIONS[event.type] === 'both';
}

/** True when `next` continues `previous` without a gap. */
export function isContiguousVoiceSeq(previous: number, next: number): boolean {
	return next === previous + 1;
}
