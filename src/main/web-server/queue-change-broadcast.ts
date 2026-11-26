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
 * exit when items only waited, moved, or changed. Every frame says the desktop names its exits,
 * except the last frame of a change with an exit it could not prove (`unnamedExit`): there the
 * claim is left off, so a client counts a gap and judges what waits by the tab, and keeps every
 * exit the frames before it named (CodeRabbit on #2154). Images ride as data URLs, as a client's
 * queue read asks for them, so a hosted queued card keeps drawing them.
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
				const items = await withQueueItemImages(change.items, true);
				for (const frame of frames) {
					server.broadcastToAll({
						type: 'queue_changed',
						sessionId: change.agentId,
						items,
						...(frame.namesExits ? { namesExits: true } : {}),
						...(frame.exit ? { exit: frame.exit } : {}),
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
