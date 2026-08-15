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
import { InvalidVoiceStateTransitionError } from '../../../shared/acappella/session-state';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Text-in STT: two partials then a final, exactly like the mock tier will. */
class FakeStt implements SttProvider {
	readonly id = 'fake-stt';
	readonly label = 'Fake STT';
	readonly tier = 'mock' as const;
	readonly sampleRate = 16_000;

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

	async route(_input: string, _context: VoiceRouteContext): Promise<RouteDecision> {
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

	speak(text: string, options: { utteranceId: string }): AsyncIterable<TtsChunk> {
		this.cancelled = false;
		const sentences = splitIntoSpokenSentences(text);
		const self = this;
		return {
			async *[Symbol.asyncIterator]() {
				for (let index = 0; index < sentences.length; index++) {
					if (self.cancelled) return;
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

function makeHarness(overrides: { executeRoute?: VoiceRouteExecutor } = {}): Harness {
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
	});

	const events: VoiceEvent[] = [];
	service.subscribe((event) => events.push(event));

	return { service, stt, tts, brain, events, types: () => events.map((e) => e.type), executor };
}

/** Start a session and drain the events emitted by startup. */
async function start(h: Harness): Promise<void> {
	await h.service.startSession({ scope: { kind: 'conductor' }, source: 'hotkey' });
	h.events.length = 0;
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

describe('illegal transitions throw', () => {
	it('surfaces the offending edge', () => {
		expect(() => {
			throw new InvalidVoiceStateTransitionError('listening', 'speaking');
		}).toThrow(/listening -> speaking/);
	});
});
