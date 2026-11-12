/**
 * The main-process group chat queue: storage, delivery, and the failure paths.
 *
 * The rules themselves are covered in `src/__tests__/shared/groupChatQueueModel.test.ts`.
 * What is exercised here is everything that made the old renderer-owned queue
 * lose messages: who can see it, how many times an item is delivered, whether it
 * survives a restart, and what happens to a file that cannot be read.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let chatsRoot: string;
const CHAT_ID = 'gc-queue';

// The module resolves its file path through `getGroupChatDir`, so the storage
// module is mocked to a temp folder rather than the real user data directory.
vi.mock('../../../main/group-chat/group-chat-storage', () => ({
	getGroupChatDir: (id: string) => path.join(chatsRoot, id),
}));

const captureMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../main/utils/sentry', () => ({
	captureMessage: (...args: unknown[]) => captureMessage(...args),
	captureException: vi.fn().mockResolvedValue(undefined),
}));

import {
	addToQueue,
	getDrainRunCountForTests,
	getQueue,
	installGroupChatQueue,
	onModeratorStateChanged,
	pauseQueueFor,
	removeFromQueue,
	reorderQueue,
	resetGroupChatQueueForTests,
	resumeQueueFor,
	submitMessage,
	waitForQueueSettledForTests,
} from '../../../main/group-chat/group-chat-queue';
import type { GroupChatQueueState } from '../../../shared/group-chat-types';

const item = (id: string, text = `msg-${id}`) => ({ id, timestamp: Date.now(), text });

/**
 * Wait until the queue is genuinely quiet.
 *
 * Deliberately NOT a tick count. Counting ticks is a guess about how many turns
 * a real disk read and write will take, so the same test passes or fails with
 * machine load - which is exactly what produced one unexplained failure in
 * twenty runs. The module tracks its own armed timers and running drains, so
 * this waits on the real thing.
 */
const settle = async (_ticks?: number) => {
	await waitForQueueSettledForTests();
};

/**
 * Wait until the drain has CLAIMED the head item.
 *
 * Tests with a gated send cannot wait for full settlement: the drain is parked
 * inside the send until the gate opens, so `settle()` would deadlock. The claim
 * is the observable moment the send is about to happen.
 */
const waitForClaim = async () => {
	for (let i = 0; i < 1000; i++) {
		if ((await getQueue(CHAT_ID)).items.some((entry) => entry.sending)) return;
		await new Promise((r) => setTimeout(r, 0));
	}
	throw new Error('No item was ever claimed');
};

/**
 * A send that behaves like the real one: the moderator goes BUSY as soon as the
 * message is handed over (`group-chat-router` sets `moderator-thinking` before
 * the spawn returns), so the next item waits for the next idle rather than being
 * swept up by the same one.
 */
const busyOnSend = (h: Harness) => async () => {
	h.idle = false;
};

/** Reinstall `h`'s deps with a send that marks the moderator busy. */
function installBusySend(h: Harness): void {
	installGroupChatQueue({
		broadcast: (id, state) => h.broadcasts.push({ id, state }),
		send: async (_id, text) => {
			h.sends.push(text);
			await busyOnSend(h)();
		},
		postSystemMessage: async (_id, content) => {
			h.systemMessages.push(content);
		},
		isIdle: () => h.idle,
	});
}

interface Harness {
	broadcasts: Array<{ id: string; state: GroupChatQueueState }>;
	sends: string[];
	systemMessages: string[];
	idle: boolean;
}

function install(overrides: Partial<{ send: () => Promise<void> }> = {}): Harness {
	const h: Harness = { broadcasts: [], sends: [], systemMessages: [], idle: true };
	installGroupChatQueue({
		broadcast: (id, state) => h.broadcasts.push({ id, state }),
		send: overrides.send
			? async (_id, text) => {
					h.sends.push(text);
					await overrides.send!();
				}
			: async (_id, text) => {
					h.sends.push(text);
				},
		postSystemMessage: async (_id, content) => {
			h.systemMessages.push(content);
		},
		isIdle: () => h.idle,
	});
	return h;
}

beforeEach(() => {
	chatsRoot = mkdtempSync(path.join(tmpdir(), 'gc-queue-'));
	require('fs').mkdirSync(path.join(chatsRoot, CHAT_ID), { recursive: true });
	captureMessage.mockClear();
	resetGroupChatQueueForTests();
});

afterEach(async () => {
	// Drains are scheduled on a later tick, so a test that ends while one is
	// pending leaks its send into the NEXT test's harness. That is exactly how
	// "sends directly when the queue is empty" intermittently saw two sends.
	await settle();
	rmSync(chatsRoot, { recursive: true, force: true });
	resetGroupChatQueueForTests();
});

describe('T1: an item queued anywhere is visible everywhere and sent once', () => {
	// "Client A" and "client B" are not separate processes here: the point is that
	// there is only ONE queue, so whatever a client renders comes from the
	// broadcast rather than from its own copy. That is the whole fix - the old
	// per-renderer array is what made a phone's queue invisible to the desktop.
	it('broadcasts the new state to every client and delivers exactly once', async () => {
		const h = install();
		h.idle = false; // busy, so the item waits rather than racing the assertion

		await addToQueue(CHAT_ID, item('1', 'hello from the phone'));

		const last = h.broadcasts.at(-1)!;
		expect(last.id).toBe(CHAT_ID);
		expect(last.state.items.map((i) => i.text)).toEqual(['hello from the phone']);

		h.idle = true;
		onModeratorStateChanged(CHAT_ID, true);
		await settle();

		expect(h.sends).toEqual(['hello from the phone']);
		expect((await getQueue(CHAT_ID)).items).toHaveLength(0);
	});
});

describe('T2: two clients seeing idle at the same moment still send once', () => {
	// Every client used to run its own drain, so two that both observed idle each
	// popped their own head and sent. Main holds a single in-flight latch, and the
	// drain is deferred to a later tick so the latch is set before a second one
	// can look.
	it('coalesces concurrent idle notifications into one delivery', async () => {
		const h = install();
		h.idle = false;
		await addToQueue(CHAT_ID, item('1', 'only once please'));

		h.idle = true;
		onModeratorStateChanged(CHAT_ID, true);
		onModeratorStateChanged(CHAT_ID, true);
		onModeratorStateChanged(CHAT_ID, true);
		await settle();

		expect(h.sends).toEqual(['only once please']);
	});
});

describe('T3: the queue survives main reloading it from disk', () => {
	it('reads back the items and holds them paused until asked', async () => {
		const h = install();
		h.idle = false;
		await addToQueue(CHAT_ID, item('1', 'survives a restart'));

		// Simulate a restart: drop every in-memory trace, keep the file.
		resetGroupChatQueueForTests();
		const h2 = install();
		h2.idle = true;

		const restored = await getQueue(CHAT_ID);
		expect(restored.items.map((i) => i.text)).toEqual(['survives a restart']);
		// R5: starting the app must not spawn a moderator to flush an old queue.
		expect(restored.paused).toBe(true);

		onModeratorStateChanged(CHAT_ID, true);
		await settle();
		expect(h2.sends).toEqual([]);

		await resumeQueueFor(CHAT_ID);
		await settle();
		expect(h2.sends).toEqual(['survives a restart']);
	});
});

describe('T4: a failed send keeps the item, warns, and does not retry', () => {
	it('marks the item, pauses, posts a system message, and stays put on the next idle', async () => {
		const h = install({
			send: async () => {
				throw new Error('Encore Feature disabled');
			},
		});
		h.idle = false;
		await addToQueue(CHAT_ID, item('1', 'will fail'));

		h.idle = true;
		onModeratorStateChanged(CHAT_ID, true);
		await settle();

		const state = await getQueue(CHAT_ID);
		expect(state.items).toHaveLength(1);
		expect(state.items[0].failed).toBe(true);
		expect(state.items[0].failureReason).toContain('Encore Feature disabled');
		expect(state.paused).toBe(true);
		expect(h.systemMessages.at(-1)).toContain('queue is paused');

		// R4: one attempt only. A cause that does not clear itself must not spin.
		const attempts = h.sends.length;
		onModeratorStateChanged(CHAT_ID, true);
		await settle();
		expect(h.sends).toHaveLength(attempts);
	});
});

describe('T8 (F5): an unreadable queue file is quarantined, never overwritten', () => {
	it('renames the file, reports it, and opens the chat empty and paused', async () => {
		const filePath = path.join(chatsRoot, CHAT_ID, 'queue.json');
		writeFileSync(filePath, '{ this is not json', 'utf8');
		const h = install();
		h.idle = true;

		const state = await getQueue(CHAT_ID);

		expect(state.items).toEqual([]);
		// Paused, because a damaged queue is exactly the one a human should see
		// before anything is sent from it.
		expect(state.paused).toBe(true);

		const quarantined = readdirSync(path.join(chatsRoot, CHAT_ID)).filter((f) =>
			f.includes('.corrupt-')
		);
		expect(quarantined).toHaveLength(1);
		// The bytes are preserved verbatim. Returning an empty queue and letting
		// the next save overwrite the file is the silent loss this guards.
		expect(readFileSync(path.join(chatsRoot, CHAT_ID, quarantined[0]), 'utf8')).toBe(
			'{ this is not json'
		);
		expect(existsSync(filePath)).toBe(false);
		expect(captureMessage).toHaveBeenCalledWith(
			'Group chat queue file was unreadable',
			'warning',
			expect.objectContaining({ groupChatId: CHAT_ID })
		);
	});
});

describe('Stop All pauses rather than sending (D8)', () => {
	it('holds the queue when the moderator goes idle after a stop', async () => {
		const h = install();
		h.idle = false;
		await addToQueue(CHAT_ID, item('1', 'should not send'));

		await pauseQueueFor(CHAT_ID);
		h.idle = true; // stopAll emits idle after killing the moderator
		onModeratorStateChanged(CHAT_ID, true);
		await settle();

		expect(h.sends).toEqual([]);
		expect((await getQueue(CHAT_ID)).items).toHaveLength(1);
	});
});

describe('T9 (F6): editing the queue during a send never drops the wrong message', () => {
	// The drainer used to complete by POSITION: it took the head, awaited the
	// send, then removed whatever was first at that moment. Delete or reorder
	// during the send and the completion landed on a different message, which was
	// discarded having never been sent.
	it('completes the item that was actually sent and keeps every other one', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const h = install({ send: () => gate });
		h.idle = false;
		await addToQueue(CHAT_ID, item('a', 'first'));
		await addToQueue(CHAT_ID, item('b', 'second'));
		await addToQueue(CHAT_ID, item('c', 'third'));

		h.idle = true;
		onModeratorStateChanged(CHAT_ID, true);
		// Wait for the claim rather than for settlement: the send is gated open, so
		// the drain is parked inside it and will not settle until `release()`.
		await waitForClaim();
		expect(h.sends[0]).toBe('first');

		// 'a' is in flight. Reorder the others under it.
		await reorderQueue(CHAT_ID, 'c', 0);
		release();
		await settle();

		await settle();
		const state = await getQueue(CHAT_ID);

		// The point is not how many drained. It is that the item that was IN FLIGHT
		// is the one completed, and that reordering under it dropped nothing: all
		// three arrive, exactly once each, with the sent one first.
		expect(h.sends[0]).toBe('first');
		expect([...h.sends].sort()).toEqual(['first', 'second', 'third']);
		expect(state.items).toHaveLength(0);
	});

	it('refuses to remove the item that is currently sending', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const h = install({ send: () => gate });
		h.idle = false;
		await addToQueue(CHAT_ID, item('a', 'in flight'));

		h.idle = true;
		onModeratorStateChanged(CHAT_ID, true);
		await waitForClaim();

		const mid = await getQueue(CHAT_ID);
		expect(mid.items[0].sending).toBe(true);

		const refusal = await removeFromQueue(CHAT_ID, 'a');
		expect(refusal.refused).toBe(true);
		expect((await getQueue(CHAT_ID)).items.map((i) => i.id)).toEqual(['a']);

		release();
		await settle();
		expect((await getQueue(CHAT_ID)).items).toHaveLength(0);
	});
});

describe('T10 (F7): concurrent adds on a cold chat both survive', () => {
	// Only the WRITE used to be serialized. Two adds on a chat with nothing
	// cached both loaded the same empty state, and the second save erased the
	// first item. Most likely right after launch, which is exactly when a phone
	// and the desktop both reconnect.
	it('keeps both items when two adds race before anything is cached', async () => {
		const h = install();
		h.idle = false;

		await Promise.all([
			addToQueue(CHAT_ID, item('x', 'from the phone')),
			addToQueue(CHAT_ID, item('y', 'from the desktop')),
		]);

		const state = await getQueue(CHAT_ID);
		expect(state.items.map((i) => i.text).sort()).toEqual(['from the desktop', 'from the phone']);
	});
});

describe('T11 (D10): main decides whether to queue or send', () => {
	// A client deciding from its own copy can send directly while items are
	// waiting, putting the newest message ahead of older ones.
	it('queues a submit that arrives while items are waiting, rather than sending it', async () => {
		const h: Harness = install();
		installBusySend(h);
		h.idle = false;
		await addToQueue(CHAT_ID, item('old', 'queued earlier'));

		// The moderator is free now, and a stale client thinks the queue is empty.
		h.idle = true;
		const state = await submitMessage(CHAT_ID, item('new', 'typed just now'));

		expect(h.sends).not.toContain('typed just now');
		expect(state.items.map((i) => i.text)).toEqual(['queued earlier', 'typed just now']);

		// Let the queue run the way it does in production: each send leaves the
		// moderator busy, so the next item needs its own idle event. The older
		// message must still reach the moderator first - that ordering is the
		// entire reason a late submit is queued.
		await settle();
		h.idle = true;
		onModeratorStateChanged(CHAT_ID, true);
		await settle();
		expect(h.sends).toEqual(['queued earlier', 'typed just now']);
	});

	it('sends directly when the queue is empty and the moderator is idle', async () => {
		const h = install();
		h.idle = true;

		await submitMessage(CHAT_ID, item('solo', 'straight through'));

		expect(h.sends).toEqual(['straight through']);
		expect((await getQueue(CHAT_ID)).items).toHaveLength(0);
	});
});

describe('T12 (F8): a cold cache with racing idles and a submit still delivers once each', () => {
	// The latch used to be claimed AFTER the disk read, so two drains - or a drain
	// and a submit - could both pass the "is anyone sending?" test during it. With
	// nothing cached the read is slowest, which is why this is a launch-time bug.
	it('delivers each item exactly once', async () => {
		const h = install();
		h.idle = false;
		await addToQueue(CHAT_ID, item('q1', 'queued one'));
		resetGroupChatQueueForTests(); // cold cache, file on disk
		const h2 = install();
		h2.idle = true;
		await resumeQueueFor(CHAT_ID); // restored queues come back paused

		onModeratorStateChanged(CHAT_ID, true);
		onModeratorStateChanged(CHAT_ID, true);
		const submitted = submitMessage(CHAT_ID, item('s1', 'submitted at the same time'));
		await submitted;
		await settle();

		const counts = h2.sends.reduce<Record<string, number>>((acc, text) => {
			acc[text] = (acc[text] ?? 0) + 1;
			return acc;
		}, {});
		for (const [text, n] of Object.entries(counts)) {
			expect(`${text}:${n}`).toBe(`${text}:1`);
		}
		expect((await getQueue(CHAT_ID)).items).toHaveLength(0);
	});
});

describe('T13 (F9): a sending mark does not survive a restart', () => {
	// Nothing is in flight after a restart. Left in the file the mark makes the
	// item permanently un-removable, and the only escape is Resume, which sends
	// it a second time.
	it('loads paused with the mark cleared, and the item can be removed', async () => {
		writeFileSync(
			path.join(chatsRoot, CHAT_ID, 'queue.json'),
			JSON.stringify({
				items: [{ id: 'stuck', timestamp: 1, text: 'mid-send when main died', sending: true }],
				paused: false,
			}),
			'utf8'
		);
		const h = install();
		h.idle = true;

		const state = await getQueue(CHAT_ID);
		expect(state.items[0].sending).toBeUndefined();
		expect(state.paused).toBe(true);

		await removeFromQueue(CHAT_ID, 'stuck');
		expect((await getQueue(CHAT_ID)).items).toHaveLength(0);
	});
});

describe('T14 (F10): a wrong-shaped queue file is quarantined too', () => {
	it.each([
		['null', 'null'],
		['an array', '[]'],
		['items that is not a list', '{"items":5}'],
	])('renames and reports %s, opening empty and paused', async (_label, contents) => {
		const filePath = path.join(chatsRoot, CHAT_ID, 'queue.json');
		writeFileSync(filePath, contents, 'utf8');
		const h = install();
		h.idle = true;

		const state = await getQueue(CHAT_ID);

		expect(state.items).toEqual([]);
		expect(state.paused).toBe(true);
		const quarantined = readdirSync(path.join(chatsRoot, CHAT_ID)).filter((f) =>
			f.includes('.corrupt-')
		);
		expect(quarantined).toHaveLength(1);
		// The bytes survive verbatim rather than being overwritten by the next save.
		expect(readFileSync(path.join(chatsRoot, CHAT_ID, quarantined[0]), 'utf8')).toBe(contents);
		expect(existsSync(filePath)).toBe(false);
		expect(captureMessage).toHaveBeenCalled();
	});
});

describe('T15 (F11): the drainer waits for the next idle instead of spinning', () => {
	// The reschedule used to fire on EVERY exit, including "nothing to send". One
	// idle event then armed a timer that re-armed itself every tick for as long as
	// the app was open, each run paying a write-queue round trip on the main
	// thread. The old tests could not see it: the reset nulls `deps`, which ends
	// the loop, and a 6-tick settle is far too short to notice.
	it('Case A: an empty queue and one idle runs a bounded number of drains', async () => {
		const h = install();
		h.idle = true;

		onModeratorStateChanged(CHAT_ID, true);
		await settle(50);

		const runs = getDrainRunCountForTests();
		expect(runs).toBeLessThanOrEqual(2);
		expect(h.sends).toEqual([]);

		// Nothing must still be armed: a second long wait adds no further runs.
		await settle(50);
		expect(getDrainRunCountForTests()).toBe(runs);
	});

	it('Case B: a busy moderator with items queued runs a bounded number of drains', async () => {
		const h = install();
		h.idle = false;
		await addToQueue(CHAT_ID, item('1', 'waiting'));
		await addToQueue(CHAT_ID, item('2', 'also waiting'));

		// Let the drains the two adds scheduled run first, so the count below
		// measures the idle event rather than the setup.
		await settle();
		const before = getDrainRunCountForTests();
		onModeratorStateChanged(CHAT_ID, true); // an idle event, but still busy
		await settle(50);

		const runs = getDrainRunCountForTests();
		expect(runs - before).toBeLessThanOrEqual(2);
		expect(h.sends).toEqual([]);

		await settle(50);
		expect(getDrainRunCountForTests()).toBe(runs);
	});
});

describe('T16 (F12): an item deleted while the queue loads is never sent', () => {
	// The race is narrow and has to be hit deliberately. `canDrain` reads the
	// queue and calls `isIdle`, and `markSending` writes in a SECOND chain entry.
	// A remove enqueued from inside `isIdle` therefore lands exactly between the
	// two. Before the fix the delete succeeded, `markSending` found nothing to
	// mark, and the drainer sent the deleted message from its stale copy anyway.
	it('does not deliver the removed item and leaves the rest queued', async () => {
		const h: Harness = { broadcasts: [], sends: [], systemMessages: [], idle: true };
		let removalStarted = false;
		let removalResult: Promise<GroupChatQueueState> | null = null;
		installGroupChatQueue({
			broadcast: (id, state) => h.broadcasts.push({ id, state }),
			send: async (_id, text) => {
				h.sends.push(text);
				h.idle = false;
			},
			postSystemMessage: async (_id, content) => {
				h.systemMessages.push(content);
			},
			isIdle: () => {
				// Fires once, from inside the drain's own decision step.
				if (!removalStarted) {
					removalStarted = true;
					removalResult = removeFromQueue(CHAT_ID, 'doomed').then((r) => r.state);
				}
				return h.idle;
			},
		});

		h.idle = false;
		await addToQueue(CHAT_ID, item('doomed', 'deleted while loading'));
		await addToQueue(CHAT_ID, item('keep', 'still wanted'));

		h.idle = true;
		onModeratorStateChanged(CHAT_ID, true);
		await settle(20);

		// Which side of the claim the remove lands on is genuinely not fixed - both
		// orderings are correct. What must hold either way is that the delete and
		// the delivery cannot BOTH succeed:
		//
		//   remove succeeded  ->  the item was never sent
		//   remove refused    ->  the item was sent, and is gone because it was
		//                         delivered rather than because the user deleted it
		//
		// Before the fix neither held: the remove returned a queue without the item
		// AND the drainer sent that same item from its stale copy, so the user
		// watched their message vanish and then get answered.
		const afterRemoval = await removalResult!;
		const removeSucceeded = !afterRemoval.items.some((i) => i.id === 'doomed');
		const wasSent = h.sends.includes('deleted while loading');

		if (removeSucceeded) {
			expect(wasSent).toBe(false);
		} else {
			// Refused because it was already claimed, and the claim is visible.
			expect(afterRemoval.items.find((i) => i.id === 'doomed')?.sending).toBe(true);
			expect(wasSent).toBe(true);
		}

		// The message the user kept is never lost either way.
		const state = await getQueue(CHAT_ID);
		const texts = [...h.sends, ...state.items.map((i) => i.text)];
		expect(texts).toContain('still wanted');
	});
});

describe('T17 (R7): a moderator that goes busy before the send is not sent to', () => {
	// `isIdle` is consulted in the decision step, then `markSending` is awaited.
	// If the moderator picks up other work during that await, the drainer used to
	// send to it regardless, because nothing checked again.
	it('clears the mark, sends nothing, and delivers once on the next idle', async () => {
		const h: Harness = { broadcasts: [], sends: [], systemMessages: [], idle: true };
		let idleCalls = 0;
		installGroupChatQueue({
			broadcast: (id, state) => h.broadcasts.push({ id, state }),
			send: async (_id, text) => {
				h.sends.push(text);
				h.idle = false;
			},
			postSystemMessage: async (_id, content) => {
				h.systemMessages.push(content);
			},
			// Idle for the decision, busy by the time the send would happen.
			isIdle: () => {
				idleCalls += 1;
				return idleCalls === 1 ? true : h.idle;
			},
		});

		h.idle = false;
		await addToQueue(CHAT_ID, item('m1', 'must wait for idle'));
		onModeratorStateChanged(CHAT_ID, true);
		await settle(20);

		expect(h.sends).toEqual([]);
		const held = await getQueue(CHAT_ID);
		expect(held.items).toHaveLength(1);
		// A stale in-flight mark would make the item permanently un-removable.
		expect(held.items[0].sending).toBeUndefined();

		h.idle = true;
		onModeratorStateChanged(CHAT_ID, true);
		await settle(20);
		expect(h.sends).toEqual(['must wait for idle']);
	});
});

describe('T18 (F13): nothing changed means nothing written and nothing broadcast', () => {
	// Once wired, `isIdle` fires for every chat on every moderator state change.
	// Writing `queue.json` and waking every client each time - empty queue or not -
	// is a cost paid forever on the main thread for no information.
	it('an idle event on an empty queue neither saves nor broadcasts', async () => {
		const h = install();
		h.idle = true;
		await getQueue(CHAT_ID); // prime the cache without writing
		const broadcastsBefore = h.broadcasts.length;
		const fileExisted = existsSync(path.join(chatsRoot, CHAT_ID, 'queue.json'));

		onModeratorStateChanged(CHAT_ID, true);
		await settle();

		expect(h.broadcasts.length).toBe(broadcastsBefore);
		expect(existsSync(path.join(chatsRoot, CHAT_ID, 'queue.json'))).toBe(fileExisted);
		expect(h.sends).toEqual([]);
	});

	it('a refused delete reports refused and writes nothing', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const h = install({ send: () => gate });
		h.idle = false;
		await addToQueue(CHAT_ID, item('a', 'in flight'));

		h.idle = true;
		onModeratorStateChanged(CHAT_ID, true);
		// Wait for the claim, not for the whole drain: the send is gated open.
		await waitForClaim();

		const broadcastsBefore = h.broadcasts.length;
		const result = await removeFromQueue(CHAT_ID, 'a');

		// The client can say "Sending, can't remove" rather than silently redrawing.
		expect(result.refused).toBe(true);
		expect(result.state.items.map((i) => i.id)).toEqual(['a']);
		expect(h.broadcasts.length).toBe(broadcastsBefore);

		release();
		await settle();
	});
});

describe('T19 (F16): after a failure, the next message you type gets the queue moving', () => {
	// Adding a message used to un-pause without clearing the failed mark on the
	// head. `canDrain` refuses a failed head, so the queue reported itself as
	// running, showed no Resume control, and sent nothing. A silent stall with no
	// affordance to clear it is worse than a visible pause.
	it('sends the failed item then the new one, in order, with no Resume', async () => {
		let failNext = true;
		const h: Harness = { broadcasts: [], sends: [], systemMessages: [], idle: true };
		installGroupChatQueue({
			broadcast: (id, state) => h.broadcasts.push({ id, state }),
			send: async (_id, text) => {
				if (failNext) {
					failNext = false;
					throw new Error('transient');
				}
				h.sends.push(text);
				h.idle = false;
			},
			postSystemMessage: async (_id, content) => {
				h.systemMessages.push(content);
			},
			isIdle: () => h.idle,
		});

		h.idle = false;
		await addToQueue(CHAT_ID, item('first', 'the failed one'));
		h.idle = true;
		onModeratorStateChanged(CHAT_ID, true);
		await settle();

		const failedState = await getQueue(CHAT_ID);
		expect(failedState.paused).toBe(true);
		expect(failedState.items[0].failed).toBe(true);

		// The user types something new. No Resume is pressed.
		h.idle = true;
		await addToQueue(CHAT_ID, item('second', 'the new one'));
		await settle();
		h.idle = true;
		onModeratorStateChanged(CHAT_ID, true);
		await settle();

		expect(h.sends).toEqual(['the failed one', 'the new one']);
		expect((await getQueue(CHAT_ID)).items).toHaveLength(0);
	});
});

describe('T20 (F15): a failed direct send keeps its place at the front', () => {
	// The direct send was handed over BEFORE anything queued while it ran, so
	// appending it would reorder the user's own messages. It also has to be the
	// head, because Resume only clears the mark on the head.
	it('puts the failed message first, and Resume then sends everything in order', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let failDirect = true;
		const h: Harness = { broadcasts: [], sends: [], systemMessages: [], idle: true };
		installGroupChatQueue({
			broadcast: (id, state) => h.broadcasts.push({ id, state }),
			send: async (_id, text) => {
				if (failDirect) {
					failDirect = false;
					await gate;
					throw new Error('direct send failed');
				}
				h.sends.push(text);
				h.idle = false;
			},
			postSystemMessage: async (_id, content) => {
				h.systemMessages.push(content);
			},
			isIdle: () => h.idle,
		});

		// A direct send starts, then two more messages arrive while it is running.
		const direct = submitMessage(CHAT_ID, item('direct', 'sent first'));
		await new Promise((r) => setTimeout(r, 0));
		await addToQueue(CHAT_ID, item('q1', 'queued during'));
		await addToQueue(CHAT_ID, item('q2', 'queued during too'));

		release();
		await direct;
		await settle();

		const state = await getQueue(CHAT_ID);
		expect(state.items.map((i) => i.text)).toEqual([
			'sent first',
			'queued during',
			'queued during too',
		]);
		expect(state.items[0].failed).toBe(true);
		expect(state.paused).toBe(true);

		// Resume clears the head's mark, and everything goes in the original order.
		h.idle = true;
		await resumeQueueFor(CHAT_ID);
		await settle();
		for (let i = 0; i < 3; i++) {
			h.idle = true;
			onModeratorStateChanged(CHAT_ID, true);
			await settle();
		}
		expect(h.sends).toEqual(['sent first', 'queued during', 'queued during too']);
	});
});
