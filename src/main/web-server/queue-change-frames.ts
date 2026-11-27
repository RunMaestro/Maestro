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

/** Forget every agent's frames (tests only). */
export function resetQueueChangeFrames(): void {
	framed.clear();
}
