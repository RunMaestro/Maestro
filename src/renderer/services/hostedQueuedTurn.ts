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
 *
 * An `@mention` runs HERE, as a local agent's does: the mentioned agent is in this machine's
 * roster, not the host's. A queued message that mentions one waits in this queue for its turn
 * (never handed over at once), and when the drain takes it the consult fires as the turn goes to
 * the host: a leading mention (`crossAgentOnly`) consults and sends nothing, a parallel consult
 * holds the tab as it does locally, a hand-off is armed for when the host's turn ends. The turn
 * carries the agent-only notes and a released consult's replies (`agentContext`) to the host, so
 * its transcript shows what a local one shows. A host that refuses the turn consults nobody.
 */

import type { AgentError, LogEntry, QueuedItem, Session } from '../types';
import type {
	QueueExit,
	TurnOverrides,
	TurnSendReceipt,
} from '../../shared/maestro-lib/client/types';
import {
	selectSessionById,
	updateAiTab,
	updateSessionWith,
	useSessionStore,
} from '../stores/sessionStore';
import { generateId } from '../utils/ids';
import { notifyToast } from '../stores/notificationStore';
import {
	clearRetryIfSettled,
	failInFlightRetry,
	getRetryEntry,
	noteDirectDispatch,
	raiseAgentError,
	settleRetryOnHost,
	useRetryStore,
	HOST_HAD_MESSAGE_TEXT,
	notOnHostText,
	type NotOnHost,
	wouldAutoRetry,
} from '../stores/retryStore';
import {
	applyQueuedItemAbort,
	applyQueuedItemRelease,
	queuedItemOwnerTabId,
	recoverQueuedItem,
} from '../utils/executionQueue';
import { getSessionSshRemoteId } from '../utils/sessionHelpers';
import { withoutDesignPickPageText } from '../utils/designModePicker';
import {
	dispatchCrossAgentMentions,
	mentionTurnNotes,
	planCrossAgentMentions,
	previewMentionDispatch,
	type CrossAgentMentionPlan,
} from './crossAgentMentions';
import {
	deferHostedHandoff,
	handoffSendBoundary,
	hasDeferredHostedHandoff,
	HOST_QUEUE_START_GRACE_MS,
	judgeUnnamedHostStart,
	markHandoffSentToHost,
	noteLateMention,
	noteSkippedMention,
	type HostedTranscriptAccess,
} from './crossAgentHandoff';
import { resolveConsultTargets } from './crossAgentConsultHold';
import { cutTurnFate } from './hostedLinkLoss';
import { hostedTargetOf, sendHostedTurn } from './hostedTurns';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { hostTabTurnStartedAt } from '../utils/hostedSession';
import { liveTurnKey } from '../../shared/maestro-lib/client/live-turn';
import { appendAgentNotes } from '../../shared/maestro-lib/turns/prompt';
import { queueExitOf } from '../../shared/maestro-lib/client/peer-mirror';
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
 * the caller keeps it its own way. `opts.onlyIfRetried` raises nothing at all when no retry would
 * take the message (the caller draws the failure its own way instead).
 */
export function keepTurnForHost(
	sessionId: string,
	item: QueuedItem,
	message: string,
	opts: { onlyIfRetried?: boolean } = {}
): boolean {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	if (!session) return false;
	// Worded as kept only when a retry will hold it: with Agent Resilience off nothing resends it.
	const refusal = hostUnavailableError(session, message);
	const retried = wouldAutoRetry(sessionId, refusal);
	if (opts.onlyIfRetried && !retried) return false;
	const error = retried ? { ...refusal, message: keptForHostText(message) } : refusal;
	const waiting = getRetryEntry(sessionId, item.tabId);
	if (waiting && waiting.heldItemId !== item.id) {
		queueBehind(sessionId, item);
		return true;
	}
	// The message's bubble, above the retry card, as an SSH agent's send draws it before its link
	// fails: once, for a message the host never had (a cut turn's is the host's own entry).
	const resend = waiting?.heldItemId === item.id;
	const bubble = resend ? null : keptBubbleFor(item);
	const kept = bubble ? { ...item, keptEntryId: bubble.id } : item;
	// Refused again: the host did not get it, so no host message may stand in for its bubble.
	if (resend) markKeptBubble(sessionId, item, false);
	if (bubble) {
		updateAiTab(sessionId, item.tabId, (tab) => ({ ...tab, logs: [...tab.logs, bubble] }));
	}
	// The prompt the retry resends. A resend of this same item keeps its snapshot.
	noteDirectDispatch(sessionId, kept);
	const raised = raiseAgentError(`${sessionId}-ai-${item.tabId}`, error);
	const held = raised && getRetryEntry(sessionId, item.tabId)?.heldItemId === item.id;
	if (bubble && !held) {
		// Not kept: the caller keeps the draft or says it was not sent, so no bubble stays behind.
		updateAiTab(sessionId, item.tabId, (tab) => ({
			...tab,
			logs: tab.logs.filter((entry) => entry.id !== bubble.id),
		}));
	}
	if (!raised) {
		// No listener to report it: say so here, as the refusal's own toast would have.
		notifyToast({ color: 'red', title: 'Message not sent', message });
		return false;
	}
	return held;
}

/**
 * Mark a kept message's bubble as handed to the host now (`sending`), or not: only a bubble this
 * machine sent may be replaced by the host's copy of it (`mergeHostedLogs()`), so a message another
 * client sent with the same words never takes its place. A send also brings the bubble to the
 * words and images it carries, so a message edited while it waited is drawn as it was sent.
 */
function markKeptBubble(sessionId: string, item: QueuedItem, sending: boolean): void {
	const bubbleId = item.keptEntryId;
	if (!bubbleId) return;
	updateAiTab(sessionId, item.tabId, (tab) => {
		const at = tab.logs.findIndex((entry) => entry.id === bubbleId && entry.keptForHost);
		if (at === -1) return tab;
		const bubble = tab.logs[at];
		const next: LogEntry = sending
			? {
					...bubble,
					keptSentAt: Date.now(),
					text: item.text ?? '',
					images: item.images?.length ? item.images : undefined,
				}
			: { ...bubble, keptSentAt: undefined };
		if (!sending && bubble.keptSentAt === undefined) return tab;
		const logs = [...tab.logs];
		logs[at] = next;
		return { ...tab, logs };
	});
}

/** The bubble a kept message draws, or null when it has one already or is not a message. */
function keptBubbleFor(item: QueuedItem): LogEntry | null {
	if (item.type !== 'message' || item.hostEntryId || item.keptEntryId) return null;
	if (!item.text && !item.images?.length) return null;
	return {
		id: generateId(),
		timestamp: Date.now(),
		source: 'user',
		text: item.text ?? '',
		...(item.images?.length ? { images: item.images } : {}),
		...(item.readOnlyMode ? { readOnly: true } : {}),
		keptForHost: true,
	};
}

const NOTHING_SENT = /\s*Nothing was sent\.\s*/g;
const KEPT_FOR_HOST = 'Your message is kept and sent when the host answers.';

/**
 * The words of the error a kept message raises: the cause, then that the message is kept, as an
 * SSH agent's strip names its cause while its message waits under the retry card. A refusal's
 * "Nothing was sent." is true but reads as a lost message, so it is replaced. A reason that
 * already says the message is kept is used as it is.
 */
export function keptForHostText(reason: string): string {
	if (/\bkept\b/.test(reason)) return reason;
	const cause = reason.replace(NOTHING_SENT, ' ').trim();
	return cause ? `${cause} ${KEPT_FOR_HOST}` : KEPT_FOR_HOST;
}

/**
 * The `@mentions` a queued message names, resolved now as the local drain resolves them: from the
 * text without its Design Mode chips' page text, with the routing the user picked. Null when it
 * names nobody (or was not queued as a mention).
 */
export function queuedItemMentionPlan(
	session: Pick<Session, 'id'>,
	item: QueuedItem
): CrossAgentMentionPlan | null {
	if (!item.crossAgentMention || item.type !== 'message' || !item.text?.trim()) return null;
	return planCrossAgentMentions(
		withoutDesignPickPageText(item.text, item.designPickPageText),
		session.id,
		item.mentionRouting
	);
}

/**
 * The choices an item froze when it was queued (`turnSettings`, `readOnlyMode`), as the host's
 * per-turn overrides, so a change to the tab while it waits does not change how it runs. Undefined
 * when it froze none (the tab's live choices decide, as the local drain falls back).
 */
export function queuedItemHostOverrides(item: QueuedItem): TurnOverrides | undefined {
	const overrides: TurnOverrides = {
		...(item.turnSettings?.model ? { model: item.turnSettings.model } : {}),
		...(item.turnSettings?.effort ? { effort: item.turnSettings.effort } : {}),
		...(typeof item.readOnlyMode === 'boolean' ? { readOnly: item.readOnlyMode } : {}),
	};
	return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/**
 * The host already had a message this machine kept (a turn its link or a restart lost track of):
 * nothing is sent or held. The resend's own retry ends saying so (`settleRetryOnHost()`); one a
 * later message started after a Stop is that message's, and is left alone. A send no retry owns
 * (Force Send of a copy parked by Stop) says it with a toast, so it never vanishes unexplained.
 *
 * With `notOnHost` the host no longer has the tab or the message the copy named (closed, or
 * cleared): nothing is sent there, and the copy is parked held, no longer naming that entry, so
 * the user can send it again as a new message. The card or the toast says which.
 */
function notHostedAgain(
	sessionId: string,
	item: QueuedItem,
	index: number,
	retryOutage: string | undefined,
	notOnHost?: NotOnHost
): void {
	const owned =
		retryOutage !== undefined && getRetryEntry(sessionId, item.tabId)?.outageId === retryOutage;
	if (owned) settleRetryOnHost(sessionId, item.tabId, notOnHost);
	if (notOnHost) holdRefusedItem(sessionId, { ...item, hostEntryId: undefined }, index);
	// Its retry's card says it (settled here, or already by the cut's own read): told once.
	if (owned || (retryOutage && useRetryStore.getState().outages[retryOutage]?.settledByHost)) {
		return;
	}
	notifyToast({
		color: 'theme',
		title: notOnHost ? 'Not sent' : 'Not sent again',
		message: notOnHost ? notOnHostText(notOnHost) : HOST_HAD_MESSAGE_TEXT,
	});
}

/** Send one item that is no longer in this queue to the host. Resolves the host's receipt. */
function forwardToHost(
	sessionId: string,
	item: QueuedItem,
	index: number,
	mention: CrossAgentMentionPlan | null = null
): Promise<TurnSendReceipt | null> {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const target = hostedTargetOf(session);
	if (!session || !target) {
		holdRefusedItem(sessionId, item, index);
		return Promise.resolve(null);
	}
	// Named from the message as the local drain names a tab it runs (`queuedItemNamingText()`).
	const namingText = queuedItemNamingText(item);
	let kept = false;
	// What the consult will tell the turn, before it fires: a refused turn consults nobody. Notes
	// the item already carries (a Federation sender's) go first.
	const mentionNotes = mention ? mentionTurnNotes(previewMentionDispatch(mention)) : undefined;
	const agentNotes =
		item.agentNotes && mentionNotes
			? appendAgentNotes(item.agentNotes, mentionNotes)
			: (item.agentNotes ?? mentionNotes);
	// The model, effort, and read-only it was queued with, as the local drain runs it on them.
	const overrides = queuedItemHostOverrides(item);
	// The retry this resend belongs to: a Stop while it waits ends that retry, and then nothing goes.
	const retry = getRetryEntry(sessionId, item.tabId);
	const retryOutage = retry?.heldItemId === item.id ? retry.outageId : undefined;
	const sendToHost = () => {
		markKeptBubble(sessionId, item, true);
		return sendHostedTurn(session, item.tabId, queuedItemHostText(item), item.images ?? [], {
			held: item.paused === true,
			...(overrides ? { overrides } : {}),
			...(namingText ? { nameFrom: { text: namingText, label: 'queue' } } : {}),
			...(item.agentContext ? { agentContext: item.agentContext } : {}),
			...(agentNotes ? { agentNotes } : {}),
			// The entry the message already is: the host writes no second one.
			...(item.hostEntryId || item.keptEntryId
				? { entryId: item.hostEntryId ?? item.keptEntryId }
				: {}),
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
				if (receipt?.status === 'answered') {
					// The host had already answered this message: it ran once, and nothing ran now.
					notHostedAgain(sessionId, item, index, retryOutage);
					return null;
				}
				if (receipt) {
					// The host took a resend: the outage it was kept through is over.
					clearRetryIfSettled(sessionId, item.tabId);
					if (mention) fireMentionsForHostTurn(sessionId, item, mention, receipt);
				} else if (!kept) {
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
	};
	// The message of a turn a lost link cut goes again only once the host says that turn died: it
	// may have run on, or finished (`cutTurnFate()`). Never sent twice.
	const connected = usePeerMirrorStore.getState().peers[target.peerId]?.connection === 'connected';
	const fate = cutTurnFate(sessionId, item, target, connected);
	const send = !fate
		? sendToHost()
		: fate.then((decided) => {
				const stillOwned =
					retryOutage !== undefined &&
					getRetryEntry(sessionId, item.tabId)?.outageId === retryOutage;
				if (decided === 'answered') {
					notHostedAgain(sessionId, item, index, retryOutage);
					return null;
				}
				if (decided === 'tab-gone' || decided === 'entry-gone') {
					notHostedAgain(
						sessionId,
						item,
						index,
						retryOutage,
						decided === 'tab-gone' ? 'tab' : 'message'
					);
					return null;
				}
				if (retryOutage && !stillOwned) {
					// Stopped while it waited: parked held, one click from Force Send, as Stop parks it.
					holdRefusedItem(sessionId, item, index);
					return null;
				}
				if (decided === 'send') return sendToHost();
				// The host could not say (its transcript did not load): kept for the next try.
				kept = keepTurnForHost(
					sessionId,
					item,
					`The Maestro host on "${target.peerId}" could not say yet how the cut turn ended. Your message is kept and sent once it can.`
				);
				if (!kept) holdRefusedItem(sessionId, item, index);
				return null;
			});
	sendsInFlight.set(item.id, send);
	const settle = () => {
		if (sendsInFlight.get(item.id) === send) sendsInFlight.delete(item.id);
	};
	send.then(settle, settle);
	return send;
}

/**
 * The host took a turn that mentions other agents: consult them now, as a local turn's dispatch
 * does, and follow the host's tab for a hand-off. Read from the live store, so the consult sees
 * the conversation as it stands.
 */
function fireMentionsForHostTurn(
	sessionId: string,
	item: QueuedItem,
	mention: CrossAgentMentionPlan,
	receipt: TurnSendReceipt
): void {
	// A turn the host queued behind another is not this agent's turn yet: its consult waits for
	// it to start (`fireHostStartedMentions()`). A hand-off consults nobody until the turn ends.
	if (receipt.status === 'queued' && mention.routing !== 'handoff') {
		// The turn it waits behind is the one the host's tab runs now, as the host told it (never
		// this machine's clock, and never this tab, which the drain just marked and released). A
		// tab the host shows idle is read again when the item is seen queued.
		const ahead = hostTurnAhead(sessionId, item.tabId);
		const queuedOn = selectSessionById(sessionId)(useSessionStore.getState())?.aiTabs.find(
			(tab) => tab.id === item.tabId
		);
		awaitHostStart(receipt.itemId, {
			sessionId,
			item,
			mention,
			seenQueued: false,
			queuedAt: Date.now(),
			readsAtSeen: ahead.queueReads,
			afterEntryId: handoffSendBoundary(queuedOn?.logs ?? []),
			...(ahead.busy ? { aheadKnown: true, turnStartedAt: ahead.startedAt } : {}),
		});
		return;
	}
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const tabId = item.tabId || session?.activeTabId;
	if (!session || !tabId) return;
	const queueReads = hostTurnAhead(sessionId, tabId).queueReads;
	// A tab holds one hand-off. While one is armed, this one waits (with the send boundary it has
	// now) until that one released with its own turn's answer, as a local tab's next turn runs
	// only after its exit released the last one. Neither replaces nor releases the other early.
	const armed = session.aiTabs.find((tab) => tab.id === tabId);
	if (
		mention.routing === 'handoff' &&
		(armed?.pendingMentionHandoff || hasDeferredHostedHandoff(sessionId, tabId))
	) {
		const boundary = { afterEntryId: handoffSendBoundary(armed?.logs ?? []) };
		deferHostedHandoff(sessionId, tabId, () => {
			const current = selectSessionById(sessionId)(useSessionStore.getState());
			if (!current) return;
			dispatchCrossAgentMentions(mention, item.text ?? '', current, tabId, item.images);
			markHandoffSentToHost(
				sessionId,
				tabId,
				receipt,
				boundary,
				queueReads,
				item.images?.length ?? 0
			);
		});
		return;
	}
	dispatchCrossAgentMentions(mention, item.text ?? '', session, tabId, item.images);
	if (mention.routing === 'handoff') {
		markHandoffSentToHost(
			sessionId,
			tabId,
			receipt,
			undefined,
			queueReads,
			item.images?.length ?? 0
		);
	}
}

/**
 * How long a consult waits for its turn to start while the host's queue does not show it (a desktop
 * host, whose queue is not mirrored, or an item that left the queue before its first frame came).
 */
export const HOST_START_MENTION_TTL_MS = 12 * 60 * 60 * 1000;

/** The most consults that wait for host starts at once; past it the oldest is let go, with a note. */
export const MAX_HOST_START_MENTIONS = 100;

/** Consults of turns the host queued, by the host's queue item id, until that item starts. */
const mentionsAwaitingHostStart = new Map<
	string,
	{
		sessionId: string;
		item: QueuedItem;
		mention: CrossAgentMentionPlan;
		seenQueued: boolean;
		/**
		 * `turnStartedAt` is recorded: the first sync that saw the item waiting set it, and no later
		 * sync overwrites it (that sync may already show the item's own turn, when its tab state
		 * came before its queue change).
		 */
		aheadKnown?: boolean;
		/** When the turn the host queued it behind started (the tab's `thinkingStartTime` then). */
		turnStartedAt?: number;
		/**
		 * When it left the host queue with no start seen, from a host that does not name its starts
		 * (this machine's clock): its message may show within `HOST_QUEUE_START_GRACE_MS`; after it,
		 * only the tab's saved transcript can still show it ran (`judgeUnnamedHostStart()`).
		 */
		goneAt?: number;
		/** When the host's receipt said it was queued (this machine's clock; only for the time limit). */
		queuedAt: number;
		/** When the host's queue last showed it (this machine's clock): the time limit runs from here. */
		lastSeenQueuedAt?: number;
		/**
		 * The mirror's count of whole host-queue reads when it was last seen waiting (or at the
		 * receipt). A read since then may have missed its named exit, so it is judged by the tab.
		 */
		readsAtSeen?: number;
		/**
		 * The send boundary at the receipt (`handoffSendBoundary()`): an unnamed start is its own only
		 * when the host wrote its message's user entry after it (`judgeUnnamedHostStart()`).
		 */
		afterEntryId?: string;
	}
>();

type AwaitingHostStart = typeof mentionsAwaitingHostStart extends Map<string, infer V> ? V : never;

/**
 * Whether the host's own record of `tabId` reads busy now, and when that turn started; and how
 * many whole reads of the agent's host queue the mirror has taken (`MirroredPeer.queueReads`).
 */
function hostTurnAhead(
	sessionId: string,
	tabId: string
): { busy: boolean; startedAt?: number; queueReads: number } {
	const target = hostedTargetOf(selectSessionById(sessionId)(useSessionStore.getState()));
	const peer = target ? usePeerMirrorStore.getState().peers[target.peerId] : undefined;
	const queueReads = (target && peer?.queueReads?.[target.agentId]) || 0;
	const host = target?.agent?.aiTabs?.find((tab) => tab.id === tabId);
	if (!target || host?.state !== 'busy') return { busy: false, queueReads };
	const liveTurn = peer?.liveTurns[liveTurnKey(target.agentId, tabId)];
	return { busy: true, startedAt: hostTabTurnStartedAt(host, liveTurn), queueReads };
}

function awaitHostStart(hostItemId: string, waiting: AwaitingHostStart): void {
	mentionsAwaitingHostStart.set(hostItemId, waiting);
	for (const [oldestId, oldest] of mentionsAwaitingHostStart) {
		if (mentionsAwaitingHostStart.size <= MAX_HOST_START_MENTIONS) break;
		letGoOfHostStart(oldestId, oldest, 'too many messages wait on the host for their turn.');
	}
}

/**
 * Stop waiting for a consult's turn without consulting, and say so on the tab, as a local mention
 * that cannot run says it. Nothing is written when the agent is gone.
 */
function letGoOfHostStart(hostItemId: string, waiting: AwaitingHostStart, why: string): void {
	mentionsAwaitingHostStart.delete(hostItemId);
	const session = selectSessionById(waiting.sessionId)(useSessionStore.getState());
	const tabId = waiting.item.tabId || session?.activeTabId;
	if (!session || !tabId || !session.aiTabs.some((tab) => tab.id === tabId)) return;
	noteSkippedMention(
		session.id,
		tabId,
		resolveConsultTargets(waiting.mention.targetSessionIds),
		why,
		'consult'
	);
}

/**
 * Let go of the consults of agents this window no longer follows on a host: deleted, moved back,
 * or with hosted agents switched off. Called on every hosted sync with the ids still hosted.
 */
export function pruneHostStartedMentions(hostedSessionIds: ReadonlySet<string>): void {
	for (const [hostItemId, waiting] of [...mentionsAwaitingHostStart]) {
		if (hostedSessionIds.has(waiting.sessionId)) continue;
		letGoOfHostStart(hostItemId, waiting, 'the agent no longer runs on that host.');
	}
}

/**
 * Stop ended the turns of `stoppedTabIds` (those it told the host to stop, or ended here): a
 * consult of one of those tabs whose message may be the turn Stop ended goes, with a note, so
 * nothing consults after Stop (M24). That is every one the host's queue does not list waiting,
 * also one it never listed (a turn that joined and left between two frames, or an older desktop
 * host) or whose start's name is still on its way, unless the tab still runs the very turn the
 * message was queued behind (`turnStartedAt`, the host's clock): then Stop ended that turn, and
 * the message still waits, listed or not yet listed (CodeRabbit on #2154). One the host's queue
 * lists stays, and one on a tab Stop did not end: those messages run later, and consult when they
 * start, as a local queued message does after Stop.
 */
export function dropStoppedHostStartMentions(
	sessionId: string,
	stoppedTabIds: readonly string[]
): void {
	if (stoppedTabIds.length === 0) return;
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const stillWaiting = new Set(
		(session?.executionQueue ?? []).filter((item) => item.hostQueued).map((item) => item.id)
	);
	for (const [hostItemId, waiting] of [...mentionsAwaitingHostStart]) {
		if (waiting.sessionId !== sessionId || stillWaiting.has(hostItemId)) continue;
		const tabId = waiting.item.tabId || session?.activeTabId;
		if (!tabId || !stoppedTabIds.includes(tabId)) continue;
		// The host's own record, as the receipt read it: the local tab may read idle between the
		// drain's release and the next sync while the host runs the turn ahead.
		const running = hostTurnAhead(sessionId, tabId);
		const behindStoppedTurn =
			!!waiting.aheadKnown &&
			waiting.turnStartedAt !== undefined &&
			running.busy &&
			running.startedAt === waiting.turnStartedAt;
		if (behindStoppedTurn) continue;
		letGoOfHostStart(hostItemId, waiting, 'the turn was stopped.');
	}
}

/**
 * Fire the consults of turns the host queued once they start.
 *
 * A host that names how each item leaves its queue (`hostExits`, the mirror's `queueExits`) says
 * so in the same message that takes it out: a start fires, a removal is let go, and an item gone
 * from the list without a name is still on its way (its start is in flight), so it waits. Nothing
 * is read from the tab's state, except after a whole read of the queue since the item was last
 * seen waiting (`hostReads`, a reconnect): the exit named while this window was not attached is
 * missing, so that item is judged by the rules below.
 *
 * An older host, headless or desktop, names none. Then the item started when it is not in
 * the host's queue and the host wrote its own message's user entry on the tab after the send
 * boundary (`judgeUnnamedHostStart()`): live as its turn starts, or in the saved transcript, read
 * once the tab is idle, when it ran while this window was not attached. A turn of another message
 * never counts. One that left the queue waits `HOST_QUEUE_START_GRACE_MS` for its entry (time, not
 * syncs: this window's own writes run the sync again in between), then counts as removed when the
 * tab still runs the turn it was queued behind (recorded once, in the host's clock) or is idle with
 * a current transcript that does not show it; while the tab runs another turn, that turn's end and
 * saved transcript decide.
 *
 * A consult that is let go without running (removed, or not in the host's queue for
 * `HOST_START_MENTION_TTL_MS` since it was last seen there) leaves the note a local mention that
 * cannot run leaves.
 */
export function fireHostStartedMentions(
	session: Session,
	hostExits?: readonly QueueExit[],
	now = Date.now(),
	/** The mirror's count of whole reads of this agent's host queue (`MirroredPeer.queueReads`). */
	hostReads = 0,
	/** The tabs' saved transcripts: an unnamed start is confirmed by its message in them. */
	transcript: HostedTranscriptAccess = { read: () => {}, isCurrent: () => false }
): void {
	if (mentionsAwaitingHostStart.size === 0) return;
	const hostQueued = new Set(
		(session.executionQueue ?? []).filter((item) => item.hostQueued).map((item) => item.id)
	);
	for (const [hostItemId, waiting] of mentionsAwaitingHostStart) {
		if (waiting.sessionId !== session.id) continue;
		const tabId = waiting.item.tabId || session.activeTabId;
		const tab = session.aiTabs.find((candidate) => candidate.id === tabId);
		const exit = queueExitOf(hostExits, hostItemId);
		if (exit !== 'started') {
			if (exit === 'removed') {
				letGoOfHostStart(hostItemId, waiting, 'the message was removed before it ran.');
				continue;
			}
			if (hostQueued.has(hostItemId)) {
				waiting.seenQueued = true;
				waiting.lastSeenQueuedAt = now;
				waiting.readsAtSeen = hostReads;
				// Listed again (its first frame came late): its gone time starts over.
				waiting.goneAt = undefined;
				if (!waiting.aheadKnown) {
					waiting.aheadKnown = true;
					waiting.turnStartedAt = tab?.state === 'busy' ? tab.thinkingStartTime : undefined;
				}
				continue;
			}
			// Not in the host's queue for longer than any turn runs: let it go, and say so.
			if (now - (waiting.lastSeenQueuedAt ?? waiting.queuedAt) > HOST_START_MENTION_TTL_MS) {
				letGoOfHostStart(hostItemId, waiting, 'its message never started on the host.');
				continue;
			}
			// Named exits: gone without a name, its start (or its first frame) is still coming.
			// Unless the queue was read whole since it was last seen waiting (a reconnect): a start
			// named while this window was not attached never comes, so the tab decides. And unless it
			// was never seen waiting (it joined and left between two of the host's frames): no name
			// may ever come for it, so its own entry on the tab decides (CodeRabbit on #2154).
			if (hostExits && waiting.seenQueued && hostReads <= (waiting.readsAtSeen ?? 0)) continue;
			// Unnamed: it ran only when the host wrote its own message on the tab (live as it starts,
			// or in the saved transcript after it ran while this window was not attached). Another
			// message's turn is never its start.
			const verdict = judgeUnnamedHostStart(
				tab,
				{
					afterEntryId: waiting.afterEntryId,
					message: {
						itemId: hostItemId,
						text: waiting.item.text,
						imageCount: waiting.item.images?.length ?? 0,
					},
					seenQueued: waiting.seenQueued,
					aheadKnown: !!waiting.aheadKnown,
					turnStartedAt: waiting.turnStartedAt,
					goneAt: waiting.goneAt,
				},
				now,
				!!tabId && transcript.isCurrent(tabId)
			);
			if (verdict === 'removed') {
				letGoOfHostStart(hostItemId, waiting, 'the message was removed before it ran.');
				continue;
			}
			if (verdict !== 'started') {
				// Gone, also when never listed: a turn that started and ended between two syncs leaves
				// no frame, and its saved transcript is read once the grace is over (M20).
				if (verdict === 'left') waiting.goneAt = now;
				if (verdict === 'read' && tabId) transcript.read(tabId);
				continue;
			}
			// Its own entry is in the saved transcript and the tab no longer runs it: the turn ran
			// without the consult beside it. Late is better than never: consult now, and say so.
			if (tab && tab.state !== 'busy' && tabId) {
				noteLateMention(session.id, tabId, resolveConsultTargets(waiting.mention.targetSessionIds));
			}
		}
		mentionsAwaitingHostStart.delete(hostItemId);
		dispatchCrossAgentMentions(
			waiting.mention,
			waiting.item.text ?? '',
			session,
			tabId,
			waiting.item.images
		);
	}
}

/**
 * The soonest time a waiting consult's limit runs out (its start grace after it left the host
 * queue, or its time limit), when no change from the host may come to run the sync. Undefined when
 * nothing waits. A grace that has run out is not a deadline again: the sync it armed has judged
 * it, and only a change from the host (or the time limit) can move it on, so it never re-arms a
 * timer that fires at once, sync after sync (Greptile and CodeRabbit on #2154).
 */
export function nextHostStartDeadline(now = Date.now()): number | undefined {
	let soonest: number | undefined;
	for (const waiting of mentionsAwaitingHostStart.values()) {
		const ttl = (waiting.lastSeenQueuedAt ?? waiting.queuedAt) + HOST_START_MENTION_TTL_MS;
		const grace =
			waiting.goneAt === undefined ? undefined : waiting.goneAt + HOST_QUEUE_START_GRACE_MS;
		const deadline = grace !== undefined && grace >= now ? Math.min(ttl, grace) : ttl;
		if (soonest === undefined || deadline < soonest) soonest = deadline;
	}
	return soonest;
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
	// A message that mentions another agent waits here for the drain, which consults as it sends.
	if (item.crossAgentMention) return false;
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
 *
 * The tab the dequeue marked running is released first: the host's update draws the turn, and
 * the card the dequeue wrote goes (the host writes the user's entry). A message addressed only at
 * the agents it mentions (`crossAgentOnly`) is the exception: its consult IS the dispatch, nothing
 * goes to the host, and the card stays as the user's bubble, as for a local agent.
 */
export async function sendTakenItemToHost(sessionId: string, item: QueuedItem): Promise<boolean> {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const mention = session ? queuedItemMentionPlan(session, item) : null;
	// Addressed only at the agents it mentions: never sent to this agent, even when the agent it
	// named is gone by now (the local drain runs no turn for it either).
	if (session && item.crossAgentMention && item.crossAgentOnly) {
		updateSessionWith(sessionId, (s) => applyQueuedItemRelease(s, queuedItemOwnerTabId(s, item)));
		const tabId = item.tabId || session.activeTabId;
		if (mention && tabId) {
			dispatchCrossAgentMentions(mention, item.text ?? '', session, tabId, item.images);
		}
		return true;
	}
	updateSessionWith(sessionId, (s) => applyQueuedItemAbort(s, item, queuedItemOwnerTabId(s, item)));
	if (sendsInFlight.has(item.id)) return true;
	// A drain never takes a held item, so a held one here was sent on purpose (Force Send on a
	// card the host refused earlier, or a retry). It runs now: sending it held would park it on
	// the host and take its card away from the user who just asked for it to go.
	await forwardToHost(sessionId, { ...item, paused: false }, 0, mention);
	return true;
}
