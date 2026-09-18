/**
 * The rules a group chat's pending-send queue follows, as pure functions.
 *
 * The queue itself is owned by the main process (`group-chat-queue.ts`), which
 * adds persistence, broadcasting and the actual send. Everything that decides
 * WHAT the queue should become lives here instead, for two reasons: the
 * transitions are where the user-visible behaviour is, and they are the part
 * worth testing without spawning a moderator or touching a disk.
 *
 * The invariant that motivates the whole module: a message the user typed is
 * never discarded without telling them. It is delivered, or it stays in the
 * queue and the chat pauses. There is no third outcome.
 */

import type { GroupChatQueuedItem, GroupChatQueueState } from './group-chat-types';

/** An empty queue. Not paused: there is nothing to hold back. */
export function emptyQueueState(): GroupChatQueueState {
	return { items: [], paused: false };
}

/**
 * Why a queue is paused. Reported so the UI can say something specific rather
 * than a bare "paused", and so a resume can tell a recoverable stop (Stop All)
 * apart from one the user may need to fix first (a failed send).
 */
export type QueuePauseReason = 'stopped' | 'send-failed' | 'restored';

/**
 * Add a user message to the end of the queue.
 *
 * Sending a NEW message also resumes: the user just demonstrated they want the
 * room running, and leaving the queue paused would silently hold their newest
 * message behind the older ones. Appending rather than jumping the line keeps
 * the order the user typed in, which is the whole reason the earlier messages
 * were queued instead of sent.
 */
export function enqueueMessage(
	state: GroupChatQueueState,
	item: GroupChatQueuedItem
): GroupChatQueueState {
	// Un-pausing is not enough: the head may still carry a `failed` mark from an
	// earlier attempt, and `canDrain` refuses a failed head. A queue that reports
	// itself as running, offers no Resume control and sends nothing is a worse
	// stall than a visible pause. So this resumes properly - same rule as the
	// button - which clears the mark on the head.
	return resumeQueue({ ...state, items: [...state.items, item] });
}

/**
 * Whether a newly composed message has to be queued rather than sent directly.
 *
 * Busy is the original rule. The two additions exist so the queue cannot be
 * overtaken: if anything is already waiting, or the chat is paused, a message
 * sent right now would reach the moderator BEFORE messages the user typed
 * earlier. Order is the one thing a queue is for.
 */
export function mustQueue(state: GroupChatQueueState, moderatorIsIdle: boolean): boolean {
	return !moderatorIsIdle || state.items.length > 0 || state.paused;
}

/**
 * Whether the drainer may send right now.
 *
 * Deliberately not "is there an item?". A paused queue holds, and a failed head
 * item is never retried on its own (a failure that does not clear itself - the
 * Encore Feature switched off, a missing binary - would otherwise re-fire on
 * every idle forever, which is a loop rather than a recovery).
 */
export function canDrain(state: GroupChatQueueState, moderatorIsIdle: boolean): boolean {
	if (state.paused || !moderatorIsIdle) return false;
	const head = state.items[0];
	return head !== undefined && head.failed !== true;
}

/** Remove the head after it was delivered. Leaves `paused` alone. */
export function completeHead(state: GroupChatQueueState): GroupChatQueueState {
	return { ...state, items: state.items.slice(1) };
}

/**
 * Mark an item as handed to the moderator.
 *
 * Broadcast so every client can show it, and load-bearing for `removeItem` and
 * `reorderItem`, which refuse to touch an item in this state.
 */
export function markSending(state: GroupChatQueueState, itemId: string): GroupChatQueueState {
	return {
		...state,
		items: state.items.map((item) => (item.id === itemId ? { ...item, sending: true } : item)),
	};
}

/**
 * Remove the item that was actually delivered, BY ID.
 *
 * Never by position. A send is awaited, and the queue can be edited while it is
 * in flight, so "drop whatever is first now" discards a message the moderator
 * never received - the silent loss this whole feature exists to end. Returns the
 * state unchanged when the id is gone, so a caller can notice and log it.
 */
export function completeItem(state: GroupChatQueueState, itemId: string): GroupChatQueueState {
	return { ...state, items: state.items.filter((item) => item.id !== itemId) };
}

/**
 * Put a message back at the FRONT, marked failed, with the queue paused.
 *
 * For a direct send that failed: it was handed over before anything queued
 * while it ran, so appending it would silently reorder the user's messages. It
 * also keeps the failed item where Resume can actually clear it, since Resume
 * only clears the head.
 */
export function requeueFailedAtFront(
	state: GroupChatQueueState,
	item: GroupChatQueuedItem,
	reason: string
): GroupChatQueueState {
	return {
		items: [{ ...item, failed: true, failureReason: reason }, ...state.items],
		paused: true,
	};
}

/**
 * Record that a specific item could not be sent, BY ID.
 *
 * Same reasoning as `completeItem`: marking by position would blame an item that
 * was never attempted. The chat pauses either way, so the user decides.
 */
export function failItem(
	state: GroupChatQueueState,
	itemId: string,
	reason: string
): GroupChatQueueState {
	return {
		items: state.items.map((item) =>
			item.id === itemId
				? { ...item, sending: undefined, failed: true, failureReason: reason }
				: item
		),
		paused: true,
	};
}

/**
 * Record that the head item could not be sent.
 *
 * The item is KEPT and marked, and the chat pauses. Dropping it would lose the
 * user's words; retrying it unattended would spin. Pausing puts the decision in
 * front of the person who can actually fix the cause.
 */
export function failHead(state: GroupChatQueueState, reason: string): GroupChatQueueState {
	if (state.items.length === 0) return { ...state, paused: true };
	const [head, ...rest] = state.items;
	return { items: [{ ...head, failed: true, failureReason: reason }, ...rest], paused: true };
}

/** Hold the queue without touching its contents (Stop All, or a restored queue). */
export function pauseQueue(state: GroupChatQueueState): GroupChatQueueState {
	return { ...state, paused: true };
}

/**
 * Let the queue run again.
 *
 * Clears the `failed` mark on the head, because resuming IS the user's decision
 * to try it again. Leaving the mark would make `canDrain` refuse forever and the
 * resume control would do nothing, which reads as a dead button.
 */
export function resumeQueue(state: GroupChatQueueState): GroupChatQueueState {
	if (state.items.length === 0) return { ...state, paused: false };
	const [head, ...rest] = state.items;
	const { failed: _failed, failureReason: _failureReason, ...cleanHead } = head;
	return { items: [cleanHead, ...rest], paused: false };
}

/**
 * Drop one item by id. Used by the per-item remove control.
 *
 * Refuses an item that is `sending`: the moderator already has it, so removing
 * it here would not un-send anything and would leave the completion with no item
 * to land on.
 */
export function removeItem(state: GroupChatQueueState, itemId: string): GroupChatQueueState {
	const target = state.items.find((item) => item.id === itemId);
	if (target?.sending) return state;
	return { ...state, items: state.items.filter((item) => item.id !== itemId) };
}

/**
 * Move an item to a new index.
 *
 * Reorder is clamped rather than validated, so a stale index from a client whose
 * queue moved under it lands at an end instead of throwing away the drag.
 */
export function reorderItem(
	state: GroupChatQueueState,
	itemId: string,
	toIndex: number
): GroupChatQueueState {
	const from = state.items.findIndex((item) => item.id === itemId);
	if (from === -1) return state;
	// Moving an in-flight item would reorder the queue under a send that is
	// already on its way to the moderator.
	if (state.items[from].sending) return state;
	const items = [...state.items];
	const [moved] = items.splice(from, 1);
	const clamped = Math.max(0, Math.min(toIndex, items.length));
	items.splice(clamped, 0, moved);
	return { ...state, items };
}

/**
 * Normalize whatever was read off disk.
 *
 * THROWS on anything that is not a well-formed queue: a non-object top level,
 * an `items` that is not an array, or an item without a string `id`. Throwing
 * rather than degrading is deliberate. A file that parses as JSON but is the
 * wrong SHAPE is just as much a damaged queue as one that does not parse at
 * all, and quietly returning an empty queue lets the next save overwrite it -
 * the user's messages gone with no trace and no warning. The caller catches
 * this, moves the file aside and reports it, so the bytes survive and a human
 * finds out. Dropping a malformed item silently would be the same loss one
 * element down.
 */
export function parseQueueState(raw: unknown): GroupChatQueueState {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error('Queue file is not an object');
	}
	const record = raw as Partial<GroupChatQueueState>;
	if (!Array.isArray(record.items)) {
		throw new Error('Queue file has no items array');
	}
	for (const item of record.items) {
		if (!item || typeof item !== 'object' || typeof (item as GroupChatQueuedItem).id !== 'string') {
			throw new Error('Queue file contains a malformed item');
		}
	}
	return { items: record.items as GroupChatQueuedItem[], paused: record.paused === true };
}
