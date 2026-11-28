/**
 * What the desktop's queue changes frames have sent so far, per agent (M28): the `seq` of the
 * agent's last frame, and each item as those frames sent it. `broadcastDesktopQueueChanges()`
 * writes it; a `list_queue` answer reads the `seq` (`queueSeq`), so a client that read the queue
 * applies the next change over what it read. Its own module so the queue handler and the
 * broadcast share it without importing each other.
 */

/** One agent's frames so far: the last `seq`, and each item's snapshot value as it was sent. */
export interface FramedQueue {
	seq: number;
	items: Map<string, string>;
}

const framed = new Map<string, FramedQueue>();

/** What the frames so far sent for `agentId`, if any were sent. */
export function framedQueue(agentId: string): FramedQueue | undefined {
	return framed.get(agentId);
}

/** Record what the frames for `agentId` sent, up to and including `seq`. */
export function recordFramedQueue(agentId: string, queue: FramedQueue): void {
	framed.set(agentId, queue);
}

/**
 * The `seq` of the last changes frame sent for `agentId` (0 before the first): a `list_queue`
 * answer carries it, so a client that read the queue applies the next change over it.
 */
export function queueChangesSeq(agentId: string): number {
	return framed.get(agentId)?.seq ?? 0;
}

/**
 * Every agent's last changes frame `seq`, as it stands now: a `list_queue` takes it BEFORE it reads
 * the queues, so its answer never labels an older list with a newer `seq` (M29). An agent not in
 * it is at 0.
 */
export function queueChangesSeqs(): Map<string, number> {
	return new Map([...framed].map(([agentId, queue]) => [agentId, queue.seq]));
}

/** Forget what the frames sent for an agent that is gone (deleted, or moved off this desktop). */
export function forgetFramedQueue(agentId: string): void {
	framed.delete(agentId);
}

/** Forget every agent's frames (tests only). */
export function resetQueueChangeFrames(): void {
	framed.clear();
}
