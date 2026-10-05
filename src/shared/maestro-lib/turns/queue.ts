/**
 * The execution queue (gap L10): one active turn per tab, later messages held in order.
 *
 * The desktop spreads these rules over `useInputProcessing` (queue or run now),
 * `exitDequeue` (what runs when a turn ends), `useQueueProcessing` (the drain and its
 * watchdog), `useInterruptHandler` (Stop with items waiting) and `agentStore.processQueuedItem`
 * (what a failed dispatch does). The TUI needs the same answers, so the decisions are pure
 * functions here and `createExecutionQueue` is the one owner of the state they act on.
 *
 * What it keeps from the desktop, rule for rule:
 *
 * - A tab runs one turn at a time. A message for a busy tab waits.
 * - A write turn waits for every other tab's turn; a read-only turn (or a forced-parallel one)
 *   waits only for its own tab. A write turn may still start beside read-only work when
 *   nothing queued or running is a writer (`canWriteBypassQueue`).
 * - Order is strict from the head: the first runnable item decides. A blocked head blocks the
 *   items behind it, except items the user has paused, which are skipped in place.
 * - A pending retry on a tab holds that tab's queue (Agent Resilience).
 * - An Auto Run holds its agent's working tree: a write turn waits for the run to end.
 * - A dispatch that fails never loses the prompt. The item keeps its place. A collision (the
 *   tab's previous process has not gone) stays runnable and is looked at again; any other
 *   failure comes back held, so a cause that will not clear cannot spin the queue.
 *
 * Where it departs, on purpose:
 *
 * - Stop does not start the next item by itself. The desktop dispatches the next item the
 *   moment the signal is sent, races the dying process, takes the collision, and relies on a
 *   second drain from the exit listener. Here the queue owns the process, so the next item
 *   starts when the interrupted turn has actually ended. The result is the same; the collision
 *   path is not part of Stop.
 * - Every trigger is an edge the queue sees (a turn ends, an item is submitted, resumed or
 *   removed), so the desktop's poll for a stalled queue is only needed after a collision.
 * - No transcript or busy state lives here. The queue says what ran when; the runtime writes
 *   the records.
 */

import { logger } from '../host';

/** What the queue reads of an item. The runtime's own item shape extends it. */
export interface QueueItem {
	id: string;
	/** The tab the turn runs on. */
	tabId: string;
	/** The turn will not write: it may run beside other tabs' turns. */
	readOnly?: boolean;
	/** The person asked for it to run beside other tabs' turns. */
	forceParallel?: boolean;
	/** Held by the person (or by a failed dispatch): kept in place, never dispatched. */
	paused?: boolean;
}

/** A turn the queue started. */
export interface QueuedTurnHandle {
	/** Settles when the turn has ended, however it ended. It should not reject; if it does, the turn is over. */
	done: Promise<unknown>;
	/** Stop the turn the way the Stop button does. */
	interrupt(): void;
}

/**
 * `start` throws this when the tab's previous process still owns the tab. It is a timing
 * collision, not a verdict on the item: the item stays runnable and is tried again.
 */
export class TurnCollisionError extends Error {
	constructor(message = 'A turn is already running on this tab') {
		super(message);
		this.name = 'TurnCollisionError';
	}
}

export type QueueEvent<T extends QueueItem> =
	/** The item is waiting. `position` counts from the head of the queue. */
	| { type: 'queued'; item: T; position: number }
	/** The item's turn started. `direct` is true when it never waited. */
	| { type: 'started'; item: T; direct: boolean }
	| { type: 'ended'; item: T }
	/** `start` threw. `held` is true when the item came back paused. */
	| { type: 'dispatch-failed'; item: T; error: Error; held: boolean }
	| { type: 'removed'; item: T }
	/** A pause or resume changed the item. */
	| { type: 'updated'; item: T };

export interface ExecutionQueueOptions<T extends QueueItem> {
	/** Start the item's turn. Throw (reject) when it cannot start; see `TurnCollisionError`. */
	start(item: T): Promise<QueuedTurnHandle>;
	/** Does this tab have a retry counting down? A tab in a retry holds its queue. */
	isRetryHeld?(tabId: string): boolean;
	/**
	 * An Auto Run holds the agent's working tree (AE17): a turn that would write waits until it
	 * ends, and a read-only or forced-parallel one still runs. The owner calls `drain()` when the
	 * hold clears.
	 */
	holdsTree?(): boolean;
	onEvent?(event: QueueEvent<T>): void;
	/** How long to wait before trying again after a collision. Default 4000. */
	recheckMs?: number;
	/** Test seam for the recheck timer. Returns its canceller. */
	schedule?(run: () => void, ms: number): () => void;
}

/** A turn that is running, as the decisions see it. */
export interface BusyTurn {
	tabId: string;
	readOnly?: boolean;
}

export interface QueueView<T extends QueueItem> {
	/** Turns running or starting. */
	busy: readonly BusyTurn[];
	/** Items waiting, in order, held ones included. */
	queued: readonly T[];
	isRetryHeld?(tabId: string): boolean;
	/** An Auto Run holds the working tree. */
	holdsTree?: boolean;
}

/** A turn the working-tree hold keeps back: it would write, and nobody forced it past the run. */
function blockedByTreeHold(item: QueueItem, view: { holdsTree?: boolean }): boolean {
	return view.holdsTree === true && !item.readOnly && !item.forceParallel;
}

export const DEFAULT_COLLISION_RECHECK_MS = 4000;

/** An item that dispatch may take: the person has not paused it. */
export function isRunnable(item: QueueItem): boolean {
	return !item.paused;
}

/** The first item that would run, skipping held ones. */
export function nextRunnable<T extends QueueItem>(queue: readonly T[]): T | undefined {
	return queue.find(isRunnable);
}

/**
 * A write turn may start beside running work only when all of that work, and everything
 * waiting, is read-only: no two writers share a working directory.
 */
function canWriteBypassQueue<T extends QueueItem>(item: T, view: QueueView<T>): boolean {
	if (item.readOnly) return false;
	if (view.busy.length === 0) return false;
	return view.busy.every((turn) => turn.readOnly === true) && view.queued.every((q) => q.readOnly);
}

/**
 * Run a new message now, or queue it? The composer's rule (`useInputProcessing`), minus the
 * bridge-connection hold, which the TUI does not have. The Auto Run hold arrives as `holdsTree`.
 */
export function decideSubmit<T extends QueueItem>(item: T, view: QueueView<T>): 'run' | 'queue' {
	// A retry counting down holds the tab even though the tab reads idle: sending now burns
	// against the same wall. This outranks force-parallel, which only skips tab serialization.
	if (view.isRetryHeld?.(item.tabId)) return 'queue';
	if (blockedByTreeHold(item, view)) return 'queue';
	const tabBusy = view.busy.some((turn) => turn.tabId === item.tabId);
	if (tabBusy) return 'queue';
	if (item.forceParallel) return 'run';
	if (view.queued.some(isRunnable)) return 'queue';
	if (item.readOnly) return 'run';
	if (view.busy.length === 0) return 'run';
	return canWriteBypassQueue(item, view) ? 'run' : 'queue';
}

export type NextDecision<T extends QueueItem> =
	| { action: 'dispatch'; item: T }
	| { action: 'wait'; item: T }
	| { action: 'none' };

/**
 * What runs next, after a turn ends (`exitingTabId`) or anything else changed the queue
 * (`chooseNextQueuedItem` in the desktop). Strict from the head: the first runnable item is
 * the only candidate.
 */
export function chooseNext<T extends QueueItem>(
	view: QueueView<T>,
	exitingTabId?: string
): NextDecision<T> {
	const head = nextRunnable(view.queued);
	if (!head) return { action: 'none' };
	// The exiting tab's retry means the provider is refusing work now; the head's own tab may
	// be in a different retry, and dispatching there would discard its prompt.
	if (exitingTabId && view.isRetryHeld?.(exitingTabId)) return { action: 'wait', item: head };
	if (view.isRetryHeld?.(head.tabId)) return { action: 'wait', item: head };
	if (blockedByTreeHold(head, view)) return { action: 'wait', item: head };
	if (view.busy.some((turn) => turn.tabId === head.tabId)) return { action: 'wait', item: head };
	const othersBusy = view.busy.length > 0;
	if (head.forceParallel || head.readOnly || !othersBusy) return { action: 'dispatch', item: head };
	return { action: 'wait', item: head };
}

export interface ExecutionQueue<T extends QueueItem> {
	/** Run the item now or queue it, by `decideSubmit`. The turn starts asynchronously. */
	submit(item: T): { queued: boolean };
	/** The items waiting, in order. An item being started is not waiting. */
	items(): readonly T[];
	isTabBusy(tabId: string): boolean;
	/** Tabs with a turn running or starting. */
	busyTabIds(): string[];
	/** Stop the running turn of a tab, or of every tab. Queued items start as the turns end. */
	interrupt(tabId?: string): void;
	/** Hold or release an item. Returns false when no waiting item has that id. */
	setPaused(id: string, paused: boolean): boolean;
	/** Take a waiting item out. Returns false when it is not waiting (it may already be running). */
	remove(id: string): boolean;
	/** Look at the queue again, for a hold that cleared (a retry that landed). */
	drain(): void;
	/** Resolves when no turn is running or starting. Items may still wait, held or blocked. */
	settled(): Promise<void>;
	/** Stop looking: no more dispatches, no recheck timer. Running turns are left to end. */
	dispose(): void;
}

interface Entry<T extends QueueItem> {
	item: T;
	state: 'queued' | 'starting';
	/** Stop was requested while `start` was still pending. */
	interruptRequested?: boolean;
}

interface ActiveTurn<T extends QueueItem> {
	item: T;
	handle: QueuedTurnHandle;
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

export function createExecutionQueue<T extends QueueItem>(
	options: ExecutionQueueOptions<T>
): ExecutionQueue<T> {
	const entries: Entry<T>[] = [];
	const active = new Map<string, ActiveTurn<T>>();
	const starting = new Map<string, Entry<T>>();
	const settledWaiters: Array<() => void> = [];
	const schedule =
		options.schedule ??
		((run: () => void, ms: number) => {
			const timer = setTimeout(run, ms);
			timer.unref?.();
			return () => clearTimeout(timer);
		});
	let cancelRecheck: (() => void) | undefined;
	let disposed = false;

	// A throwing listener must not break a dispatch half way: the item would be left starting.
	const emit = (event: QueueEvent<T>): void => {
		try {
			options.onEvent?.(event);
		} catch (error) {
			logger.warn(`A queue listener threw: ${asError(error).message}`, 'ExecutionQueue');
		}
	};

	const waiting = (): T[] => entries.filter((e) => e.state === 'queued').map((e) => e.item);

	const busyTurns = (): BusyTurn[] => [
		...[...active.values()].map(({ item }) => ({ tabId: item.tabId, readOnly: item.readOnly })),
		...[...starting.values()].map(({ item }) => ({ tabId: item.tabId, readOnly: item.readOnly })),
	];

	const view = (): QueueView<T> => ({
		busy: busyTurns(),
		queued: waiting(),
		isRetryHeld: options.isRetryHeld,
		holdsTree: options.holdsTree?.() ?? false,
	});

	const notifyIfSettled = (): void => {
		if (active.size > 0 || starting.size > 0) return;
		for (const resolve of settledWaiters.splice(0)) resolve();
	};

	const scheduleRecheck = (): void => {
		if (disposed || cancelRecheck) return;
		cancelRecheck = schedule(() => {
			cancelRecheck = undefined;
			drain();
		}, options.recheckMs ?? DEFAULT_COLLISION_RECHECK_MS);
	};

	const dispatch = async (entry: Entry<T>, direct: boolean): Promise<void> => {
		const { item } = entry;
		entry.state = 'starting';
		starting.set(item.tabId, entry);

		let handle: QueuedTurnHandle;
		try {
			handle = await options.start(item);
		} catch (cause) {
			const error = asError(cause);
			const collision = error instanceof TurnCollisionError;
			starting.delete(item.tabId);
			entry.state = 'queued';
			// A collision stays runnable; anything else would fail the same way next tick.
			if (!collision) entry.item = { ...item, paused: true };
			emit({ type: 'dispatch-failed', item: entry.item, error, held: !collision });
			if (collision) {
				// Draining now would pick the same head and collide again, in a loop. The next
				// edge or the recheck retries it.
				scheduleRecheck();
				notifyIfSettled();
			} else {
				notifyIfSettled();
				drain();
			}
			return;
		}

		starting.delete(item.tabId);
		const index = entries.indexOf(entry);
		if (index !== -1) entries.splice(index, 1);
		active.set(item.tabId, { item, handle });
		emit({ type: 'started', item, direct });
		if (entry.interruptRequested) handle.interrupt();

		void Promise.resolve(handle.done)
			.catch(() => undefined)
			.then(() => {
				active.delete(item.tabId);
				emit({ type: 'ended', item });
				drain(item.tabId);
				notifyIfSettled();
			});
	};

	function drain(exitingTabId?: string): void {
		if (disposed) return;
		for (;;) {
			const decision = chooseNext(view(), exitingTabId);
			if (decision.action !== 'dispatch') return;
			const entry = entries.find((e) => e.item === decision.item);
			if (!entry) return;
			void dispatch(entry, false);
		}
	}

	return {
		submit(item) {
			if (disposed) throw new Error('The execution queue was disposed');
			const entry: Entry<T> = { item, state: 'queued' };
			const decision = decideSubmit(item, view());
			entries.push(entry);
			if (decision === 'run') {
				void dispatch(entry, true);
				return { queued: false };
			}
			emit({ type: 'queued', item, position: waiting().length - 1 });
			// A queued item can be runnable already (its blockers ended while it was decided).
			drain();
			return { queued: true };
		},

		items: waiting,

		isTabBusy(tabId) {
			return active.has(tabId) || starting.has(tabId);
		},

		busyTabIds() {
			return busyTurns().map((turn) => turn.tabId);
		},

		interrupt(tabId) {
			for (const [id, turn] of active) {
				if (tabId === undefined || id === tabId) turn.handle.interrupt();
			}
			for (const [id, entry] of starting) {
				if (tabId === undefined || id === tabId) entry.interruptRequested = true;
			}
		},

		setPaused(id, paused) {
			const entry = entries.find((e) => e.state === 'queued' && e.item.id === id);
			if (!entry) return false;
			if (Boolean(entry.item.paused) === paused) return true;
			entry.item = { ...entry.item, paused };
			emit({ type: 'updated', item: entry.item });
			if (!paused) drain();
			return true;
		},

		remove(id) {
			const index = entries.findIndex((e) => e.state === 'queued' && e.item.id === id);
			if (index === -1) return false;
			const [entry] = entries.splice(index, 1);
			emit({ type: 'removed', item: entry.item });
			// A removed head can unblock what is behind it.
			drain();
			return true;
		},

		drain() {
			drain();
		},

		settled() {
			if (active.size === 0 && starting.size === 0) return Promise.resolve();
			return new Promise<void>((resolve) => settledWaiters.push(resolve));
		},

		dispose() {
			disposed = true;
			cancelRecheck?.();
			cancelRecheck = undefined;
		},
	};
}
