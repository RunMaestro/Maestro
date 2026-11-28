/**
 * Steer Running Turn on a headless host (M4): the host's own steer over a real execution queue,
 * with the socket's answer faked. What the turn wiring and a real socket do is in turns.test.ts.
 */
import { describe, expect, it } from 'vitest';

import type { SteeringResultFrame } from '../../../chatSteering';
import type { LogEntryRecord } from '../../store/transcript';
import { createExecutionQueue, type ExecutionQueue } from '../../turns/queue';
import {
	createRuntimeSteering,
	runtimeSteerBlockedReason,
	type SteerableItem,
	type SteeredTurn,
	type SteeredTurnHandle,
} from '../steering';

type Verdict = Omit<SteeringResultFrame, 'type' | 'id'>;

function setup(
	answer: Verdict = { verdict: 'delivered' },
	beforeAnswer?: (steerId: string) => void
) {
	const queue: ExecutionQueue<SteerableItem> = createExecutionQueue<SteerableItem>({
		// A turn that runs until the test is done with it.
		start: async () => ({ done: new Promise<void>(() => undefined), interrupt: () => undefined }),
		onEvent: () => undefined,
	});
	const entries: LogEntryRecord[] = [];
	const typed: string[] = [];
	let id = 0;
	const steering = createRuntimeSteering<SteerableItem>({
		queueOf: () => queue,
		toolTypeOf: () => 'claude-code',
		appendEntry: async (_agentId, _tabId, entry) => {
			entries.push(entry);
		},
		stampSteerState: async (_agentId, _tabId, entryId, steerState) => {
			const at = entries.findIndex((entry) => entry.id === entryId);
			if (at !== -1) entries[at] = { ...entries[at], steerState };
		},
		newId: () => `id-${++id}`,
		now: () => 5,
		send: async (_socket, text, steerId) => {
			typed.push(text);
			beforeAnswer?.(steerId);
			return { type: 'steering', id: steerId, ...answer };
		},
	});
	// The running turn on t1, and one message waiting behind it.
	queue.submit({ id: 'run', tabId: 't1', text: 'first' });
	queue.submit({ id: 'q1', tabId: 't1', text: 'go left instead' });
	const ids = () => queue.items().map((item) => `${item.id}${item.paused ? ' (paused)' : ''}`);
	const tui: SteeredTurn = { provider: 'claude-code', readOnly: false, socketPath: '/tmp/s.sock' };
	return { queue, steering, entries, typed, ids, tui };
}

describe('the host steer', () => {
	it('types the message into the running turn, takes it off the queue, and writes the steered entry', async () => {
		const { steering, entries, typed, ids, tui } = setup();
		steering.turnStarted('a1', 't1', tui);

		expect(await steering.steer('a1', 'q1')).toEqual({
			outcome: 'delivered',
			verdict: 'delivered',
		});
		expect(typed).toEqual(['go left instead']);
		expect(ids()).toEqual([]);
		expect(entries).toEqual([
			expect.objectContaining({
				source: 'user',
				text: 'go left instead',
				steered: true,
				queuedItemId: 'q1',
			}),
		]);
	});

	// Parity R51: the entry says what the agent did with the steer, as the desktop's bubble does,
	// so a steer run as a turn of its own (`queued`) is read as that turn on every client.
	it('records what the agent did with the steer on its entry (R51)', async () => {
		const settled = setup({ verdict: 'queued' });
		settled.steering.turnStarted('a1', 't1', settled.tui);
		await settled.steering.steer('a1', 'q1');
		expect(settled.entries).toEqual([
			expect.objectContaining({ steered: true, steerState: 'queued' }),
		]);

		// Delivered first: no verdict yet; the turn's later verdict is stamped on the entry.
		const later = setup();
		const turn = later.steering.turnStarted('a1', 't1', later.tui);
		await later.steering.steer('a1', 'q1');
		expect(later.entries).toEqual([
			expect.objectContaining({ steered: true, steerState: 'pending' }),
		]);
		turn.verdict({ type: 'steering', id: 'id-1', verdict: 'queued' });
		await Promise.resolve();
		expect(later.entries).toEqual([
			expect.objectContaining({ steered: true, steerState: 'queued' }),
		]);
	});

	it('puts a refused steer back at the head, live, and writes nothing', async () => {
		const { steering, entries, ids, tui, queue } = setup({
			verdict: 'refused',
			refusal: 'blocking-dialog',
			detail: 'a permission prompt is on screen',
		});
		queue.submit({ id: 'q2', tabId: 't1', text: 'behind it' });
		steering.turnStarted('a1', 't1', tui);

		expect(await steering.steer('a1', 'q2')).toEqual({
			outcome: 'refused',
			verdict: 'refused',
			refusal: 'blocking-dialog',
			detail: 'a permission prompt is on screen',
		});
		expect(ids()).toEqual(['q2', 'q1']);
		expect(entries).toEqual([]);
	});

	it('pauses a steer whose answer never came, so it is never typed twice', async () => {
		const { steering, entries, ids, tui } = setup({ verdict: 'unknown' });
		steering.turnStarted('a1', 't1', tui);

		expect(await steering.steer('a1', 'q1')).toMatchObject({ outcome: 'unconfirmed' });
		expect(ids()).toEqual(['q1 (paused)']);
		expect(entries).toEqual([]);
		// Paused on purpose: Steer is not the way out, the card's resume is.
		expect(await steering.steer('a1', 'q1')).toMatchObject({
			outcome: 'not-steerable',
			blockedReason: 'paused',
		});
	});

	it('settles a steer the turn said it took, even when the socket answer was lost', async () => {
		// The turn prints its verdict before the socket gives up.
		const turn: { handle?: SteeredTurnHandle } = {};
		const { steering, entries, ids, tui } = setup({ verdict: 'unknown' }, (steerId) =>
			turn.handle?.verdict({ type: 'steering', id: steerId, verdict: 'absorbed' })
		);
		turn.handle = steering.turnStarted('a1', 't1', tui);

		expect(await steering.steer('a1', 'q1')).toEqual({ outcome: 'settled', verdict: 'absorbed' });
		expect(ids()).toEqual([]);
		expect(entries).toEqual([expect.objectContaining({ source: 'user', steered: true })]);
	});

	it('takes a paused steer off the queue when the turn later says it took it, and frees it when dropped', async () => {
		const first = setup({ verdict: 'unknown' });
		const turn = first.steering.turnStarted('a1', 't1', first.tui);
		await first.steering.steer('a1', 'q1');
		expect(first.ids()).toEqual(['q1 (paused)']);
		turn.verdict({ type: 'steering', id: 'id-1', verdict: 'queued' });
		await Promise.resolve();
		// Taken: Resume can no longer send it a second time.
		expect(first.ids()).toEqual([]);
		expect(first.entries).toEqual([expect.objectContaining({ source: 'user', steered: true })]);

		const second = setup({ verdict: 'unknown' });
		const other = second.steering.turnStarted('a1', 't1', second.tui);
		await second.steering.steer('a1', 'q1');
		other.verdict({ type: 'steering', id: 'id-1', verdict: 'dropped' });
		// Never taken: it sends next, and the tab says so.
		expect(second.ids()).toEqual(['q1']);
		expect(second.entries).toEqual([
			expect.objectContaining({
				source: 'system',
				text: expect.stringContaining('will send next'),
			}),
		]);
	});

	it('brings a steer the agent never took back to the queue, live, with the words the desktop toast uses', async () => {
		const { steering, entries, ids, tui } = setup();
		const turn = steering.turnStarted('a1', 't1', tui);
		await steering.steer('a1', 'q1');

		turn.verdict({ type: 'steering', id: 'id-1', verdict: 'dropped' });

		expect(ids()).toEqual(['q1']);
		expect(entries.map((entry) => entry.source)).toEqual(['user', 'system']);
		expect(entries[1].text).toBe(
			'Steer returned to the queue: the turn ended before Claude Code took your message, so it will send next.'
		);
	});

	it('settles an absorbed steer, and holds one the turn ended on without a word', async () => {
		const { steering, ids, tui, queue, entries } = setup();
		const turn = steering.turnStarted('a1', 't1', tui);
		await steering.steer('a1', 'q1');
		turn.verdict({ type: 'steering', id: 'id-1', verdict: 'absorbed' });
		turn.ended();
		expect(ids()).toEqual([]);

		queue.submit({ id: 'q3', tabId: 't1', text: 'and then this' });
		const next = steering.turnStarted('a1', 't1', tui);
		await steering.steer('a1', 'q3');
		next.ended();
		// Nobody knows whether the agent saw it: kept, paused, and said so.
		expect(ids()).toEqual(['q3 (paused)']);
		expect(entries[entries.length - 1]).toMatchObject({
			source: 'system',
			text: expect.stringContaining('paused rather than sent twice'),
		});
	});

	it('answers not-steerable, and keeps the message, when the tab runs no turn or the turn takes no input', async () => {
		const { steering, ids } = setup();
		expect(await steering.steer('a1', 'q1')).toMatchObject({
			outcome: 'not-steerable',
			blockedReason: 'tab-not-working',
		});
		steering.turnStarted('a1', 't1', { provider: 'claude-code', readOnly: false });
		expect(await steering.steer('a1', 'q1')).toMatchObject({
			outcome: 'not-steerable',
			blockedReason: 'api-token-source',
		});
		expect(await steering.steer('a1', 'nope')).toMatchObject({ outcome: 'not-found' });
		expect(ids()).toEqual(['q1']);
	});
});

describe('runtimeSteerBlockedReason', () => {
	const tui: SteeredTurn = { provider: 'claude-code', readOnly: false, socketPath: '/s' };
	const item = (extra: Partial<SteerableItem> = {}): SteerableItem => ({
		id: 'q1',
		tabId: 't1',
		text: 'hello',
		...extra,
	});

	it.each([
		['a slash command', item({ text: '/compact' }), tui, 'tui-command-prefix'],
		['a message with images', item({ images: ['data:image/png;base64,AA=='] }), tui, 'has-images'],
		// M7: a consult's replies or the @mention notes ride only a normal send.
		['a message with consult replies', item({ agentContext: 'REPLIES' }), tui, 'has-agent-context'],
		['a message with @mention notes', item({ agentNotes: 'NOTES' }), tui, 'has-agent-context'],
		['a read-only message into a writing turn', item({ readOnly: true }), tui, 'read-only'],
		['an empty message', item({ text: '  ' }), tui, 'nothing-to-type'],
		['a codex exec turn', item(), { provider: 'codex', readOnly: false }, 'codex-exec'],
		['a grok turn', item(), { provider: 'grok', readOnly: false }, 'grok-no-input-op'],
	] as const)('refuses %s, as the desktop does', (_label, queued, turn, reason) => {
		expect(runtimeSteerBlockedReason(queued, turn)).toBe(reason);
	});

	it('lets a read-only message into a read-only turn', () => {
		expect(runtimeSteerBlockedReason(item({ readOnly: true }), { ...tui, readOnly: true })).toBe(
			null
		);
	});
});
