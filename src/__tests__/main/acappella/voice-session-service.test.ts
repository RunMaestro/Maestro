/**
 * @file voice-session-service.test.ts
 *
 * Unit tests for the headless voice session service: the wake -> listen ->
 * transcribe -> route -> dispatch -> speak pipeline, monotonic `seq`, the
 * barge-in / stop distinction, and the classified failure modes.
 *
 * No electron, no providers, no timers: a fake trio drives the pipeline
 * synchronously so every assertion is about the service's own sequencing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * Every transition the service takes, recorded in order.
 *
 * `transition()` is private and most edges are invisible in the event stream
 * (`transcribing` and `routing` emit nothing of their own), so the only honest
 * way to prove which edges the pipeline actually walks is to wrap the shared
 * assertion the service routes all of them through. The wrapper still delegates,
 * so an illegal edge throws exactly as it would in production.
 */
const transitionLog = vi.hoisted(() => ({ edges: [] as string[] }));

vi.mock('../../../shared/acappella/session-state', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../shared/acappella/session-state')>();
	return {
		...actual,
		assertVoiceStateTransition: (from: string, to: string) => {
			transitionLog.edges.push(`${from} -> ${to}`);
			actual.assertVoiceStateTransition(from as VoiceSessionState, to as VoiceSessionState);
		},
	};
});

import { captureException } from '../../../main/utils/sentry';
import {
	VoiceSessionService,
	VoiceDispatchError,
	type VoiceDispatchResult,
	type VoiceRouteExecutor,
} from '../../../main/acappella/voice-session-service';
import type { RosterAgent, VoiceEvent, VoiceEventType } from '../../../shared/acappella/protocol';
import type {
	BrainProvider,
	SttCallbacks,
	SttProvider,
	TtsChunk,
	TtsProvider,
	VoiceConverseContext,
	VoiceProviderTrio,
	VoiceRouteContext,
} from '../../../shared/acappella/providers';
import type { RouteDecision } from '../../../shared/acappella/route-decision';
import { splitIntoSpokenSentences } from '../../../shared/acappella/sentences';
import {
	InvalidVoiceStateTransitionError,
	VOICE_STATE_TRANSITIONS,
	type VoiceSessionState,
} from '../../../shared/acappella/session-state';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Text-in STT: two partials then a final, exactly like the mock tier will. */
class FakeStt implements SttProvider {
	readonly id = 'fake-stt';
	readonly label = 'Fake STT';
	readonly tier = 'mock' as const;
	readonly sampleRate = 16_000;
	readonly acceptsAudio = false;

	callbacks: SttCallbacks | null = null;
	started = false;
	stopped = false;
	/** When set, `start()` rejects with it. */
	startError: Error | null = null;

	async start(callbacks: SttCallbacks): Promise<void> {
		if (this.startError) throw this.startError;
		this.callbacks = callbacks;
		this.started = true;
	}
	feed(): void {}
	async flush(): Promise<void> {}
	async stop(): Promise<void> {
		this.stopped = true;
	}
	injectUtterance(text: string): void {
		this.callbacks?.onPartial(text.slice(0, Math.ceil(text.length / 3)), 0.3);
		this.callbacks?.onPartial(text.slice(0, Math.ceil((text.length * 2) / 3)), 0.7);
		this.callbacks?.onFinal(text, 0.95);
	}
}

class FakeBrain implements BrainProvider {
	readonly id = 'fake-brain';
	readonly label = 'Fake Brain';
	readonly tier = 'mock' as const;

	decision: RouteDecision = {
		target: 'conductor',
		tabAction: 'current',
		prompt: 'hello',
		confidence: 0.9,
	};
	spoken = 'All done. Two files changed.';
	routeError: Error | null = null;
	/** When set, `route()` parks here, so a test can act while the brain thinks. */
	routeGate: Promise<void> | null = null;

	async route(_input: string, _context: VoiceRouteContext): Promise<RouteDecision> {
		if (this.routeGate) await this.routeGate;
		if (this.routeError) throw this.routeError;
		return this.decision;
	}
	async converse(_agentText: string, _context: VoiceConverseContext): Promise<string> {
		return this.spoken;
	}
}

/**
 * Yields one chunk per sentence, checking a cancel flag between them so
 * `cancel()` cuts the run off rather than draining it.
 */
class FakeTts implements TtsProvider {
	readonly id = 'fake-tts';
	readonly label = 'Fake TTS';
	readonly tier = 'mock' as const;

	cancelled = false;
	/** Called after each chunk, so a test can interrupt mid-run. */
	onChunk: (() => void) | null = null;
	/** Thrown from inside the iterator, the way a streaming cloud voice fails. */
	speakError: Error | null = null;

	speak(text: string, options: { utteranceId: string }): AsyncIterable<TtsChunk> {
		this.cancelled = false;
		const sentences = splitIntoSpokenSentences(text);
		const self = this;
		return {
			async *[Symbol.asyncIterator]() {
				for (let index = 0; index < sentences.length; index++) {
					if (self.cancelled) return;
					if (self.speakError) throw self.speakError;
					yield {
						utteranceId: options.utteranceId,
						index,
						text: sentences[index],
						format: 'none' as const,
						audio: null,
					};
					self.onChunk?.();
				}
			},
		};
	}
	cancel(): void {
		this.cancelled = true;
	}
}

function makeRoster(): RosterAgent[] {
	return [
		{
			sessionId: 'agent-backend',
			name: 'Backend',
			agentType: 'claude-code',
			cwd: '/repo',
			tabs: [{ id: 'tab-1', name: 'Auth', lastActiveAt: 1 }],
		},
	];
}

interface Harness {
	service: VoiceSessionService;
	stt: FakeStt;
	tts: FakeTts;
	brain: FakeBrain;
	events: VoiceEvent[];
	types: () => VoiceEventType[];
	executor: ReturnType<typeof vi.fn>;
}

function makeHarness(
	overrides: { executeRoute?: VoiceRouteExecutor; onSpeechChunk?: (chunk: TtsChunk) => void } = {}
): Harness {
	const stt = new FakeStt();
	const tts = new FakeTts();
	const brain = new FakeBrain();
	const providers: VoiceProviderTrio = { stt, tts, brain };

	const dispatchResult: VoiceDispatchResult = {
		agentSessionId: 'agent-backend',
		agentName: 'Backend',
		tabId: 'tab-1',
		action: 'focused',
		promptSent: true,
	};
	const executor = vi.fn(async () => dispatchResult);

	const service = new VoiceSessionService({
		providers,
		getRoster: () => makeRoster(),
		executeRoute: overrides.executeRoute ?? (executor as unknown as VoiceRouteExecutor),
		onSpeechChunk: overrides.onSpeechChunk,
	});

	const events: VoiceEvent[] = [];
	service.subscribe((event) => events.push(event));

	return { service, stt, tts, brain, events, types: () => events.map((e) => e.type), executor };
}

/** Start a session and drain the events emitted by startup. */
async function start(h: Harness): Promise<void> {
	await h.service.startSession({ scope: { kind: 'conductor' }, source: 'hotkey' });
	h.events.length = 0;
	takeEdges();
}

/** Read and clear the recorded transitions. */
function takeEdges(): string[] {
	return transitionLog.edges.splice(0, transitionLog.edges.length);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoiceSessionService lifecycle', () => {
	let h: Harness;

	beforeEach(() => {
		h = makeHarness();
	});

	it('starts idle with no session', () => {
		const snapshot = h.service.getSnapshot();
		expect(snapshot.state).toBe('idle');
		expect(snapshot.sessionId).toBeNull();
		expect(snapshot.providerIds).toEqual({ stt: 'fake-stt', tts: 'fake-tts', brain: 'fake-brain' });
	});

	it('wakes into listening and announces the provider', async () => {
		const snapshot = await h.service.startSession({
			scope: { kind: 'agent', sessionId: 'agent-backend' },
			source: 'wake-word',
		});

		expect(snapshot.state).toBe('listening');
		expect(snapshot.sessionId).toBeTruthy();
		expect(h.stt.started).toBe(true);
		expect(h.types()).toEqual(['wake', 'listen-start', 'agent-roster']);

		const listenStart = h.events[1];
		expect(listenStart.type === 'listen-start' && listenStart.sttProviderId).toBe('fake-stt');
	});

	it('stamps every event with the session id and a monotonic seq', async () => {
		await start(h);
		h.service.submitUtterance('do the thing');
		await vi.waitFor(() => expect(h.types()).toContain('dispatch'));

		const sessionId = h.service.getSnapshot().sessionId;
		expect(new Set(h.events.map((e) => e.sessionId))).toEqual(new Set([sessionId]));

		const seqs = h.events.map((e) => e.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
	});

	it('resets seq when a new session replaces the old one', async () => {
		await start(h);
		await h.service.stopSession('user');
		h.events.length = 0;

		await h.service.startSession({ scope: { kind: 'conductor' } });
		expect(h.events[0].seq).toBe(1);
	});

	it('replaces a running session rather than stacking one', async () => {
		await start(h);
		const first = h.service.getSnapshot().sessionId;

		await h.service.startSession({ scope: { kind: 'agent', sessionId: 'agent-backend' } });
		expect(h.service.getSnapshot().sessionId).not.toBe(first);
		expect(h.service.getState()).toBe('listening');
		expect(h.types()).toContain('listen-stop');
	});

	it('stops back to idle and releases the provider', async () => {
		await start(h);
		await h.service.stopSession('user');

		expect(h.service.getState()).toBe('idle');
		expect(h.service.getSnapshot().sessionId).toBeNull();
		expect(h.stt.stopped).toBe(true);
		expect(h.types()).toEqual(['listen-stop']);
	});

	it('ignores stopSession when already idle', async () => {
		await h.service.stopSession('user');
		expect(h.events).toHaveLength(0);
	});
});

describe('VoiceSessionService turn pipeline', () => {
	let h: Harness;

	beforeEach(async () => {
		h = makeHarness();
		await start(h);
	});

	it('runs partials, final, routing, and dispatch in order', async () => {
		h.service.submitUtterance('open the auth tab');
		await vi.waitFor(() => expect(h.types()).toContain('dispatch'));

		expect(h.types()).toEqual([
			'partial-transcript',
			'partial-transcript',
			'final-transcript',
			'agent-roster',
			'route-decision',
			'dispatch',
		]);
		expect(h.service.getState()).toBe('dispatching');
	});

	it('passes the roster and recent utterances to the brain', async () => {
		const spy = vi.spyOn(h.brain, 'route');
		h.service.submitUtterance('first thing');
		await vi.waitFor(() => expect(h.types()).toContain('dispatch'));

		const context = spy.mock.calls[0][1];
		expect(context.roster.map((agent) => agent.sessionId)).toEqual(['agent-backend']);
		expect(context.recentUtterances).toEqual(['first thing']);
	});

	it('returns to listening on an empty utterance', async () => {
		h.service.submitUtterance('   ');
		await vi.waitFor(() => expect(h.types()).toContain('listen-start'));

		expect(h.service.getState()).toBe('listening');
		expect(h.types()).not.toContain('route-decision');
	});

	it('refuses an utterance that arrives in a state that cannot take one', async () => {
		await h.service.stopSession('user');
		expect(h.service.submitUtterance('too late')).toBe(false);
	});

	it('abandons a pending reply when the user speaks again', async () => {
		h.service.submitUtterance('first');
		await vi.waitFor(() => expect(h.service.getState()).toBe('dispatching'));

		h.events.length = 0;
		expect(h.service.submitUtterance('second')).toBe(true);
		await vi.waitFor(() => expect(h.types()).toContain('dispatch'));
		expect(h.events[0].type).toBe('listen-start');
	});
});

describe('VoiceSessionService speech', () => {
	let h: Harness;

	beforeEach(async () => {
		h = makeHarness();
		await start(h);
		h.service.submitUtterance('what changed');
		await vi.waitFor(() => expect(h.service.getState()).toBe('dispatching'));
		h.events.length = 0;
	});

	it('speaks a reply sentence by sentence and returns the floor', async () => {
		await h.service.submitAgentReply({
			agentSessionId: 'agent-backend',
			tabId: 'tab-1',
			text: 'Raw terminal output.',
		});

		expect(h.types()).toEqual([
			'agent-reply',
			'speak-start',
			'speak-sentence',
			'speak-sentence',
			'speak-end',
			'listen-start',
		]);

		const start = h.events[1];
		expect(start.type === 'speak-start' && start.sentenceCount).toBe(2);
		const sentences = h.events.filter((e) => e.type === 'speak-sentence');
		expect(sentences.map((e) => (e.type === 'speak-sentence' ? e.text : ''))).toEqual([
			'All done.',
			'Two files changed.',
		]);
		expect(h.service.getState()).toBe('listening');
	});

	it('skips the speech run when there is nothing worth speaking', async () => {
		h.brain.spoken = '   ';
		await h.service.submitAgentReply({
			agentSessionId: 'agent-backend',
			tabId: 'tab-1',
			text: 'noise',
		});

		expect(h.types()).toEqual(['agent-reply', 'listen-start']);
		expect(h.service.getState()).toBe('listening');
	});

	it('ignores a reply that arrives when nothing was dispatched', async () => {
		await h.service.stopSession('user');
		const accepted = await h.service.submitAgentReply({
			agentSessionId: 'agent-backend',
			tabId: 'tab-1',
			text: 'late',
		});
		expect(accepted).toBe(false);
	});
});

describe('VoiceSessionService barge-in versus stop', () => {
	let h: Harness;

	beforeEach(async () => {
		h = makeHarness();
		await start(h);
		h.service.submitUtterance('what changed');
		await vi.waitFor(() => expect(h.service.getState()).toBe('dispatching'));
		h.events.length = 0;
	});

	it('barge-in cancels speech mid-run and keeps the floor', async () => {
		h.tts.onChunk = () => {
			h.service.interrupt('voice');
		};

		await h.service.submitAgentReply({
			agentSessionId: 'agent-backend',
			tabId: 'tab-1',
			text: 'anything',
		});

		expect(h.types()).toEqual([
			'agent-reply',
			'speak-start',
			'speak-sentence',
			'barge-in',
			'speak-end',
			'listen-start',
		]);
		const end = h.events.find((e) => e.type === 'speak-end');
		expect(end?.type === 'speak-end' && end.reason).toBe('cancelled');
		expect(h.tts.cancelled).toBe(true);
		// The floor is retained: still in session, still listening.
		expect(h.service.getState()).toBe('listening');
		expect(h.service.getSnapshot().sessionId).toBeTruthy();
	});

	it('barge-in is a no-op when nothing is speaking', () => {
		expect(h.service.interrupt('client-button')).toBe(false);
		expect(h.events).toHaveLength(0);
	});

	it('the stop word ends the session from any state', async () => {
		await h.service.hardStop('voice', 'never mind');

		expect(h.types()).toEqual(['stop-word', 'listen-stop']);
		expect(h.service.getState()).toBe('idle');
		expect(h.service.getSnapshot().sessionId).toBeNull();
		expect(h.stt.stopped).toBe(true);
	});

	it('the stop word cancels speech on the way out', async () => {
		h.tts.onChunk = () => {
			void h.service.hardStop('voice');
		};
		await h.service.submitAgentReply({
			agentSessionId: 'agent-backend',
			tabId: 'tab-1',
			text: 'anything',
		});

		expect(h.tts.cancelled).toBe(true);
		expect(h.service.getState()).toBe('idle');
	});
});

describe('VoiceSessionService classified failures', () => {
	it('reports a provider that cannot start', async () => {
		const h = makeHarness();
		h.stt.startError = new Error('microphone busy');

		const snapshot = await h.service.startSession({ scope: { kind: 'conductor' } });

		expect(snapshot.state).toBe('error');
		expect(h.types()).toEqual(['wake', 'session-error']);
		const error = h.events[1];
		expect(error.type === 'session-error' && error.code).toBe('provider-unavailable');
		expect(error.type === 'session-error' && error.providerId).toBe('fake-stt');
	});

	it('reports a decision that targets an agent which is not running', async () => {
		const h = makeHarness();
		await start(h);
		h.brain.decision = {
			target: { sessionId: 'agent-ghost' },
			tabAction: 'current',
			prompt: 'hi',
			confidence: 0.5,
		};

		h.service.submitUtterance('talk to the ghost');
		await vi.waitFor(() => expect(h.types()).toContain('session-error'));

		const error = h.events.find((e) => e.type === 'session-error');
		expect(error?.type === 'session-error' && error.code).toBe('no-agent-matched');
		expect(h.service.getState()).toBe('error');
		expect(h.types()).not.toContain('dispatch');
	});

	it('reports a known dispatch failure and swallows nothing else', async () => {
		const h = makeHarness({
			executeRoute: async () => {
				throw new VoiceDispatchError('renderer did not answer in time');
			},
		});
		await start(h);

		h.service.submitUtterance('open a new tab');
		await vi.waitFor(() => expect(h.types()).toContain('session-error'));

		const error = h.events.find((e) => e.type === 'session-error');
		expect(error?.type === 'session-error' && error.code).toBe('dispatch-failed');
		expect(h.service.getState()).toBe('error');
	});

	it('reports a missing route executor rather than dispatching nowhere', async () => {
		const stt = new FakeStt();
		const service = new VoiceSessionService({
			providers: { stt, tts: new FakeTts(), brain: new FakeBrain() },
			getRoster: () => makeRoster(),
		});
		const events: VoiceEvent[] = [];
		service.subscribe((e) => events.push(e));

		await service.startSession({ scope: { kind: 'conductor' } });
		service.submitUtterance('do it');
		await vi.waitFor(() => expect(events.some((e) => e.type === 'session-error')).toBe(true));

		expect(service.getState()).toBe('error');
	});

	it('recovers from error only by stopping', async () => {
		const h = makeHarness();
		h.stt.startError = new Error('nope');
		await h.service.startSession({ scope: { kind: 'conductor' } });
		expect(h.service.getState()).toBe('error');

		await h.service.stopSession('error');
		expect(h.service.getState()).toBe('idle');
	});

	it('reports an unexpected provider exception to Sentry and closes the floor', async () => {
		const h = makeHarness();
		await start(h);
		h.brain.routeError = new Error('brain exploded');

		h.service.submitUtterance('boom');
		await vi.waitFor(() => expect(h.service.getState()).toBe('error'));

		const stop = h.events.find((e) => e.type === 'listen-stop');
		expect(stop?.type === 'listen-stop' && stop.reason).toBe('error');
		// Unexpected failures are never dressed up as a classified session-error.
		expect(h.types()).not.toContain('session-error');
		expect(vi.mocked(captureException)).toHaveBeenCalledWith(
			h.brain.routeError,
			expect.objectContaining({ context: 'acappella.runTurn' })
		);
	});
});

describe('VoiceSessionService audio telemetry', () => {
	it('publishes a meter update on the one ordered stream', async () => {
		const h = makeHarness();
		await start(h);

		h.service.publishAudioLevel(0.4, true);
		const event = h.events.at(-1);

		expect(event?.type).toBe('audio-level');
		expect(event).toMatchObject({ level: 0.4, speech: true, sessionId: expect.any(String) });
	});

	it('clamps a level rather than putting an impossible number on the wire', async () => {
		const h = makeHarness();
		await start(h);

		h.service.publishAudioLevel(4, false);
		h.service.publishAudioLevel(Number.NaN, false);

		const levels = h.events
			.filter((e) => e.type === 'audio-level')
			.map((e) => (e as Extract<VoiceEvent, { type: 'audio-level' }>).level);
		expect(levels).toEqual([1, 0]);
	});

	it('numbers audio events in the same seq space as the rest', async () => {
		const h = makeHarness();
		await start(h);

		h.service.publishAudioLevel(0.1, false);
		h.service.publishMicState({
			permission: 'granted',
			capturing: true,
			deviceId: 'default',
			deviceLabel: 'Built-in Microphone',
			issue: null,
			deviceChanged: false,
		});

		const seqs = h.events.map((e) => e.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
	});

	it('publishes the microphone state, including the benign transitions', async () => {
		const h = makeHarness();
		await start(h);

		h.service.publishMicState({
			permission: 'denied',
			capturing: false,
			deviceId: null,
			deviceLabel: null,
			issue: 'permission-denied',
			deviceChanged: false,
		});

		expect(h.events.at(-1)).toMatchObject({
			type: 'mic-state',
			permission: 'denied',
			issue: 'permission-denied',
		});
	});

	it('drops telemetry that belongs to no session', () => {
		const h = makeHarness();

		// A frame in flight when the session ended has no envelope to travel in.
		h.service.publishAudioLevel(0.5, true);
		expect(h.events).toHaveLength(0);
	});
});

describe('VoiceSessionService audio seams', () => {
	it('exposes the recogniser only while a session exists', async () => {
		const h = makeHarness();

		// Audio that arrives with no session behind it has nowhere to go, and the
		// pipeline reads this null to decide to drop it rather than buffer it.
		expect(h.service.getActiveStt()).toBeNull();

		await start(h);
		expect(h.service.getActiveStt()).toBe(h.stt);

		await h.service.stopSession('user');
		expect(h.service.getActiveStt()).toBeNull();
	});

	it('parks the session on a capture failure the user can fix, and says it is fixable', async () => {
		const h = makeHarness();
		await start(h);

		h.service.reportAudioCaptureFailure('permission-denied', 'Microphone permission denied');

		expect(h.events.at(-1)).toMatchObject({
			type: 'session-error',
			code: 'audio-capture-failed',
			recoverable: true,
		});
		// A listening indicator over a microphone that will never produce a
		// transcript is the worst outcome this feature has.
		expect(h.service.getState()).toBe('error');
	});

	it('reports an environment failure as unrecoverable, so no client offers a fix', async () => {
		const h = makeHarness();
		await start(h);

		h.service.reportAudioCaptureFailure('audio-init-failed', 'AudioContext unavailable');

		expect(h.events.at(-1)).toMatchObject({
			type: 'session-error',
			code: 'audio-capture-failed',
			recoverable: false,
		});
	});

	it('hands every spoken chunk to the audio sink, after its sentence event', async () => {
		const seen: Array<{ index: number; eventsSoFar: number }> = [];
		const h = makeHarness({
			onSpeechChunk: (chunk) => seen.push({ index: chunk.index, eventsSoFar: h.events.length }),
		});
		await start(h);
		h.service.submitUtterance('what changed');
		await vi.waitFor(() => expect(h.service.getState()).toBe('dispatching'));
		h.events.length = 0;

		await h.service.submitAgentReply({
			agentSessionId: 'agent-backend',
			tabId: 'tab-1',
			text: 'Raw terminal output.',
		});

		// One per sentence, and each after the `speak-sentence` that announced it:
		// the text should be on screen by the time it is audible.
		expect(seen.map((s) => s.index)).toEqual([0, 1]);
		const sentenceEvents = h.events
			.map((event, index) => ({ event, index }))
			.filter(({ event }) => event.type === 'speak-sentence');
		expect(seen[0].eventsSoFar).toBe(sentenceEvents[0].index + 1);
	});

	it('drops chunks from a run that was cancelled mid-sentence', async () => {
		const chunks: TtsChunk[] = [];
		const h = makeHarness({ onSpeechChunk: (chunk) => chunks.push(chunk) });
		await start(h);
		h.service.submitUtterance('what changed');
		await vi.waitFor(() => expect(h.service.getState()).toBe('dispatching'));

		h.tts.onChunk = () => h.service.interrupt('voice');
		await h.service.submitAgentReply({
			agentSessionId: 'agent-backend',
			tabId: 'tab-1',
			text: 'Raw terminal output.',
		});

		// The interrupt lands after the first chunk was handed over; the second must
		// never reach an output device the user has already talked over.
		expect(chunks).toHaveLength(1);
	});
});

describe('VoiceSessionService subscribers', () => {
	it('keeps delivering when one subscriber throws', async () => {
		const h = makeHarness();
		const good = vi.fn();
		h.service.subscribe(() => {
			throw new Error('bad client');
		});
		h.service.subscribe(good);

		await h.service.startSession({ scope: { kind: 'conductor' } });
		expect(good).toHaveBeenCalled();
	});

	it('stops delivering after unsubscribe', async () => {
		const h = makeHarness();
		const listener = vi.fn();
		const unsubscribe = h.service.subscribe(listener);
		unsubscribe();

		await h.service.startSession({ scope: { kind: 'conductor' } });
		expect(listener).not.toHaveBeenCalled();
	});

	it('drops every subscriber on dispose', async () => {
		const h = makeHarness();
		await start(h);
		await h.service.dispose();

		expect(h.service.getState()).toBe('idle');
		h.events.length = 0;
		await h.service.startSession({ scope: { kind: 'conductor' } });
		expect(h.events).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// State machine coverage
//
// One test per edge the service can actually reach, each asserting the exact
// sequence of transitions it took. `DEFENSIVE_EDGES` names the rest, and the
// last test fails if the table grows an edge that appears in neither list.
// ---------------------------------------------------------------------------

/** Edges driven end to end by the tests in this block. */
const DRIVEN_EDGES = [
	'idle -> arming',
	'arming -> listening',
	'arming -> error',
	'listening -> transcribing',
	'listening -> idle',
	'listening -> error',
	'transcribing -> routing',
	'transcribing -> listening',
	'routing -> dispatching',
	'routing -> idle',
	'routing -> error',
	'dispatching -> speaking',
	'dispatching -> listening',
	'dispatching -> idle',
	'dispatching -> error',
	'speaking -> interrupted',
	'speaking -> listening',
	'speaking -> idle',
	'speaking -> error',
	'interrupted -> listening',
	'error -> idle',
];

/**
 * Edges the table allows that nothing in Phase 01 can reach. Each is a guard
 * against a shape a later phase adds, not dead weight: leaving them out of the
 * table would turn that phase's first real failure into a thrown
 * `InvalidVoiceStateTransitionError` instead of a clean teardown.
 */
const DEFENSIVE_EDGES = [
	// `arming` is only held across `stt.start()`, which no client can interrupt
	// today. A real microphone permission prompt (Phase 05) is cancellable.
	'arming -> idle',
	// `transcribing` and `interrupted` are both crossed synchronously, so nothing
	// can stop or fail a session while it is in either one.
	'transcribing -> idle',
	'transcribing -> error',
	'interrupted -> idle',
	'interrupted -> error',
];

describe('VoiceSessionService state machine', () => {
	let h: Harness;

	beforeEach(() => {
		h = makeHarness();
		takeEdges();
	});

	it('idle -> arming -> listening on wake', async () => {
		await h.service.startSession({ scope: { kind: 'conductor' } });
		expect(takeEdges()).toEqual(['idle -> arming', 'arming -> listening']);
	});

	it('arming -> error when the speech provider will not open', async () => {
		h.stt.startError = new Error('microphone busy');
		await h.service.startSession({ scope: { kind: 'conductor' } });
		expect(takeEdges()).toEqual(['idle -> arming', 'arming -> error']);
	});

	it('error -> idle is the only way out of error', async () => {
		h.stt.startError = new Error('microphone busy');
		await h.service.startSession({ scope: { kind: 'conductor' } });
		takeEdges();

		await h.service.stopSession('error');
		expect(takeEdges()).toEqual(['error -> idle']);
		expect(h.service.getState()).toBe('idle');
	});

	it('listening -> idle when the session is stopped', async () => {
		await start(h);
		await h.service.stopSession('user');
		expect(takeEdges()).toEqual(['listening -> idle']);
	});

	it('listening -> error when the speech provider drops out mid-session', async () => {
		await start(h);
		h.stt.callbacks?.onError(new Error('device disappeared'));
		expect(takeEdges()).toEqual(['listening -> error']);
	});

	it('listening -> transcribing -> routing -> dispatching for a full utterance', async () => {
		await start(h);
		h.service.submitUtterance('open the auth tab');
		await vi.waitFor(() => expect(h.service.getState()).toBe('dispatching'));

		expect(takeEdges()).toEqual([
			'listening -> transcribing',
			'transcribing -> routing',
			'routing -> dispatching',
		]);
	});

	it('transcribing -> listening when the utterance was empty', async () => {
		await start(h);
		h.service.submitUtterance('   ');
		await vi.waitFor(() => expect(transitionLog.edges).toContain('transcribing -> listening'));

		expect(takeEdges()).toEqual(['listening -> transcribing', 'transcribing -> listening']);
	});

	it('routing -> idle when the stop word lands while the brain is still thinking', async () => {
		await start(h);
		const gate = deferred();
		h.brain.routeGate = gate.promise;

		h.service.submitUtterance('think about it');
		await vi.waitFor(() => expect(h.service.getState()).toBe('routing'));

		await h.service.hardStop('voice', 'never mind');
		expect(h.service.getState()).toBe('idle');

		// The superseded turn resumes and drops itself rather than transitioning.
		gate.resolve();
		await gate.promise;
		expect(takeEdges()).toEqual([
			'listening -> transcribing',
			'transcribing -> routing',
			'routing -> idle',
		]);
	});

	it('routing -> error when the decision names an agent that is gone', async () => {
		await start(h);
		h.brain.decision = {
			target: { sessionId: 'agent-ghost' },
			tabAction: 'current',
			prompt: 'hi',
			confidence: 0.5,
		};

		h.service.submitUtterance('talk to the ghost');
		await vi.waitFor(() => expect(h.service.getState()).toBe('error'));

		expect(takeEdges()).toEqual([
			'listening -> transcribing',
			'transcribing -> routing',
			'routing -> error',
		]);
	});

	it('dispatching -> error when the dispatch itself fails', async () => {
		const failing = makeHarness({
			executeRoute: async () => {
				throw new VoiceDispatchError('renderer did not answer in time');
			},
		});
		await start(failing);

		failing.service.submitUtterance('open a new tab');
		await vi.waitFor(() => expect(failing.service.getState()).toBe('error'));

		expect(takeEdges()).toEqual([
			'listening -> transcribing',
			'transcribing -> routing',
			'routing -> dispatching',
			'dispatching -> error',
		]);
	});

	it('dispatching -> speaking -> listening for a spoken reply', async () => {
		await start(h);
		h.service.submitUtterance('what changed');
		await vi.waitFor(() => expect(h.service.getState()).toBe('dispatching'));
		takeEdges();

		await h.service.submitAgentReply({
			agentSessionId: 'agent-backend',
			tabId: 'tab-1',
			text: 'Raw terminal output.',
		});

		expect(takeEdges()).toEqual(['dispatching -> speaking', 'speaking -> listening']);
	});

	it('dispatching -> listening when the reply is not worth speaking', async () => {
		await start(h);
		h.service.submitUtterance('what changed');
		await vi.waitFor(() => expect(h.service.getState()).toBe('dispatching'));
		takeEdges();

		h.brain.spoken = '   ';
		await h.service.submitAgentReply({
			agentSessionId: 'agent-backend',
			tabId: 'tab-1',
			text: 'noise',
		});

		expect(takeEdges()).toEqual(['dispatching -> listening']);
	});

	it('dispatching -> idle when the session is stopped before the reply lands', async () => {
		await start(h);
		h.service.submitUtterance('what changed');
		await vi.waitFor(() => expect(h.service.getState()).toBe('dispatching'));
		takeEdges();

		await h.service.stopSession('user');
		expect(takeEdges()).toEqual(['dispatching -> idle']);
	});

	it('speaking -> interrupted -> listening on barge-in, keeping the floor', async () => {
		await start(h);
		h.service.submitUtterance('what changed');
		await vi.waitFor(() => expect(h.service.getState()).toBe('dispatching'));
		takeEdges();

		h.tts.onChunk = () => {
			h.service.interrupt('voice');
		};
		await h.service.submitAgentReply({
			agentSessionId: 'agent-backend',
			tabId: 'tab-1',
			text: 'anything',
		});

		expect(takeEdges()).toEqual([
			'dispatching -> speaking',
			'speaking -> interrupted',
			'interrupted -> listening',
		]);
		expect(h.service.getSnapshot().sessionId).toBeTruthy();
	});

	it('speaking -> idle when the stop word lands mid-sentence', async () => {
		await start(h);
		h.service.submitUtterance('what changed');
		await vi.waitFor(() => expect(h.service.getState()).toBe('dispatching'));
		takeEdges();

		h.tts.onChunk = () => {
			void h.service.hardStop('voice');
		};
		await h.service.submitAgentReply({
			agentSessionId: 'agent-backend',
			tabId: 'tab-1',
			text: 'anything',
		});
		await vi.waitFor(() => expect(h.service.getState()).toBe('idle'));

		expect(takeEdges()).toEqual(['dispatching -> speaking', 'speaking -> idle']);
	});

	it('speaking -> error when the voice throws mid-run, releasing the floor', async () => {
		await start(h);
		h.service.submitUtterance('what changed');
		await vi.waitFor(() => expect(h.service.getState()).toBe('dispatching'));
		takeEdges();

		h.tts.speakError = new Error('voice stream closed');
		// The rejection must not escape: a caller that only awaited this would
		// otherwise leave the session in `speaking` with the floor held.
		await expect(
			h.service.submitAgentReply({
				agentSessionId: 'agent-backend',
				tabId: 'tab-1',
				text: 'anything',
			})
		).resolves.toBe(true);

		expect(takeEdges()).toEqual(['dispatching -> speaking', 'speaking -> error']);
		expect(h.service.getState()).toBe('error');
		expect(h.events.filter((e) => e.type === 'listen-stop')).toEqual([
			expect.objectContaining({ reason: 'error' }),
		]);
	});

	it('never takes an edge the table does not name', async () => {
		await start(h);
		h.service.submitUtterance('open the auth tab');
		await vi.waitFor(() => expect(h.service.getState()).toBe('dispatching'));
		await h.service.submitAgentReply({
			agentSessionId: 'agent-backend',
			tabId: 'tab-1',
			text: 'done',
		});
		await h.service.stopSession('user');

		// The wrapper delegates, so an illegal edge would already have thrown. This
		// asserts the recorder is watching the same table the service asserts on.
		for (const edge of takeEdges()) {
			const [from, to] = edge.split(' -> ') as [VoiceSessionState, VoiceSessionState];
			expect(VOICE_STATE_TRANSITIONS[from]).toContain(to);
		}
	});

	it('has a driving test or a documented reason for every edge in the table', () => {
		const declared = Object.entries(VOICE_STATE_TRANSITIONS).flatMap(([from, targets]) =>
			targets.map((to) => `${from} -> ${to}`)
		);

		expect(DRIVEN_EDGES.filter((edge) => DEFENSIVE_EDGES.includes(edge))).toEqual([]);
		expect([...DRIVEN_EDGES, ...DEFENSIVE_EDGES].sort()).toEqual([...declared].sort());
	});
});

describe('illegal transitions throw', () => {
	it('surfaces the offending edge', () => {
		expect(() => {
			throw new InvalidVoiceStateTransitionError('listening', 'speaking');
		}).toThrow(/listening -> speaking/);
	});
});
