/**
 * crossAgentHandoff - forward a turn's final answer to the agents the user
 * asked to hand it to.
 *
 * "Look into MNQ and feed whatever we learn over to @Kensho" names an ORDER:
 * this agent works first, and @Kensho gets the result. Consulting @Kensho at
 * send time (the parallel path) hands it a question with nothing in it yet, and
 * the findings it was promised never reach it. So a hand-off is armed on the
 * source tab when the message dispatches and released when that turn ends:
 *
 * 1. Dispatch (`armMentionHandoff`) stamps `pendingMentionHandoff` on the tab
 *    and the turn's prompt gets `cross-agent-handoff-pending`, so the agent
 *    writes a final answer that stands on its own.
 * 2. The turn's process exits (`useAgentExitListener` calls
 *    `releaseMentionHandoff`). A clean exit sends the user's message plus the
 *    turn's final answer to every target, through the same consult pipeline a
 *    typed mention uses, flagged as a hand-off so the target is told what it
 *    is receiving. A failed turn sends nothing and says so in the transcript.
 * 3. Stop clears it (`dropMentionHandoffs`): Stop means stop, and forwarding a
 *    half-finished answer would act on the user's behalf after they said no.
 *
 * A hosted agent's turn runs on its Federation host, so no local process exits: the host's tab
 * state releases it instead (`markHandoffSentToHost()`, then `followHostedHandoffs()` on every
 * sync), with the same answer, the same notes, and the same targets.
 *
 * One way by design: the target's reply lands on the source tab as an
 * attributed bubble, and no follow-up turn is sent back to the source agent.
 */

import type { QueueExit, TurnSendReceipt } from '../../shared/maestro-lib/client/types';
import { queueExitOf } from '../../shared/maestro-lib/client/peer-mirror';
import { PROMPT_LAYER_SEPARATOR } from '../../shared/maestro-lib/turns/prompt';
import { collapseWhitespace } from '../../shared/stringUtils';
import type { AITab, ConsultHoldTarget, LogEntry, MentionHandoff, Session } from '../types';
import { updateAiTab, updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { sendCrossAgentRequest } from '../hooks/agent/useCrossAgentDispatch';
import { isSelfContainedCard } from '../utils/logEntries';
import { generateId } from '../utils/ids';
import { formatConsultedAgentNames } from './crossAgentConsultHold';

/** The turn's answer, and the transcript that led up to it. */
export interface HandoffTurn {
	/** The turn's final answer: its last assistant entry with text. */
	answer: string;
	/** Everything before the turn's user message, for the target's context. */
	priorLogs: LogEntry[];
}

/** Assistant output that can carry the answer (cards own their own text). */
function isAnswerEntry(entry: LogEntry): boolean {
	return (
		(entry.source === 'ai' || entry.source === 'stdout') &&
		!isSelfContainedCard(entry) &&
		!!entry.text?.trim()
	);
}

/**
 * Split a finished turn out of a tab's logs. The turn starts at the LAST user
 * entry; its answer is the last assistant entry after that, which is what the
 * pending note told the agent to make stand on its own (earlier entries are
 * narration between tool calls). Returns null when the turn produced no answer.
 */
export function collectHandoffTurn(logs: LogEntry[]): HandoffTurn | null {
	let userIndex = -1;
	for (let i = logs.length - 1; i >= 0; i--) {
		if (logs[i].source === 'user') {
			userIndex = i;
			break;
		}
	}
	for (let i = logs.length - 1; i > userIndex; i--) {
		if (isAnswerEntry(logs[i])) {
			return {
				answer: logs[i].text.trim(),
				priorLogs: userIndex >= 0 ? logs.slice(0, userIndex) : [],
			};
		}
	}
	return null;
}

/** Arm a hand-off on the tab whose turn is about to run. */
export function armMentionHandoff(sessionId: string, tabId: string, handoff: MentionHandoff): void {
	if (handoff.targets.length === 0) return;
	updateAiTab(sessionId, tabId, (tab) => ({ ...tab, pendingMentionHandoff: handoff }));
}

/**
 * Clear the armed hand-offs on an agent (Stop is agent-level), or on one tab
 * when `tabId` is given (a Stop aimed at a single turn).
 */
export function dropMentionHandoffs(sessionId: string, tabId?: string): void {
	// The hand-offs waiting behind an armed one go with it.
	for (const key of [...deferredHostedHandoffs.keys()]) {
		const scoped = tabId
			? key === deferredKey(sessionId, tabId)
			: key.startsWith(`${sessionId}\u0000`);
		if (scoped) deferredHostedHandoffs.delete(key);
	}
	const armed = (t: { id: string; pendingMentionHandoff?: unknown }) =>
		!!t.pendingMentionHandoff && (!tabId || t.id === tabId);
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session?.aiTabs.some(armed)) return;
	updateSessionWith(sessionId, (s) => ({
		...s,
		aiTabs: s.aiTabs.map((t) => (armed(t) ? { ...t, pendingMentionHandoff: undefined } : t)),
	}));
}

/**
 * A system note on the source tab saying why a mention's hand-off (or consult) did not go out,
 * the one note every mode writes for a mention that cannot run.
 */
export function noteSkippedMention(
	sessionId: string,
	tabId: string,
	targets: ConsultHoldTarget[],
	why: string,
	kind: 'handoff' | 'consult' = 'handoff'
) {
	const names = formatConsultedAgentNames(targets.map((t) => t.targetAgentName));
	appendMentionNote(
		sessionId,
		tabId,
		kind === 'handoff'
			? `Nothing was handed off to ${names}: ${why}`
			: `Nothing was asked of ${names}: ${why}`
	);
}

/**
 * A system note on the source tab saying a consult went out only after its turn ran: a host that
 * does not say when a queued message starts showed the start in the saved transcript (M20).
 */
export function noteLateMention(sessionId: string, tabId: string, targets: ConsultHoldTarget[]) {
	const names = formatConsultedAgentNames(targets.map((t) => t.targetAgentName));
	appendMentionNote(
		sessionId,
		tabId,
		`${names} ${targets.length === 1 ? 'was' : 'were'} asked after the turn ran: the host did not say when the message started.`
	);
}

function appendMentionNote(sessionId: string, tabId: string, text: string) {
	const entry: LogEntry = { id: generateId(), timestamp: Date.now(), source: 'system', text };
	updateAiTab(sessionId, tabId, (tab) => ({ ...tab, logs: [...tab.logs, entry] }));
}

/**
 * Release the hand-off armed on a tab whose turn just ended. `failed` is a turn
 * that did not end cleanly (non-zero exit): its answer is not what the user
 * asked to pass on, so nothing is sent. A no-op when nothing is armed, which
 * makes a second exit event for the same turn harmless.
 */
export function releaseMentionHandoff(
	sessionId: string,
	tabId: string,
	opts: {
		failed: boolean;
		managedQueue?: { dispatchId: string; generation: string; targetSessionIds: string[] };
		/** The turn's answer as the caller found it (a hosted turn, after its send boundary). */
		turn?: HandoffTurn | null;
	}
): void | Promise<void> {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const tab = session?.aiTabs.find((t) => t.id === tabId);
	if (opts.managedQueue) {
		const release = opts.managedQueue;
		const item = session?.executionQueue.find(
			(row) =>
				row.id === release.dispatchId &&
				row.pendingAdmissionId === release.dispatchId &&
				row.tabId === tabId
		);
		if (!session || !tab || !item || opts.failed) return;
		return Promise.all(
			release.targetSessionIds.map((targetSessionId) =>
				sendCrossAgentRequest({
					sourceSessionId: sessionId,
					sourceAgentName: session.name,
					sourceTabId: tabId,
					targetSessionId,
					userPrompt: item.text ?? '',
					sourceLogs: [],
					managedQueue: {
						dispatchId: release.dispatchId,
						generation: release.generation,
						handoff: true,
					},
				})
			)
		).then(() => {});
	}
	const handoff = tab?.pendingMentionHandoff;
	if (!session || !tab || !handoff) return;

	// Clear first, so a send that throws cannot leave it armed for the next turn.
	updateAiTab(sessionId, tabId, (t) => ({ ...t, pendingMentionHandoff: undefined }));

	if (opts.failed) {
		noteSkippedMention(sessionId, tabId, handoff.targets, 'the turn did not finish.');
		return;
	}
	const turn = opts.turn !== undefined ? opts.turn : collectHandoffTurn(tab.logs);
	if (!turn) {
		noteSkippedMention(sessionId, tabId, handoff.targets, 'the turn produced no answer.');
		return;
	}

	for (const target of handoff.targets) {
		sendCrossAgentRequest({
			sourceSessionId: session.id,
			sourceAgentName: session.name,
			sourceTabId: tabId,
			targetSessionId: target.targetSessionId,
			userPrompt: handoff.message,
			sourceLogs: turn.priorLogs,
			sourceCwd: session.cwd,
			handoffAnswer: turn.answer,
		});
	}
}

/** The host took the turn a hand-off waits on: follow its tab from now on. */
export function markHandoffSentToHost(
	sessionId: string,
	tabId: string,
	receipt: TurnSendReceipt,
	/** The send boundary when the host took the turn, for a hand-off armed later than that. */
	boundary?: { afterEntryId: string | undefined },
	/** The mirror's count of whole host-queue reads now (`MirroredPeer.queueReads`). */
	queueReads = 0,
	/** How many images the message carried: an image-only message is matched by it. */
	imageCount = 0
): void {
	updateAiTab(sessionId, tabId, (tab) => {
		if (!tab.pendingMentionHandoff) return tab;
		const afterEntryId = boundary ? boundary.afterEntryId : handoffSendBoundary(tab.logs);
		return {
			...tab,
			pendingMentionHandoff: {
				...tab.pendingMentionHandoff,
				hostTurn: {
					stage: 'sent',
					...(receipt.status === 'queued'
						? { queueItemId: receipt.itemId, readsAtSeen: queueReads }
						: {}),
					...(afterEntryId ? { afterEntryId } : {}),
					...(imageCount > 0 ? { imageCount } : {}),
				},
			},
		};
	});
}

/**
 * How long a turn the host queued may take, after it left the host's queue, before its tab reads
 * busy with it (a host that does not name its starts). The queue change and the tab state arrive
 * as separate messages, and this window's own writes run the sync again in between, so the wait is
 * time, never a count of syncs. A start seen later is not taken for it: it was removed.
 */
export const HOST_QUEUE_START_GRACE_MS = 15_000;

/**
 * The soonest time a hosted hand-off that left the host queue runs out of its start grace, over
 * `sessions`' tabs. Undefined when none waits on one. A grace that has run out is no deadline:
 * the sync it armed judged it, and a change from the host moves it on from there, so no timer
 * fires again at once, sync after sync (Greptile and CodeRabbit on #2154).
 */
export function nextHostedHandoffDeadline(
	sessions: readonly Session[],
	now = Date.now()
): number | undefined {
	let soonest: number | undefined;
	for (const session of sessions) {
		for (const tab of session.aiTabs) {
			const goneAt = tab.pendingMentionHandoff?.hostTurn?.goneAt;
			if (goneAt === undefined) continue;
			const deadline = goneAt + HOST_QUEUE_START_GRACE_MS;
			if (deadline < now) continue;
			if (soonest === undefined || deadline < soonest) soonest = deadline;
		}
	}
	return soonest;
}

/** The send boundary of a hosted turn: the last entry the tab holds that is not live. */
export function handoffSendBoundary(logs: LogEntry[]): string | undefined {
	return [...logs].reverse().find((entry) => !entry.hostLive)?.id;
}

/** The entries a host wrote after `afterEntryId` (all of them when it is unknown or gone). */
function entriesAfter(logs: LogEntry[], afterEntryId: string | undefined): LogEntry[] {
	const at = afterEntryId ? logs.findIndex((entry) => entry.id === afterEntryId) : -1;
	return at === -1 ? logs : logs.slice(at + 1);
}

/**
 * A message this window handed a host, as the host's transcript can show it: the queue item the
 * host's receipt named (`itemId`), its text, and how many images it carried.
 */
export interface HostedMessageRef {
	itemId?: string;
	text?: string;
	imageCount?: number;
}

/** The most user entries a host wrote that this window has matched to a message at once. */
export const MAX_HOST_ENTRY_CLAIMS = 1000;

/**
 * Which queued message each host user entry was matched to (entry id to the host's queue item id),
 * so two messages with the same text never share one entry: the first to match it keeps it, and the
 * second waits for its own. Bounded; the oldest claim goes first.
 */
const hostEntryClaims = new Map<string, string>();

function claimHostEntry(entryId: string, itemId: string): void {
	if (hostEntryClaims.get(entryId) === itemId) return;
	hostEntryClaims.set(entryId, itemId);
	for (const oldest of hostEntryClaims.keys()) {
		if (hostEntryClaims.size <= MAX_HOST_ENTRY_CLAIMS) break;
		hostEntryClaims.delete(oldest);
	}
}

/** Forget every claim (tests). */
export function resetHostEntryClaims(): void {
	hostEntryClaims.clear();
}

/** Whether `text` is `wanted`, or holds it as one whole layer, whitespace collapsed in both. */
function textHoldsMessage(text: string, wanted: string): boolean {
	return (
		collapseWhitespace(text) === wanted ||
		text.split(PROMPT_LAYER_SEPARATOR).some((layer) => collapseWhitespace(layer) === wanted)
	);
}

/**
 * Where, in `entries`, the host wrote the user entry of `message`. -1 while none.
 *
 * By identity first: a host stamps each user entry with the queue item it ran from
 * (`queuedItemId`), so the entry stamped with the message's own item id is its entry, and one
 * stamped with another item's id never is. An older host stamps none; then the entry is the first
 * one no other message claimed (`hostEntryClaims`) whose text is the message, whitespace collapsed,
 * or holds it as one whole layer (an older host that takes no agent-only text gets the consult's
 * replies and notes laid around the message, `withTurnAgentText()`). A message with no text (images
 * only) matches an entry with no text and the same number of images, never the first entry there;
 * a message of which neither is known takes the first user entry. A matched entry is claimed for
 * the message's item.
 */
function userEntryIndexOf(entries: LogEntry[], message: HostedMessageRef): number {
	const itemId = message.itemId;
	if (itemId) {
		const own = entries.findIndex(
			(entry) => entry.source === 'user' && entry.queuedItemId === itemId
		);
		if (own !== -1) {
			claimHostEntry(entries[own].id, itemId);
			return own;
		}
	}
	const wanted = collapseWhitespace(message.text ?? '');
	// Neither its text nor its images known: the first user entry is its own.
	const unknown = message.text === undefined && message.imageCount === undefined;
	const index = entries.findIndex((entry) => {
		if (entry.source !== 'user') return false;
		// Another queued message's entry: stamped with its id, or matched to it already.
		if (itemId && entry.queuedItemId) return false;
		const claimedBy = hostEntryClaims.get(entry.id);
		if (claimedBy !== undefined && claimedBy !== itemId) return false;
		if (unknown) return true;
		if (wanted) return textHoldsMessage(entry.text ?? '', wanted);
		if (!textHoldsMessage(entry.text ?? '', '')) return false;
		return message.imageCount === undefined || (entry.images?.length ?? 0) === message.imageCount;
	});
	if (index !== -1 && itemId) claimHostEntry(entries[index].id, itemId);
	return index;
}

/**
 * The one turn a hosted hand-off waits on: from the user entry the host wrote for its message after
 * the send boundary (`userEntryIndexOf()`) up to the next user entry. The turn the message was
 * queued behind, a later turn that ended before the same sync, and the end of a turn still running
 * at the send are none of them. Empty until the host wrote the message.
 */
function ownTurnEntries(
	logs: LogEntry[],
	afterEntryId: string | undefined,
	message: HostedMessageRef
): LogEntry[] {
	const after = entriesAfter(logs, afterEntryId);
	const start = userEntryIndexOf(after, message);
	if (start === -1) return [];
	const next = after.findIndex((entry, index) => index > start && entry.source === 'user');
	return after.slice(start, next === -1 ? undefined : next);
}

/** Whether the host wrote `message`'s user entry on the tab after the send boundary: it ran. */
export function hostRanMessage(
	logs: LogEntry[],
	afterEntryId: string | undefined,
	message: HostedMessageRef
): boolean {
	return userEntryIndexOf(entriesAfter(logs, afterEntryId), message) !== -1;
}

/** A hosted hand-off's message, as `userEntryIndexOf()` matches it. */
function handoffMessageRef(handoff: MentionHandoff | undefined): HostedMessageRef {
	return {
		...(handoff?.hostTurn?.queueItemId ? { itemId: handoff.hostTurn.queueItemId } : {}),
		...(handoff?.message !== undefined ? { text: handoff.message } : {}),
		...(handoff?.hostTurn?.imageCount !== undefined
			? { imageCount: handoff.hostTurn.imageCount }
			: {}),
	};
}

/** A hosted tab's saved transcript, as the sync reads it for a turn's own entries. */
export interface HostedTranscriptAccess {
	/** Ask for the tab's saved transcript (once; a failed read waits for a new trigger). */
	read: (tabId: string) => void;
	/** The tab's saved transcript is loaded and nothing marked it stale since. */
	isCurrent: (tabId: string) => boolean;
}

/**
 * How a message the host queued, now gone from the host's queue with no exit named for it (a host
 * that names none, or a reconnect read that may have missed the name), stands. A start belongs to
 * the message only when the host wrote the message's own user entry after its send boundary
 * (`hostRanMessage()`, live as the turn starts, or in the saved transcript after it): another
 * message's turn, or a turn that started at another time, never counts as its start.
 * - `started`: its user entry is on the tab.
 * - `left`: first seen gone (the caller records `goneAt`), also when the host's queue never showed
 *   it: a turn that started and ended between two syncs is gone before its first frame (M20).
 * - `wait`: its start may still show (inside `HOST_QUEUE_START_GRACE_MS`), or the tab runs a turn
 *   whose own entry has not come (a host that does not stream it): the saved transcript decides
 *   once that turn ends.
 * - `read`: the tab is idle and its saved transcript is not current: read it before deciding.
 * - `removed`: past the grace, the tab still runs the turn it was queued behind, or is idle with a
 *   current transcript that never shows the message. Only for a message the host's queue showed
 *   (`seenQueued`): one it never showed (a host whose queue is not mirrored, or a start before the
 *   first frame) proves nothing by its absence, so it waits for its entry, late rather than lost.
 */
export function judgeUnnamedHostStart(
	tab: Pick<AITab, 'state' | 'logs' | 'thinkingStartTime'> | undefined,
	waiting: {
		afterEntryId: string | undefined;
		message: HostedMessageRef;
		/** The host's queue showed it waiting (else its absence there proves nothing). */
		seenQueued: boolean;
		/** The turn it was queued behind is recorded (`turnStartedAt`, the host's clock). */
		aheadKnown: boolean;
		turnStartedAt?: number;
		goneAt?: number;
	},
	now: number,
	transcriptCurrent: boolean
): 'started' | 'left' | 'wait' | 'read' | 'removed' {
	if (tab && hostRanMessage(tab.logs, waiting.afterEntryId, waiting.message)) return 'started';
	if (waiting.goneAt === undefined) return 'left';
	if (now - waiting.goneAt <= HOST_QUEUE_START_GRACE_MS) return 'wait';
	if (tab?.state === 'busy') {
		const ahead =
			waiting.seenQueued && waiting.aheadKnown && tab.thinkingStartTime === waiting.turnStartedAt;
		return ahead ? 'removed' : 'wait';
	}
	if (!transcriptCurrent) return 'read';
	return waiting.seenQueued ? 'removed' : 'wait';
}

/**
 * What a hosted tab's armed hand-off does on this sync. A hand-off no host took (`hostTurn`
 * absent) is a local one, released by its process exit: `wait`.
 * - `running`: the tab reads busy with the turn (not while it still waits in the host's queue).
 * - `read`: the turn ended but its saved answer is not here yet (the tab still draws what the
 *   turn streamed, or holds nothing after the entry it ended on at send): read the saved
 *   transcript, so the answer handed off is the one the host recorded.
 * - `release`: the saved answer is here, or the saved transcript is current (`transcriptCurrent`)
 *   and the turn left none (the release says so in the transcript). A turn so short the tab never
 *   read busy counts once its answer follows the entry the tab ended on when it was sent.
 *
 * A turn the host queued starts as `fireHostStartedMentions()` reads it: named by a host that names
 * how each item leaves its queue (`hostExits`), else by the user entry the host wrote for its own
 * message (`judgeUnnamedHostStart()`), with the turn ahead recorded once (`seen-queued`) and the
 * time it left the queue (`left-queue`); one whose message never shows is dropped. A named start
 * runs once the tab reads busy with a turn that is not the one ahead; until then only its own saved
 * answer ends it, never a transcript that was current before the start.
 */
export function hostedHandoffStep(
	tab: Pick<AITab, 'state' | 'pendingMentionHandoff' | 'logs' | 'thinkingStartTime'>,
	hostQueueItemIds: ReadonlySet<string>,
	transcriptCurrent = false,
	hostExits?: readonly QueueExit[],
	now = Date.now(),
	/** The mirror's count of whole reads of this agent's host queue (`MirroredPeer.queueReads`). */
	hostReads = 0
): 'wait' | 'running' | 'read' | 'release' | 'drop' | 'seen-queued' | 'left-queue' {
	const hostTurn = tab.pendingMentionHandoff?.hostTurn;
	if (!hostTurn) return 'wait';
	const message = handoffMessageRef(tab.pendingMentionHandoff);
	// A whole read of the host queue since it was last seen waiting (a reconnect) may have missed
	// its named exit: from here the tab's state decides, as for a host that names none.
	const readSince = hostReads > (hostTurn.readsAtSeen ?? 0);
	const queued = hostTurn.stage === 'sent' ? hostTurn.queueItemId : undefined;
	const exit = queued ? queueExitOf(hostExits, queued) : undefined;
	if (exit === 'removed') return 'drop';
	if (exit === 'started') {
		const ownTurnBusy =
			tab.state === 'busy' &&
			(!hostTurn.seenQueued || tab.thinkingStartTime !== hostTurn.turnStartedAt);
		if (ownTurnBusy) return 'running';
		if (tab.state === 'busy') return 'wait';
		// Idle while it still draws a stream: a turn ended whose saved answer is not here yet. The
		// read is safe: only this turn's own entries after the send can release it.
		if (tab.logs.some((entry) => entry.hostLive)) return 'read';
		if (collectHandoffTurn(ownTurnEntries(tab.logs, hostTurn.afterEntryId, message))) {
			return 'release';
		}
		return transcriptCurrent ? 'wait' : 'read';
	}
	if (hostTurn.queueItemId && hostQueueItemIds.has(hostTurn.queueItemId)) {
		// The turn ahead is what the tab runs when it is first seen waiting, never overwritten; a
		// sighting after a read moves only the read count.
		return hostTurn.seenQueued && !readSince && hostTurn.goneAt === undefined
			? 'wait'
			: 'seen-queued';
	}
	if (queued) {
		// Named exits: gone without a name, its start (or its first frame) is still coming.
		if (hostExits && !readSince) return 'wait';
		// Unnamed: it ran only when the host wrote its own message on the tab; another message's
		// turn is never its start, and nothing it never ran is handed off.
		const verdict = judgeUnnamedHostStart(
			tab,
			{
				afterEntryId: hostTurn.afterEntryId,
				message,
				seenQueued: !!hostTurn.seenQueued,
				aheadKnown: !!hostTurn.seenQueued,
				turnStartedAt: hostTurn.turnStartedAt,
				goneAt: hostTurn.goneAt,
			},
			now,
			transcriptCurrent
		);
		if (verdict === 'started') return 'running';
		if (verdict === 'removed') return 'drop';
		if (verdict === 'read') return 'read';
		return verdict === 'left' ? 'left-queue' : 'wait';
	}
	if (tab.state === 'busy') return hostTurn.stage === 'sent' ? 'running' : 'wait';
	if (tab.logs.some((entry) => entry.hostLive)) return 'read';
	if (collectHandoffTurn(ownTurnEntries(tab.logs, hostTurn.afterEntryId, message))) {
		return 'release';
	}
	// Not started yet, or ended between two syncs: a stale transcript is read to tell them apart.
	if (hostTurn.stage === 'sent') return transcriptCurrent ? 'wait' : 'read';
	return transcriptCurrent ? 'release' : 'read';
}

/**
 * The answer a hosted hand-off sends: its own turn's last answer (`ownTurnEntries()`), with the
 * conversation before the turn's user message as the target's context. Null when the turn left
 * no answer (the release notes it), never an earlier or a later turn's answer.
 */
export function hostedHandoffTurn(
	logs: LogEntry[],
	afterEntryId: string | undefined,
	/** The hand-off's message: its turn starts at the user entry the host wrote for it. */
	message: HostedMessageRef = {}
): HandoffTurn | null {
	const fromSend = collectHandoffTurn(ownTurnEntries(logs, afterEntryId, message));
	if (!fromSend) return null;
	return { answer: fromSend.answer, priorLogs: collectHandoffTurn(logs)?.priorLogs ?? [] };
}

/** Release a hosted tab's armed hand-off now, with the answer its turn left after the send. */
export function releaseHostedHandoff(sessionId: string, tab: AITab): void {
	const handoff = tab.pendingMentionHandoff;
	void releaseMentionHandoff(sessionId, tab.id, {
		failed: !!tab.agentError,
		turn: hostedHandoffTurn(tab.logs, handoff?.hostTurn?.afterEntryId, handoffMessageRef(handoff)),
	});
}

const deferredKey = (sessionId: string, tabId: string) => `${sessionId}\u0000${tabId}`;

/**
 * Hand-offs of hosted turns whose tab still holds an armed hand-off, in the order the host took
 * them. A tab holds one hand-off: the next one arms once the armed one has released with its own
 * turn's answer (`followHostedHandoffs()`), never replacing it or releasing it early. Stop drops
 * them with the armed one (`dropMentionHandoffs()`).
 */
const deferredHostedHandoffs = new Map<string, Array<() => void>>();

/** Hold `arm` until `tabId` no longer holds an armed hand-off. */
export function deferHostedHandoff(sessionId: string, tabId: string, arm: () => void): void {
	const key = deferredKey(sessionId, tabId);
	deferredHostedHandoffs.set(key, [...(deferredHostedHandoffs.get(key) ?? []), arm]);
}

/** Whether a hand-off waits behind the one `tabId` holds. */
export function hasDeferredHostedHandoff(sessionId: string, tabId: string): boolean {
	return (deferredHostedHandoffs.get(deferredKey(sessionId, tabId))?.length ?? 0) > 0;
}

/** Arm the next waiting hand-off of every tab of `sessionId` that holds none now. */
function armDeferredHostedHandoffs(sessionId: string): void {
	for (const [key, waiting] of [...deferredHostedHandoffs]) {
		if (!key.startsWith(`${sessionId}\u0000`)) continue;
		const tabId = key.slice(sessionId.length + 1);
		const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
		const tab = session?.aiTabs.find((candidate) => candidate.id === tabId);
		if (!tab) {
			deferredHostedHandoffs.delete(key);
			continue;
		}
		if (tab.pendingMentionHandoff) continue;
		const [next, ...rest] = waiting;
		if (rest.length) deferredHostedHandoffs.set(key, rest);
		else deferredHostedHandoffs.delete(key);
		next?.();
	}
}

/**
 * Move every hand-off a hosted agent's tabs wait on: a turn its host started, then ended, releases
 * as a local exit does (`releaseMentionHandoff()`), failed when the tab ended on an error.
 * `transcript` reads a tab's saved transcript when the turn's answer is not here yet.
 */
export function followHostedHandoffs(
	session: Session,
	transcript: HostedTranscriptAccess = { read: () => {}, isCurrent: () => false },
	/** How the host queue items that last left it left, when the host names that. */
	hostExits?: readonly QueueExit[],
	now = Date.now(),
	/** The mirror's count of whole reads of this agent's host queue. */
	hostReads = 0
): void {
	armDeferredHostedHandoffs(session.id);
	if (!session.aiTabs.some((tab) => tab.pendingMentionHandoff?.hostTurn)) return;
	const hostQueueItemIds = new Set(
		(session.executionQueue ?? []).filter((item) => item.hostQueued).map((item) => item.id)
	);
	for (const tab of session.aiTabs) {
		const step = hostedHandoffStep(
			tab,
			hostQueueItemIds,
			transcript.isCurrent(tab.id),
			hostExits,
			now,
			hostReads
		);
		if (step === 'running') {
			updateAiTab(session.id, tab.id, (current) =>
				current.pendingMentionHandoff?.hostTurn
					? {
							...current,
							pendingMentionHandoff: {
								...current.pendingMentionHandoff,
								// The queue gate and the send boundary still hold for this turn.
								hostTurn: { ...current.pendingMentionHandoff.hostTurn, stage: 'running' },
							},
						}
					: current
			);
		} else if (step === 'seen-queued') {
			updateAiTab(session.id, tab.id, (current) =>
				current.pendingMentionHandoff?.hostTurn
					? {
							...current,
							pendingMentionHandoff: {
								...current.pendingMentionHandoff,
								hostTurn: {
									...current.pendingMentionHandoff.hostTurn,
									seenQueued: true,
									readsAtSeen: hostReads,
									// Listed again (a frame that came late): its gone time starts over.
									goneAt: undefined,
									turnStartedAt: current.pendingMentionHandoff.hostTurn.seenQueued
										? current.pendingMentionHandoff.hostTurn.turnStartedAt
										: current.state === 'busy'
											? current.thinkingStartTime
											: undefined,
								},
							},
						}
					: current
			);
		} else if (step === 'left-queue') {
			updateAiTab(session.id, tab.id, (current) =>
				current.pendingMentionHandoff?.hostTurn
					? {
							...current,
							pendingMentionHandoff: {
								...current.pendingMentionHandoff,
								hostTurn: { ...current.pendingMentionHandoff.hostTurn, goneAt: now },
							},
						}
					: current
			);
		} else if (step === 'read') {
			transcript.read(tab.id);
		} else if (step === 'release') {
			releaseHostedHandoff(session.id, tab);
		} else if (step === 'drop') {
			const handoff = tab.pendingMentionHandoff!;
			updateAiTab(session.id, tab.id, (t) => ({ ...t, pendingMentionHandoff: undefined }));
			noteSkippedMention(
				session.id,
				tab.id,
				handoff.targets,
				'the message was removed before it ran.'
			);
		}
	}
	// A hand-off that waited behind one released (or dropped) on this sync arms now.
	armDeferredHostedHandoffs(session.id);
}
