import { describe, expect, it } from 'vitest';
import type { AgentError, LogEntryRecord, TurnEvent } from '../../../shared/maestro-lib';
import {
	foldTurnEvent,
	liveTurnEntries,
	mergeLiveTurn,
	thinkingVisible,
	transcriptCoversTurn,
	type LiveTurn,
} from '../liveTurn';

const T0 = 1_700_000_000_000;

const userEntry = (text: string, timestamp = T0): LogEntryRecord => ({
	id: `user-${timestamp}`,
	timestamp,
	source: 'user',
	text,
});

const stored = (id: string, source: string, text: string, timestamp: number): LogEntryRecord => ({
	id,
	timestamp,
	source,
	text,
});

const replay = (events: TurnEvent[]): LiveTurn | undefined =>
	events.reduce<LiveTurn | undefined>((turn, event) => foldTurnEvent(turn, event), undefined);

/** A recorded stream: the message, start, reasoning, a tool call, two answer chunks, the end. */
const RECORDED: TurnEvent[] = [
	{ kind: 'user', at: T0, entry: userEntry('List the files') },
	{ kind: 'started', at: T0 + 10 },
	{ kind: 'session', at: T0 + 20, providerSessionId: 'prov-1' },
	{ kind: 'thinking', at: T0 + 30, text: 'Let me ' },
	{ kind: 'thinking', at: T0 + 40, text: 'look.' },
	{
		kind: 'tool',
		at: T0 + 50,
		tool: { id: 'c1', name: 'Bash', status: 'running', detail: { input: { command: 'ls' } } },
	},
	{
		kind: 'tool',
		at: T0 + 60,
		tool: {
			id: 'c1',
			name: 'Bash',
			status: 'completed',
			detail: { input: { command: 'ls' }, output: 'a.ts' },
		},
	},
	{ kind: 'text', at: T0 + 70, text: 'Found ' },
	{ kind: 'text', at: T0 + 80, text: '**one** file.' },
	{ kind: 'outcome', at: T0 + 90, outcome: 'completed', exitCode: 0 },
];

describe('foldTurnEvent', () => {
	it('folds a recorded stream into ordered parts', () => {
		const turn = replay(RECORDED)!;
		expect(turn.running).toBe(false);
		expect(turn.since).toBe(T0);
		expect(turn.user?.text).toBe('List the files');
		expect(turn.parts.map((part) => part.kind)).toEqual(['thinking', 'tool', 'text']);
		// Consecutive chunks of one kind are one part.
		expect(turn.parts[0]).toMatchObject({ kind: 'thinking', text: 'Let me look.' });
		expect(turn.parts[2]).toMatchObject({ kind: 'text', text: 'Found **one** file.' });
		// A call's two events are one part, holding the later state in the earlier place.
		expect(turn.parts[1]).toMatchObject({
			kind: 'tool',
			at: T0 + 50,
			tool: { status: 'completed' },
		});
		expect(turn.outcome).toMatchObject({ outcome: 'completed', exitCode: 0 });
		expect(turn.sawText).toBe(true);
	});

	it('is running from the first event until the outcome', () => {
		const midway = replay(RECORDED.slice(0, 5))!;
		expect(midway.running).toBe(true);
		expect(midway.outcome).toBeUndefined();
		// The message alone does not make the agent busy: it may be queued behind another turn.
		expect(replay(RECORDED.slice(0, 1))!.running).toBe(false);
	});

	it('starts a new turn after an outcome', () => {
		const next = foldTurnEvent(replay(RECORDED), { kind: 'started', at: T0 + 5_000 })!;
		expect(next.since).toBe(T0 + 5_000);
		expect(next.parts).toEqual([]);
		expect(next.outcome).toBeUndefined();
		expect(next.running).toBe(true);
	});

	it('keeps the message that arrived before the start', () => {
		const turn = replay([
			{ kind: 'started', at: T0 + 10 },
			{ kind: 'user', at: T0, entry: userEntry('late echo') },
		])!;
		expect(turn.user?.text).toBe('late echo');
		expect(turn.since).toBe(T0);
	});

	it('ignores usage, session, and gap, and a stray error with no turn', () => {
		const error = { type: 'unknown', message: 'x', recoverable: false, agentId: 'a', timestamp: 1 };
		expect(foldTurnEvent(undefined, { kind: 'gap', at: 1 })).toBeUndefined();
		expect(
			foldTurnEvent(undefined, { kind: 'error', at: 1, error: error as AgentError })
		).toBeUndefined();
		const turn = replay(RECORDED.slice(0, 2))!;
		expect(foldTurnEvent(turn, { kind: 'session', at: 3, providerSessionId: 'p' })).toBe(turn);
		expect(foldTurnEvent(turn, { kind: 'gap', at: 3 })).toBe(turn);
	});

	it('carries the error to the outcome', () => {
		const error = {
			type: 'rate_limited',
			message: 'Rate limited, retry in a minute',
			recoverable: true,
			agentId: 'claude-code',
			timestamp: T0,
		} as AgentError;
		const turn = replay([
			{ kind: 'started', at: T0 },
			{ kind: 'error', at: T0 + 1, error },
			{ kind: 'outcome', at: T0 + 2, outcome: 'crashed', exitCode: 1 },
		])!;
		expect(turn.outcome?.error?.message).toBe('Rate limited, retry in a minute');
	});

	it('does not mutate the previous turn', () => {
		const before = replay(RECORDED.slice(0, 4))!;
		const snapshot = JSON.stringify(before);
		foldTurnEvent(before, { kind: 'text', at: T0 + 100, text: 'more' });
		expect(JSON.stringify(before)).toBe(snapshot);
	});
});

describe('thinking mode (CH-3)', () => {
	const during = replay(RECORDED.slice(0, 6))!;
	const afterText = replay(RECORDED.slice(0, 9))!;
	const finished = replay(RECORDED)!;

	it('off hides it, sticky keeps it', () => {
		expect(thinkingVisible(during, 'off')).toBe(false);
		expect(thinkingVisible(finished, 'sticky')).toBe(true);
	});

	it('on shows it until the answer starts or the turn ends', () => {
		expect(thinkingVisible(during, 'on')).toBe(true);
		expect(thinkingVisible(afterText, 'on')).toBe(false);
		expect(thinkingVisible(finished, 'on')).toBe(false);
	});

	it('draws a thinking entry only when it is visible', () => {
		expect(liveTurnEntries(during, 'off').map((e) => e.source)).toEqual(['user', 'tool']);
		expect(liveTurnEntries(during, 'on').map((e) => e.source)).toEqual([
			'user',
			'thinking',
			'tool',
		]);
		expect(liveTurnEntries(finished, 'sticky').map((e) => e.source)).toEqual([
			'user',
			'thinking',
			'tool',
			'ai',
		]);
	});
});

describe('liveTurnEntries', () => {
	it('draws a tool call as a tool entry the transcript view understands', () => {
		const [, tool] = liveTurnEntries(replay(RECORDED)!, 'off');
		expect(tool).toMatchObject({
			source: 'tool',
			text: 'Bash',
			metadata: { toolState: { status: 'completed', input: { command: 'ls' }, output: 'a.ts' } },
		});
	});

	it('nests a subagent call under its parent', () => {
		const turn = replay([
			{ kind: 'started', at: T0 },
			{
				kind: 'tool',
				at: T0 + 1,
				tool: { id: 'c2', name: 'Read', status: 'running', parentId: 'parent-1' },
			},
		])!;
		expect(liveTurnEntries(turn, 'off')[0]?.metadata?.parentToolUseId).toBe('parent-1');
	});

	it('skips blank text parts', () => {
		const turn = replay([
			{ kind: 'started', at: T0 },
			{ kind: 'text', at: T0 + 1, text: '  \n' },
		])!;
		expect(liveTurnEntries(turn, 'off')).toEqual([]);
	});

	it('says why a turn that did not complete stopped', () => {
		const interrupted = replay([
			{ kind: 'started', at: T0 },
			{ kind: 'outcome', at: T0 + 1, outcome: 'interrupted', exitCode: null },
		])!;
		expect(liveTurnEntries(interrupted, 'off')).toMatchObject([
			{ source: 'system', text: 'The turn was interrupted.' },
		]);
		const crashed = replay([
			{ kind: 'started', at: T0 },
			{ kind: 'outcome', at: T0 + 1, outcome: 'crashed', exitCode: 137 },
		])!;
		expect(liveTurnEntries(crashed, 'off')).toMatchObject([
			{ source: 'error', text: 'The agent exited unexpectedly (code 137).' },
		]);
		const completed = replay(RECORDED)!;
		expect(liveTurnEntries(completed, 'off').some((e) => e.id === 'live-ending')).toBe(false);
	});
});

describe('mergeLiveTurn', () => {
	const earlier = [
		stored('h1', 'user', 'Earlier question', T0 - 60_000),
		stored('h2', 'ai', 'Earlier answer', T0 - 59_000),
	];

	it('returns the transcript itself when no turn is streaming', () => {
		expect(mergeLiveTurn(earlier, undefined, 'off')).toBe(earlier);
	});

	it('lays the live turn after what came before it', () => {
		const turn = replay(RECORDED.slice(0, 8))!;
		const merged = mergeLiveTurn(earlier, turn, 'off');
		expect(merged.map((e) => e.text)).toEqual([
			'Earlier question',
			'Earlier answer',
			'List the files',
			'Bash',
			'Found ',
		]);
	});

	it('draws a half-persisted turn once, from the live copy', () => {
		// The host persisted the message and a partial answer mid-turn.
		const partial = [
			...earlier,
			stored('p1', 'user', 'List the files', T0),
			stored('p2', 'ai', 'Found', T0 + 75),
		];
		const merged = mergeLiveTurn(partial, replay(RECORDED.slice(0, 8))!, 'off');
		expect(merged.filter((e) => e.text === 'List the files')).toHaveLength(1);
		expect(merged.some((e) => e.id === 'p2')).toBe(false);
		expect(merged.at(-1)?.text).toBe('Found ');
	});

	it('keeps the stored message when the live turn never saw it', () => {
		const withoutUser = replay(RECORDED.slice(1, 8))!;
		// Stored after the turn began, so the live side would otherwise replace it with nothing.
		const partial = [...earlier, stored('p1', 'user', 'List the files', T0 + 12)];
		const merged = mergeLiveTurn(partial, withoutUser, 'off');
		expect(merged.map((e) => e.text).slice(0, 4)).toEqual([
			'Earlier question',
			'Earlier answer',
			'List the files',
			'Bash',
		]);
	});

	it('hands over to the transcript once it holds the finished turn', () => {
		const finished = [
			...earlier,
			stored('p1', 'user', 'List the files', T0),
			stored('p2', 'ai', 'Found one file.', T0 + 2_000),
		];
		const turn = replay(RECORDED)!;
		expect(transcriptCoversTurn(finished, turn)).toBe(true);
		expect(mergeLiveTurn(finished, turn, 'off')).toBe(finished);
	});

	it('keeps the live turn while the transcript has only the message', () => {
		const onlyUser = [...earlier, stored('p1', 'user', 'List the files', T0)];
		const turn = replay(RECORDED)!;
		expect(transcriptCoversTurn(onlyUser, turn)).toBe(false);
		expect(mergeLiveTurn(onlyUser, turn, 'off').at(-1)?.text).toBe('Found **one** file.');
	});

	it('never counts a running turn as covered', () => {
		const running = replay(RECORDED.slice(0, 8))!;
		const stuffed = [...earlier, stored('p2', 'ai', 'Found', T0 + 75)];
		expect(transcriptCoversTurn(stuffed, running)).toBe(false);
	});
});
