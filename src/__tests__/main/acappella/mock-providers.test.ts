/**
 * @file mock-providers.test.ts
 *
 * Unit tests for the mock provider tier: partial then final ordering out of the
 * mock STT, deterministic keyword routing out of the mock Brain, and cancellable
 * sentence streaming out of the mock TTS.
 *
 * Resolution rules live in `provider-registry.test.ts`, because they are about
 * what gets CHOSEN rather than about what the mocks do.
 *
 * Every provider is constructed with zero-delay timing so the suite runs
 * synchronously: the timers are a UX affordance, not behaviour under test.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { MockBrainProvider } from '../../../main/acappella/providers/mock/mock-brain';
import { MockSttProvider } from '../../../main/acappella/providers/mock/mock-stt';
import { MockTtsProvider } from '../../../main/acappella/providers/mock/mock-tts';
import { createMockProviderTrio } from '../../../main/acappella/providers/mock';
import type { RosterAgent } from '../../../shared/acappella/protocol';
import type { SttCallbacks, TtsChunk } from '../../../shared/acappella/providers';
import { splitIntoSpokenSentences } from '../../../shared/acappella/sentences';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoster(): RosterAgent[] {
	return [
		{
			sessionId: 'agent-backend',
			name: 'Backend',
			agentType: 'claude-code',
			cwd: '/repo/api',
			tabs: [
				{ id: 'tab-auth', name: 'Auth Refactor', lastActiveAt: 1_000 },
				{ id: 'tab-migrations', name: 'DB Migrations', lastActiveAt: 5_000 },
			],
		},
		{
			sessionId: 'agent-frontend',
			name: 'Frontend',
			agentType: 'codex',
			cwd: '/repo/web',
			tabs: [{ id: 'tab-ui', name: 'Sidebar', lastActiveAt: 2_000 }],
		},
	];
}

/** Records every callback the STT fires, in order. */
function recordingCallbacks(): {
	callbacks: SttCallbacks;
	events: Array<{ kind: 'partial' | 'final' | 'error'; text: string; value: number }>;
} {
	const events: Array<{ kind: 'partial' | 'final' | 'error'; text: string; value: number }> = [];
	return {
		events,
		callbacks: {
			onPartial: (text, stability) => events.push({ kind: 'partial', text, value: stability }),
			onFinal: (text, confidence) => events.push({ kind: 'final', text, value: confidence }),
			onError: (error) => events.push({ kind: 'error', text: error.message, value: 0 }),
		},
	};
}

async function collect(iterable: AsyncIterable<TtsChunk>): Promise<TtsChunk[]> {
	const chunks: TtsChunk[] = [];
	for await (const chunk of iterable) chunks.push(chunk);
	return chunks;
}

// ---------------------------------------------------------------------------
// Mock STT
// ---------------------------------------------------------------------------

describe('MockSttProvider', () => {
	it('emits two partials before the final, in that order', async () => {
		const stt = new MockSttProvider({ partialDelayMs: 0 });
		const { callbacks, events } = recordingCallbacks();
		await stt.start(callbacks);

		stt.injectUtterance('open a new tab on the backend agent');

		expect(events.map((event) => event.kind)).toEqual(['partial', 'partial', 'final']);
		expect(events[2].text).toBe('open a new tab on the backend agent');
	});

	it('grows the partial hypothesis and its stability', async () => {
		const stt = new MockSttProvider({ partialDelayMs: 0 });
		const { callbacks, events } = recordingCallbacks();
		await stt.start(callbacks);

		stt.injectUtterance('one two three four five six');

		const [first, second] = events;
		expect(second.text.startsWith(first.text)).toBe(true);
		expect(second.text.length).toBeGreaterThan(first.text.length);
		expect(second.value).toBeGreaterThan(first.value);
	});

	it('still emits two partials for a single word', async () => {
		const stt = new MockSttProvider({ partialDelayMs: 0 });
		const { callbacks, events } = recordingCallbacks();
		await stt.start(callbacks);

		stt.injectUtterance('stop');

		expect(events.filter((event) => event.kind === 'partial')).toHaveLength(2);
	});

	it('reports an empty utterance as a final with no partials', async () => {
		const stt = new MockSttProvider({ partialDelayMs: 0 });
		const { callbacks, events } = recordingCallbacks();
		await stt.start(callbacks);

		stt.injectUtterance('   ');

		expect(events).toEqual([{ kind: 'final', text: '', value: 1 }]);
	});

	it('drops pending emissions after stop()', async () => {
		vi.useFakeTimers();
		try {
			const stt = new MockSttProvider({ partialDelayMs: 10 });
			const { callbacks, events } = recordingCallbacks();
			await stt.start(callbacks);

			stt.injectUtterance('this will be abandoned');
			await stt.stop();
			vi.advanceTimersByTime(100);

			expect(events).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('supersedes a pending utterance rather than interleaving the two', async () => {
		vi.useFakeTimers();
		try {
			const stt = new MockSttProvider({ partialDelayMs: 10 });
			const { callbacks, events } = recordingCallbacks();
			await stt.start(callbacks);

			stt.injectUtterance('first utterance');
			vi.advanceTimersByTime(10);
			stt.injectUtterance('second utterance');
			vi.advanceTimersByTime(100);

			const finals = events.filter((event) => event.kind === 'final');
			expect(finals).toHaveLength(1);
			expect(finals[0].text).toBe('second utterance');
		} finally {
			vi.useRealTimers();
		}
	});

	it('ignores fed audio instead of inventing a transcript', async () => {
		const stt = new MockSttProvider({ partialDelayMs: 0 });
		const { callbacks, events } = recordingCallbacks();
		await stt.start(callbacks);

		stt.feed(new Int16Array(1024));
		await stt.flush();

		expect(events).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Mock Brain
// ---------------------------------------------------------------------------

describe('MockBrainProvider routing', () => {
	const brain = new MockBrainProvider();
	const roster = makeRoster();

	it('targets the agent whose name is in the utterance', async () => {
		const decision = await brain.route('ask backend to run the migrations', {
			roster,
			scope: { kind: 'conductor' },
		});

		expect(decision.target).toEqual({ sessionId: 'agent-backend' });
	});

	it('targets the conductor when no name is mentioned and nothing is bound', async () => {
		const decision = await brain.route('what is running right now', {
			roster,
			scope: { kind: 'conductor' },
		});

		expect(decision.target).toBe('conductor');
	});

	it('falls back to the bound agent when no name is mentioned', async () => {
		const decision = await brain.route('run the tests', {
			roster,
			scope: { kind: 'agent', sessionId: 'agent-frontend' },
		});

		expect(decision.target).toEqual({ sessionId: 'agent-frontend' });
	});

	it('lets a named agent beat the bound one', async () => {
		const decision = await brain.route('backend, run the tests', {
			roster,
			scope: { kind: 'agent', sessionId: 'agent-frontend' },
		});

		expect(decision.target).toEqual({ sessionId: 'agent-backend' });
	});

	it('picks new from a new-tab cue and names the tab', async () => {
		const decision = await brain.route(
			'start a new tab on the backend agent about the auth refactor',
			{ roster, scope: { kind: 'conductor' } }
		);

		expect(decision.target).toEqual({ sessionId: 'agent-backend' });
		expect(decision.tabAction).toBe('new');
		expect(decision.prompt).toBe('the auth refactor');
		expect(decision.tabName).toBe('Auth Refactor');
	});

	it('picks recall from a back-to cue and resolves the tab by name', async () => {
		const decision = await brain.route('go back to the auth refactor on backend', {
			roster,
			scope: { kind: 'conductor' },
		});

		expect(decision.tabAction).toBe('recall');
		expect(decision.tabId).toBe('tab-auth');
	});

	it('recalls the most recent tab when the utterance names none', async () => {
		const decision = await brain.route('back to backend', {
			roster,
			scope: { kind: 'conductor' },
		});

		expect(decision.tabAction).toBe('recall');
		expect(decision.tabId).toBe('tab-migrations');
	});

	it('downgrades recall to current when the target has no tabs', async () => {
		const decision = await brain.route('back to the auth one', {
			roster: [{ ...roster[0], tabs: [] }],
			scope: { kind: 'conductor' },
		});

		expect(decision.tabAction).toBe('current');
		expect(decision.tabId).toBeUndefined();
	});

	it('defaults to the current tab with no cue', async () => {
		const decision = await brain.route('frontend, tighten the sidebar spacing', {
			roster,
			scope: { kind: 'conductor' },
		});

		expect(decision.tabAction).toBe('current');
		expect(decision.tabName).toBeUndefined();
	});

	it('is deterministic: the same utterance routes the same way twice', async () => {
		const context = { roster, scope: { kind: 'conductor' as const } };
		const first = await brain.route('new tab on frontend about dark mode', context);
		const second = await brain.route('new tab on frontend about dark mode', context);

		expect(first).toEqual(second);
	});

	it('scores a named agent with a cue above a bare guess', async () => {
		const context = { roster, scope: { kind: 'conductor' as const } };
		const strong = await brain.route('new tab on backend about caching', context);
		const weak = await brain.route('what changed', context);

		expect(strong.confidence).toBeGreaterThan(weak.confidence);
		expect(strong.confidence).toBeLessThanOrEqual(1);
		expect(weak.confidence).toBeGreaterThanOrEqual(0);
	});

	it('never returns an empty prompt', async () => {
		const decision = await brain.route('backend', { roster, scope: { kind: 'conductor' } });

		expect(decision.prompt.length).toBeGreaterThan(0);
	});
});

describe('MockBrainProvider converse', () => {
	const brain = new MockBrainProvider();
	const context = { agentSessionId: 'agent-backend', tabId: 'tab-auth' };

	it('reshapes markdown into at most two spoken sentences', async () => {
		const spoken = await brain.converse(
			'## Done\n\nI updated `auth.ts` and **two** tests. The suite is green. One more thing to check later.',
			context
		);

		expect(splitIntoSpokenSentences(spoken)).toHaveLength(2);
		expect(spoken).not.toContain('#');
		expect(spoken).not.toContain('`');
		expect(spoken).not.toContain('**');
	});

	it('honours an explicit sentence budget', async () => {
		const spoken = await brain.converse('One. Two. Three. Four.', { ...context, maxSentences: 3 });

		expect(splitIntoSpokenSentences(spoken)).toHaveLength(3);
	});

	it('keeps the sentence count the session announces', async () => {
		const spoken = await brain.converse(`${'word '.repeat(80)}. Second sentence here.`, context);

		// The service emits `speak-start` with this count and the TTS splits the
		// same text, so a truncated sentence must not become two.
		expect(splitIntoSpokenSentences(spoken)).toHaveLength(2);
	});

	it('returns nothing to speak for empty agent output', async () => {
		expect(await brain.converse('   ', context)).toBe('');
	});
});

// ---------------------------------------------------------------------------
// Mock TTS
// ---------------------------------------------------------------------------

describe('MockTtsProvider', () => {
	it('emits one chunk per sentence, in order', async () => {
		const tts = new MockTtsProvider({ msPerCharacter: 0 });
		const chunks = await collect(
			tts.speak('First sentence. Second sentence. Third one.', { utteranceId: 'u1' })
		);

		expect(chunks.map((chunk) => chunk.text)).toEqual([
			'First sentence.',
			'Second sentence.',
			'Third one.',
		]);
		expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
		expect(chunks.every((chunk) => chunk.utteranceId === 'u1')).toBe(true);
	});

	it('splits exactly like the shared splitter the service counted with', async () => {
		const text = 'Dr. Reed shipped it. The tests pass!';
		const tts = new MockTtsProvider({ msPerCharacter: 0 });
		const chunks = await collect(tts.speak(text, { utteranceId: 'u1' }));

		expect(chunks.map((chunk) => chunk.text)).toEqual(splitIntoSpokenSentences(text));
	});

	it('carries no audio, so the mock tier is silent by construction', async () => {
		const tts = new MockTtsProvider({ msPerCharacter: 0 });
		const [chunk] = await collect(tts.speak('Only one.', { utteranceId: 'u1' }));

		expect(chunk.format).toBe('none');
		expect(chunk.audio).toBeNull();
	});

	it('stops emitting sentences after cancel()', async () => {
		const tts = new MockTtsProvider({ msPerCharacter: 0 });
		const seen: string[] = [];

		for await (const chunk of tts.speak('One. Two. Three. Four.', { utteranceId: 'u1' })) {
			seen.push(chunk.text);
			if (seen.length === 2) tts.cancel();
		}

		expect(seen).toEqual(['One.', 'Two.']);
	});

	it('cuts the in-flight sentence delay short instead of waiting it out', async () => {
		const tts = new MockTtsProvider({ msPerCharacter: 50, minSentenceMs: 5_000 });
		const seen: string[] = [];

		const run = (async () => {
			for await (const chunk of tts.speak('One. Two. Three.', { utteranceId: 'u1' })) {
				seen.push(chunk.text);
				tts.cancel();
			}
		})();

		// Real timers: if cancel() did not wake the sleep this would hang for 5s.
		await run;
		expect(seen).toEqual(['One.']);
	});

	it('supersedes a previous run so its stragglers are dropped', async () => {
		const tts = new MockTtsProvider({ msPerCharacter: 0 });
		const first = tts.speak('One. Two. Three.', { utteranceId: 'u1' })[Symbol.asyncIterator]();

		await first.next();
		const second = await collect(tts.speak('Fresh run.', { utteranceId: 'u2' }));

		expect((await first.next()).done).toBe(true);
		expect(second.map((chunk) => chunk.text)).toEqual(['Fresh run.']);
	});

	it('yields nothing for text with no sentences in it', async () => {
		const tts = new MockTtsProvider({ msPerCharacter: 0 });

		expect(await collect(tts.speak('   ', { utteranceId: 'u1' }))).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
// Trio wiring
// ---------------------------------------------------------------------------

describe('createMockProviderTrio', () => {
	it('drives an utterance from typed text through to spoken sentences', async () => {
		const trio = createMockProviderTrio({ stt: { partialDelayMs: 0 }, tts: { msPerCharacter: 0 } });
		const { callbacks, events } = recordingCallbacks();
		await trio.stt.start(callbacks);

		trio.stt.injectUtterance?.('new tab on backend about the auth refactor');
		const final = events.at(-1);
		expect(final?.kind).toBe('final');

		const decision = await trio.brain.route(final!.text, {
			roster: makeRoster(),
			scope: { kind: 'conductor' },
		});
		expect(decision.tabAction).toBe('new');

		const spoken = await trio.brain.converse('Opened it. The refactor branch is checked out.', {
			agentSessionId: 'agent-backend',
			tabId: 'tab-auth',
		});
		const chunks = await collect(trio.tts.speak(spoken, { utteranceId: 'u1' }));

		expect(chunks).toHaveLength(splitIntoSpokenSentences(spoken).length);
	});
});
