/**
 * A Cappella headless voice session service.
 *
 * Owns the whole session: lifecycle, the state machine from
 * `src/shared/acappella/session-state.ts`, the monotonic `seq` counter, and the
 * subscriber fan-out. Every client (the desktop HUD today, the iPhone later)
 * sees the identical event stream; none of them holds authoritative state.
 *
 * Two rules this file exists to enforce, both inherited by every later phase:
 *   - Nothing here may reference a BrowserWindow, the DOM, or a React store. The
 *     session is transport-agnostic because the phone is a peer client, not a
 *     port of the desktop UI. See docs/architecture/acappella/decisions/adr-002-main-process-session.md.
 *   - No concrete provider is ever imported. The trio arrives at construction so
 *     Phase 05 can swap Whisper/Kokoro/OpenAI in without touching this file.
 */

import type {
	DispatchAction,
	InterruptSource,
	MicState,
	RosterAgent,
	VoiceEvent,
	VoiceEventBase,
	VoiceEventPayload,
	VoiceEventType,
	VoiceScope,
	VoiceSessionErrorCode,
	WakeSource,
} from '../../shared/acappella/protocol';
import type { RouteDecision } from '../../shared/acappella/route-decision';
import { isClarification, routeTargetSessionId } from '../../shared/acappella/route-decision';
import { isCorrectionUtterance, planCorrection } from './router/conductor-router';
import type {
	SttCallbacks,
	SttProvider,
	TtsChunk,
	VoicePipelineShape,
	VoiceProviderTrio,
	VoiceRouteContext,
} from '../../shared/acappella/providers';
import {
	isVoiceProviderError,
	type VoiceProviderError,
} from '../../shared/acappella/provider-errors';
import { recordTurn, TurnTimer } from './telemetry/turn-metrics';
import {
	audioHostErrorToSessionError,
	type AudioHostErrorCode,
} from '../../shared/acappella/audio-host';
import { readinessErrorMessage, type VoiceReadiness } from '../../shared/acappella/readiness';
import type { VoiceSessionState } from '../../shared/acappella/session-state';
import {
	assertVoiceStateTransition,
	canTransitionVoiceState,
} from '../../shared/acappella/session-state';
import { countSpokenSentences } from '../../shared/acappella/sentences';
import { generateUUID } from '../../shared/uuid';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

const LOG_CONTEXT = 'ACappella';

/** Spoken replies stay short by default: nobody wants a diff read aloud. */
const DEFAULT_MAX_SPOKEN_SENTENCES = 2;

/** How many utterances the Brain gets as "back to the auth one" context. */
const DEFAULT_UTTERANCE_HISTORY = 8;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** A single event delivered to one subscriber. Subscribers never mutate it. */
export type VoiceEventListener = (event: VoiceEvent) => void;

/**
 * Why a session ended. Maps onto `ListenStopEvent.reason` on the way out.
 *
 * `timeout` is the idle backstop in `audio/floor-control.ts`: a forgotten open
 * microphone going cold on its own. It is deliberately not the same reason as
 * `user`, because "you stopped me" and "you walked away" are different facts and
 * only one of them is worth telling the user about.
 */
export type VoiceStopReason = 'user' | 'stop-word' | 'timeout' | 'replaced' | 'shutdown' | 'error';

/** What the dispatch executor actually did, echoed as a `dispatch` event. */
export interface VoiceDispatchResult {
	agentSessionId: string;
	agentName: string;
	tabId: string;
	tabName?: string;
	action: DispatchAction;
	promptSent: boolean;
}

/**
 * Thrown by a route executor for a KNOWN dispatch failure (the renderer did not
 * answer within its timeout, the recalled tab is gone). Anything else thrown by
 * an executor is a bug and bubbles to Sentry unchanged.
 */
export class VoiceDispatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'VoiceDispatchError';
	}
}

/**
 * Performs a `RouteDecision` against the renderer. Injected rather than imported
 * because main has no tab authority: the executor forwards `remote:*` messages
 * and waits for the renderer to confirm.
 */
export type VoiceRouteExecutor = (
	decision: RouteDecision,
	context: { roster: RosterAgent[]; scope: VoiceScope }
) => Promise<VoiceDispatchResult>;

export interface VoiceSessionServiceOptions {
	/** The active provider trio. Resolved by `providers/provider-registry.ts`. */
	providers: VoiceProviderTrio;
	/**
	 * Which pipeline shape the trio came from. Recorded with every turn's timings
	 * so a latency report can be compared against the right configuration; nothing
	 * in this file branches on it, which is the whole point of the two shapes
	 * sharing one interface.
	 */
	pipelineShape?: VoicePipelineShape;
	/** Current agents and their tabs. Defaults to an empty roster. */
	getRoster?: () => RosterAgent[] | Promise<RosterAgent[]>;
	/** Executes route decisions. Absent until the executor is wired. */
	executeRoute?: VoiceRouteExecutor;
	/** Spoken-form budget handed to `BrainProvider.converse()`. */
	maxSpokenSentences?: number;
	/** Utterances retained for `VoiceRouteContext.recentUtterances`. */
	utteranceHistoryLimit?: number;
	/**
	 * One chunk of synthesised speech, as it comes off the TTS provider.
	 *
	 * The audio bridge turns these into `play` commands for the audio host. It is
	 * a callback rather than an event because audio is the one thing in this
	 * pipeline that must NOT be broadcast: `speak-sentence` goes to every client so
	 * they can render the text, while the samples go to exactly one output device.
	 * Chunks with no audio behind them (the mock tier) are still delivered - what
	 * to do with `format: 'none'` is the sink's call, not this file's.
	 */
	onSpeechChunk?: (chunk: TtsChunk) => void;
	/**
	 * The capability gate, consulted before the microphone is touched.
	 *
	 * A verdict rather than a provider, deliberately: the service refuses to start
	 * when a required slot is unsatisfied and says which one. It does NOT ask
	 * anything to pick a replacement. Routing audio to a cloud API the user did not
	 * choose is both an unasked-for charge and a privacy break, so the "recovery"
	 * for a missing local model is a stated error, not a substitution.
	 *
	 * Absent means "no gate", which is the mock tier: nothing to be missing.
	 */
	checkReadiness?: () => VoiceReadiness | Promise<VoiceReadiness>;
	/**
	 * The body of the `provider-state` event, from whoever resolved the pipeline.
	 *
	 * A supplier rather than a value because a slot can be substituted, and only
	 * the registry knows what was requested; and a supplier rather than an import
	 * because this file must never learn how providers are chosen.
	 */
	getProviderState?: () => Omit<VoiceEventPayload<'provider-state'>, 'type'> | null;
}

/** Everything a client needs to catch up after `get-state`. */
export interface VoiceSessionSnapshot {
	sessionId: string | null;
	state: VoiceSessionState;
	scope: VoiceScope | null;
	/** Last `seq` emitted. A client whose next event skips this has lost events. */
	seq: number;
	startedAt: number | null;
	providerIds: { stt: string; tts: string; brain: string };
	/**
	 * The last routing decision, so a client that joined mid-session can show
	 * where the last thing went and how sure the router was. Null until the first
	 * utterance of the session has been routed.
	 */
	lastDecision: RouteDecision | null;
	/** Where that decision actually landed, once it was performed. */
	lastDispatch: VoiceDispatchResult | null;
}

/** The body of an event before the service stamps `sessionId`, `seq`, and `ts`. */
type VoiceEventBody<T extends VoiceEventType> = Omit<
	Extract<VoiceEvent, { type: T }>,
	keyof VoiceEventBase | 'type'
>;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class VoiceSessionService {
	private readonly providers: VoiceProviderTrio;
	private readonly getRoster: () => RosterAgent[] | Promise<RosterAgent[]>;
	private readonly executeRoute?: VoiceRouteExecutor;
	private readonly maxSpokenSentences: number;
	private readonly utteranceHistoryLimit: number;
	private readonly onSpeechChunk?: (chunk: TtsChunk) => void;
	private readonly checkReadiness?: () => VoiceReadiness | Promise<VoiceReadiness>;
	private readonly getProviderState?: () => Omit<
		VoiceEventPayload<'provider-state'>,
		'type'
	> | null;

	private readonly pipelineShape: VoicePipelineShape;

	private readonly listeners = new Set<VoiceEventListener>();

	private state: VoiceSessionState = 'idle';
	private sessionId: string | null = null;
	private scope: VoiceScope | null = null;
	private seq = 0;
	private startedAt: number | null = null;

	private recentUtterances: string[] = [];

	/**
	 * The question the router asked out loud, waiting for an answer.
	 *
	 * Consumed by the next utterance and cleared, so an abandoned question does
	 * not silently reinterpret an unrelated sentence three turns later.
	 */
	private pendingClarification: { question: string; utterance: string } | null = null;

	/** The last decision, for the HUD's "why did it go there" line. */
	private lastDecision: RouteDecision | null = null;

	/** The last dispatch, so a correction has something to move. */
	private lastDispatch: { decision: RouteDecision; result: VoiceDispatchResult } | null = null;

	/**
	 * Bumped on every utterance and on every teardown. A provider callback whose
	 * turn no longer matches is a straggler from a superseded turn and is
	 * dropped: async providers resolve after the user has already moved on.
	 */
	private turn = 0;
	/** The speech run currently on the floor, or null when nothing is speaking. */
	private activeUtteranceId: string | null = null;

	/**
	 * Timings for the turn being spoken now.
	 *
	 * Started at the DETECTOR's endpoint rather than at the transcript, because the
	 * decode between those two moments is the hop most often to blame and the one a
	 * transcript-anchored timer cannot see. Null between turns.
	 */
	private timer: TurnTimer | null = null;

	constructor(options: VoiceSessionServiceOptions) {
		this.providers = options.providers;
		this.getRoster = options.getRoster ?? (() => []);
		this.executeRoute = options.executeRoute;
		this.maxSpokenSentences = options.maxSpokenSentences ?? DEFAULT_MAX_SPOKEN_SENTENCES;
		this.utteranceHistoryLimit = options.utteranceHistoryLimit ?? DEFAULT_UTTERANCE_HISTORY;
		this.onSpeechChunk = options.onSpeechChunk;
		this.checkReadiness = options.checkReadiness;
		this.getProviderState = options.getProviderState;
		this.pipelineShape = options.pipelineShape ?? 'cascade';
	}

	// -- Subscription --------------------------------------------------------

	/** Subscribe to the event stream. Returns the unsubscribe function. */
	subscribe(listener: VoiceEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getState(): VoiceSessionState {
		return this.state;
	}

	/**
	 * The recogniser this session is feeding, or null when there is no session.
	 *
	 * The audio pipeline reads this per frame rather than capturing the provider,
	 * so a trio rebuilt between sessions cannot leave frames going into a stopped
	 * recogniser. Null while idle is the whole point: audio that arrives with no
	 * session behind it is dropped and counted, never buffered.
	 */
	getActiveStt(): SttProvider | null {
		return this.state === 'idle' ? null : this.providers.stt;
	}

	getSnapshot(): VoiceSessionSnapshot {
		return {
			sessionId: this.sessionId,
			state: this.state,
			scope: this.scope,
			seq: this.seq,
			startedAt: this.startedAt,
			providerIds: {
				stt: this.providers.stt.id,
				tts: this.providers.tts.id,
				brain: this.providers.brain.id,
			},
			lastDecision: this.lastDecision,
			lastDispatch: this.lastDispatch?.result ?? null,
		};
	}

	// -- Lifecycle -----------------------------------------------------------

	/**
	 * Open a session in `scope`. An already-running session is stopped first, so
	 * waking with a different scope switches rather than stacking.
	 *
	 * A provider that cannot start is a classified `provider-unavailable` error,
	 * not a throw: the snapshot comes back in the `error` state.
	 */
	async startSession(params: {
		scope: VoiceScope;
		source?: WakeSource;
	}): Promise<VoiceSessionSnapshot> {
		if (this.state !== 'idle') {
			await this.stopSession('replaced');
		}

		this.sessionId = generateUUID();
		this.scope = params.scope;
		this.seq = 0;
		this.startedAt = Date.now();
		this.recentUtterances = [];
		this.activeUtteranceId = null;
		this.pendingClarification = null;
		this.lastDecision = null;
		this.lastDispatch = null;
		this.turn += 1;

		this.transition('arming');
		this.emit('wake', { source: params.source ?? 'client-button', scope: params.scope });

		// Before the device, not after: a session that opened the microphone and
		// then discovered it has nowhere to send the audio has already cost the user
		// a recording light and an OS permission prompt for nothing.
		const readiness = await this.checkReadiness?.();
		if (readiness && !readiness.canStartSession) {
			const blocked = readiness.blocking[0];
			this.fail(
				'provider-unavailable',
				readinessErrorMessage(readiness) || 'Voice mode is not ready.',
				blocked?.providerId
			);
			return this.getSnapshot();
		}

		try {
			await this.providers.stt.start(this.sttCallbacks());
		} catch (error) {
			if (isVoiceProviderError(error)) {
				this.failFromProvider(error, this.providers.stt.id);
			} else {
				this.fail(
					'provider-unavailable',
					`Speech provider '${this.providers.stt.id}' could not start: ${(error as Error).message}`,
					this.providers.stt.id
				);
			}
			return this.getSnapshot();
		}

		this.transition('listening');
		this.emit('listen-start', { scope: params.scope, sttProviderId: this.providers.stt.id });
		// Immediately after the floor opens, so a client that joined mid-session
		// never has to guess which engines it is actually talking to.
		this.publishProviderState();
		await this.publishRoster();

		return this.getSnapshot();
	}

	/** End the session and release the floor. Safe to call when already idle. */
	async stopSession(reason: VoiceStopReason): Promise<void> {
		if (this.state === 'idle') return;

		this.turn += 1;
		this.cancelSpeech();

		try {
			await this.providers.stt.stop();
		} catch (error) {
			// Teardown failure must not wedge the session in a non-idle state, so
			// it is reported rather than thrown.
			void captureException(error as Error, {
				context: 'acappella.stopSession',
				providerId: this.providers.stt.id,
			});
		}

		this.emit('listen-stop', { reason: reason === 'error' ? 'error' : 'stopped' });
		this.transition('idle');

		this.sessionId = null;
		this.scope = null;
		this.startedAt = null;
		this.recentUtterances = [];
		// A question nobody answered, and a dispatch nobody can correct any more:
		// both belong to the session that just ended.
		this.pendingClarification = null;
		this.lastDispatch = null;
	}

	/**
	 * The stop word. Ends the session from wherever it is. Distinct from
	 * `interrupt()` on purpose: conflating the two makes talking over the
	 * assistant hang up on it.
	 */
	async hardStop(source: InterruptSource = 'voice', phrase?: string): Promise<void> {
		if (this.state === 'idle') return;
		this.emit('stop-word', { source, phrase });
		await this.stopSession('stop-word');
	}

	/**
	 * Barge-in. Cancels speech and KEEPS the floor
	 * (`speaking -> interrupted -> listening`).
	 *
	 * @returns `false` when nothing was speaking, so a stray button press is a
	 *          no-op rather than an error.
	 */
	interrupt(source: InterruptSource = 'voice'): boolean {
		if (this.state !== 'speaking') return false;

		const cancelledUtteranceId = this.activeUtteranceId ?? undefined;
		this.cancelSpeech();

		this.emit('barge-in', { source, cancelledUtteranceId });
		if (cancelledUtteranceId) {
			this.emit('speak-end', { utteranceId: cancelledUtteranceId, reason: 'cancelled' });
		}

		this.transition('interrupted');
		this.transition('listening');
		this.emitListenStart();
		return true;
	}

	// -- Input ---------------------------------------------------------------

	/**
	 * The seam a real STT final transcript lands on, and the one the dev harness
	 * types into. Routed through the provider's `injectUtterance` so the two are
	 * indistinguishable downstream.
	 *
	 * @returns `false` when the session cannot take an utterance right now.
	 */
	submitUtterance(text: string): boolean {
		if (this.state === 'speaking') {
			// An utterance arriving over active speech IS the user talking over it.
			this.interrupt('voice');
		}
		if (this.state === 'dispatching') {
			// The user moved on before the agent replied. Abandon the pending reply
			// and take back the floor.
			this.transition('listening');
			this.emitListenStart();
		}

		if (this.state !== 'listening') {
			logger.warn(`Utterance ignored in state '${this.state}'`, LOG_CONTEXT);
			return false;
		}

		const inject = this.providers.stt.injectUtterance;
		if (!inject) {
			this.fail(
				'provider-unavailable',
				`Speech provider '${this.providers.stt.id}' has no text-in seam`,
				this.providers.stt.id
			);
			return false;
		}

		inject.call(this.providers.stt, text);
		return true;
	}

	/**
	 * An agent answered. Reshapes the text for the ear and speaks it.
	 *
	 * This is the seam Phase 05 wires real agent output to; until then the dev
	 * harness calls it directly.
	 *
	 * @returns `false` when the session was not waiting on a reply.
	 */
	async submitAgentReply(params: {
		agentSessionId: string;
		tabId: string;
		text: string;
	}): Promise<boolean> {
		if (this.state !== 'dispatching') {
			logger.warn(`Agent reply ignored in state '${this.state}'`, LOG_CONTEXT);
			return false;
		}

		const turn = this.turn;
		this.timer?.mark('agentFirstToken');

		let spokenText: string;
		try {
			spokenText = await this.providers.brain.converse(params.text, {
				agentSessionId: params.agentSessionId,
				tabId: params.tabId,
				maxSentences: this.maxSpokenSentences,
			});
		} catch (error) {
			if (!isVoiceProviderError(error)) throw error;
			this.failFromProvider(error, error.providerId);
			return true;
		}
		if (!this.isCurrentTurn(turn)) return false;

		this.emit('agent-reply', {
			agentSessionId: params.agentSessionId,
			tabId: params.tabId,
			text: params.text,
			spokenText,
		});

		const sentenceCount = countSpokenSentences(spokenText);
		if (sentenceCount === 0) {
			// Nothing worth speaking. Take the floor back rather than opening a
			// speech run with no sentences in it.
			this.transition('listening');
			this.emitListenStart();
			return true;
		}

		this.transition('speaking');
		try {
			await this.speak(spokenText, sentenceCount, turn);
		} catch (error) {
			// A streaming voice can throw mid-iteration. Without this the rejection
			// leaves through the caller (an IPC handler) and the session sits in
			// `speaking` holding a floor nothing will ever hand back.
			if (isVoiceProviderError(error)) this.failFromProvider(error, error.providerId);
			else this.closeFloorOnUnexpectedError(error as Error, 'acappella.speak');
		}
		return true;
	}

	// -- Audio telemetry -----------------------------------------------------

	/**
	 * Publish one meter update, already downsampled by
	 * `audio/level-meter.ts`. The service does no rate limiting of its own: the
	 * meter owns the window, and a second opinion here would only mean two places
	 * deciding how often a client hears about the same number.
	 *
	 * Dropped when no session is open - `emit` needs an envelope to stamp, and a
	 * level that belongs to no session belongs nowhere.
	 */
	publishAudioLevel(level: number, speech: boolean): void {
		this.emit('audio-level', { level: clampLevel(level), speech });
	}

	/**
	 * Publish the microphone's state, as projected by `audio/mic-state.ts`.
	 *
	 * Every transition goes out, including the benign ones. The failure this
	 * exists to prevent is a client showing a listening indicator over a
	 * microphone that will never produce a transcript, and that failure is silent
	 * by construction: a denied permission and a quiet room look identical from
	 * the event stream unless something says otherwise.
	 */
	publishMicState(state: MicState): void {
		this.emit('mic-state', { ...state });
	}

	/**
	 * The microphone could not be opened, or was taken away mid-session.
	 *
	 * Parks the session in `error` rather than leaving it listening, because a
	 * listening indicator over a device that will never produce a transcript is
	 * the worst outcome this feature has: the user has no screen to read and hears
	 * nothing back. `recoverable` comes from the classified host code, so the HUD
	 * can offer a privacy-settings button for the failures a user can actually fix
	 * and stay quiet about the ones they cannot.
	 */
	reportAudioCaptureFailure(code: AudioHostErrorCode, message: string): void {
		const translated = audioHostErrorToSessionError({ kind: 'mic-error', code, message });
		this.fail(translated.code, translated.message, undefined, translated.recoverable);
	}

	/**
	 * Announce which engines are live.
	 *
	 * The body is supplied by whoever resolved the pipeline, because the honest
	 * answer includes what the user ASKED for and this file deliberately never
	 * learns that: it is handed a trio and has no idea whether it is the configured
	 * one. Without a supplier this is a no-op, which is the mock tier's case.
	 */
	publishProviderState(): void {
		const state = this.getProviderState?.();
		if (!state) return;
		this.emit('provider-state', state);
	}

	/** Re-read the roster and push it to every client. */
	async publishRoster(): Promise<RosterAgent[]> {
		const roster = await this.getRoster();
		this.emit('agent-roster', { agents: roster });
		return roster;
	}

	/** Stop the session and drop every subscriber. Called on app shutdown. */
	async dispose(): Promise<void> {
		await this.stopSession('shutdown');
		this.listeners.clear();
	}

	// -- Turn pipeline -------------------------------------------------------

	/**
	 * The detector heard the user stop talking.
	 *
	 * The zero point for the turn's timings. Wired from the audio pipeline, which
	 * is the only place that instant is known: everything downstream sees the
	 * consequences (a flush, then a transcript) rather than the moment itself.
	 */
	noteSpeechEnd(): void {
		if (this.state !== 'listening') return;
		this.timer = new TurnTimer(generateUUID(), {
			pipeline: this.pipelineShape,
			providerIds: {
				stt: this.providers.stt.id,
				tts: this.providers.tts.id,
				brain: this.providers.brain.id,
			},
		});
	}

	private sttCallbacks(): SttCallbacks {
		return {
			onPartial: (text, stability) => {
				if (this.state !== 'listening') return;
				this.timer?.mark('firstPartial');
				this.emit('partial-transcript', { text, stability });
			},
			onFinal: (text, confidence, durationMs) => {
				if (this.state !== 'listening') return;
				void this.runTurn(text, confidence, durationMs);
			},
			onError: (error) => {
				this.failFromProvider(error, this.providers.stt.id);
			},
		};
	}

	/**
	 * One utterance, end to end: transcript, routing, dispatch. Only the three
	 * classified failure modes become `session-error` events.
	 *
	 * Anything else is a bug and goes to Sentry explicitly rather than by
	 * bubbling: this runs from a provider callback with no caller to bubble to,
	 * so an escaping rejection would arrive at the process handler stripped of
	 * the session context, and would leave the HUD frozen mid-turn.
	 */
	private async runTurn(text: string, confidence: number, durationMs?: number): Promise<void> {
		const turn = ++this.turn;

		try {
			this.timer?.mark('finalTranscript');
			this.emit('final-transcript', { text, confidence, durationMs });
			this.transition('transcribing');

			const utterance = text.trim();
			if (!utterance) {
				this.transition('listening');
				this.emitListenStart();
				return;
			}

			this.rememberUtterance(utterance);
			this.transition('routing');

			const roster = await this.publishRoster();
			if (!this.isCurrentTurn(turn)) return;

			// A correction is not a request, so it never reaches the Brain: "no, the
			// other one" routed as an utterance becomes a prompt, and the agent it
			// lands in has no idea what it refers to.
			if (this.lastDispatch && isCorrectionUtterance(utterance)) {
				await this.runCorrection(roster, turn);
				return;
			}

			const startedAt = Date.now();
			const context = this.routeContext(roster);
			const decision = await this.providers.brain.route(utterance, context);
			if (!this.isCurrentTurn(turn)) return;

			const targetId = routeTargetSessionId(decision.target);
			if (targetId && !roster.some((agent) => agent.sessionId === targetId)) {
				this.fail('no-agent-matched', `No agent with id '${targetId}' is running`);
				return;
			}

			this.timer?.mark('routeDecision');
			this.lastDecision = decision;
			this.emit('route-decision', {
				decision,
				brainProviderId: this.providers.brain.id,
				latencyMs: Date.now() - startedAt,
			});

			if (isClarification(decision)) {
				// The router is not sure enough to act. Ask, remember what the question
				// was about, and hand the floor straight back: the answer arrives as the
				// next utterance and routes the ORIGINAL request.
				await this.askForClarification(decision, context, utterance, turn);
				return;
			}

			this.transition('dispatching');
			await this.dispatch(decision, roster, turn);
		} catch (error) {
			// A provider that predicted its own failure is announced, not reported: it
			// has a message written for the user and a recovery to go with it.
			// Anything else is a bug and keeps the Sentry path.
			if (isVoiceProviderError(error)) {
				this.failFromProvider(error, error.providerId);
				return;
			}
			this.closeFloorOnUnexpectedError(error as Error, 'acappella.runTurn');
		}
	}

	/**
	 * Perform the decision and announce what happened. The session stays in
	 * `dispatching` afterwards, holding the turn open for the agent's reply.
	 */
	private async dispatch(
		decision: RouteDecision,
		roster: RosterAgent[],
		turn: number
	): Promise<void> {
		if (!this.executeRoute) {
			this.fail('dispatch-failed', 'No route executor is configured for this session');
			return;
		}

		let result: VoiceDispatchResult;
		try {
			result = await this.executeRoute(decision, {
				roster,
				scope: this.scope ?? { kind: 'conductor' },
			});
		} catch (error) {
			// Only the executor's own classified failure is an event. Anything else
			// is a bug and belongs in Sentry.
			if (!(error instanceof VoiceDispatchError)) throw error;
			this.fail('dispatch-failed', error.message);
			return;
		}

		if (!this.isCurrentTurn(turn)) return;
		// Remembered so "no, the other one" has something to move, and so the HUD
		// can show where the last thing went.
		this.lastDispatch = { decision, result };
		this.emit('dispatch', result);
	}

	/**
	 * Ask the disambiguation out loud and take the floor back.
	 *
	 * The pending clarification is remembered rather than the question being
	 * re-derived next turn, because the ANSWER is a fragment: "the API one" routed
	 * on its own creates a tab called "the API one". The original utterance rides
	 * along so the next turn routes the request the user actually made.
	 */
	private async askForClarification(
		decision: RouteDecision,
		context: VoiceRouteContext,
		utterance: string,
		turn: number
	): Promise<void> {
		const question = decision.clarify?.trim();
		if (!question) return;

		this.pendingClarification = {
			question,
			// A clarification of a clarification is still about the ORIGINAL request.
			utterance: context.clarification?.utterance ?? utterance,
		};

		this.transition('speaking');
		try {
			await this.speak(question, countSpokenSentences(question) || 1, turn);
		} catch (error) {
			if (isVoiceProviderError(error)) this.failFromProvider(error, error.providerId);
			else this.closeFloorOnUnexpectedError(error as Error, 'acappella.askForClarification');
		}
	}

	/**
	 * Move the last dispatch somewhere else, on the user's say-so.
	 *
	 * Its own event rather than a second `dispatch`: the two mean opposite things
	 * to the routing log, and a correction counted as a hit would make a router
	 * that is wrong half the time look perfect.
	 */
	private async runCorrection(roster: RosterAgent[], turn: number): Promise<void> {
		const previous = this.lastDispatch;
		if (!previous) return;

		const plan = planCorrection(roster, previous.result.agentSessionId);
		if (plan.kind === 'ask') {
			await this.askForClarification(
				{ ...previous.decision, clarify: plan.question },
				this.routeContext(roster),
				previous.decision.prompt,
				turn
			);
			return;
		}

		this.transition('dispatching');
		await this.correctTo(plan.agentSessionId, roster, turn, 'voice');
	}

	/**
	 * Re-dispatch the last prompt to a different agent.
	 *
	 * The prompt is the one that was actually sent, not the raw utterance: the
	 * user is moving a request they already made, and re-deriving it would send
	 * the wrong agent a differently worded question.
	 *
	 * @returns false when there is nothing to correct.
	 */
	async correctLastDispatch(
		agentSessionId: string,
		source: InterruptSource = 'client-button'
	): Promise<boolean> {
		if (!this.lastDispatch) return false;
		if (this.state !== 'listening' && this.state !== 'dispatching' && this.state !== 'speaking') {
			return false;
		}
		if (this.state === 'speaking') this.interrupt(source);

		const roster = await this.publishRoster();
		const turn = ++this.turn;
		this.walkToDispatching();

		return this.correctTo(agentSessionId, roster, turn, source);
	}

	/**
	 * Take the session from wherever it is to `dispatching`, one legal edge at a
	 * time.
	 *
	 * A correction arrives from a button rather than from a turn, so it can start
	 * in `listening` with the whole transcribe-and-route path still in front of
	 * it. The machine has no shortcut edge and should not grow one for a case that
	 * is three legal transitions away.
	 */
	private walkToDispatching(): void {
		const path: VoiceSessionState[] = ['transcribing', 'routing', 'dispatching'];
		for (const next of path) {
			if (this.state === 'dispatching') return;
			if (canTransitionVoiceState(this.state, next)) this.transition(next);
		}
	}

	private async correctTo(
		agentSessionId: string,
		roster: RosterAgent[],
		turn: number,
		source: InterruptSource
	): Promise<boolean> {
		const previous = this.lastDispatch;
		if (!previous) return false;

		const decision: RouteDecision = {
			target: { sessionId: agentSessionId },
			// The corrected target's own current tab: the tab id from the wrong agent
			// means nothing on the right one.
			tabAction: 'current',
			prompt: previous.decision.prompt,
			confidence: 1,
		};

		if (!this.executeRoute) {
			this.fail('dispatch-failed', 'No route executor is configured for this session');
			return false;
		}

		let result: VoiceDispatchResult;
		try {
			result = await this.executeRoute(decision, {
				roster,
				scope: this.scope ?? { kind: 'conductor' },
			});
		} catch (error) {
			if (!(error instanceof VoiceDispatchError)) throw error;
			this.fail('dispatch-failed', error.message);
			return false;
		}

		if (!this.isCurrentTurn(turn)) return false;

		this.emit('route-correction', {
			fromAgentSessionId: previous.result.agentSessionId,
			fromTabId: previous.result.tabId,
			agentSessionId: result.agentSessionId,
			agentName: result.agentName,
			tabId: result.tabId,
			tabName: result.tabName,
			action: result.action,
			promptSent: result.promptSent,
			source,
		});
		this.lastDispatch = { decision, result };
		return true;
	}

	/** Stream one reply through TTS, one event per sentence. */
	private async speak(spokenText: string, sentenceCount: number, turn: number): Promise<void> {
		const utteranceId = generateUUID();
		this.activeUtteranceId = utteranceId;

		this.emit('speak-start', {
			utteranceId,
			sentenceCount,
			ttsProviderId: this.providers.tts.id,
		});

		for await (const chunk of this.providers.tts.speak(spokenText, { utteranceId })) {
			// A cancelled run's stragglers are dropped: `interrupt()` already
			// emitted `speak-end` and handed the floor back.
			if (!this.isCurrentTurn(turn) || this.activeUtteranceId !== utteranceId) return;
			this.timer?.mark('firstSpokenSentence');
			this.emit('speak-sentence', { utteranceId, index: chunk.index, text: chunk.text });
			// After the event, not before: the sentence should be on screen by the
			// time it is audible, never the other way round.
			this.onSpeechChunk?.(chunk);
		}

		if (!this.isCurrentTurn(turn) || this.activeUtteranceId !== utteranceId) return;

		this.activeUtteranceId = null;
		this.emit('speak-end', { utteranceId, reason: 'complete' });
		this.closeTurnMetrics();
		this.transition('listening');
		this.emitListenStart();
	}

	/**
	 * Close the current turn's timings and file them.
	 *
	 * Only a turn that reached spoken audio is recorded: a turn abandoned by a
	 * barge-in has a "total" that measures how long the user waited before giving
	 * up, and averaging that into the latency history would make an impatient user
	 * look like a slow provider.
	 */
	private closeTurnMetrics(): void {
		const timer = this.timer;
		this.timer = null;
		if (!timer) return;
		recordTurn(timer.finish());
	}

	// -- Internals -----------------------------------------------------------

	private routeContext(roster: RosterAgent[]): VoiceRouteContext {
		const scope = this.scope ?? { kind: 'conductor' };
		// Consumed here, not on the next turn: a question that was asked and then
		// abandoned must not reinterpret an unrelated sentence later on.
		const clarification = this.pendingClarification ?? undefined;
		this.pendingClarification = null;

		return {
			roster,
			scope,
			activeAgentSessionId: scope.kind === 'agent' ? scope.sessionId : null,
			recentUtterances: [...this.recentUtterances],
			clarification,
		};
	}

	private rememberUtterance(utterance: string): void {
		this.recentUtterances.push(utterance);
		if (this.recentUtterances.length > this.utteranceHistoryLimit) {
			this.recentUtterances.shift();
		}
	}

	private isCurrentTurn(turn: number): boolean {
		return this.turn === turn && this.sessionId !== null;
	}

	/** Cancel any speech run without emitting. Callers own the events. */
	private cancelSpeech(): void {
		if (!this.activeUtteranceId) return;
		this.activeUtteranceId = null;
		this.providers.tts.cancel();
	}

	private transition(to: VoiceSessionState): void {
		assertVoiceStateTransition(this.state, to);
		this.state = to;
	}

	private emitListenStart(): void {
		this.emit('listen-start', {
			scope: this.scope ?? { kind: 'conductor' },
			sttProviderId: this.providers.stt.id,
		});
	}

	/** Classified failure: announce it and park the session in `error`. */
	private fail(
		code: VoiceSessionErrorCode,
		message: string,
		providerId?: string,
		// Most codes answer this from the code alone. A capture failure does not:
		// a denied permission is fixable and a machine with no audio stack is not,
		// and both arrive as `audio-capture-failed`.
		recoverable = code !== 'provider-unavailable'
	): void {
		logger.warn(`Voice session error (${code}): ${message}`, LOG_CONTEXT);
		// A provider callback can fire after teardown; there is no session left to
		// move into `error` and no envelope to stamp the event with.
		if (!this.sessionId || this.state === 'idle' || this.state === 'error') return;

		this.emit('session-error', {
			code,
			message,
			recoverable,
			providerId,
		});
		this.transition('error');
	}

	/**
	 * A provider reported a failure it predicted.
	 *
	 * The error carries its own protocol code (auth, quota, network, or plain
	 * unavailable), its own recoverable flag, and a message written for someone
	 * with no screen in front of them. Collapsing all four into
	 * `provider-unavailable` would tell a user with an expired API key to go and
	 * download a model.
	 */
	private failFromProvider(error: Error, providerId?: string): void {
		if (!isVoiceProviderError(error)) {
			this.fail('provider-unavailable', error.message, providerId);
			return;
		}
		const failure: VoiceProviderError = error;
		this.fail(
			failure.sessionErrorCode,
			failure.message,
			providerId ?? failure.providerId,
			failure.recoverable
		);
	}

	/**
	 * An unexpected exception escaped the turn. Report it with the session
	 * context Sentry would otherwise lose, then close the floor honestly so the
	 * HUD is not stuck mid-turn.
	 */
	private closeFloorOnUnexpectedError(error: Error, context: string): void {
		logger.error(`Unexpected voice session failure: ${error.message}`, LOG_CONTEXT);
		void captureException(error, {
			context,
			voiceSessionId: this.sessionId,
			state: this.state,
		});
		if (this.state === 'idle' || this.state === 'error') return;
		this.cancelSpeech();
		this.emit('listen-stop', { reason: 'error' });
		this.transition('error');
	}

	/** Stamp `sessionId`, `seq`, and `ts`, then fan out to every subscriber. */
	private emit<T extends VoiceEventType>(type: T, body: VoiceEventBody<T>): void {
		if (!this.sessionId) return;

		// The spread is provably a `VoiceEvent` for each concrete `T`, but TypeScript
		// cannot narrow a generic discriminant, hence the assertion.
		const event = {
			...body,
			type,
			sessionId: this.sessionId,
			seq: ++this.seq,
			ts: Date.now(),
		} as unknown as VoiceEvent;

		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch (error) {
				// One broken client must not stop the stream reaching the others.
				void captureException(error as Error, {
					context: 'acappella.emit',
					eventType: type,
				});
			}
		}
	}
}

/** A meter value out of range is clamped rather than published: it is only a bar. */
function clampLevel(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return value < 0 ? 0 : value > 1 ? 1 : value;
}
