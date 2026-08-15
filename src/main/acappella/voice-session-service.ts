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
	RosterAgent,
	VoiceEvent,
	VoiceEventBase,
	VoiceEventType,
	VoiceScope,
	VoiceSessionErrorCode,
	WakeSource,
} from '../../shared/acappella/protocol';
import type { RouteDecision } from '../../shared/acappella/route-decision';
import { routeTargetSessionId } from '../../shared/acappella/route-decision';
import type {
	SttCallbacks,
	VoiceProviderTrio,
	VoiceRouteContext,
} from '../../shared/acappella/providers';
import type { VoiceSessionState } from '../../shared/acappella/session-state';
import { assertVoiceStateTransition } from '../../shared/acappella/session-state';
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

/** Why a session ended. Maps onto `ListenStopEvent.reason` on the way out. */
export type VoiceStopReason = 'user' | 'stop-word' | 'replaced' | 'shutdown' | 'error';

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
	/** Current agents and their tabs. Defaults to an empty roster. */
	getRoster?: () => RosterAgent[] | Promise<RosterAgent[]>;
	/** Executes route decisions. Absent until the executor is wired. */
	executeRoute?: VoiceRouteExecutor;
	/** Spoken-form budget handed to `BrainProvider.converse()`. */
	maxSpokenSentences?: number;
	/** Utterances retained for `VoiceRouteContext.recentUtterances`. */
	utteranceHistoryLimit?: number;
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

	private readonly listeners = new Set<VoiceEventListener>();

	private state: VoiceSessionState = 'idle';
	private sessionId: string | null = null;
	private scope: VoiceScope | null = null;
	private seq = 0;
	private startedAt: number | null = null;

	private recentUtterances: string[] = [];

	/**
	 * Bumped on every utterance and on every teardown. A provider callback whose
	 * turn no longer matches is a straggler from a superseded turn and is
	 * dropped: async providers resolve after the user has already moved on.
	 */
	private turn = 0;
	/** The speech run currently on the floor, or null when nothing is speaking. */
	private activeUtteranceId: string | null = null;

	constructor(options: VoiceSessionServiceOptions) {
		this.providers = options.providers;
		this.getRoster = options.getRoster ?? (() => []);
		this.executeRoute = options.executeRoute;
		this.maxSpokenSentences = options.maxSpokenSentences ?? DEFAULT_MAX_SPOKEN_SENTENCES;
		this.utteranceHistoryLimit = options.utteranceHistoryLimit ?? DEFAULT_UTTERANCE_HISTORY;
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
		this.turn += 1;

		this.transition('arming');
		this.emit('wake', { source: params.source ?? 'client-button', scope: params.scope });

		try {
			await this.providers.stt.start(this.sttCallbacks());
		} catch (error) {
			this.fail(
				'provider-unavailable',
				`Speech provider '${this.providers.stt.id}' could not start: ${(error as Error).message}`,
				this.providers.stt.id
			);
			return this.getSnapshot();
		}

		this.transition('listening');
		this.emit('listen-start', { scope: params.scope, sttProviderId: this.providers.stt.id });
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
		const spokenText = await this.providers.brain.converse(params.text, {
			agentSessionId: params.agentSessionId,
			tabId: params.tabId,
			maxSentences: this.maxSpokenSentences,
		});
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
			this.closeFloorOnUnexpectedError(error as Error, 'acappella.speak');
		}
		return true;
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

	private sttCallbacks(): SttCallbacks {
		return {
			onPartial: (text, stability) => {
				if (this.state !== 'listening') return;
				this.emit('partial-transcript', { text, stability });
			},
			onFinal: (text, confidence, durationMs) => {
				if (this.state !== 'listening') return;
				void this.runTurn(text, confidence, durationMs);
			},
			onError: (error) => {
				this.fail('provider-unavailable', error.message, this.providers.stt.id);
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

			const startedAt = Date.now();
			const decision = await this.providers.brain.route(utterance, this.routeContext(roster));
			if (!this.isCurrentTurn(turn)) return;

			const targetId = routeTargetSessionId(decision.target);
			if (targetId && !roster.some((agent) => agent.sessionId === targetId)) {
				this.fail('no-agent-matched', `No agent with id '${targetId}' is running`);
				return;
			}

			this.emit('route-decision', {
				decision,
				brainProviderId: this.providers.brain.id,
				latencyMs: Date.now() - startedAt,
			});
			this.transition('dispatching');

			await this.dispatch(decision, roster, turn);
		} catch (error) {
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
		this.emit('dispatch', result);
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
			this.emit('speak-sentence', { utteranceId, index: chunk.index, text: chunk.text });
		}

		if (!this.isCurrentTurn(turn) || this.activeUtteranceId !== utteranceId) return;

		this.activeUtteranceId = null;
		this.emit('speak-end', { utteranceId, reason: 'complete' });
		this.transition('listening');
		this.emitListenStart();
	}

	// -- Internals -----------------------------------------------------------

	private routeContext(roster: RosterAgent[]): VoiceRouteContext {
		const scope = this.scope ?? { kind: 'conductor' };
		return {
			roster,
			scope,
			activeAgentSessionId: scope.kind === 'agent' ? scope.sessionId : null,
			recentUtterances: [...this.recentUtterances],
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
	private fail(code: VoiceSessionErrorCode, message: string, providerId?: string): void {
		logger.warn(`Voice session error (${code}): ${message}`, LOG_CONTEXT);
		// A provider callback can fire after teardown; there is no session left to
		// move into `error` and no envelope to stamp the event with.
		if (!this.sessionId || this.state === 'idle' || this.state === 'error') return;

		this.emit('session-error', {
			code,
			message,
			recoverable: code !== 'provider-unavailable',
			providerId,
		});
		this.transition('error');
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
