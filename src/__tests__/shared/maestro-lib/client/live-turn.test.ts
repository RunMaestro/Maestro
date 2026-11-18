/**
 * Tests for the live-turn fold the peer mirror shows while a host runs a turn.
 */

import { describe, expect, it } from 'vitest';
import {
	coalesceTurnEvents,
	foldLiveTurn,
	liveTurnKey,
	parseLiveTurnKey,
	type LiveTurn,
} from '../../../../shared/maestro-lib/client/live-turn';
import type { TurnEvent } from '../../../../shared/maestro-lib/client/types';

function ids() {
	let n = 0;
	return { newId: () => `id-${++n}` };
}

function foldAll(events: TurnEvent[], ctx = ids()): LiveTurn | undefined {
	let turn: LiveTurn | undefined;
	for (const event of events) turn = foldLiveTurn(turn, event, ctx);
	return turn;
}

describe('liveTurnKey', () => {
	it('round-trips agent and tab ids', () => {
		expect(parseLiveTurnKey(liveTurnKey('agent-1', 'tab-1'))).toEqual({
			agentId: 'agent-1',
			tabId: 'tab-1',
		});
		expect(parseLiveTurnKey('no-separator')).toBeNull();
	});
});

describe('foldLiveTurn', () => {
	it('appends the user entry and marks the turn busy on start', () => {
		const entry = { id: 'u1', timestamp: 1, source: 'user', text: 'hi' };
		const turn = foldAll([
			{ kind: 'user', at: 1, entry },
			{ kind: 'started', at: 2 },
		]);
		expect(turn).toEqual({ startedAt: 1, entries: [entry], busy: true });
	});

	it('joins consecutive text chunks into one stdout entry', () => {
		const turn = foldAll([
			{ kind: 'started', at: 1 },
			{ kind: 'text', at: 2, text: 'Hel' },
			{ kind: 'text', at: 3, text: 'lo' },
		]);
		expect(turn?.entries).toEqual([{ id: 'id-1', timestamp: 2, source: 'stdout', text: 'Hello' }]);
	});

	it('starts a new stream entry after a tool card, and keeps thinking apart from text', () => {
		const turn = foldAll([
			{ kind: 'thinking', at: 1, text: 'hmm' },
			{ kind: 'text', at: 2, text: 'a' },
			{ kind: 'tool', at: 3, tool: { id: 'c1', name: 'Read', status: 'running' } },
			{ kind: 'text', at: 4, text: 'b' },
		]);
		expect(turn?.entries.map((e) => [e.source, e.text])).toEqual([
			['thinking', 'hmm'],
			['stdout', 'a'],
			['tool', 'Read'],
			['stdout', 'b'],
		]);
	});

	it('updates a tool call by its id and keeps the input it started with', () => {
		const turn = foldAll([
			{
				kind: 'tool',
				at: 1,
				tool: { id: 'c1', name: 'Read', status: 'running', detail: { input: { path: 'a' } } },
			},
			{
				kind: 'tool',
				at: 2,
				tool: { id: 'c1', name: 'Read', status: 'completed', detail: { output: 'ok' } },
			},
		]);
		expect(turn?.entries).toHaveLength(1);
		expect(turn?.entries[0]).toMatchObject({
			id: 'tool-c1',
			source: 'tool',
			metadata: { toolState: { status: 'completed', input: { path: 'a' }, output: 'ok' } },
		});
	});

	it('finishes the newest running call of the same name when the provider gives no id', () => {
		const turn = foldAll([
			{ kind: 'tool', at: 1, tool: { name: 'Bash', status: 'running' } },
			{ kind: 'tool', at: 2, tool: { name: 'Bash', status: 'completed' } },
		]);
		expect(turn?.entries).toHaveLength(1);
		expect(turn?.entries[0].metadata?.toolState?.status).toBe('completed');
	});

	it('appends an error entry and keeps the latest usage report', () => {
		const turn = foldAll([
			{ kind: 'usage', at: 1, usage: { inputTokens: 1 } as never },
			{ kind: 'usage', at: 2, usage: { inputTokens: 5 } as never },
			{ kind: 'error', at: 3, error: { message: 'boom' } as never },
		]);
		expect(turn?.usage).toEqual({ inputTokens: 5 });
		expect(turn?.entries).toEqual([{ id: 'id-1', timestamp: 3, source: 'error', text: 'boom' }]);
	});

	it('ends on outcome and on gap', () => {
		const started = foldAll([{ kind: 'started', at: 1 }]);
		expect(
			foldLiveTurn(
				started,
				{ kind: 'outcome', at: 2, outcome: 'completed' as never, exitCode: 0 },
				ids()
			)
		).toBeUndefined();
		expect(foldLiveTurn(started, { kind: 'gap', at: 2 }, ids())).toBeUndefined();
	});

	it('leaves the turn alone for a session event and an empty chunk', () => {
		const started = foldAll([{ kind: 'started', at: 1 }]);
		expect(foldLiveTurn(started, { kind: 'session', at: 2, providerSessionId: 's' }, ids())).toBe(
			started
		);
		expect(foldLiveTurn(started, { kind: 'text', at: 2, text: '' }, ids())).toBe(started);
	});
});

describe('coalesceTurnEvents', () => {
	it('merges consecutive text and thinking chunks and keeps order', () => {
		const events: TurnEvent[] = [
			{ kind: 'text', at: 1, text: 'a' },
			{ kind: 'text', at: 2, text: 'b' },
			{ kind: 'thinking', at: 3, text: 'x' },
			{ kind: 'thinking', at: 4, text: 'y' },
			{ kind: 'tool', at: 5, tool: { name: 'Read', status: 'running' } },
			{ kind: 'text', at: 6, text: 'c' },
		];
		expect(coalesceTurnEvents(events)).toEqual([
			{ kind: 'text', at: 1, text: 'ab' },
			{ kind: 'thinking', at: 3, text: 'xy' },
			{ kind: 'tool', at: 5, tool: { name: 'Read', status: 'running' } },
			{ kind: 'text', at: 6, text: 'c' },
		]);
	});

	it('folds to the same text as the burst it replaces', () => {
		const events: TurnEvent[] = [
			{ kind: 'text', at: 1, text: 'one ' },
			{ kind: 'text', at: 2, text: 'two' },
		];
		const strip = (turn: LiveTurn | undefined) => turn?.entries.map((e) => e.text);
		expect(strip(foldAll(coalesceTurnEvents(events)))).toEqual(strip(foldAll(events)));
	});
});
