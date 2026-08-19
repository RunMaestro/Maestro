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

import type { VoiceProviderRole, VoiceProviderTier } from './providers';
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

/**
 * Where a tab is, from the roster's point of view.
 *
 * Snoozed and closed tabs are listed rather than hidden because recall has to be
 * able to reach them: "back to the auth thing" is most often said about a
 * conversation the user put away, and a roster that only knows about open tabs
 * answers that by opening a duplicate. The state travels with the tab so the
 * dispatch can wake or reopen it deliberately instead of discovering afterwards
 * that the tab it focused was not on screen.
 */
export type RosterTabState = 'open' | 'snoozed' | 'closed';

/** One AI tab, compact enough to push on every change and to feed a model. */
export interface RosterTab {
	id: string;
	name: string | null;
	lastActiveAt: number | null;
	/** Absent means `open`, which is what every pre-Phase-07 producer emitted. */
	state?: RosterTabState;
	/**
	 * One line of what this tab is about, derived from data the app already has
	 * (the tab name the naming pipeline produced, the opening message, the
	 * session synopsis). Never a fresh model call: a routing turn that had to
	 * summarise twelve tabs first would be slower than reading the screen.
	 */
	topic?: string | null;
}

/** One agent as the Brain sees it, and later as the phone's project wheel shows it. */
export interface RosterAgent {
	sessionId: string;
	name: string;
	agentType: string;
	cwd: string;
	tabs: RosterTab[];
	/** As the Left Bar colours it: `idle`, `busy`, `error`. Absent when unknown. */
	status?: string;
	/**
	 * The last thing this agent finished, taken from the synopsis the history
	 * manager already wrote. It is what makes "tell the one doing the migration"
	 * routable without naming an agent, and it costs a file read rather than a
	 * model call.
	 */
	recentWork?: string | null;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** How a session was woken. */
export type WakeSource = 'wake-word' | 'hotkey' | 'client-button' | 'remote-device';

/**
 * Which microphone the session is being held by.
 *
 * A remote session is not a different KIND of session - routing, dispatch,
 * translation, and TTS run the identical code path either way, which is the
 * whole point of terminating the phone's audio in the same pipeline the local
 * microphone feeds. The origin exists so a client can SAY which microphone is
 * open, because a Mac whose HUD claims to be listening while its own microphone
 * is shut is describing something that is not happening in the room.
 */
export type VoiceOrigin =
	| { kind: 'local' }
	| { kind: 'remote'; deviceId: string; deviceName: string };

/**
 * The desktop window whose HUD owns this session, or null for none.
 *
 * A different axis from {@link VoiceOrigin}, which says which MICROPHONE is
 * open: a session held by a paired phone still has to be shown on exactly one
 * desktop window. Every main -> renderer push is broadcast to every window (see
 * the multi-window invariant in `utils/safe-send.ts`), so without this each
 * window rendered the same HUD and one microphone appeared to be open in all of
 * them.
 *
 * Null means no window could be resolved at all - a host with no windows open,
 * or a caller that does not scope sessions. The primary window shows those, so
 * a session always has exactly one surface rather than none.
 */
export type VoiceWindowId = string | null;

/**
 * Inbound, requests a session in `scope`. Outbound, announces `idle -> arming`.
 */
export interface WakeEvent extends VoiceEventBase {
	type: 'wake';
	source: WakeSource;
	scope: VoiceScope;
	/** Absent means `local`, which is what every pre-Phase-10 producer emitted. */
	origin?: VoiceOrigin;
	/**
	 * The window whose HUD owns this session. Carried on `wake` so a window knows
	 * from the FIRST event whether the session is its own; waiting for the
	 * catch-up snapshot would flash a HUD in every window first.
	 */
	windowId?: VoiceWindowId;
}

/** The floor is open and audio is being consumed. */
export interface ListenStartEvent extends VoiceEventBase {
	type: 'listen-start';
	scope: VoiceScope;
	/** Named so provider substitution can never be silent. */
	sttProviderId: string;
	/** Which microphone is open. Absent means this machine's. */
	origin?: VoiceOrigin;
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

/**
 * The last dispatch went to the wrong place and was moved.
 *
 * Its own event rather than a second `dispatch`, because the two mean opposite
 * things to anyone measuring routing quality: a dispatch is the router's answer
 * and a correction is the user overruling it. Collapsing them would make a
 * misroute that the user had to fix by hand indistinguishable from a hit, which
 * is precisely the number the routing log exists to produce.
 */
export interface RouteCorrectionEvent extends VoiceEventBase {
	type: 'route-correction';
	/** Where the prompt originally landed. */
	fromAgentSessionId: string;
	fromTabId: string;
	/** Where it went instead, as the executor actually performed it. */
	agentSessionId: string;
	agentName: string;
	tabId: string;
	tabName?: string;
	action: DispatchAction;
	promptSent: boolean;
	source: InterruptSource;
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
	/**
	 * The reply is still being written, so `sentenceCount` is a LOWER BOUND and
	 * `speak-sentence` indices will run past it.
	 *
	 * Set by the sentence-streaming scheduler, which starts speaking the first
	 * sentence while the agent is still typing the rest - the entire reason the
	 * first spoken word arrives when it does. A client showing "3 of 5" must treat
	 * the total as provisional while this is true rather than clamping the index,
	 * because the honest alternative is holding every sentence back until the
	 * whole reply exists.
	 */
	streaming?: boolean;
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
	/**
	 * A hosted provider rejected the API key. Its own code because the recovery is
	 * specific and nobody can guess it from silence: replace the key in Voice
	 * Setup. Folding it into `provider-unavailable` would tell a user with a
	 * revoked key to go and download a model.
	 */
	'provider-auth-failed',
	/** Rate limited or out of credit. Distinct from auth: the key is fine. */
	'provider-quota-exceeded',
	/** The service could not be reached, or answered too slowly to speak with. */
	'provider-network-error',
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

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** One slot of the live configuration, as the engines actually resolved. */
export interface ProviderSlotState {
	role: VoiceProviderRole;
	/** What is RUNNING, which is not always what settings asked for. */
	providerId: string;
	label: string;
	/** `unresolved` means nothing is filling this slot. It is not a working tier. */
	tier: VoiceProviderTier;
	/** Set when this slot is not the one that was requested. */
	substitutedFor?: string;
	/**
	 * Whether this slot consumes microphone audio. Meaningful on `stt`.
	 *
	 * False for the text-in mock tier, which opens no capture device at all. It
	 * travels because "Listening" is otherwise indistinguishable from a session
	 * that can never hear anything: the floor is genuinely open, the state machine
	 * is telling the truth, and the microphone was never touched.
	 */
	hearsAudio?: boolean;
}

/**
 * Which engines are live, pushed whenever that changes.
 *
 * Its own event rather than a field on `listen-start` because a provider swap
 * happens between turns, and because every client - the HUD, the phone, a CLI -
 * has to be able to answer "what am I actually talking to right now" without
 * having been listening when the session began. A silently swapped engine is the
 * failure this whole subsystem is arranged to prevent; broadcasting the truth is
 * the cheap half of preventing it.
 */
export interface ProviderStateEvent extends VoiceEventBase {
	type: 'provider-state';
	pipeline: 'cascade' | 'realtime';
	slots: ProviderSlotState[];
	/** The one sentence about where audio goes. Computed, never hard-coded copy. */
	egressStatement: string;
	/** True when the microphone's samples reach a service. */
	audioLeavesMachine: boolean;
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
	| RouteCorrectionEvent
	| AgentReplyEvent
	| SpeakStartEvent
	| SpeakSentenceEvent
	| SpeakEndEvent
	| BargeInEvent
	| StopWordEvent
	| SessionErrorEvent
	| AudioLevelEvent
	| MicStateEvent
	| ProviderStateEvent
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
	// A client asks for a correction over its own channel and reads the outcome
	// here, the same way it starts a session: the four `both` events are the ones
	// a client can originate as raw voice input, and a correction is a command.
	'route-correction': 'service-to-client',
	'agent-reply': 'service-to-client',
	'speak-start': 'service-to-client',
	'speak-sentence': 'service-to-client',
	'speak-end': 'service-to-client',
	'barge-in': 'both',
	'stop-word': 'both',
	'session-error': 'service-to-client',
	'audio-level': 'service-to-client',
	'mic-state': 'service-to-client',
	'provider-state': 'service-to-client',
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
