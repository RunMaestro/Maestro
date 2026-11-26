/**
 * A hosted agent's turn when the link to its Federation host is lost, told and recovered the way
 * an SSH agent's turn is when its link is cut mid-turn.
 *
 * The mirror keeps the host's last report through a disconnect, so a tab the host last reported
 * running would draw Thinking forever, and Stop would have nowhere to go. Here:
 *
 * - `hostLinkLostError()`: while the link is down (a confirmed outage of the agent's remote, or a
 *   connection the mirror gave up), the error each such turn ends with. The projection draws the
 *   tab ended with it and a note in its transcript (`HostedProjectionInput.linkLost`), and the
 *   outage dialog is surfaced, as a live SSH turn dying on its remote surfaces it.
 * - `endHostedTurnsHere()`: Stop on a hosted turn while the host cannot be told settles the tab
 *   here (`settleTabThinkingState()`) and says so. The tab stays idle until the host reports again
 *   (`hostedTurnsEndedHere()`); a turn the host still runs then draws Thinking again, with Stop.
 * - `settleCutHostedTurns()`: once the host is back, each cut turn's fate is read from the host,
 *   never guessed. Still running: it draws Thinking again. Finished: its answer is in the host's
 *   transcript and draws. Died with the host (no answer after the message): the message gets the
 *   same treatment as one the host could not take (`keepTurnForHost()`): kept, the auto-retry card,
 *   and sent. A message is never sent again while the host's transcript cannot be read.
 */

import { liveTurnKey } from '../../shared/maestro-lib/client/live-turn';
import type { PeerMirrorConnection } from '../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import { notifyToast } from '../stores/notificationStore';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { selectSessionById, updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { useSshOutageStore } from '../stores/sshOutageStore';
import type { AgentError, LogEntry, QueuedItem, Session } from '../types';
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
 */
export function noteHostedTurnsCut(session: Session, link: HostLink): void {
	// Connected: the host's report is the real state, nothing is cut (`hostLinkLostError()`).
	if (link.connection === 'connected') return;
	let cut = false;
	for (const hostTab of link.agent.aiTabs ?? []) {
		if (hostTab.state !== 'busy' || hostTab.hidden) continue;
		const key = cutKey(session.id, hostTab.id);
		if (cutTurns.has(key)) continue;
		const message = lastUserMessage(session.aiTabs.find((tab) => tab.id === hostTab.id)?.logs);
		cutTurns.set(key, {
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
		});
		cut = true;
	}
	if (cut && useSshOutageStore.getState().outages[link.remoteId]) {
		useSshOutageStore.getState().surface(link.remoteId);
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
		return;
	}
	const slot = mirror.transcripts[link.peerId]?.[liveTurnKey(link.agentId, cut.tabId)];
	// A read that failed, or one already behind, cannot prove the turn died: never send twice.
	if (!slot?.loaded || slot.loading || slot.error || slot.stale) {
		cut.awaitingRead = true;
		return;
	}
	cutTurns.delete(key);
	if (turnEnded(slot.entries, cut.message.id)) return;
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
	linkErrors.clear();
	cutTurns.clear();
	stoppedTurns.clear();
	endedHere.clear();
}
