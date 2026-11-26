/**
 * The desktop's `queue_changed` frame: what waits for one of its agents now, and how the item a
 * write took out of the queue left it (`desktopQueueChanges()`). A Federation client attached to
 * this desktop reads it as it reads a headless host's (`createWsMaestroClient`), so a hosted
 * agent's queued consult or hand-off starts on the named start, and a removed message is let go
 * at once, the same on a desktop host and a headless one. A client that does not know the type
 * ignores it.
 */

import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import type { QueueExit } from '../../shared/maestro-lib/client/types';
import { desktopQueueChanges, type QueueDiffAgent } from '../../shared/queueSnapshot';
import { captureException } from '../utils/sentry';
import { withQueueItemImages } from './handlers/messageHandlers/queue';

/** The part of the web server the broadcast uses. */
export interface QueueChangeBroadcaster {
	broadcastToAll(message: object): void;
	getWebClientCount(): number;
}

/** One agent's frames go out in the order of its writes, though each inlines its images first. */
const frameOrder = createKeyedWriteQueue();

/**
 * Tell every web client how the agents' queues changed between two writes of the stored agents.
 * One frame per item that left (each with the whole list after the write), or one frame with no
 * exit when items only waited, moved, or changed. Images ride as data URLs, as a client's queue read
 * asks for them, so a hosted queued card keeps drawing them.
 */
export function broadcastDesktopQueueChanges(
	server: QueueChangeBroadcaster | null | undefined,
	previous: readonly QueueDiffAgent[],
	next: readonly QueueDiffAgent[]
): void {
	if (!server || server.getWebClientCount() === 0) return;
	for (const change of desktopQueueChanges(previous, next)) {
		const exits: Array<QueueExit | undefined> = change.exits.length ? change.exits : [undefined];
		void frameOrder
			.enqueue(change.agentId, async () => {
				const items = await withQueueItemImages(change.items, true);
				for (const exit of exits) {
					server.broadcastToAll({
						type: 'queue_changed',
						sessionId: change.agentId,
						items,
						namesExits: true,
						...(exit ? { exit } : {}),
					});
				}
			})
			.catch((error) =>
				captureException(error instanceof Error ? error : new Error(String(error)), {
					extra: { area: 'web-server', handler: 'queue_changed', sessionId: change.agentId },
				})
			);
	}
}
