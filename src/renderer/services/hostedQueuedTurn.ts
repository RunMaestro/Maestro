/**
 * A turn queued on this machine for a hosted agent goes to its host.
 *
 * Everything that queues a prompt from outside the composer (a snooze's wake prompt, a review, a
 * Design Mode pick, a web client's command, `maestro-cli dispatch --queue`) puts it in this
 * machine's queue for the agent, and the drain spawns `${agentId}-ai-${tabId}` here. A hosted
 * agent's turns run on its Federation host, so main refuses that spawn. Both choke points hand the
 * item to the host instead, through the same `sendHostedTurn()` the composer's send uses (the
 * tab's own model, effort, read-only and save to History; a busy host tab queues it there):
 *
 * - `handQueuedItemToHost()`: an item just queued (`enqueuePromptForTab()`) leaves this queue at
 *   once and goes to the host, so nothing waits here for a drain.
 * - `sendTakenItemToHost()`: an item a drain already took (`agentStore.processQueuedItem`), such
 *   as one queued before the agent moved, or before hosted agents were turned on.
 *
 * A slash command goes as the typed text (`/commit args`); the host resolves it, as it does for a
 * typed one. A held item goes held (the host queues it paused). A host that refuses (it is down,
 * or the tab is gone) has already said so in a toast; the item comes back into this queue held,
 * in the place it left, so nothing is lost and Resume sends it again.
 */

import type { QueuedItem, Session } from '../types';
import type { TurnSendReceipt } from '../../shared/maestro-lib/client/types';
import { selectSessionById, updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { recoverQueuedItem } from '../utils/executionQueue';
import { hostedTargetOf, sendHostedTurn } from './hostedTurns';
import { queuedItemNamingText } from './tabAutoNaming';

/**
 * Items on their way to a host, each with the host's receipt to come (null: refused, and the item
 * is back in this queue held). A second trigger in the same window cannot send one twice.
 */
const sendsInFlight = new Map<string, Promise<TurnSendReceipt | null>>();

/**
 * The host's answer for an item this queue handed over and is still sending, or undefined when it
 * is not on its way to a host. A caller that follows the turn (Quick Chat) reads the receipt: a
 * `queued` one names the host's queue item that now stands for it.
 */
export function queuedItemHostSend(itemId: string): Promise<TurnSendReceipt | null> | undefined {
	return sendsInFlight.get(itemId);
}

/** The text a queued item sends to a host: a message's text, or a command as it was typed. */
export function queuedItemHostText(item: QueuedItem): string {
	if (item.type === 'command') {
		return [item.command, item.commandArgs].filter(Boolean).join(' ');
	}
	return item.text ?? '';
}

/**
 * Whether `item` is a turn this machine holds for a hosted agent, which its host must run. A host
 * queue item (`hostQueued`) is already the host's; a managed admission (`pendingAdmissionId`) is
 * the native owner's to release.
 */
export function isQueuedItemForHost(
	session: Pick<Session, 'liftedTo'> | null | undefined,
	item: QueuedItem
): boolean {
	return !item.hostQueued && !item.pendingAdmissionId && !!hostedTargetOf(session);
}

/** Put a refused item back in this queue, held, at `index` (or where it already sits). */
function holdRefusedItem(sessionId: string, item: QueuedItem, index: number): void {
	updateSessionWith(sessionId, (session) => {
		const queue = session.executionQueue ?? [];
		const existing = queue.find((queued) => queued.id === item.id);
		const held = recoverQueuedItem({ ...item, paused: true }, existing);
		if (existing) {
			return {
				...session,
				executionQueue: queue.map((queued) => (queued.id === item.id ? held : queued)),
			};
		}
		const at = Math.max(0, Math.min(index, queue.length));
		return {
			...session,
			executionQueue: [...queue.slice(0, at), held, ...queue.slice(at)],
		};
	});
}

/** Send one item that is no longer in this queue to the host. Resolves the host's receipt. */
function forwardToHost(
	sessionId: string,
	item: QueuedItem,
	index: number
): Promise<TurnSendReceipt | null> {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	if (!session || !hostedTargetOf(session)) {
		holdRefusedItem(sessionId, item, index);
		return Promise.resolve(null);
	}
	// Named from the message as the local drain names a tab it runs (`queuedItemNamingText()`).
	const namingText = queuedItemNamingText(item);
	const send = sendHostedTurn(session, item.tabId, queuedItemHostText(item), item.images ?? [], {
		held: item.paused === true,
		...(namingText ? { nameFrom: { text: namingText, label: 'queue' } } : {}),
	}).then(
		(receipt) => {
			if (!receipt) holdRefusedItem(sessionId, item, index);
			return receipt;
		},
		(error: unknown) => {
			holdRefusedItem(sessionId, item, index);
			throw error;
		}
	);
	sendsInFlight.set(item.id, send);
	const settle = () => {
		if (sendsInFlight.get(item.id) === send) sendsInFlight.delete(item.id);
	};
	send.then(settle, settle);
	return send;
}

/**
 * Take `itemId` out of a hosted agent's queue on this machine and send it to the host. The take
 * and the check are one store update, so no drain runs it here too. Answers whether it was handed
 * over (false: the agent is not hosted, or the item is not one this machine holds for it).
 */
export function handQueuedItemToHost(sessionId: string, itemId: string): boolean {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const item = session?.executionQueue?.find((queued) => queued.id === itemId);
	if (!session || !item || !isQueuedItemForHost(session, item)) return false;
	type Taken = { item: QueuedItem; index: number };
	let taken: Taken | null = null;
	updateSessionWith(sessionId, (s) => {
		const queue = s.executionQueue ?? [];
		const index = queue.findIndex((queued) => queued.id === itemId);
		if (index === -1) return s;
		taken = { item: queue[index], index };
		return { ...s, executionQueue: queue.filter((queued) => queued.id !== itemId) };
	});
	// The updater runs once, synchronously, inside the store's `set`; TS cannot see the write.
	const handed = taken as Taken | null;
	if (!handed) return false;
	void forwardToHost(sessionId, handed.item, handed.index);
	return true;
}

/**
 * Send an item a drain already took out of this queue to the host. A refusal puts it back at the
 * head of the queue, held. Resolves true either way: the host runs it, or the queue holds it, so
 * the caller has nothing left to restore.
 */
export async function sendTakenItemToHost(sessionId: string, item: QueuedItem): Promise<boolean> {
	if (sendsInFlight.has(item.id)) return true;
	// A drain never takes a held item, so a held one here was sent on purpose (Force Send on a
	// card the host refused earlier, or a retry). It runs now: sending it held would park it on
	// the host and take its card away from the user who just asked for it to go.
	await forwardToHost(sessionId, { ...item, paused: false }, 0);
	return true;
}
