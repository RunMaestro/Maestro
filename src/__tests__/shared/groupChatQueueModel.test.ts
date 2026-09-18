/**
 * The group chat queue's behaviour rules.
 *
 * These cover the decisions, not the plumbing: what the queue becomes when a
 * message is sent, when Stop All is pressed, when a send fails, and when the
 * user resumes. The main-process module around them adds persistence, the
 * broadcast and the actual moderator send.
 *
 * The invariant every case here defends: a message the user typed is either
 * delivered or still in the queue with the chat paused. It is never silently
 * dropped, and it is never retried unattended.
 */

import { describe, expect, it } from 'vitest';

import {
	canDrain,
	completeHead,
	emptyQueueState,
	enqueueMessage,
	failHead,
	mustQueue,
	parseQueueState,
	pauseQueue,
	removeItem,
	reorderItem,
	requeueFailedAtFront,
	resumeQueue,
} from '../../shared/groupChatQueueModel';
import type { GroupChatQueuedItem } from '../../shared/group-chat-types';

const item = (id: string, text = `msg-${id}`): GroupChatQueuedItem => ({
	id,
	timestamp: Number(id.replace(/\D/g, '')) || 1,
	text,
});

const queueOf = (...ids: string[]) => ({ items: ids.map((id) => item(id)), paused: false });

describe('queueing rather than sending', () => {
	it('sends directly only when the moderator is idle and nothing is waiting', () => {
		expect(mustQueue(emptyQueueState(), true)).toBe(false);
	});

	it('queues while the moderator is busy', () => {
		expect(mustQueue(emptyQueueState(), false)).toBe(true);
	});

	// Without this a message typed now would overtake messages typed earlier,
	// which defeats the only thing a queue is for.
	it('queues when anything is already waiting, even if the moderator is idle', () => {
		expect(mustQueue(queueOf('1'), true)).toBe(true);
	});

	it('queues while paused, even if the moderator is idle and the queue is empty', () => {
		expect(mustQueue({ items: [], paused: true }, true)).toBe(true);
	});
});

describe('T5: Stop All pauses rather than sending the next item', () => {
	// Before this, `stopAll` emitted idle after killing the moderator, the drain
	// fired on that idle, and the send auto-restarted the moderator that Stop All
	// had just killed. Pressing stop restarted the room.
	it('holds a populated queue and sends nothing', () => {
		const stopped = pauseQueue(queueOf('1', '2'));

		expect(stopped.paused).toBe(true);
		expect(stopped.items).toHaveLength(2);
		expect(canDrain(stopped, true)).toBe(false);
	});
});

describe('T6: a failed send is kept, marked, and never retried on its own', () => {
	it('keeps the item, marks it, and pauses', () => {
		const failed = failHead(queueOf('1', '2'), 'Encore Feature disabled');

		expect(failed.items).toHaveLength(2);
		expect(failed.items[0].failed).toBe(true);
		expect(failed.items[0].failureReason).toBe('Encore Feature disabled');
		expect(failed.items[0].text).toBe('msg-1');
		expect(failed.paused).toBe(true);
	});

	// A cause that does not clear itself would otherwise re-fire on every idle
	// forever. That is a loop, not a recovery.
	it('does not drain on the next idle', () => {
		expect(canDrain(failHead(queueOf('1'), 'boom'), true)).toBe(false);
	});

	// Refusing forever would make the resume control a dead button.
	it('drains again once the user resumes, with the mark cleared', () => {
		const resumed = resumeQueue(failHead(queueOf('1', '2'), 'boom'));

		expect(resumed.paused).toBe(false);
		expect(resumed.items[0].failed).toBeUndefined();
		expect(resumed.items[0].failureReason).toBeUndefined();
		expect(canDrain(resumed, true)).toBe(true);
	});
});

describe('T7: a new message while paused appends and resumes', () => {
	it('goes to the end, resumes, and preserves order', () => {
		const paused = pauseQueue(queueOf('1', '2'));
		const next = enqueueMessage(paused, item('3'));

		expect(next.paused).toBe(false);
		expect(next.items.map((i) => i.id)).toEqual(['1', '2', '3']);
		expect(canDrain(next, true)).toBe(true);
	});

	// F16: adding a message must leave the queue genuinely runnable. Un-pausing
	// while the head still carries a `failed` mark produces a queue that reports
	// itself as running, offers no Resume control, and sends nothing - a worse
	// stall than a visible pause, because there is no affordance to clear it.
	// The old version of this test only passed because it called `resumeQueue`
	// itself, which hid exactly that gap.
	it('clears a failed head so the queue can actually move, with no Resume needed', () => {
		const stuck = failHead(queueOf('1'), 'boom');
		const next = enqueueMessage(stuck, item('2'));

		expect(next.paused).toBe(false);
		expect(next.items.map((i) => i.id)).toEqual(['1', '2']);
		expect(next.items[0].failed).toBeUndefined();
		expect(next.items[0].failureReason).toBeUndefined();
		// No `resumeQueue` here on purpose: that is the point.
		expect(canDrain(next, true)).toBe(true);
	});

	// F15: a direct send that failed was handed over BEFORE anything queued while
	// it ran, so it goes back to the front rather than behind them.
	it('puts a failed direct send at the front, paused', () => {
		const queuedDuringSend = queueOf('later-1', 'later-2');
		const next = requeueFailedAtFront(queuedDuringSend, item('original'), 'boom');

		expect(next.items.map((i) => i.id)).toEqual(['original', 'later-1', 'later-2']);
		expect(next.items[0].failed).toBe(true);
		expect(next.paused).toBe(true);
		// Resume clears only the head, so the failed item must BE the head or it
		// stops the queue again later while showing as running.
		expect(canDrain(resumeQueue(next), true)).toBe(true);
	});
});

describe('draining', () => {
	it('will not drain an empty or paused queue', () => {
		expect(canDrain(emptyQueueState(), true)).toBe(false);
		expect(canDrain(pauseQueue(queueOf('1')), true)).toBe(false);
	});

	it('will not drain while the moderator is busy', () => {
		expect(canDrain(queueOf('1'), false)).toBe(false);
	});

	it('removes the head once delivered and leaves the rest in order', () => {
		const after = completeHead(queueOf('1', '2', '3'));
		expect(after.items.map((i) => i.id)).toEqual(['2', '3']);
	});

	it('keeps a pause across a completed send', () => {
		expect(completeHead(pauseQueue(queueOf('1', '2'))).paused).toBe(true);
	});
});

describe('editing the queue', () => {
	it('removes by id', () => {
		expect(removeItem(queueOf('1', '2', '3'), '2').items.map((i) => i.id)).toEqual(['1', '3']);
	});

	it('reorders and clamps an out-of-range index instead of dropping the move', () => {
		expect(reorderItem(queueOf('1', '2', '3'), '3', 0).items.map((i) => i.id)).toEqual([
			'3',
			'1',
			'2',
		]);
		expect(reorderItem(queueOf('1', '2', '3'), '1', 99).items.map((i) => i.id)).toEqual([
			'2',
			'3',
			'1',
		]);
	});

	it('ignores a reorder for an item that is gone', () => {
		const state = queueOf('1', '2');
		expect(reorderItem(state, 'missing', 0)).toBe(state);
	});
});

describe('reading a queue off disk', () => {
	// F10: a file that parses as JSON but is the wrong SHAPE is just as damaged as
	// one that does not parse. Degrading to an empty queue lets the next save
	// overwrite it, so the caller can quarantine the bytes only if this throws.
	it('rejects a top level that is not an object', () => {
		expect(() => parseQueueState(null)).toThrow();
		expect(() => parseQueueState('nonsense')).toThrow();
		expect(() => parseQueueState([])).toThrow();
	});

	it('rejects a missing or non-array items field', () => {
		expect(() => parseQueueState({})).toThrow();
		expect(() => parseQueueState({ items: 5 })).toThrow();
		expect(() => parseQueueState({ items: 'not-an-array' })).toThrow();
	});

	// Dropping one bad entry silently is the same loss one element down.
	it('rejects a malformed item rather than dropping it', () => {
		expect(() => parseQueueState({ items: [item('1'), null] })).toThrow();
		expect(() => parseQueueState({ items: [{ noId: true }] })).toThrow();
	});

	it('round-trips a paused queue', () => {
		const saved = pauseQueue(queueOf('1'));
		expect(parseQueueState(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
	});

	it('accepts a well-formed empty queue', () => {
		expect(parseQueueState({ items: [], paused: false })).toEqual({ items: [], paused: false });
	});
});
