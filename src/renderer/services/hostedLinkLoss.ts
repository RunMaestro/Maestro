/**
 * A hosted agent's turn when the link to its Federation host is lost, told and recovered the way
 * an SSH agent's turn is when its link is cut mid-turn.
 *
 * The mirror keeps the host's last report through a disconnect, so a tab the host last reported
 * running would draw Thinking forever, and Stop would have nowhere to go. Here:
 *
 * - `hostLinkLostError()`: while the link is down (a confirmed outage of the agent's remote, or a
 *   connection the mirror gave up), the error each such turn ends with. The projection draws the
 *   tab ended, and the outage dialog is surfaced, as a live SSH turn dying on its remote surfaces
 *   it. The turn's message is kept at once under the auto-retry card, as an SSH turn's is when its
 *   link is cut (`noteHostedTurnsCut()`, `HostedProjectionInput.keptCuts`), drawn once: its resend
 *   names the entry the host already wrote (`QueuedItem.hostEntryId`). A cut whose message cannot
 *   be kept (Agent Resilience off) gets the error and a note in its transcript instead
 *   (`HostedProjectionInput.linkLost`).
 * - `endHostedTurnsHere()`: Stop on a hosted turn while the host cannot be told settles the tab
 *   here (`settleTabThinkingState()`) and says so. The tab stays idle until the host reports again
 *   (`hostedTurnsEndedHere()`); a turn the host still runs then draws Thinking again, with Stop.
 * - `settleCutHostedTurns()`: once the host is back, each cut turn's fate is read from the host,
 *   never guessed. Still running: it draws Thinking again, and the kept message is not sent
 *   (`settleRetryOnHost()`). Finished: its answer is in the host's transcript and draws, and the
 *   same. Died with the host (no answer after the message): the kept message is sent at once
 *   (`retryNow()`). A resend that fires first waits for that answer (`cutTurnFate()`). A message is
 *   never sent again while the host's transcript cannot be read.
 */

import { liveTurnKey } from '../../shared/maestro-lib/client/live-turn';
import type { PeerMirrorConnection } from '../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import { notifyToast } from '../stores/notificationStore';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { getRetryEntry, retryNow, settleRetryOnHost } from '../stores/retryStore';
import { selectSessionById, updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { useSshOutageStore } from '../stores/sshOutageStore';
import type { AgentError, LogEntry, QueuedItem, Session } from '../types';
import { sameImages } from '../utils/hostedSession';
import { generateId } from '../utils/ids';
import { settleTabThinkingState } from '../utils/tabHelpers';
import { keepTurnForHost } from './hostedQueuedTurn';
import { readMirrorTranscript } from './peerMirror';

/** How the mirror stands with the host a hosted record runs on. */
export interface HostLink {
	peerId: string;
	agentId: string;
	remoteId: string;
	/** The remote's name, for the words. */
	remoteName: string;
	connection: PeerMirrorConnection;
	/** The host's record of the agent. */
	agent: AgentRecord;
}

/**
 * The link error per record, kept while one loss lasts so every projection sees one value. `since`
 * is the loss's stage (0 while only the connection is lost, the outage's start once one is
 * confirmed): a new stage rewords the error and keeps its timestamp, so it stays one cut.
 */
const linkErrors = new Map<string, { since: number; error: AgentError }>();

/**
 * The error a hosted record's running turns end with while the link to its host is down, or
 * undefined while it is up. Down: an outage of the agent's remote is confirmed (ssh itself, or the
 * host behind it), or the mirror gave the connection up (`lost`). A reconnect in progress is not
 * down yet: the client may resume and the turn with it. Connected is up, whatever outage is still
 * on record: an SSH-cause outage clears only on its own re-probe, and the host's report while
 * connected is the real state of its turns.
 */
export function hostLinkLostError(session: Session, link: HostLink): AgentError | undefined {
	const outage = useSshOutageStore.getState().outages[link.remoteId]?.event;
	if (link.connection === 'connected' || (!outage && link.connection !== 'lost')) {
		linkErrors.delete(session.id);
		return undefined;
	}
	const since = outage?.since ?? 0;
	const kept = linkErrors.get(session.id);
	if (kept && kept.since === since) return kept.error;
	const why = outage?.message ? ` ${outage.message}` : '';
	const error: AgentError = {
		type: 'network_error',
		source: 'host-link',
		message: `Lost the connection to the Maestro host on "${link.remoteName}" during this turn.${why}`,
		recoverable: true,
		agentId: session.toolType,
		sessionId: session.id,
		sshRemoteId: link.remoteId,
		timestamp: kept?.error.timestamp ?? (since || Date.now()),
	};
	linkErrors.set(session.id, { since, error });
	return error;
}

/** A turn drawn ended because its link was lost, waiting for the host to say how it ended. */
interface CutTurn {
	sessionId: string;
	tabId: string;
	remoteName: string;
	/** The message the turn answers: what is sent again if the turn died with the host. */
	message?: Pick<LogEntry, 'id' | 'text' | 'images'>;
	/** A read of the host's transcript after it came back is running. */
	reading?: boolean;
	/**
	 * The read answered nothing conclusive (it failed, or was already behind). The cut waits for the
	 * tab's next successful read (a reconnect marks it stale, or the user opens it) instead of
	 * reading again in a loop against a host that errors.
	 */
	awaitingRead?: boolean;
	/** The user stopped this turn here while the host could not be told: never sent again. */
	stopped?: boolean;
	/** The message is kept for a resend under the auto-retry card, as this queue item. */
	keptItemId?: string;
	/** Resends waiting for the host to say how the turn ended (`cutTurnFate()`). */
	waiters?: ((fate: CutTurnFate) => void)[];
}

/**
 * How a cut turn's kept message goes on: `send` (the turn died with the host), `answered` (the
 * host still runs it, finished it, or no longer has the tab: never sent again), or `unknown` (the
 * host's transcript could not be read: kept for the next try).
 */
export type CutTurnFate = 'send' | 'answered' | 'unknown';

/** How long a resend waits for the host to say how a cut turn ended, as a send waits for a reconnect. */
export const CUT_TURN_FATE_WAIT_MS = 10_000;

/** Tell each resend waiting on `cut` how it goes on. */
function answerWaiters(cut: CutTurn, fate: CutTurnFate): void {
	const waiters = cut.waiters ?? [];
	cut.waiters = undefined;
	for (const waiter of waiters) waiter(fate);
}

/** By `sessionId:tabId`. */
const cutTurns = new Map<string, CutTurn>();

/**
 * Turns the user stopped here while the host could not be told, by `sessionId:tabId`: the id of
 * the message each answers (empty when the tab had none). Kept until the host reports the tab
 * idle, so the same turn cut again by a later outage is still never sent again.
 */
const stoppedTurns = new Map<string, string>();

/** Whether the turn answering `messageId` on this tab was stopped here. */
function stoppedHere(key: string, messageId: string | undefined): boolean {
	return stoppedTurns.has(key) && stoppedTurns.get(key) === (messageId ?? '');
}

const cutKey = (sessionId: string, tabId: string) => `${sessionId}:${tabId}`;

/**
 * The message the turn a host tab runs answers: the tab's newest user message, when it is not
 * older than the turn (the host stamps both on its own clock, and writes the message after the
 * turn's process starts). An older one is the previous turn's, so the cut keeps nothing for it.
 */
function cutTurnMessage(
	logs: readonly LogEntry[] | undefined,
	turnStartedAt: number | undefined
): LogEntry | undefined {
	const message = lastUserMessage(logs);
	if (!message || turnStartedAt === undefined) return message;
	return message.timestamp >= turnStartedAt ? message : undefined;
}

/** The newest message the user sent in a tab: the one its running turn answers. */
function lastUserMessage(logs: readonly LogEntry[] | undefined): LogEntry | undefined {
	for (let i = (logs?.length ?? 0) - 1; i >= 0; i -= 1) {
		if (logs![i].source === 'user') return logs![i];
	}
	return undefined;
}

/**
 * Record each turn the host last reported running as cut by the lost link, once, and surface the
 * outage: a live turn died on that remote, so its dialog shows even for an agent not on screen.
 * The turn's message is kept at once for a resend under the auto-retry card (with `lost` as its
 * reason), as an SSH turn's is when its link is cut; its resend names the host's entry for it.
 */
export function noteHostedTurnsCut(session: Session, link: HostLink, lost?: AgentError): void {
	// Connected: the host's report is the real state, nothing is cut (`hostLinkLostError()`).
	if (link.connection === 'connected') return;
	let cut = false;
	for (const hostTab of link.agent.aiTabs ?? []) {
		if (hostTab.state !== 'busy' || hostTab.hidden) continue;
		const key = cutKey(session.id, hostTab.id);
		if (cutTurns.has(key)) continue;
		const message = cutTurnMessage(
			session.aiTabs.find((tab) => tab.id === hostTab.id)?.logs,
			hostTab.thinkingStartTime
		);
		const entry: CutTurn = {
			sessionId: session.id,
			tabId: hostTab.id,
			remoteName: link.remoteName,
			...(stoppedHere(key, message?.id) ? { stopped: true } : {}),
			...(message
				? {
						message: {
							id: message.id,
							text: message.text,
							...(message.images?.length ? { images: message.images } : {}),
						},
					}
				: {}),
		};
		cutTurns.set(key, entry);
		if (lost && entry.message && !entry.stopped) keepCutMessage(entry, lost.message);
		cut = true;
	}
	if (cut && useSshOutageStore.getState().outages[link.remoteId]) {
		useSshOutageStore.getState().surface(link.remoteId);
	}
}

/**
 * Keep a cut turn's message for a resend under the auto-retry card, the way an SSH turn's message
 * is kept when its link is cut. Kept only when a retry takes it (Agent Resilience on); otherwise
 * the cut draws its error and note, and is settled from the host once it is back.
 */
function keepCutMessage(cut: CutTurn, reason: string): void {
	const message = cut.message!;
	const item: QueuedItem = {
		id: generateId(),
		timestamp: Date.now(),
		tabId: cut.tabId,
		type: 'message',
		text: message.text,
		...(message.images?.length ? { images: [...message.images] } : {}),
		hostEntryId: message.id,
	};
	if (keepTurnForHost(cut.sessionId, item, reason, { onlyIfRetried: true })) {
		cut.keptItemId = item.id;
	}
}

/**
 * The tabs of `sessionId` whose cut turn's message is kept for a resend: drawn ended with no link
 * note, since the auto-retry card stands for the cut (as it does for an SSH turn's).
 */
export function hostedCutsKept(sessionId: string): ReadonlySet<string> | undefined {
	let tabs: Set<string> | undefined;
	for (const cut of cutTurns.values()) {
		if (cut.sessionId !== sessionId || !cut.keptItemId) continue;
		(tabs ??= new Set()).add(cut.tabId);
	}
	return tabs;
}

/** Whether `item` is still the cut turn's message as it was: not edited while it was kept. */
function sameAsCut(item: Pick<QueuedItem, 'text' | 'images'>, cut: CutTurn): boolean {
	return (
		!!cut.message &&
		(item.text ?? '') === cut.message.text &&
		sameImages(item.images, cut.message.images)
	);
}

/**
 * Whether the resend of `item` must wait for the host to say how the turn it repeats ended, and if
 * so, that answer. Null: send now (not a cut turn's message, already decided, edited while kept so
 * it is a message of its own, or the host is not connected, so the send is refused and the message
 * stays kept).
 */
export function cutTurnFate(
	sessionId: string,
	item: Pick<QueuedItem, 'tabId' | 'hostEntryId' | 'text' | 'images'>,
	connected: boolean
): Promise<CutTurnFate> | null {
	if (!item.hostEntryId || !connected) return null;
	const cut = cutTurns.get(cutKey(sessionId, item.tabId));
	if (!cut || cut.stopped || cut.message?.id !== item.hostEntryId) return null;
	// Edited while it was kept: the user's own message now, sent as one whatever the turn did.
	if (!sameAsCut(item, cut)) return null;
	if (cut.awaitingRead) return Promise.resolve('unknown');
	return new Promise<CutTurnFate>((resolve) => {
		const timer = setTimeout(() => {
			cut.waiters = cut.waiters?.filter((waiter) => waiter !== answer);
			resolve('unknown');
		}, CUT_TURN_FATE_WAIT_MS);
		const answer = (fate: CutTurnFate) => {
			clearTimeout(timer);
			resolve(fate);
		};
		(cut.waiters ??= []).push(answer);
	});
}

/**
 * A kept cut message is not owed: the host had it. Its copy leaves the queue and nothing is sent,
 * whether its retry counts down or it waits behind another message's retry (that one is left
 * alone). A copy the user edited while it was kept is their own message now: it stays, no longer
 * named as the host's entry, and goes as one.
 */
function settleKeptCut(cut: CutTurn): void {
	answerWaiters(cut, 'answered');
	const keptId = cut.keptItemId;
	if (!keptId) return;
	const holdsIt = getRetryEntry(cut.sessionId, cut.tabId)?.heldItemId === keptId;
	const queued = selectSessionById(cut.sessionId)(useSessionStore.getState())?.executionQueue?.find(
		(item) => item.id === keptId
	);
	if (queued && !sameAsCut(queued, cut)) {
		updateSessionWith(cut.sessionId, (session) => ({
			...session,
			executionQueue: (session.executionQueue ?? []).map((item) =>
				item.id === keptId ? { ...item, hostEntryId: undefined } : item
			),
		}));
		if (holdsIt) retryNow(cut.sessionId, cut.tabId);
		return;
	}
	if (holdsIt) {
		settleRetryOnHost(cut.sessionId, cut.tabId);
		return;
	}
	if (queued) {
		updateSessionWith(cut.sessionId, (session) => ({
			...session,
			executionQueue: (session.executionQueue ?? []).filter((item) => item.id !== keptId),
		}));
	}
}

/** Sources that say a turn ended on the host: its answer, or its own error. */
const ENDED_SOURCES = new Set<LogEntry['source']>(['stdout', 'ai', 'error']);

/** The host's transcript says the turn answering `message` ended (an answer or an error after it). */
function turnEnded(entries: readonly { id: string; source: string }[], messageId: string): boolean {
	const at = entries.findIndex((entry) => entry.id === messageId);
	if (at === -1) return true;
	return entries
		.slice(at + 1)
		.some((entry) => ENDED_SOURCES.has(entry.source as LogEntry['source']));
}

/**
 * Decide one cut turn from the host's transcript, read after the host came back. A read that says
 * nothing conclusive keeps the cut for the next one.
 */
function decideCutTurn(key: string, link: HostLink): void {
	const cut = cutTurns.get(key);
	if (!cut) return;
	cut.reading = false;
	const mirror = usePeerMirrorStore.getState();
	// Read now, not when the host came back: the host's fresh snapshot follows its reconnect, and
	// lands before the answer to a read sent after it.
	const hostTab = mirror.peers[link.peerId]?.agents
		.find((agent) => agent.id === link.agentId)
		?.aiTabs?.find((tab) => tab.id === cut.tabId);
	// Closed on the host, still running there (it draws Thinking again), stopped by the user, or
	// no message to send: nothing to settle.
	if (
		!hostTab ||
		hostTab.state === 'busy' ||
		cut.stopped ||
		stoppedHere(key, cut.message?.id) ||
		!cut.message
	) {
		cutTurns.delete(key);
		settleKeptCut(cut);
		return;
	}
	const slot = mirror.transcripts[link.peerId]?.[liveTurnKey(link.agentId, cut.tabId)];
	// A read that failed, or one already behind, cannot prove the turn died: never send twice.
	if (!slot?.loaded || slot.loading || slot.error || slot.stale) {
		cut.awaitingRead = true;
		answerWaiters(cut, 'unknown');
		return;
	}
	cutTurns.delete(key);
	if (turnEnded(slot.entries, cut.message.id)) {
		settleKeptCut(cut);
		return;
	}
	if (cut.keptItemId) {
		// Died with the host: the kept message goes now, not at its countdown's end.
		answerWaiters(cut, 'send');
		retryNow(cut.sessionId, cut.tabId);
		return;
	}
	const item: QueuedItem = {
		id: generateId(),
		timestamp: Date.now(),
		tabId: cut.tabId,
		type: 'message',
		text: cut.message.text,
		...(cut.message.images?.length ? { images: [...cut.message.images] } : {}),
	};
	keepTurnForHost(
		cut.sessionId,
		item,
		`The Maestro host on "${cut.remoteName}" stopped before this turn finished. Your message is sent again.`
	);
}

/**
 * The host is back: settle each turn of this record the lost link cut. The host's transcript is
 * read once, and the host's report after it decides (`decideCutTurn()`).
 */
export function settleCutHostedTurns(sessionId: string, link: HostLink): void {
	// A stopped turn the host reports idle (or no longer lists) is over: its stop is settled.
	for (const key of [...stoppedTurns.keys()]) {
		if (!key.startsWith(`${sessionId}:`)) continue;
		const tabId = key.slice(sessionId.length + 1);
		const hostTab = link.agent.aiTabs?.find((tab) => tab.id === tabId);
		if (hostTab?.state !== 'busy') stoppedTurns.delete(key);
	}
	for (const [key, cut] of cutTurns) {
		if (cut.sessionId !== sessionId || cut.reading) continue;
		if (cut.stopped) {
			cutTurns.delete(key);
			continue;
		}
		if (cut.awaitingRead) {
			// Decided by the tab's next read that lands: never by another read started here.
			decideCutTurn(key, link);
			continue;
		}
		cut.reading = true;
		void readMirrorTranscript(link.peerId, link.agentId, cut.tabId).then(() =>
			decideCutTurn(key, link)
		);
	}
}

/** Tabs whose turn was stopped here while the host could not be told, by record id. */
const endedHere = new Map<string, Set<string>>();

/**
 * The tabs of `sessionId` stopped here and not yet reported by the host. Once the host is connected
 * again it is told nothing more here: its report draws the tab, and a turn it still runs can be
 * stopped there.
 */
export function hostedTurnsEndedHere(
	sessionId: string,
	connected: boolean
): ReadonlySet<string> | undefined {
	if (connected) {
		endedHere.delete(sessionId);
		return undefined;
	}
	return endedHere.get(sessionId);
}

/**
 * The tabs of `sessionId` (only `tabId`, when given) whose turn a lost link cut and that wait for
 * the host to say how the turn ended. Drawn idle here, so Stop finds them by this, not by state.
 */
export function cutHostedTurnTabs(sessionId: string, tabId?: string): string[] {
	const tabs: string[] = [];
	for (const cut of cutTurns.values()) {
		if (cut.sessionId !== sessionId || cut.stopped) continue;
		if (tabId !== undefined && cut.tabId !== tabId) continue;
		tabs.push(cut.tabId);
	}
	return tabs;
}

/**
 * Stop means stop: when the host is back, the turn of each tab is not sent again, whether the link
 * loss was confirmed before the Stop or after it, or again by a later outage.
 */
export function markHostedTurnsStopped(
	sessionId: string,
	tabIds: readonly string[],
	remoteName: string
): void {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	for (const tabId of tabIds) {
		const key = cutKey(sessionId, tabId);
		const tabLogs = session?.aiTabs.find((tab) => tab.id === tabId)?.logs;
		stoppedTurns.set(key, lastUserMessage(tabLogs)?.id ?? '');
		const cut = cutTurns.get(key);
		if (cut) cut.stopped = true;
		else cutTurns.set(key, { sessionId, tabId, remoteName, stopped: true });
	}
}

/**
 * Stop on a hosted turn whose host cannot be told: end it here, as a local Stop settles its tab,
 * and say the host was not told.
 */
export function endHostedTurnsHere(
	sessionId: string,
	tabIds: readonly string[],
	remoteName: string
): void {
	if (tabIds.length === 0) return;
	const tabs = endedHere.get(sessionId) ?? new Set<string>();
	for (const tabId of tabIds) tabs.add(tabId);
	markHostedTurnsStopped(sessionId, tabIds, remoteName);
	endedHere.set(sessionId, tabs);
	updateSessionWith(sessionId, (session) =>
		tabIds.reduce((current, tabId) => settleTabThinkingState(current, tabId), session)
	);
	notifyToast({
		color: 'orange',
		title: 'Stopped here',
		message: `The Maestro host on "${remoteName}" could not be told: it is not connected. If the turn is still running there, it shows again when the host is back.`,
	});
}

/** Test-only: forget every cut turn and local stop. */
export function __resetHostedLinkLossForTests(): void {
	for (const cut of cutTurns.values()) cut.waiters = undefined;
	linkErrors.clear();
	cutTurns.clear();
	stoppedTurns.clear();
	endedHere.clear();
}
