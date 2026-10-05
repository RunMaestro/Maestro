/**
 * The execution queue: the desktop's queue rules, driven with turns the test ends by hand.
 */
import { describe, it, expect } from 'vitest';

import {
	TurnCollisionError,
	chooseNext,
	createExecutionQueue,
	decideSubmit,
	type QueueEvent,
	type QueueItem,
	type QueuedTurnHandle,
} from '../../../../shared/maestro-lib/turns/queue';

interface Item extends QueueItem {
	text: string;
}

const item = (id: string, tabId: string, extra: Partial<Item> = {}): Item => ({
	id,
	tabId,
	text: id,
	...extra,
});

interface Turn {
	item: Item;
	end(): void;
	interrupted: boolean;
}

/** A queue whose turns last until the test ends them. `failures` scripts `start` per item id. */
function harness(options: { retryHeld?: Set<string> } = {}) {
	const turns: Turn[] = [];
	const events: QueueEvent<Item>[] = [];
	const failures = new Map<string, Error[]>();
	const timers: Array<() => void> = [];
	const startOrder: string[] = [];

	const queue = createExecutionQueue<Item>({
		start: async (queued) => {
			const scripted = failures.get(queued.id)?.shift();
			if (scripted) throw scripted;
			startOrder.push(queued.id);
			let end!: () => void;
			const done = new Promise<void>((resolve) => {
				end = resolve;
			});
			const turn: Turn = { item: queued, end, interrupted: false };
			turns.push(turn);
			const handle: QueuedTurnHandle = {
				done,
				interrupt: () => {
					turn.interrupted = true;
					// A stopped turn ends on its own, a moment later in real life.
					end();
				},
			};
			return handle;
		},
		isRetryHeld: (tabId) => options.retryHeld?.has(tabId) ?? false,
		onEvent: (event) => events.push(event),
		schedule: (run) => {
			timers.push(run);
			return () => {
				const index = timers.indexOf(run);
				if (index !== -1) timers.splice(index, 1);
			};
		},
	});

	const turnFor = (id: string): Turn => {
		const turn = turns.find((t) => t.item.id === id);
		if (!turn) throw new Error(`no turn started for ${id}`);
		return turn;
	};
	/** Let queued microtasks (the async `start`, the `done` handlers) run. */
	const flush = async (): Promise<void> => {
		for (let i = 0; i < 10; i += 1) await Promise.resolve();
	};
	return { queue, turns, events, failures, timers, startOrder, turnFor, flush };
}

describe('decideSubmit', () => {
	const view = (
		busy: Array<{ tabId: string; readOnly?: boolean }> = [],
		queued: Item[] = [],
		retryHeld: string[] = []
	) => ({ busy, queued, isRetryHeld: (tabId: string) => retryHeld.includes(tabId) });

	it('runs on an idle agent', () => {
		expect(decideSubmit(item('a', 't1'), view())).toBe('run');
	});

	it('queues behind a busy tab, forced parallel or not', () => {
		expect(decideSubmit(item('a', 't1'), view([{ tabId: 't1' }]))).toBe('queue');
		expect(decideSubmit(item('a', 't1', { forceParallel: true }), view([{ tabId: 't1' }]))).toBe(
			'queue'
		);
	});

	it('queues a write behind another tab, but lets a read-only turn run beside it', () => {
		expect(decideSubmit(item('a', 't2'), view([{ tabId: 't1' }]))).toBe('queue');
		expect(decideSubmit(item('a', 't2', { readOnly: true }), view([{ tabId: 't1' }]))).toBe('run');
	});

	it('lets a write run beside read-only work only when everything is read-only', () => {
		const readOnlyBusy = [{ tabId: 't1', readOnly: true }];
		expect(decideSubmit(item('a', 't2'), view(readOnlyBusy))).toBe('run');
		expect(
			decideSubmit(item('a', 't2'), view(readOnlyBusy, [item('q', 't3', { readOnly: false })]))
		).toBe('queue');
		expect(decideSubmit(item('a', 't2'), view([{ tabId: 't1', readOnly: false }]))).toBe('queue');
	});

	it('queues behind runnable queued work, but not behind a paused item', () => {
		expect(decideSubmit(item('a', 't2'), view([], [item('q', 't1')]))).toBe('queue');
		expect(decideSubmit(item('a', 't2'), view([], [item('q', 't1', { paused: true })]))).toBe(
			'run'
		);
		expect(
			decideSubmit(item('a', 't2', { forceParallel: true }), view([], [item('q', 't1')]))
		).toBe('run');
	});

	it('queues while the tab has a retry counting down, even when forced parallel', () => {
		expect(decideSubmit(item('a', 't1'), view([], [], ['t1']))).toBe('queue');
		expect(decideSubmit(item('a', 't1', { forceParallel: true }), view([], [], ['t1']))).toBe(
			'queue'
		);
	});
});

describe('chooseNext', () => {
	const view = (
		busy: Array<{ tabId: string; readOnly?: boolean }>,
		queued: Item[],
		retryHeld: string[] = []
	) => ({ busy, queued, isRetryHeld: (tabId: string) => retryHeld.includes(tabId) });

	it('has nothing to do for an empty or fully held queue', () => {
		expect(chooseNext(view([], []))).toEqual({ action: 'none' });
		expect(chooseNext(view([], [item('a', 't1', { paused: true })]))).toEqual({ action: 'none' });
	});

	it('skips a held item and dispatches the first runnable one', () => {
		const queued = [item('a', 't1', { paused: true }), item('b', 't1')];
		expect(chooseNext(view([], queued))).toEqual({ action: 'dispatch', item: queued[1] });
	});

	it('waits for a write item while another tab is busy, and runs read-only or forced items', () => {
		const busy = [{ tabId: 't1' }];
		expect(chooseNext(view(busy, [item('a', 't2')])).action).toBe('wait');
		expect(chooseNext(view(busy, [item('a', 't2', { readOnly: true })])).action).toBe('dispatch');
		expect(chooseNext(view(busy, [item('a', 't2', { forceParallel: true })])).action).toBe(
			'dispatch'
		);
	});

	it('holds the queue for the exiting tab and for the head tab while a retry counts down', () => {
		expect(chooseNext(view([], [item('a', 't2')], ['t1']), 't1').action).toBe('wait');
		expect(chooseNext(view([], [item('a', 't2')], ['t2']), 't1').action).toBe('wait');
		expect(chooseNext(view([], [item('a', 't2')], ['t3']), 't1').action).toBe('dispatch');
	});

	it('does not let a runnable item overtake a blocked head', () => {
		const queued = [item('write', 't2'), item('ro', 't3', { readOnly: true })];
		expect(chooseNext(view([{ tabId: 't1' }], queued))).toEqual({
			action: 'wait',
			item: queued[0],
		});
	});
});

describe('createExecutionQueue ordering', () => {
	it('starts an idle send directly and runs later sends for the same tab one at a time, in order', async () => {
		const h = harness();
		expect(h.queue.submit(item('a', 't1'))).toEqual({ queued: false });
		expect(h.queue.submit(item('b', 't1'))).toEqual({ queued: true });
		expect(h.queue.submit(item('c', 't1'))).toEqual({ queued: true });
		await h.flush();
		expect(h.startOrder).toEqual(['a']);
		expect(h.queue.items().map((i) => i.id)).toEqual(['b', 'c']);
		expect(h.queue.isTabBusy('t1')).toBe(true);

		h.turnFor('a').end();
		await h.flush();
		expect(h.startOrder).toEqual(['a', 'b']);
		expect(h.queue.items().map((i) => i.id)).toEqual(['c']);

		h.turnFor('b').end();
		await h.flush();
		h.turnFor('c').end();
		await h.queue.settled();
		expect(h.startOrder).toEqual(['a', 'b', 'c']);
		expect(h.queue.items()).toEqual([]);
		expect(h.queue.busyTabIds()).toEqual([]);
	});

	it('reports queued, started, and ended events with positions and the direct flag', async () => {
		const h = harness();
		h.queue.submit(item('a', 't1'));
		h.queue.submit(item('b', 't1'));
		await h.flush();
		h.turnFor('a').end();
		await h.flush();
		h.turnFor('b').end();
		await h.queue.settled();
		expect(h.events.map((e) => `${e.type}:${e.item.id}`)).toEqual([
			// `started` is announced once the process exists, so it follows the synchronous `queued`.
			'queued:b',
			'started:a',
			'ended:a',
			'started:b',
			'ended:b',
		]);
		const queued = h.events.find((e) => e.type === 'queued');
		expect(queued).toMatchObject({ position: 0 });
		expect(h.events.find((e) => e.type === 'started' && e.item.id === 'a')).toMatchObject({
			direct: true,
		});
		expect(h.events.find((e) => e.type === 'started' && e.item.id === 'b')).toMatchObject({
			direct: false,
		});
	});

	it('holds a write item for another tab, and starts it when that tab ends', async () => {
		const h = harness();
		h.queue.submit(item('a', 't1'));
		h.queue.submit(item('b', 't2'));
		await h.flush();
		expect(h.startOrder).toEqual(['a']);
		h.turnFor('a').end();
		await h.flush();
		expect(h.startOrder).toEqual(['a', 'b']);
	});

	it('runs read-only turns on different tabs at once, and a write beside only read-only work', async () => {
		const h = harness();
		h.queue.submit(item('r1', 't1', { readOnly: true }));
		h.queue.submit(item('r2', 't2', { readOnly: true }));
		h.queue.submit(item('w', 't3'));
		await h.flush();
		expect(h.startOrder).toEqual(['r1', 'r2', 'w']);
		expect(h.queue.items()).toEqual([]);
	});

	it('runs a read-only turn beside a write turn on another tab', async () => {
		const h = harness();
		h.queue.submit(item('w', 't1'));
		h.queue.submit(item('r', 't2', { readOnly: true }));
		await h.flush();
		expect(h.startOrder).toEqual(['w', 'r']);
	});

	it('starts every dispatchable item in one drain, and holds a write behind a blocked head', async () => {
		const h = harness();
		h.queue.submit(item('w1', 't1'));
		h.queue.submit(item('w2', 't2'));
		h.queue.submit(item('r1', 't3', { readOnly: true }));
		h.queue.submit(item('r2', 't4', { readOnly: true }));
		h.queue.submit(item('w3', 't5'));
		await h.flush();
		// w2 waits for w1; the read-only items queue behind it (work ahead) rather than overtaking.
		expect(h.startOrder).toEqual(['w1']);
		expect(h.queue.items().map((i) => i.id)).toEqual(['w2', 'r1', 'r2', 'w3']);
		h.turnFor('w1').end();
		await h.flush();
		// w2 runs; r1 and r2 may run beside it; w3 is a write and waits for w2.
		expect(h.startOrder).toEqual(['w1', 'w2', 'r1', 'r2']);
		expect(h.queue.items().map((i) => i.id)).toEqual(['w3']);
		h.turnFor('w2').end();
		await h.flush();
		expect(h.startOrder).toEqual(['w1', 'w2', 'r1', 'r2']);
		h.turnFor('r1').end();
		h.turnFor('r2').end();
		await h.flush();
		expect(h.startOrder).toEqual(['w1', 'w2', 'r1', 'r2', 'w3']);
	});

	it('skips a paused item in place and runs it after resume, without reordering', async () => {
		const h = harness();
		h.queue.submit(item('a', 't1'));
		h.queue.submit(item('b', 't1'));
		h.queue.submit(item('c', 't1'));
		await h.flush();
		expect(h.queue.setPaused('b', true)).toBe(true);
		h.turnFor('a').end();
		await h.flush();
		expect(h.startOrder).toEqual(['a', 'c']);
		expect(h.queue.items().map((i) => i.id)).toEqual(['b']);
		expect(h.queue.setPaused('b', false)).toBe(true);
		h.turnFor('c').end();
		await h.flush();
		expect(h.startOrder).toEqual(['a', 'c', 'b']);
		expect(h.queue.setPaused('nope', true)).toBe(false);
	});

	it('removes a waiting item and lets the item behind it run', async () => {
		const h = harness();
		h.queue.submit(item('a', 't1'));
		h.queue.submit(item('b', 't2'));
		h.queue.submit(item('c', 't3'));
		await h.flush();
		expect(h.queue.remove('b')).toBe(true);
		expect(h.queue.remove('a')).toBe(false);
		h.turnFor('a').end();
		await h.flush();
		expect(h.startOrder).toEqual(['a', 'c']);
	});

	it('holds a tab behind a retry until drain() is called after it clears', async () => {
		const retryHeld = new Set(['t1']);
		const h = harness({ retryHeld });
		expect(h.queue.submit(item('a', 't1'))).toEqual({ queued: true });
		await h.flush();
		expect(h.startOrder).toEqual([]);
		retryHeld.clear();
		h.queue.drain();
		await h.flush();
		expect(h.startOrder).toEqual(['a']);
	});
});

describe('createExecutionQueue dispatch failure', () => {
	it('keeps a failed direct send in the queue, held, in its place', async () => {
		const h = harness();
		h.failures.set('a', [new Error('spawn ENOENT')]);
		h.queue.submit(item('a', 't1'));
		await h.flush();
		expect(h.startOrder).toEqual([]);
		expect(h.queue.isTabBusy('t1')).toBe(false);
		expect(h.queue.items()).toEqual([expect.objectContaining({ id: 'a', paused: true })]);
		const failed = h.events.find((e) => e.type === 'dispatch-failed');
		expect(failed).toMatchObject({
			held: true,
			error: expect.objectContaining({ message: 'spawn ENOENT' }),
		});
	});

	it('does not spin on a held failure and does not reorder the queue around it', async () => {
		const h = harness();
		h.queue.submit(item('a', 't1'));
		await h.flush();
		h.queue.submit(item('b', 't1'));
		h.queue.submit(item('c', 't1'));
		h.failures.set('b', [new Error('boom')]);
		h.turnFor('a').end();
		await h.flush();
		// b failed and is held at its place; c, behind it, runs.
		expect(h.startOrder).toEqual(['a', 'c']);
		expect(h.queue.items()).toEqual([expect.objectContaining({ id: 'b', paused: true })]);
		expect(h.events.filter((e) => e.type === 'dispatch-failed')).toHaveLength(1);
		h.turnFor('c').end();
		await h.flush();
		// Releasing the hold sends it, exactly once.
		h.queue.setPaused('b', false);
		await h.flush();
		expect(h.startOrder).toEqual(['a', 'c', 'b']);
		expect(h.queue.items()).toEqual([]);
	});

	it('keeps the failed item ahead of items that were behind it when a held item sits in front', async () => {
		const h = harness();
		h.queue.submit(item('a', 't1'));
		await h.flush();
		h.queue.submit(item('held', 't2', { paused: true }));
		h.queue.submit(item('b', 't1'));
		h.failures.set('b', [new Error('boom')]);
		h.turnFor('a').end();
		await h.flush();
		expect(h.queue.items().map((i) => i.id)).toEqual(['held', 'b']);
	});

	it('leaves a collision runnable, does not retry in a loop, and tries again on the recheck', async () => {
		const h = harness();
		h.queue.submit(item('a', 't1'));
		await h.flush();
		h.queue.submit(item('b', 't1'));
		h.failures.set('b', [new TurnCollisionError()]);
		h.turnFor('a').end();
		await h.flush();
		expect(h.startOrder).toEqual(['a']);
		expect(h.queue.items()).toEqual([expect.objectContaining({ id: 'b' })]);
		expect(h.queue.items()[0].paused).toBeUndefined();
		expect(h.events.find((e) => e.type === 'dispatch-failed')).toMatchObject({ held: false });
		expect(h.timers).toHaveLength(1);

		h.timers.splice(0)[0]();
		await h.flush();
		expect(h.startOrder).toEqual(['a', 'b']);
		expect(h.queue.items()).toEqual([]);
	});

	it('keeps rechecking while the collision persists, one timer at a time', async () => {
		const h = harness();
		h.failures.set('a', [new TurnCollisionError(), new TurnCollisionError()]);
		h.queue.submit(item('a', 't1'));
		await h.flush();
		expect(h.timers).toHaveLength(1);
		h.timers.splice(0)[0]();
		await h.flush();
		expect(h.timers).toHaveLength(1);
		h.timers.splice(0)[0]();
		await h.flush();
		expect(h.startOrder).toEqual(['a']);
	});

	it('survives a throwing event listener', async () => {
		const queue = createExecutionQueue<Item>({
			start: async () => ({ done: Promise.resolve(), interrupt: () => undefined }),
			onEvent: () => {
				throw new Error('listener bug');
			},
		});
		queue.submit(item('a', 't1'));
		await queue.settled();
		expect(queue.busyTabIds()).toEqual([]);
	});
});

describe('createExecutionQueue interrupt', () => {
	it('stops the running turn, then starts the next queued item after it has ended', async () => {
		const h = harness();
		h.queue.submit(item('a', 't1'));
		h.queue.submit(item('b', 't1'));
		h.queue.submit(item('c', 't1'));
		await h.flush();
		h.queue.interrupt();
		await h.flush();
		expect(h.turnFor('a').interrupted).toBe(true);
		expect(h.startOrder).toEqual(['a', 'b']);
		expect(h.queue.items().map((i) => i.id)).toEqual(['c']);
		expect(h.turnFor('b').interrupted).toBe(false);
	});

	it('does not dispatch the next item while the interrupted turn is still ending', async () => {
		const turns: Array<{ end: () => void; item: Item; interrupts: number }> = [];
		const queue = createExecutionQueue<Item>({
			start: async (queued) => {
				let end!: () => void;
				const done = new Promise<void>((resolve) => {
					end = resolve;
				});
				const turn = { end, item: queued, interrupts: 0 };
				turns.push(turn);
				// The process takes its time to die: interrupt alone does not end the turn.
				return { done, interrupt: () => (turn.interrupts += 1) };
			},
		});
		queue.submit(item('a', 't1'));
		queue.submit(item('b', 't1'));
		for (let i = 0; i < 10; i += 1) await Promise.resolve();
		queue.interrupt();
		for (let i = 0; i < 10; i += 1) await Promise.resolve();
		expect(turns.map((t) => t.item.id)).toEqual(['a']);
		expect(turns[0].interrupts).toBe(1);
		turns[0].end();
		for (let i = 0; i < 10; i += 1) await Promise.resolve();
		expect(turns.map((t) => t.item.id)).toEqual(['a', 'b']);
	});

	it('interrupts only the named tab', async () => {
		const h = harness();
		h.queue.submit(item('a', 't1', { readOnly: true }));
		h.queue.submit(item('b', 't2', { readOnly: true }));
		await h.flush();
		h.queue.interrupt('t2');
		await h.flush();
		expect(h.turnFor('a').interrupted).toBe(false);
		expect(h.turnFor('b').interrupted).toBe(true);
		expect(h.queue.busyTabIds()).toEqual(['t1']);
	});

	it('stops a turn the moment it starts when Stop arrived while it was still starting', async () => {
		const h = harness();
		h.queue.submit(item('a', 't1'));
		// `start` has not resolved yet: the tab is reserved but there is no process to signal.
		expect(h.queue.isTabBusy('t1')).toBe(true);
		h.queue.interrupt();
		await h.flush();
		expect(h.turnFor('a').interrupted).toBe(true);
	});

	it('does not drop or reorder items waiting behind an interrupt', async () => {
		const h = harness();
		h.queue.submit(item('a', 't1'));
		h.queue.submit(item('b', 't1'));
		h.queue.submit(item('c', 't1'));
		h.queue.submit(item('d', 't1'));
		await h.flush();
		h.queue.interrupt();
		await h.flush();
		h.queue.interrupt();
		await h.flush();
		expect(h.startOrder).toEqual(['a', 'b', 'c']);
		expect(h.queue.items().map((i) => i.id)).toEqual(['d']);
	});
});

describe('createExecutionQueue lifecycle', () => {
	it('settled() resolves at once on an idle queue and after the last turn otherwise', async () => {
		const h = harness();
		await h.queue.settled();
		h.queue.submit(item('a', 't1'));
		let settled = false;
		void h.queue.settled().then(() => {
			settled = true;
		});
		await h.flush();
		expect(settled).toBe(false);
		h.turnFor('a').end();
		await h.queue.settled();
		expect(settled).toBe(true);
	});

	it('stops dispatching after dispose, and refuses new sends', async () => {
		const h = harness();
		h.queue.submit(item('a', 't1'));
		h.queue.submit(item('b', 't1'));
		await h.flush();
		h.queue.dispose();
		h.turnFor('a').end();
		await h.flush();
		expect(h.startOrder).toEqual(['a']);
		expect(() => h.queue.submit(item('c', 't1'))).toThrow(/disposed/);
	});

	it('treats a turn whose done rejects as ended', async () => {
		const queue = createExecutionQueue<Item>({
			start: async () => ({
				done: Promise.reject(new Error('stream broke')),
				interrupt: () => undefined,
			}),
		});
		queue.submit(item('a', 't1'));
		await queue.settled();
		expect(queue.busyTabIds()).toEqual([]);
	});
});
