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
 * in the place it left, so nothing is lost and Resume sends it again. A host that is not connected
 * (nothing was sent) is the one exception: the item is kept for an automatic retry, as an SSH
 * agent's turn is when its link is down (`keepTurnForHost()`).
 */

import type { AgentError, QueuedItem, Session } from '../types';
import type { TurnSendReceipt } from '../../shared/maestro-lib/client/types';
import { selectSessionById, updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { notifyToast } from '../stores/notificationStore';
import {
	clearRetryIfSettled,
	failInFlightRetry,
	getRetryEntry,
	noteDirectDispatch,
	raiseAgentError,
} from '../stores/retryStore';
import { recoverQueuedItem } from '../utils/executionQueue';
import { getSessionSshRemoteId } from '../utils/sessionHelpers';
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

/**
 * The error a send its host could not take is raised as: the `network_error` an SSH agent's turn
 * reports when ssh cannot reach its remote, on the same remote, so the same retry and the same
 * outage dialog follow.
 */
function hostUnavailableError(session: Session, message: string): AgentError {
	const sshRemoteId = getSessionSshRemoteId(session);
	return {
		type: 'network_error',
		message,
		recoverable: true,
		agentId: session.toolType,
		sessionId: session.id,
		timestamp: Date.now(),
		...(sshRemoteId ? { sshRemoteId } : {}),
	};
}

/** Hosted sends per tab, chained so each settles (sent, kept, or refused) before the next starts. */
const tabSendChains = new Map<string, Promise<void>>();

/**
 * Run a hosted send for one tab after every earlier one of that tab has settled. A message whose
 * images take longer to hand over must not lose its place to one typed after it: when the host is
 * down, the first refusal to land becomes the kept head, so refusals must land in typed order.
 */
export function inHostTabOrder<T>(key: string, task: () => Promise<T>): Promise<T> {
	const prior = tabSendChains.get(key) ?? Promise.resolve();
	const run = prior.then(task);
	const tail = run.then(
		() => undefined,
		() => undefined
	);
	tabSendChains.set(key, tail);
	void tail.then(() => {
		if (tabSendChains.get(key) === tail) tabSendChains.delete(key);
	});
	return run;
}

/** Put `item` at the end of this agent's queue, waiting (not held), unless it is already there. */
function queueBehind(sessionId: string, item: QueuedItem): void {
	updateSessionWith(sessionId, (session) => {
		const queue = session.executionQueue ?? [];
		if (queue.some((queued) => queued.id === item.id)) return session;
		return { ...session, executionQueue: [...queue, recoverQueuedItem(item)] };
	});
}

/**
 * Keep a message the host could not take because it was not connected (nothing was sent), the way
 * an SSH agent's message is kept when its link is down: the failure is raised as that turn's
 * error (`raiseAgentError()`), so Agent Resilience parks it at the head of its tab's queue with the
 * auto-retry card, retries it with the same backoff, and sends it when the host is back. Its
 * resend comes back through `forwardToHost()`, so a second refusal continues the same outage.
 *
 * A message sent while an earlier one of the same tab waits for its retry queues behind it, so
 * the two reach the host in the order they were typed.
 *
 * Answers whether the message is kept. False (Agent Resilience off for the agent, or no listener):
 * the caller keeps it its own way.
 */
export function keepTurnForHost(sessionId: string, item: QueuedItem, message: string): boolean {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	if (!session) return false;
	const waiting = getRetryEntry(sessionId, item.tabId);
	if (waiting && waiting.heldItemId !== item.id) {
		queueBehind(sessionId, item);
		return true;
	}
	// The prompt the retry resends. A resend of this same item keeps its snapshot.
	noteDirectDispatch(sessionId, item);
	if (!raiseAgentError(`${sessionId}-ai-${item.tabId}`, hostUnavailableError(session, message))) {
		// No listener to report it: say so here, as the refusal's own toast would have.
		notifyToast({ color: 'red', title: 'Message not sent', message });
		return false;
	}
	return getRetryEntry(sessionId, item.tabId)?.heldItemId === item.id;
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
	let kept = false;
	const send = sendHostedTurn(session, item.tabId, queuedItemHostText(item), item.images ?? [], {
		held: item.paused === true,
		...(namingText ? { nameFrom: { text: namingText, label: 'queue' } } : {}),
		// A held item is the user's to send; only one on its way now is kept for a retry.
		...(item.paused === true
			? {}
			: {
					onHostUnavailable: (message: string) => {
						kept = keepTurnForHost(sessionId, item, message);
					},
				}),
	}).then(
		(receipt) => {
			// The host took a resend: the outage it was kept through is over.
			if (receipt) clearRetryIfSettled(sessionId, item.tabId);
			else if (!kept) {
				// Refused for another reason (already toasted): a resend ends its outage here.
				failInFlightRetry(sessionId, item.tabId, 'The host did not take the message.');
				holdRefusedItem(sessionId, item, index);
			}
			return receipt;
		},
		(error: unknown) => {
			failInFlightRetry(sessionId, item.tabId, 'The message could not be sent to the host.');
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
	// An earlier message of this tab waits for its retry: this one waits behind it, and the drain
	// sends it once the retry went through, so the host gets them in the order they were queued.
	if (getRetryEntry(sessionId, item.tabId)) return false;
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
