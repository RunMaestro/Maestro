import { describe, it, expect } from 'vitest';
import { CodexAppServerEventTranslator } from '../../../main/codex-app-server/event-translator';
import { CodexOutputParser } from '../../../main/parsers/codex-output-parser';

const THREAD = 'thread-1';
const TURN = 'turn-1';

/** A translator with turn-1 active, the way a live turn looks after turn/started. */
function liveTranslator() {
	const translator = new CodexAppServerEventTranslator();
	translator.translate({
		method: 'turn/started',
		params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } },
	} as never);
	return translator;
}

function delta(
	translator: CodexAppServerEventTranslator,
	itemId: string,
	text: string,
	turnId = TURN
) {
	return translator.translate({
		method: 'item/reasoning/summaryTextDelta',
		params: { threadId: THREAD, turnId, itemId, summaryIndex: 0, delta: text },
	} as never);
}

function reasoningPart(translator: CodexAppServerEventTranslator, itemId: string, index: number) {
	return translator.translate({
		method: 'item/reasoning/summaryPartAdded',
		params: { threadId: THREAD, turnId: TURN, itemId, summaryIndex: index },
	} as never);
}

function completedReasoning(
	translator: CodexAppServerEventTranslator,
	itemId: string,
	summary: string[]
) {
	return translator.translate({
		method: 'item/completed',
		params: {
			threadId: THREAD,
			turnId: TURN,
			item: { id: itemId, type: 'reasoning', summary, content: [] },
		},
	} as never);
}

describe('Codex app-server reasoning summary deltas', () => {
	it('forwards each live summary delta as a reasoning line for the active turn', () => {
		const t = liveTranslator();
		const lines = [...delta(t, 'r1', '**Plan'), ...delta(t, 'r1', ' the change**')];
		expect(lines).toEqual([
			{ type: 'maestro.reasoning_delta', text: '**Plan' },
			{ type: 'maestro.reasoning_delta', text: ' the change**' },
		]);
	});

	it('drops deltas from another turn (a replayed or sub-agent turn) and empty deltas', () => {
		const t = liveTranslator();
		expect(delta(t, 'r1', 'old', 'turn-0')).toEqual([]);
		expect(delta(t, 'r1', '')).toEqual([]);
	});

	it('separates a second summary part from the text before it, as reasoningText joins parts', () => {
		const t = liveTranslator();
		delta(t, 'r1', 'first part');
		expect(reasoningPart(t, 'r1', 1)).toEqual([{ type: 'maestro.reasoning_delta', text: '\n\n' }]);
		expect(delta(t, 'r1', 'second part')).toEqual([
			{ type: 'maestro.reasoning_delta', text: 'second part' },
		]);
	});

	it('does not emit a separator before the first part of an item', () => {
		const t = liveTranslator();
		expect(reasoningPart(t, 'r1', 0)).toEqual([]);
	});

	it('does not re-emit a completed reasoning item whose summary already streamed', () => {
		const t = liveTranslator();
		delta(t, 'r1', 'streamed');
		expect(completedReasoning(t, 'r1', ['streamed'])).toEqual([]);
	});

	it('still emits a completed reasoning item that never streamed (no summary deltas)', () => {
		const t = liveTranslator();
		expect(completedReasoning(t, 'r2', ['whole summary'])).toEqual([
			{ type: 'item.completed', item: { id: 'r2', type: 'reasoning', text: 'whole summary' } },
		]);
	});

	it('the exec parser maps a reasoning delta to a partial reasoning event (Thinking display)', () => {
		const t = liveTranslator();
		const [line] = delta(t, 'r1', 'thinking now');
		const parsed = new CodexOutputParser().parseJsonLine(JSON.stringify(line));
		expect(parsed).toMatchObject({
			type: 'text',
			text: 'thinking now',
			isPartial: true,
			isReasoning: true,
		});
	});
});
