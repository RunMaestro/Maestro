/**
 * The main process's ownership of each group chat's pending sends.
 *
 * Why main owns this at all: the queue used to be a zustand array in the
 * renderer, so every client had its own. A message queued on a phone was
 * invisible to the desktop, died with the browser tab that held it, and was
 * delivered only if that one client happened to observe the moderator going
 * idle. Moving it here makes one queue per chat, visible to every client and
 * drained exactly once by the process that actually knows when the moderator is
 * free.
 *
 * The rules live next door in `src/shared/groupChatQueueModel.ts` as pure
 * functions. This module is the part that cannot be pure: reading and writing
 * the file, broadcasting, and calling the send.
 *
 * The invariant the whole thing exists to hold: a message the user typed is
 * delivered, or it is still in the queue with the chat paused and the user told
 * why. There is no path that drops one silently.
 */

import { existsSync } from 'fs';
import { mkdir, readFile, rename } from 'fs/promises';
import path from 'path';

import type { GroupChatQueuedItem, GroupChatQueueState } from '../../shared/group-chat-types';
import {
	canDrain,
	completeItem,
	emptyQueueState,
	enqueueMessage,
	failItem,
	markSending,
	mustQueue,
	parseQueueState,
	pauseQueue,
	removeItem,
	requeueFailedAtFront,
	reorderItem,
	resumeQueue,
} from '../../shared/groupChatQueueModel';
import { atomicWriteJson, createKeyedWriteQueue } from '../utils/atomic-json-store';
import { logger } from '../utils/logger';
import { captureMessage } from '../utils/sentry';
import { getGroupChatDir } from './group-chat-storage';

const LOG_CONTEXT = 'GroupChatQueue';

/**
 * One write chain per group chat id.
 *
 * Every mutation is a read-modify-write of the same file, so two of them racing
 * on one chat is a lost update - exactly the class this repo's shared helper
 * exists to prevent. Keyed, so unrelated chats still write concurrently.
 */
const writeQueue = createKeyedWriteQueue();

/** In-memory copy, so a read does not hit the disk on every broadcast. */
const cache = new Map<string, GroupChatQueueState>();

/**
 * Chats with a send in flight right now.
 *
 * Separate from `paused`: pausing is a decision that persists, this is a
 * transient "one send at a time" latch. Without it, two idle events arriving
 * close together would each start the head item.
 */
const inFlight = new Set<string>();

function queueFilePath(groupChatId: string): string {
	return path.join(getGroupChatDir(groupChatId), 'queue.json');
}

/**
 * Read a chat's queue off disk.
 *
 * An unreadable file is MOVED ASIDE rather than ignored. Returning an empty
 * queue and carrying on looks harmless and is not: the next save would write
 * over the file, so whatever the user had queued is gone with no trace and no
 * warning. That is the same silent loss this feature was built to end, so the
 * bytes are preserved under `.corrupt-<timestamp>` and the failure is reported.
 *
 * A restored queue always comes back PAUSED. Launching the app must not spawn a
 * moderator just to flush messages from a previous session, and a queue whose
 * file was damaged is exactly the one a human should look at before it sends.
 */
async function loadQueue(groupChatId: string): Promise<GroupChatQueueState> {
	const cached = cache.get(groupChatId);
	if (cached) return cached;

	const filePath = queueFilePath(groupChatId);
	if (!existsSync(filePath)) {
		const empty = emptyQueueState();
		cache.set(groupChatId, empty);
		return empty;
	}

	let state: GroupChatQueueState;
	try {
		state = parseQueueState(JSON.parse(await readFile(filePath, 'utf8')));
	} catch (err) {
		const quarantine = `${filePath}.corrupt-${Date.now()}`;
		try {
			await rename(filePath, quarantine);
		} catch (renameErr) {
			// If it cannot even be moved, refuse to write over it below.
			logger.error(`Could not quarantine unreadable queue file`, LOG_CONTEXT, {
				groupChatId,
				error: renameErr instanceof Error ? renameErr.message : String(renameErr),
			});
		}
		await captureMessage('Group chat queue file was unreadable', 'warning', {
			groupChatId,
			quarantine,
			error: err instanceof Error ? err.message : String(err),
		});
		logger.warn(`Queue file unreadable, moved to ${quarantine}`, LOG_CONTEXT, { groupChatId });
		state = pauseQueue(emptyQueueState());
		cache.set(groupChatId, state);
		return state;
	}

	// Nothing is being sent after a restart, so a `sending` mark left in the file
	// is a lie that outlives the process that set it. Left in place it would make
	// the item permanently un-removable and un-reorderable (both refuse an
	// in-flight item), and the only escape would be Resume, which sends it again.
	const cleaned: GroupChatQueueState = {
		...state,
		items: state.items.map(({ sending: _sending, ...item }) => item),
	};

	// A queue that survived a restart holds until the user asks for it (R5).
	const restored = cleaned.items.length > 0 ? pauseQueue(cleaned) : cleaned;
	cache.set(groupChatId, restored);
	return restored;
}

/** Callbacks the handler module supplies, so this file imports no IPC surface. */
export interface GroupChatQueueDeps {
	/** Fan the whole state out to every client (desktop windows and web). */
	broadcast: (groupChatId: string, state: GroupChatQueueState) => void;
	/** Deliver one message. The step-A extraction from the IPC handler. */
	send: (
		groupChatId: string,
		message: string,
		images?: string[],
		readOnly?: boolean
	) => Promise<void>;
	/** Post a system message into the chat transcript. */
	postSystemMessage: (groupChatId: string, content: string) => Promise<void>;
	/** Whether the moderator for this chat is idle right now. */
	isIdle: (groupChatId: string) => boolean;
}

let deps: GroupChatQueueDeps | null = null;

export function installGroupChatQueue(next: GroupChatQueueDeps): void {
	deps = next;
}

/**
 * How many times `drain` has run. Test seam for the self-rescheduling bug: a
 * count that keeps climbing while nothing is queued means the drainer is
 * spinning rather than waiting for the next idle.
 */
let drainRuns = 0;

/** Test seam: how many drains have run since the last reset. */
export function getDrainRunCountForTests(): number {
	return drainRuns;
}

/**
 * Timers armed by `scheduleDrain`, and the drains currently running.
 *
 * Tracked so a test can wait for the queue to be genuinely QUIET rather than
 * counting event-loop ticks. Tick counting is a guess about how many turns a
 * disk read and a write will take, so it passes or fails with machine load -
 * which is what made one run in twenty fail for no visible reason.
 */
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
const runningDrains = new Set<Promise<void>>();

/**
 * Test seam: resolve once no drain is armed or running.
 *
 * Loops because finishing one drain can arm the next (a completed send
 * re-checks for anything queued while it ran).
 */
export async function waitForQueueSettledForTests(): Promise<void> {
	for (let guard = 0; guard < 1000; guard++) {
		if (pendingTimers.size === 0 && runningDrains.size === 0) return;
		if (runningDrains.size > 0) {
			await Promise.allSettled([...runningDrains]);
			continue;
		}
		// A timer is armed but has not fired. Yield until it does.
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error('Group chat queue never settled');
}

/** Test seam: drop all in-memory state. */
export function resetGroupChatQueueForTests(): void {
	for (const timer of pendingTimers) clearTimeout(timer);
	pendingTimers.clear();
	runningDrains.clear();
	cache.clear();
	inFlight.clear();
	deps = null;
	drainRuns = 0;
}

/**
 * Read, change and write one chat's queue as a single serialized step.
 *
 * The WHOLE read-modify-write runs inside the keyed chain, not just the write.
 * Serializing only the write still lets two callers load the same state and
 * compute their changes from it, and the second save then erases the first
 * caller's item - the classic lost update, and one that is most likely right
 * after launch when nothing is cached yet and two clients both add.
 */
async function mutate(
	groupChatId: string,
	change: (current: GroupChatQueueState) => GroupChatQueueState
): Promise<{ state: GroupChatQueueState; changed: boolean }> {
	const result = await writeQueue.enqueue(groupChatId, async () => {
		const current = await loadQueue(groupChatId);
		const updated = change(current);

		// A change function that hands back the SAME object is saying "nothing to
		// do" - a refused remove, a reorder of a missing item, a drain that found
		// nothing to claim. Writing and broadcasting anyway would mean every idle
		// event in every chat rewrote `queue.json` and woke every client, empty
		// queue or not, for as long as the app is open.
		if (updated === current) return { state: current, changed: false };

		cache.set(groupChatId, updated);
		// The chat folder normally exists, but the queue must not be the thing that
		// makes an unrelated action fail: `stopAll` pauses the queue, so a missing
		// directory here would turn Stop All into an error the user cannot act on.
		await mkdir(path.dirname(queueFilePath(groupChatId)), { recursive: true });
		await atomicWriteJson(queueFilePath(groupChatId), updated);
		return { state: updated, changed: true };
	});
	if (result.changed) deps?.broadcast(groupChatId, result.state);
	return result;
}

export async function getQueue(groupChatId: string): Promise<GroupChatQueueState> {
	return writeQueue.enqueue(groupChatId, () => loadQueue(groupChatId));
}

export async function addToQueue(
	groupChatId: string,
	item: GroupChatQueuedItem
): Promise<GroupChatQueueState> {
	const { state } = await mutate(groupChatId, (current) => enqueueMessage(current, item));
	scheduleDrain(groupChatId);
	return state;
}

/**
 * Result of an edit that the queue may decline.
 *
 * `refused` is true when the item is already in flight. Without it the client
 * gets back a state that still contains the item and cannot tell whether the
 * remove failed or simply had not applied yet, so it has nothing to say beyond
 * silently redrawing the row.
 */
export interface QueueEditResult {
	state: GroupChatQueueState;
	refused: boolean;
}

export async function removeFromQueue(
	groupChatId: string,
	itemId: string
): Promise<QueueEditResult> {
	const { state, changed } = await mutate(groupChatId, (current) => removeItem(current, itemId));
	// Only a present-but-sending item counts as refused. An id that is simply
	// gone changed nothing either, but there is nothing to tell the user.
	const refused = !changed && state.items.some((entry) => entry.id === itemId);
	return { state, refused };
}

export async function reorderQueue(
	groupChatId: string,
	itemId: string,
	toIndex: number
): Promise<QueueEditResult> {
	const { state, changed } = await mutate(groupChatId, (current) =>
		reorderItem(current, itemId, toIndex)
	);
	const refused = !changed && state.items.some((entry) => entry.id === itemId);
	return { state, refused };
}

export async function resumeQueueFor(groupChatId: string): Promise<GroupChatQueueState> {
	const { state } = await mutate(groupChatId, resumeQueue);
	scheduleDrain(groupChatId);
	return state;
}

/** Hold a chat's queue. Called by Stop All (D8). */
export async function pauseQueueFor(groupChatId: string): Promise<GroupChatQueueState> {
	return (await mutate(groupChatId, pauseQueue)).state;
}

/**
 * Consider sending the head item, on a later tick.
 *
 * Deferred deliberately. The send emits its own state changes, and those call
 * back into the idle hook that triggers this - running inline would let one
 * idle start two sends before the in-flight latch was set.
 */
export function scheduleDrain(groupChatId: string): void {
	const timer = setTimeout(() => {
		pendingTimers.delete(timer);
		const run = drain(groupChatId).finally(() => {
			runningDrains.delete(run);
		});
		runningDrains.add(run);
		void run;
	}, 0);
	pendingTimers.add(timer);
}

/**
 * Send the head item if the queue is allowed to move.
 *
 * KNOWN LIMIT, deliberately not fixed: if main dies after the moderator has
 * accepted an item but before `completeHead` is persisted, that item is still on
 * disk and a later resume sends it a second time. It cannot happen on its own,
 * because a queue restored from disk comes back paused and only a human resume
 * or a new message releases it. Closing it properly needs a two-phase record of
 * "handed over" separate from "completed", which is more machinery than the
 * failure warrants today.
 */
async function drain(groupChatId: string): Promise<void> {
	// Claim the latch in the SAME synchronous step as the test. Checking here and
	// adding after the disk read leaves an await in between, and two drains - or a
	// drain and a submit - can both pass the test during it and send the same
	// item twice. Most likely right after launch, when nothing is cached and the
	// read is slowest.
	const active = deps;
	if (!active || inFlight.has(groupChatId)) return;
	inFlight.add(groupChatId);

	drainRuns++;
	let sent = false;
	try {
		sent = await drainClaimed(groupChatId, active);
	} finally {
		inFlight.delete(groupChatId);
		// Re-arm ONLY after a send actually happened, so anything queued while it
		// was running is picked up. Rescheduling unconditionally turns every idle
		// into a self-perpetuating timer: nothing-to-do exits reschedule
		// themselves, and main runs a write-queue round trip every tick for as
		// long as the app is open.
		//
		// A real send leaves the moderator busy (it is set to `moderator-thinking`
		// before the spawn returns), so this follow-up normally finds nothing and
		// stops - the next item waits for the next idle, which is the intended
		// rhythm. It costs at most one extra drain that sends nothing.
		if (sent) scheduleDrain(groupChatId);
	}
}

/**
 * The body of a drain, with the latch already held.
 *
 * `active` is captured by the caller so a handler swap mid-send cannot route the
 * completion through a different set of dependencies than the send used.
 */
async function drainClaimed(groupChatId: string, active: GroupChatQueueDeps): Promise<boolean> {
	// Decide and claim in ONE mutate. Reading the queue and marking the head in
	// two separate steps leaves a window on the write chain: a remove landing
	// between them wins, `markSending` then has nothing to mark, and the drainer
	// would go on to send the deleted message from its stale copy.
	let claimedId: string | null = null;
	const { state } = await mutate(groupChatId, (current) => {
		if (!canDrain(current, active.isIdle(groupChatId))) return current;
		claimedId = current.items[0].id;
		return markSending(current, claimedId);
	});

	if (claimedId === null) return false;
	const sendingId: string = claimedId;
	const head = state.items.find((entry) => entry.id === sendingId);
	if (!head) return false;

	// The moderator can pick up other work while the claim above was being
	// written. Check again immediately before handing anything over, and give the
	// claim back if it did, or the item is sent to a busy moderator AND left
	// wearing an in-flight mark that makes it un-removable.
	if (!active.isIdle(groupChatId)) {
		await mutate(groupChatId, (current) => ({
			...current,
			items: current.items.map((entry) =>
				entry.id === sendingId ? { ...entry, sending: undefined } : entry
			),
		}));
		return false;
	}

	try {
		await active.send(groupChatId, head.text, head.images, head.readOnlyMode);
		const { state: after } = await mutate(groupChatId, (current) =>
			completeItem(current, sendingId)
		);
		if (after.items.some((item) => item.id === sendingId)) {
			logger.warn(`Delivered item was still present after completion`, LOG_CONTEXT, {
				groupChatId,
				itemId: sendingId,
			});
		}
	} catch (err) {
		// The drainer runs outside `withIpcErrorLogging`, so it owns this. Keep
		// the item, mark it, pause, and say so in the room. Never retry by itself:
		// a cause that does not clear (the Encore Feature off, a missing binary)
		// would otherwise re-fire on every idle for as long as the app runs.
		const reason = err instanceof Error ? err.message : String(err);
		logger.error(`Queued message failed to send`, LOG_CONTEXT, { groupChatId, error: reason });
		const { state: after } = await mutate(groupChatId, (current) =>
			failItem(current, sendingId, reason)
		);
		if (!after.items.some((item) => item.id === sendingId)) {
			// The item was removed while the send was failing. Nothing to mark, but
			// the pause still stands so the cause gets looked at.
			logger.warn(`Failed item was no longer queued`, LOG_CONTEXT, {
				groupChatId,
				itemId: sendingId,
			});
		}
		await active
			.postSystemMessage(
				groupChatId,
				`⚠️ A queued message could not be sent, so the queue is paused. Resume it to try again. (${reason})`
			)
			.catch(() => {});
	}
	return true;
}

/**
 * The hook the moderator's state emitter calls.
 *
 * Only an idle transition can release the queue, and it goes through
 * `scheduleDrain` rather than sending inline for the reason given there.
 */
export function onModeratorStateChanged(groupChatId: string, isIdle: boolean): void {
	if (isIdle) scheduleDrain(groupChatId);
}

/**
 * Accept a message the user just composed, and decide what happens to it here.
 *
 * MAIN makes this call, not the client. A client decides from its own copy of
 * the queue, and a copy that is even slightly stale sends directly while items
 * are already waiting - so the newest message reaches the moderator before older
 * ones, which is precisely what a queue exists to prevent. Main is the only
 * party that knows both the real queue and the moderator's real state.
 *
 * Returns the queue as it now stands so the caller can render it immediately.
 */
export async function submitMessage(
	groupChatId: string,
	item: GroupChatQueuedItem
): Promise<GroupChatQueueState> {
	// Captured once, so a handler swap mid-send cannot route the failure path
	// through a different set of dependencies than the send used.
	const active = deps;
	if (!active) throw new Error('Group chat queue is not installed');

	const current = await getQueue(groupChatId);

	// Claim the latch in the SAME synchronous step as the test, for the reason
	// given on `drain`: an await between them lets a drain and a submit both
	// decide they are the only sender.
	if (mustQueue(current, active.isIdle(groupChatId)) || inFlight.has(groupChatId)) {
		return addToQueue(groupChatId, item);
	}
	inFlight.add(groupChatId);

	try {
		await active.send(groupChatId, item.text, item.images, item.readOnlyMode);
		return current;
	} catch (err) {
		// A direct send that fails is queued rather than lost, with the same
		// marking and pause the drainer uses, so the user can retry it.
		const reason = err instanceof Error ? err.message : String(err);
		logger.error(`Direct send failed, keeping the message`, LOG_CONTEXT, {
			groupChatId,
			error: reason,
		});
		// F15: to the FRONT. This message was handed over before anything that was
		// queued while it ran, so appending it would reorder what the user sent.
		const { state: saved } = await mutate(groupChatId, (state) =>
			requeueFailedAtFront(state, item, reason)
		);
		await active
			.postSystemMessage(
				groupChatId,
				`⚠️ Your message could not be sent, so it is queued and the queue is paused. Resume it to try again. (${reason})`
			)
			.catch(() => {});
		return saved;
	} finally {
		inFlight.delete(groupChatId);
		// R6: anything queued WHILE this send was running has no idle event left
		// to wake it - that event may already have fired and been ignored because
		// the latch was held. Look again now. `canDrain` still decides.
		scheduleDrain(groupChatId);
	}
}
