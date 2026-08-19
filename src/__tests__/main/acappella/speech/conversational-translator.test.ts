/**
 * @file conversational-translator.test.ts
 *
 * The layer that decides what a person actually hears. Four fixtures, chosen
 * because each is a different way for a voice reply to be unusable: a four
 * hundred line implementation summary (too long), a diff-heavy reply (unspeakable
 * shapes), a one-word confirmation (a wasted round trip), and an error trace
 * (the case where going silent is worst).
 *
 * The fake Brain deliberately returns markdown and more sentences than it was
 * asked for, because that is what every real backend eventually does. The
 * assertions are about what the TRANSLATOR guarantees on top of the model, not
 * about the model's prose.
 */

import { describe, it, expect, vi } from 'vitest';

import { ConversationalTranslator } from '../../../../main/acappella/speech/conversational-translator';
import type { BrainProvider, VoiceConverseContext } from '../../../../shared/acappella/providers';
import type { RouteDecision } from '../../../../shared/acappella/route-decision';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LONG_SUMMARY = [
	'## Summary',
	'',
	'I refactored the authentication middleware and threaded the refresh token through the session store.',
	'',
	...Array.from(
		{ length: 380 },
		(_, i) => `Step ${i + 1}: touched a call site and updated its test.`
	),
].join('\n');

const DIFF_REPLY = [
	'Here is the change:',
	'',
	'```diff',
	'--- a/src/main/auth.ts',
	'+++ b/src/main/auth.ts',
	'-const token = read();',
	'+const token = readFresh();',
	'```',
	'',
	'That is the whole fix.',
].join('\n');

const ONE_WORD = 'Yes, the tests pass.';

const ERROR_TRACE = [
	'TypeError: cannot read property id of undefined',
	'    at resolveSession (src/main/session.ts:42:11)',
	'    at dispatch (src/main/dispatch.ts:11:3)',
].join('\n');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeBrainOptions {
	reply?: string;
	deltas?: string[];
}

function fakeBrain(options: FakeBrainOptions = {}): BrainProvider & {
	converse: ReturnType<typeof vi.fn>;
	seen: VoiceConverseContext[];
} {
	const seen: VoiceConverseContext[] = [];
	const reply = options.reply ?? '**Done.** I fixed the auth bug. Want the details?';

	const converse = vi.fn(async (_text: string, context: VoiceConverseContext) => {
		seen.push(context);
		return reply;
	});

	const brain: BrainProvider & { converse: typeof converse; seen: VoiceConverseContext[] } = {
		id: 'fake-brain',
		label: 'Fake',
		tier: 'mock',
		route: async (): Promise<RouteDecision> => ({
			target: 'conductor',
			tabAction: 'current',
			prompt: '',
			confidence: 1,
		}),
		converse,
		seen,
	};

	if (options.deltas) {
		brain.converseStream = async function* (_text: string, context: VoiceConverseContext) {
			seen.push(context);
			for (const delta of options.deltas ?? []) {
				if (context.signal?.aborted) return;
				yield delta;
			}
		};
	}

	return brain;
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
	const out: string[] = [];
	for await (const value of iterable) out.push(value);
	return out;
}

function request(text: string, overrides: Partial<{ signal: AbortSignal }> = {}) {
	return {
		agentSessionId: 'agent-1',
		tabId: 'tab-1',
		text,
		kind: 'final' as const,
		...overrides,
	};
}

// ---------------------------------------------------------------------------

describe('ConversationalTranslator', () => {
	it('turns a four hundred line summary into a short, markdown-free reply that offers detail', async () => {
		const brain = fakeBrain({
			reply: '**Done.** I refactored the `auth` middleware, it was a stale token check.',
		});
		const translator = new ConversationalTranslator({ brain });

		const spoken = await collect(translator.translate(request(LONG_SUMMARY)));

		expect(spoken.length).toBeLessThanOrEqual(3);
		expect(spoken.join(' ')).not.toMatch(/[*`#|]/);
		// The rewrite made no offer, so the translator makes one. The whole point of
		// the layer is a headline plus a door back into the detail.
		expect(spoken[spoken.length - 1]).toMatch(/details\?$/i);
		expect(brain.converse).toHaveBeenCalledOnce();
	});

	it('never yields more sentences than the budget, whatever the model returns', async () => {
		const brain = fakeBrain({ reply: 'One. Two. Three. Four. Five.' });
		const translator = new ConversationalTranslator({ brain, maxSentences: 2 });

		const spoken = await collect(translator.translate(request(DIFF_REPLY)));

		// Two sentences of content. No offer: the source was short.
		expect(spoken).toEqual(['One.', 'Two.']);
	});

	it('passes a short conversational reply through without a translation hop', async () => {
		const brain = fakeBrain();
		const translator = new ConversationalTranslator({ brain });

		const spoken = await collect(translator.translate(request(ONE_WORD)));

		expect(spoken).toEqual([ONE_WORD]);
		expect(brain.converse).not.toHaveBeenCalled();
		expect(translator.stats).toEqual({ translations: 0, passthroughs: 1 });
	});

	it('translates anything path-shaped or code-shaped rather than passing it through', async () => {
		const brain = fakeBrain({ reply: 'It failed on a missing session id.' });
		const translator = new ConversationalTranslator({ brain });

		const spoken = await collect(translator.translate(request(ERROR_TRACE)));

		expect(brain.converse).toHaveBeenCalledOnce();
		expect(spoken).toEqual(['It failed on a missing session id.']);
		expect(spoken.join(' ')).not.toContain('src/main/session.ts');
	});

	it('speaks a status chunk as-is: an error is not worth a round trip', async () => {
		const brain = fakeBrain();
		const translator = new ConversationalTranslator({ brain });

		const spoken = await collect(
			translator.translate({ ...request('It hit an error: rate limited.'), kind: 'status' })
		);

		expect(spoken).toEqual(['It hit an error: rate limited.']);
		expect(brain.converse).not.toHaveBeenCalled();
	});

	it('emits sentences as they are streamed rather than waiting for the whole rewrite', async () => {
		const brain = fakeBrain({
			deltas: ['Done, ', 'the auth bug ', 'was a stale token check. ', 'Two files changed.'],
		});
		const translator = new ConversationalTranslator({ brain });

		const spoken = await collect(translator.translate(request(DIFF_REPLY)));

		expect(spoken).toEqual(['Done, the auth bug was a stale token check.', 'Two files changed.']);
		// The streaming seam is used INSTEAD of the buffered one, never as well as.
		expect(brain.converse).not.toHaveBeenCalled();
	});

	it('stops mid-stream when the turn is aborted', async () => {
		const controller = new AbortController();
		const brain = fakeBrain({ deltas: ['First one. ', 'Second one. ', 'Third one.'] });
		const translator = new ConversationalTranslator({ brain, maxSentences: 5 });

		const spoken: string[] = [];
		for await (const sentence of translator.translate(
			request(DIFF_REPLY, { signal: controller.signal })
		)) {
			spoken.push(sentence);
			controller.abort();
		}

		expect(spoken).toEqual(['First one.']);
	});

	it('carries what was SPOKEN across turns, not what was queued', async () => {
		const brain = fakeBrain({ reply: 'All good.' });
		const translator = new ConversationalTranslator({ brain });

		translator.rememberSpoken(['Done, it was a stale token check.']);
		await collect(translator.translate(request(ERROR_TRACE)));

		expect(brain.seen[0].recentSpoken).toEqual(['Done, it was a stale token check.']);
	});

	it('forgets the conversation on reset', async () => {
		const brain = fakeBrain({ reply: 'All good.' });
		const translator = new ConversationalTranslator({ brain });

		translator.rememberSpoken(['Something earlier.']);
		translator.reset();
		await collect(translator.translate(request(ERROR_TRACE)));

		expect(brain.seen[0].recentSpoken).toEqual([]);
		expect(translator.memory).toEqual([]);
	});

	it('bounds the memory it carries', () => {
		const translator = new ConversationalTranslator({ brain: fakeBrain(), memoryLimit: 2 });

		translator.rememberSpoken(['One.', 'Two.', 'Three.']);

		expect(translator.memory).toEqual(['Two.', 'Three.']);
	});
});
