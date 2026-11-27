/**
 * The desktop's `queue_changed` frame: what waits for one of its agents now, and how the item a
 * write took out of the queue left it (`desktopQueueChanges()`). A Federation client attached to
 * this desktop reads it as it reads a headless host's (`createWsMaestroClient`), so a hosted
 * agent's queued consult or hand-off starts on the named start, and a removed message is let go
 * at once, the same on a desktop host and a headless one. A client that does not know the type
 * ignores it.
 *
 * Only a client admitted by the CLI secret reads the frame (a Federation client, `maestro-cli`),
 * so it goes to those clients alone: a browser, a phone over the tunnel, never gets it. And an
 * item's images go once (M26): a later frame whose item still has the images it was sent with
 * says so (`imagesKept`) instead of sending them again, and the client keeps the ones it holds.
 */

import { canonicalJson } from '../../shared/canonicalJson';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import type { QueueExit } from '../../shared/maestro-lib/client/types';
import {
	desktopQueueChanges,
	type QueueDiffAgent,
	type QueuedItemSnapshot,
} from '../../shared/queueSnapshot';
import { captureException } from '../utils/sentry';
import { withQueueItemImages } from './handlers/messageHandlers/queue';

/** The part of the web server the broadcast uses. */
export interface QueueChangeBroadcaster {
	/** To the clients admitted by the CLI secret only: no browser reads the frame. */
	broadcastToCliClients(message: object): void;
	getWebClientCount(): number;
}

/** One agent's frames go out in the order of its writes, though each inlines its images first. */
const frameOrder = createKeyedWriteQueue();

/**
 * The images each agent's last frame sent, as each item's image refs, by agent id and item id. An
 * item whose refs are the same in the next frame rides without them (`imagesKept`).
 */
const sentImages = new Map<string, Map<string, string>>();

function withoutImages({ images: _images, ...item }: QueuedItemSnapshot): QueuedItemSnapshot {
	return item;
}

/** An item's image refs as one comparable value; empty when it has none. */
function imageKey(item: QueuedItemSnapshot): string {
	return item.images?.length ? canonicalJson(item.images) : '';
}

/**
 * One change's items for its frames: the first frame carries the images of each item whose images
 * the agent's last frame did not send, as data URLs (the client cannot read this machine's store);
 * every other item with images, and every item in the change's later frames, says `imagesKept`.
 */
async function framedItems(
	agentId: string,
	items: QueuedItemSnapshot[]
): Promise<{ first: object[]; later: object[] }> {
	const before = sentImages.get(agentId);
	const after = new Map<string, string>();
	const kept = new Set<string>();
	for (const item of items) {
		const key = imageKey(item);
		if (!key) continue;
		after.set(item.id, key);
		if (before?.get(item.id) === key) kept.add(item.id);
	}
	const inlined = await withQueueItemImages(
		items.map((item) => (kept.has(item.id) ? withoutImages(item) : item)),
		true
	);
	// Recorded once the images are in hand: a change whose images could not be read sends no frame,
	// and its items' images go again with the next one.
	if (after.size > 0) sentImages.set(agentId, after);
	else sentImages.delete(agentId);
	const keptMark = (item: QueuedItemSnapshot, isKept: boolean) =>
		isKept ? { ...withoutImages(item), imagesKept: true } : item;
	return {
		first: inlined.map((item) => keptMark(item, kept.has(item.id))),
		later: items.map((item) => keptMark(item, after.has(item.id))),
	};
}

/**
 * Tell the Federation clients how the agents' queues changed between two writes of the stored
 * agents. One frame per item that left (each with the whole list after the write), or one frame
 * with no exit when items only waited, moved, or changed. Every frame says the desktop names its
 * exits, except the last frame of a change with an exit it could not prove (`unnamedExit`): there
 * the claim is left off, so a client counts a gap and judges what waits by the tab, and keeps
 * every exit the frames before it named (CodeRabbit on #2154). Images ride as data URLs, as a
 * client's queue read asks for them, so a hosted queued card keeps drawing them; once per item.
 */
export function broadcastDesktopQueueChanges(
	server: QueueChangeBroadcaster | null | undefined,
	previous: readonly QueueDiffAgent[],
	next: readonly QueueDiffAgent[]
): void {
	if (!server || server.getWebClientCount() === 0) return;
	for (const change of desktopQueueChanges(previous, next)) {
		// Each proven exit rides a frame that names it. A change that also lost an item it cannot
		// name ends on one frame that does not claim to name every exit, so the proven ones are kept
		// (a client stores an exit only from a frame that names exits) and the gap is still counted.
		const frames: Array<{ exit?: QueueExit; namesExits: boolean }> = change.exits.map((exit) => ({
			exit,
			namesExits: true,
		}));
		if (change.unnamedExit) frames.push({ namesExits: false });
		else if (frames.length === 0) frames.push({ namesExits: true });
		void frameOrder
			.enqueue(change.agentId, async () => {
				const { first, later } = await framedItems(change.agentId, change.items);
				frames.forEach((frame, index) => {
					server.broadcastToCliClients({
						type: 'queue_changed',
						sessionId: change.agentId,
						items: index === 0 ? first : later,
						...(frame.namesExits ? { namesExits: true } : {}),
						...(frame.exit ? { exit: frame.exit } : {}),
					});
				});
			})
			.catch((error) =>
				captureException(error instanceof Error ? error : new Error(String(error)), {
					extra: { area: 'web-server', handler: 'queue_changed', sessionId: change.agentId },
				})
			);
	}
}
