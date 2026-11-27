/**
 * The desktop's `queue_changed` frame: what waits for one of its agents now, and how the item a
 * write took out of the queue left it (`desktopQueueChanges()`). A Federation client attached to
 * this desktop reads it as it reads a headless host's (`createWsMaestroClient`), so a hosted
 * agent's queued consult or hand-off starts on the named start, and a removed message is let go
 * at once, the same on a desktop host and a headless one. A client that does not know the type
 * ignores it.
 *
 * Only a client admitted by the CLI secret reads the frame (a Federation client, `maestro-cli`),
 * so it goes to those clients alone: a browser, a phone over the tunnel, never gets it. A client
 * that said at connect it reads queue CHANGES (`QUEUE_CHANGES_QUERY_PARAM`, M28) gets the change
 * only: the waiting ids in order and the items new or changed since the agent's last frame, with
 * their images (`QueueChangesFrame`), so an item's images go once. Any other client (an older
 * build) gets the whole list with every image, as before M26, so it never meets a field it does
 * not know. Nothing is tracked per client: a client whose list is not the one a frame changes
 * (it missed a frame, or connected since) reads the queue whole, which answers the `seq` it is at.
 */

import { canonicalJson } from '../../shared/canonicalJson';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import type { QueueExit } from '../../shared/maestro-lib/client/types';
import {
	desktopQueueChanges,
	type QueueChangesFrame,
	type QueueDiffAgent,
	type QueuedItemSnapshot,
} from '../../shared/queueSnapshot';
import { captureException } from '../utils/sentry';
import { withQueueItemImages } from './handlers/messageHandlers/queue';
import { framedQueue, recordFramedQueue } from './queue-change-frames';

/** Which clients the CLI secret admitted a frame is for: those that read changes, or the rest. */
export type CliAudience = 'queue-changes' | 'whole-queue';

/** The part of the web server the broadcast uses. */
export interface QueueChangeBroadcaster {
	/** To the clients admitted by the CLI secret only (no browser reads it), or one audience of them. */
	broadcastToCliClients(message: object, audience?: CliAudience): void;
	getWebClientCount(): number;
	/** How many open clients the CLI secret admitted are in each audience. */
	getCliClientCounts?(): Record<CliAudience, number>;
}

/** One agent's frames go out in the order of its writes, though each inlines its images first. */
const frameOrder = createKeyedWriteQueue();

/**
 * The changes frames of one change, one per frame of it: the first carries the items new or
 * changed since the agent's last frame, the later ones none (the first sent them). An item whose
 * images were not all read is not recorded as sent, so the next change carries it again
 * (CodeRabbit on #2160).
 */
async function changesFrames(
	agentId: string,
	items: QueuedItemSnapshot[],
	count: number,
	inlinedAll: QueuedItemSnapshot[] | undefined
): Promise<QueueChangesFrame[]> {
	const before = framedQueue(agentId);
	const values = items.map((item) => canonicalJson(item));
	const changedIndexes = items
		.map((_item, index) => index)
		.filter((index) => before?.items.get(items[index].id) !== values[index]);
	const changed = inlinedAll
		? changedIndexes.map((index) => inlinedAll[index])
		: await withQueueItemImages(
				changedIndexes.map((index) => items[index]),
				true
			);
	const sent = new Map<string, string>();
	items.forEach((item, index) => {
		const changedAt = changedIndexes.indexOf(index);
		if (changedAt === -1) {
			sent.set(item.id, values[index]);
			return;
		}
		const wanted = item.images?.length ?? 0;
		if ((changed[changedAt].images?.length ?? 0) >= wanted) sent.set(item.id, values[index]);
	});
	const order = items.map((item) => item.id);
	let seq = before?.seq ?? 0;
	const frames: QueueChangesFrame[] = [];
	for (let index = 0; index < count; index++) {
		frames.push({ seq: seq + 1, base: seq, order, changed: index === 0 ? changed : [] });
		seq += 1;
	}
	recordFramedQueue(agentId, { seq, items: sent });
	return frames;
}

/**
 * Tell the Federation clients how the agents' queues changed between two writes of the stored
 * agents. One frame per item that left (each with the whole list after the write), or one frame
 * with no exit when items only waited, moved, or changed. Every frame says the desktop names its
 * exits, except the last frame of a change with an exit it could not prove (`unnamedExit`): there
 * the claim is left off, so a client counts a gap and judges what waits by the tab, and keeps
 * every exit the frames before it named (CodeRabbit on #2154). Images ride as data URLs, as a
 * client's queue read asks for them, so a hosted queued card keeps drawing them: once per item for
 * a client that reads changes, on every frame for one that does not.
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
				const counts = server.getCliClientCounts?.();
				const toWhole = !counts || counts['whole-queue'] > 0;
				const toChanges = !counts || counts['queue-changes'] > 0;
				// Read once for both audiences: a whole frame inlines every item's images.
				const inlinedAll = toWhole ? await withQueueItemImages(change.items, true) : undefined;
				const changes = toChanges
					? await changesFrames(change.agentId, change.items, frames.length, inlinedAll)
					: [];
				frames.forEach((frame, index) => {
					const named = {
						type: 'queue_changed',
						sessionId: change.agentId,
						...(frame.namesExits ? { namesExits: true } : {}),
						...(frame.exit ? { exit: frame.exit } : {}),
					};
					if (inlinedAll) {
						server.broadcastToCliClients({ ...named, items: inlinedAll }, 'whole-queue');
					}
					if (changes[index]) {
						server.broadcastToCliClients({ ...named, changes: changes[index] }, 'queue-changes');
					}
				});
			})
			.catch((error) =>
				captureException(error instanceof Error ? error : new Error(String(error)), {
					extra: { area: 'web-server', handler: 'queue_changed', sessionId: change.agentId },
				})
			);
	}
}
