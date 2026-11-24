/**
 * voiceSessionStore - the renderer's mirror of the A Cappella voice session.
 *
 * The session itself lives in the main process (see
 * docs/architecture/acappella/decisions/adr-002-main-process-session.md). This
 * store holds nothing authoritative: it is a projection of the ordered
 * `acappella:event` stream, so the HUD renders from the stream rather than from
 * the return values of the IPC calls. That is what lets a second window, and
 * later the phone, show the same conversation without either client owning it.
 *
 * Two rules the projection follows:
 *   - **The state is derived from the event, not guessed.** `EVENT_STATE` maps
 *     each event to the state the service is in immediately after emitting it,
 *     which is checkable against `voice-session-service.ts` line by line.
 *   - **A gap is reported, not smoothed over.** `seq` is monotonic per voice
 *     session; a jump sets `lostEvents`, because a HUD that quietly drops a
 *     `speak-end` would sit there claiming the assistant is still talking.
 */

import { create } from 'zustand';
import type {
	VoiceFeedEntry,
	VoiceFeedRoute,
	VoiceFeedKind,
	VoiceProviderIds,
	VoiceSessionProjection,
} from '../../shared/acappella/hud-state';
export type {
	VoiceFeedEntry,
	VoiceFeedKind,
	VoiceFeedRoute,
	VoiceSpeechRun,
	VoiceProviderIds,
} from '../../shared/acappella/hud-state';

import type {
	VoiceEvent,
	VoiceScope,
	VoiceWindowId,
	VoiceSendState,
} from '../../shared/acappella/protocol';
import type { VoiceProviderSubstitution } from '../../shared/acappella/providers';
import { isContiguousVoiceSeq } from '../../shared/acappella/protocol';
import {
	documentScopeName,
	isDocumentScope,
	voiceScopeAgentId,
} from '../../shared/acappella/document-scope';
import { QUICK_CHAT_VOICE_LABEL, isQuickChatScope } from '../../shared/acappella/quick-chat-scope';
import { isVoiceSessionActive, type VoiceSessionState } from '../../shared/acappella/session-state';
import { useVoiceDiagnosticsStore } from './voiceDiagnosticsStore';
import { useVoiceUiStore } from './voiceUiStore';

// ============================================================================
// Types
// ============================================================================

/** The subset of `VoiceSessionSnapshot` a client can act on. */
export interface VoiceSnapshotLike {
	sessionId: string | null;
	state: VoiceSessionState;
	scope: VoiceScope | null;
	seq: number;
	providerIds: VoiceProviderIds;
	/**
	 * The window whose HUD owns the session. Optional so a pre-multi-window
	 * producer (and every existing test fixture) still type-checks; absent reads
	 * the same as null, which the primary window shows.
	 */
	windowId?: VoiceWindowId;
	/** Whether the microphone is gated shut. Optional for the same reason. */
	listenPaused?: boolean;
	sendState?: VoiceSendState;
}

type VoiceSessionStoreState = VoiceSessionProjection;

interface VoiceSessionStoreActions {
	/** Project one protocol event. The only way session state changes. */
	applyEvent: (event: VoiceEvent) => void;
	/** Catch-up from `acappella:get-state`. Null means the service never ran. */
	applySnapshot: (snapshot: VoiceSnapshotLike | null) => void;
	setSubstitutions: (substitutions: VoiceProviderSubstitution[]) => void;
	setDismissed: (dismissed: boolean) => void;
	/**
	 * Re-bind while NO session is live, so the next one starts on this scope.
	 *
	 * The one write that is not an event, because there is no session to emit
	 * one: the HUD stays up after its session ends, the talk button restarts it
	 * on `scope`, and a user who moved to another tab in between must not be sent
	 * back to the old one. A live session is re-bound through main
	 * (`voice.setScope`) and this is left alone.
	 */
	rememberScope: (scope: VoiceScope) => void;
	/** Back to a never-started session. */
	reset: () => void;
}

export type VoiceSessionStore = VoiceSessionStoreState & VoiceSessionStoreActions;

// ============================================================================
// Projection rules
// ============================================================================

/** Newest kept; older lines scroll out of the HUD and out of memory. */
export const VOICE_FEED_LIMIT = 60;

/**
 * The state the service is in immediately AFTER emitting each event. Events
 * absent from the map do not move the state: `speak-end` and `barge-in` are
 * always followed by a `listen-start` that says where the floor went, and
 * inventing a state for them here would race that event.
 */
const EVENT_STATE: Partial<Record<VoiceEvent['type'], VoiceSessionState>> = {
	wake: 'arming',
	'listen-start': 'listening',
	'partial-transcript': 'listening',
	'final-transcript': 'transcribing',
	'route-decision': 'dispatching',
	dispatch: 'dispatching',
	'agent-reply': 'dispatching',
	'speak-start': 'speaking',
	'speak-sentence': 'speaking',
	'barge-in': 'interrupted',
	'session-error': 'error',
};

const EMPTY_STATE: VoiceSessionStoreState = {
	sessionId: null,
	state: 'idle',
	scope: null,
	origin: { kind: 'local' },
	windowId: null,
	seq: 0,
	lostEvents: false,
	providerIds: null,
	sttHearsAudio: null,
	substitutions: [],
	partialTranscript: '',
	heldUtterance: null,
	sendState: { forceSend: false, pending: [] },
	utterance: null,
	decision: null,
	lastDispatch: null,
	speech: null,
	audioLevel: 0,
	speechDetected: false,
	mic: null,
	error: null,
	roster: [],
	feed: [],
	dismissed: false,
	listenPaused: false,
	surfaced: false,
};

/**
 * Everything a new session must start clean. Keeps the roster, and keeps the
 * microphone state: both outlive a session. A permission the user denied is
 * still denied on the next attempt, and blanking it here would make the HUD
 * forget the one thing it needs to explain why the new session hears nothing.
 */
function freshSessionFields(sessionId: string): Partial<VoiceSessionStoreState> {
	return {
		sessionId,
		seq: 0,
		lostEvents: false,
		partialTranscript: '',
		heldUtterance: null,
		sendState: { forceSend: false, pending: [] },
		utterance: null,
		decision: null,
		lastDispatch: null,
		speech: null,
		audioLevel: 0,
		speechDetected: false,
		error: null,
		feed: [],
		dismissed: false,
		// A new session opens hot unless its own `listen-gate` says otherwise.
		listenPaused: false,
	};
}

function appendFeed(
	feed: VoiceFeedEntry[],
	entry: { id: string; kind: VoiceFeedKind; text: string; ts: number; route?: VoiceFeedRoute }
): VoiceFeedEntry[] {
	if (!entry.text.trim()) return feed;
	const next = [...feed, entry];
	return next.length > VOICE_FEED_LIMIT ? next.slice(next.length - VOICE_FEED_LIMIT) : next;
}

/** Human-readable line for the events worth narrating in the transcript. */
function narrate(event: VoiceEvent): string | null {
	switch (event.type) {
		case 'dispatch': {
			const where = event.tabName ? ` named ${event.tabName}` : '';
			const verb =
				event.action === 'created'
					? `Opened a new tab${where}`
					: event.action === 'recalled'
						? `Went back to a tab${where}`
						: `Focused the current tab${where}`;
			return `${verb} on ${event.agentName}`;
		}
		case 'session-error':
			return event.message;
		case 'stop-word':
			return 'Stopped.';
		case 'barge-in':
			return 'Interrupted.';
		default:
			return null;
	}
}

// ============================================================================
// Store
// ============================================================================

export const useVoiceSessionStore = create<VoiceSessionStore>()((set) => ({
	...EMPTY_STATE,

	applyEvent: (event) =>
		set((prev) => {
			// Recorded before the projection, so an event that this reducer decides to
			// ignore is still visible to anyone asking why nothing happened.
			useVoiceDiagnosticsStore.getState().record(event);

			// A different session id means the previous one ended, however it
			// ended: start the projection over rather than interleaving two
			// conversations in one transcript.
			const base: VoiceSessionStoreState =
				event.sessionId === prev.sessionId
					? prev
					: { ...prev, ...freshSessionFields(event.sessionId) };

			const patch: Partial<VoiceSessionStoreState> = {
				seq: event.seq,
				lostEvents: base.lostEvents || (base.seq > 0 && !isContiguousVoiceSeq(base.seq, event.seq)),
				state: EVENT_STATE[event.type] ?? base.state,
			};

			switch (event.type) {
				case 'wake':
					patch.scope = event.scope;
					patch.origin = event.origin ?? { kind: 'local' };
					// The first event of the session, so no window ever renders a HUD
					// before it knows whether the session belongs to it.
					patch.windowId = event.windowId ?? null;
					break;
				case 'listen-gate':
					patch.listenPaused = event.paused;
					if (event.paused) {
						// Nothing is arriving to move the meter or finish the hypothesis.
						patch.audioLevel = 0;
						patch.speechDetected = false;
						patch.partialTranscript = '';
						patch.heldUtterance = null;
					}
					break;
				case 'scope-change':
					// Switched from the HUD mid-session: the header and the switch
					// follow, and the next utterance goes where this says.
					patch.scope = event.scope;
					break;
				case 'listen-start':
					patch.scope = event.scope;
					patch.origin = event.origin ?? { kind: 'local' };
					patch.partialTranscript = '';
					patch.heldUtterance = null;
					break;
				case 'listen-stop':
					patch.partialTranscript = '';
					patch.heldUtterance = null;
					// The floor closed, so nothing is arriving to move the meter. Leaving
					// the last level on screen would draw a bar for a microphone that is
					// no longer being read.
					patch.audioLevel = 0;
					patch.speechDetected = false;
					// `stopped` is the end of the session; `error` parks it. Anything
					// else (endpoint, interrupted) is mid-conversation and the state
					// belongs to whichever event comes next.
					if (event.reason === 'stopped') {
						patch.sendState = { forceSend: false, pending: [] };
						patch.state = 'idle';
						// The gate belongs to the session that just ended.
						patch.listenPaused = false;
						// An error describes the session that carried it. A refusal from a
						// session the user has since ended is describing nothing, and the
						// HUD renders whenever `error` is set - so keeping it here left a
						// voice panel on screen indefinitely that nobody had opened. The
						// error still outlives a session that FAILED (no `listen-stop` is
						// emitted for that, which is how the user gets to read why).
						patch.error = null;
					} else if (event.reason === 'error') patch.state = 'error';
					break;
				case 'partial-transcript':
					patch.partialTranscript = event.text;
					// A live hypothesis (no `held`) means the user is speaking again;
					// the next held partial re-arms the countdown.
					patch.heldUtterance = event.held
						? {
								settlesAt: event.ts + event.held.settlesInMs,
								sendPhrases: event.held.sendPhrases,
							}
						: null;
					break;
				case 'final-transcript':
					patch.partialTranscript = '';
					patch.heldUtterance = null;
					patch.utterance = event.text;
					patch.feed = appendFeed(base.feed, {
						id: `${event.sessionId}:${event.seq}`,
						kind: 'you',
						text: event.text,
						ts: event.ts,
					});
					break;
				case 'route-decision':
					patch.decision = event.decision;
					break;
				case 'dispatch':
					patch.lastDispatch = event;
					break;
				case 'agent-reply':
					patch.feed = appendFeed(base.feed, {
						id: `${event.sessionId}:${event.seq}`,
						kind: 'assistant',
						text: event.text,
						ts: event.ts,
					});
					break;
				case 'speak-start':
					patch.speech = {
						utteranceId: event.utteranceId,
						sentenceCount: event.sentenceCount,
						streaming: event.streaming === true,
						sentences: [],
						endedReason: null,
					};
					break;
				case 'speak-sentence':
					// A sentence from a run that is no longer current is a straggler
					// from a cancelled run. Dropping it is what makes barge-in look
					// like a cut rather than a stutter.
					if (base.speech?.utteranceId === event.utteranceId) {
						patch.speech = {
							...base.speech,
							sentences: [...base.speech.sentences, event.text],
						};
					}
					break;
				case 'speak-end':
					if (base.speech?.utteranceId === event.utteranceId) {
						patch.speech = { ...base.speech, endedReason: event.reason };
					}
					break;
				case 'audio-level':
					patch.audioLevel = event.level;
					patch.speechDetected = event.speech;
					break;
				case 'mic-state':
					patch.mic = {
						permission: event.permission,
						capturing: event.capturing,
						deviceId: event.deviceId,
						deviceLabel: event.deviceLabel,
						issue: event.issue,
						deviceChanged: event.deviceChanged,
					};
					// A microphone that is not being read cannot be making the meter
					// move; a bar left standing there is the same lie as a listening
					// indicator over a denied device.
					if (!event.capturing) {
						patch.audioLevel = 0;
						patch.speechDetected = false;
					}
					break;
				case 'session-error':
					patch.error = {
						code: event.code,
						message: event.message,
						recoverable: event.recoverable,
					};
					break;
				case 'send-state':
					patch.sendState = { forceSend: event.forceSend, pending: event.pending };
					break;
				case 'agent-roster':
					patch.roster = event.agents;
					break;
				case 'provider-state': {
					// Only the STT slot declares this, and only it matters here: the
					// question the HUD has to answer is whether talking can possibly
					// produce a transcript.
					const stt = event.slots.find((slot) => slot.role === 'stt');
					patch.sttHearsAudio = stt?.hearsAudio ?? null;
					break;
				}
				default:
					break;
			}

			const line = narrate(event);
			if (line) {
				patch.feed = appendFeed(patch.feed ?? base.feed, {
					id: `${event.sessionId}:${event.seq}:note`,
					kind: 'system',
					text: line,
					ts: event.ts,
					route:
						event.type === 'dispatch'
							? {
									groupChatId: event.groupChatId,
									agentSessionId: event.agentSessionId,
									agentName: event.agentName,
									tabId: event.tabId,
									tabName: event.tabName,
									action: event.action,
								}
							: undefined,
				});
			}

			const next = { ...base, ...patch };
			// Sticky until the HUD is closed: see the field's own comment.
			if (isVoiceSessionActive(next.state)) next.surfaced = true;
			return next;
		}),

	applySnapshot: (snapshot) =>
		set((prev) => {
			// Null means the service has never been built. Believe it only while
			// this client has no session of its own: the mount-time catch-up read
			// can resolve AFTER the first events of a session that started in
			// between, and rewinding to idle there would blank a live HUD.
			if (!snapshot || !snapshot.sessionId) {
				return prev.sessionId ? prev : { ...prev, state: 'idle' };
			}
			// Same reason, one step subtler: the stream is authoritative once it is
			// ahead of the snapshot. Keep the projection and take only what a
			// snapshot knows that events do not.
			if (snapshot.sessionId === prev.sessionId && prev.seq >= snapshot.seq) {
				return {
					...prev,
					providerIds: snapshot.providerIds,
					// Taken even on this path: a window that RELOADED mid-session never
					// saw the `wake` that carries it, and without it that window would
					// decide it does not own a session that is in fact its own.
					windowId: snapshot.windowId ?? null,
					surfaced: prev.surfaced || isVoiceSessionActive(prev.state),
				};
			}
			const changed = snapshot.sessionId !== prev.sessionId;
			return {
				...prev,
				...(changed ? freshSessionFields(snapshot.sessionId) : {}),
				state: snapshot.state,
				scope: snapshot.scope,
				listenPaused: snapshot.listenPaused === true,
				sendState: snapshot.sendState ?? { forceSend: false, pending: [] },
				surfaced: prev.surfaced || isVoiceSessionActive(snapshot.state),
				windowId: snapshot.windowId ?? null,
				// Adopt the snapshot's seq as the baseline: a client that joins
				// mid-session has not lost events, it simply was not there.
				seq: snapshot.seq,
				providerIds: snapshot.providerIds,
			};
		}),

	setSubstitutions: (substitutions) => set({ substitutions }),

	// Closing is what ends `surfaced`; un-dismissing must not invent a HUD for a
	// session that was never live here.
	setDismissed: (dismissed) => set(dismissed ? { dismissed, surfaced: false } : { dismissed }),

	rememberScope: (scope) =>
		set((prev) => (isVoiceSessionActive(prev.state) ? prev : { ...prev, scope })),

	reset: () => set({ ...EMPTY_STATE }),
}));

/**
 * Start a voice session and project everything the start reported.
 *
 * The one way any surface opens the floor. It exists because a start returns TWO
 * things - the snapshot and the provider substitutions - and a caller that
 * `await`s `voice.start()` for its side effect silently drops the second.
 *
 * That is not a hypothetical. Every trigger except the HUD's own button (the
 * composer microphone, the Left Bar menu, the command palette) went straight to
 * `window.maestro.voice.start()` and discarded the result, so a build whose
 * speech-to-text had fallen back to the mock tier said "Listening" and explained
 * nothing - the exact silent downgrade the provider registry refuses to perform,
 * leaking back in at the last hop. Anything that starts a session goes through
 * here so there is no second place to forget.
 */
export async function beginVoiceSession(
	scope?: VoiceScope,
	options: {
		/**
		 * Open the microphone whatever the listen mode says. For the one caller
		 * whose start IS the user opening it: the HUD's talk button.
		 */
		open?: boolean;
	} = {}
): Promise<void> {
	// Push-to-talk means the microphone is open only while the button is held, so
	// a session started by anything else (the composer microphone, the palette,
	// the Left Bar menu) opens gated. Decided here because this is the one way a
	// surface starts a session: a trigger that forgot to ask would open a hot
	// microphone in the mode that exists to prevent one.
	const paused = !options.open && useVoiceUiStore.getState().listenMode === 'push-to-talk';
	const result = paused
		? await window.maestro.voice.start(scope, { paused: true })
		: await window.maestro.voice.start(scope);
	const store = useVoiceSessionStore.getState();
	store.applySnapshot(result.snapshot);
	store.setSubstitutions(result.substitutions);
}

// ============================================================================
// Selectors
// ============================================================================

/** The floor is open: the service is consuming (or about to consume) audio. */
export const selectVoiceListening = (s: VoiceSessionStore) =>
	s.state === 'listening' || s.state === 'arming';

export const selectVoiceSpeaking = (s: VoiceSessionStore) => s.state === 'speaking';

/**
 * The live input level, 0 to 1.
 *
 * Subscribe to this on its own, from the smallest component that draws it. It
 * changes ~20 times a second, so a component that reads it alongside the rest of
 * the session re-renders the whole HUD at meter rate for a bar a few pixels
 * wide.
 */
export const selectVoiceAudioLevel = (s: VoiceSessionStore) => s.audioLevel;

/** What is wrong with the microphone, or null when it is fine or unknown. */
export const selectVoiceMicIssue = (s: VoiceSessionStore) => s.mic?.issue ?? null;

/**
 * The name of the paired device holding the floor, or null when it is this
 * machine's own microphone.
 *
 * The HUD renders this next to the state, so a Mac at home visibly reflects that
 * a phone is the thing listening. Without it, the desktop shows a listening
 * indicator over a microphone that is not open, which is the one thing the HUD
 * must never do.
 */
export const selectVoiceRemoteDevice = (s: VoiceSessionStore): string | null =>
	s.origin.kind === 'remote' ? s.origin.deviceName : null;

/** What the HUD binds to, in words. */
export const selectVoiceScopeLabel = (s: VoiceSessionStore): string => {
	const scope = s.scope;
	// The document comes first: a document conversation is bound to an agent too,
	// so an agent-id test alone would label it with the agent and lose the file.
	if (isDocumentScope(scope)) return documentScopeName(scope);
	if (isQuickChatScope(scope)) return QUICK_CHAT_VOICE_LABEL;
	if (scope?.kind === 'group-chat') return scope.name || 'Group Chat';
	const agentSessionId = voiceScopeAgentId(scope);
	if (!agentSessionId) return 'Conductor';
	return s.roster.find((a) => a.sessionId === agentSessionId)?.name ?? 'Agent';
};
