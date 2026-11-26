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
import { updateSessionWith } from '../stores/sessionStore';
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

/** The link error per record, kept while one outage lasts so every projection sees one value. */
const linkErrors = new Map<string, { since: number; error: AgentError }>();

/**
 * The error a hosted record's running turns end with while the link to its host is down, or
 * undefined while it is up. Down: an outage of the agent's remote is confirmed (ssh itself, or the
 * host behind it), or the mirror gave the connection up (`lost`). A reconnect in progress is not
 * down yet: the client may resume and the turn with it.
 */
export function hostLinkLostError(session: Session, link: HostLink): AgentError | undefined {
	const outage = useSshOutageStore.getState().outages[link.remoteId]?.event;
	if (!outage && link.connection !== 'lost') {
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
		timestamp: since || Date.now(),
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
}

/** By `sessionId:tabId`. */
const cutTurns = new Map<string, CutTurn>();

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

/** Decide one cut turn from the host's transcript, read after the host came back. */
function decideCutTurn(key: string, link: HostLink): void {
	const cut = cutTurns.get(key);
	if (!cut) return;
	cutTurns.delete(key);
	const mirror = usePeerMirrorStore.getState();
	// Read now, not when the host came back: the host's fresh snapshot follows its reconnect, and
	// lands before the answer to a read sent after it.
	const hostTab = mirror.peers[link.peerId]?.agents
		.find((agent) => agent.id === link.agentId)
		?.aiTabs?.find((tab) => tab.id === cut.tabId);
	// Closed on the host, or still running there (it draws Thinking again): nothing to settle.
	if (!hostTab || hostTab.state === 'busy') return;
	const slot = mirror.transcripts[link.peerId]?.[liveTurnKey(link.agentId, cut.tabId)];
	// A read that failed, or one already behind, cannot prove the turn died: never send twice.
	if (!slot?.loaded || slot.error || slot.stale || !cut.message) return;
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
	for (const [key, cut] of cutTurns) {
		if (cut.sessionId !== sessionId || cut.reading) continue;
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
	endedHere.clear();
}
