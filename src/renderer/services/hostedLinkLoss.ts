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

import {
	isSameUserEntry,
	turnFateAfter,
	userEntryFate,
	type TranscriptHostKind,
} from '../../shared/maestro-lib/agents/rules';
import { liveTurnKey } from '../../shared/maestro-lib/client/live-turn';
import {
	hostReportIsCurrent,
	type PeerMirrorConnection,
} from '../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import type { LogEntryRecord } from '../../shared/maestro-lib/store/transcript';
import { notifyToast } from '../stores/notificationStore';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import {
	getRetryEntry,
	retryNow,
	scheduleRetryForError,
	settleRetryOnHost,
} from '../stores/retryStore';
import { selectSessionById, updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { useSshOutageStore } from '../stores/sshOutageStore';
import type { AgentError, LogEntry, QueuedItem, Session } from '../types';
import { sameImages } from '../utils/hostedSession';
import { generateId } from '../utils/ids';
import { settleTabThinkingState } from '../utils/tabHelpers';
import { keepTurnForHost } from './hostedQueuedTurn';
import { MIRROR_TRANSCRIPT_TAIL, readMirrorTranscript, requestPeerReport } from './peerMirror';

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
	/**
	 * The host is connected, and the decision waits for its first report since the link was down
	 * (`hostReportIsCurrent()`): until then the mirror holds the report that drew this tab running,
	 * and a host that restarted can answer a transcript read before its snapshot lands.
	 */
	awaitingReport?: boolean;
	/** The user stopped this turn here while the host could not be told: never sent again. */
	stopped?: boolean;
	/** The message is kept for a resend under the auto-retry card, as this queue item. */
	keptItemId?: string;
	/** Resends waiting for the host to say how the turn ended (`cutTurnFate()`). */
	waiters?: ((fate: CutTurnFate) => void)[];
}

/**
 * How a cut turn's kept message goes on: `send` (the turn died with the host), `answered` (the
 * host still runs it or finished it: never sent again), `tab-gone` or `entry-gone` (the host no
 * longer has the tab, or the message after a clear: not sent there, and parked held for the user
 * to send again), `errored` (the turn ended on its own error there: retried by that error's own
 * rule, `routeErroredTurn()`, and the retry holds the message), or `unknown` (the host's transcript
 * could not be read: kept for the next try).
 */
export type CutTurnFate = 'send' | 'answered' | 'errored' | 'tab-gone' | 'entry-gone' | 'unknown';

/**
 * Kept messages whose turn ended on its own retryable error on the host, by `sessionId:tabId`: the
 * entry id. Their retry (`routeErroredTurn()`) sends them, into the same entry, without asking the
 * host's transcript again, which still ends on that error. Taken by the send it lets through.
 */
const erroredResends = new Map<string, string>();

/**
 * The error a host recorded for the turn of the user message at `at`: the error of its LAST failed
 * attempt (a retry runs into the same entry, and each end stamp closes one attempt, as
 * `turnFateAfter()` reads them; CodeRabbit on #2167), as its structured error when the host kept
 * one.
 */
function turnErrorAfter(
	sessionId: string,
	entries: readonly LogEntryRecord[],
	at: number
): AgentError | undefined {
	let latest: LogEntryRecord | undefined;
	let attempt: LogEntryRecord | undefined;
	for (let i = at + 1; i < entries.length; i += 1) {
		const entry = entries[i];
		if (entry.source === 'user' && entry.steered !== true) break;
		if (entry.source === 'error' && !attempt) attempt = entry;
		if (entry.turnEnded === true) {
			if (attempt) latest = attempt;
			attempt = undefined;
		}
	}
	const failed = attempt ?? latest;
	if (!failed) return undefined;
	if (failed.agentError) return failed.agentError as AgentError;
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	return {
		type: 'unknown',
		message: failed.text,
		recoverable: true,
		agentId: session?.toolType ?? 'claude-code',
		sessionId,
		timestamp: failed.timestamp,
	};
}

/**
 * A kept message whose turn ended on its own error on the host goes on as a local turn that ends
 * on that error does: `scheduleRetryForError()` decides by the error's own rule, holding the
 * message under its retry, and the retry sends it into the same entry. Answers whether a retry
 * took it; one that did not (not retryable, Agent Resilience off) leaves the error standing, drawn
 * from the host's transcript, and nothing is sent.
 */
function routeErroredTurn(
	sessionId: string,
	tabId: string,
	entryId: string,
	error: AgentError | undefined,
	itemId: string | undefined
): 'retried' | 'not-retried' | 'not-held' {
	// The tab's retry holds another message: this error must not reschedule that one. The copy
	// stays kept behind it and is decided again when its own turn comes (CodeRabbit on #2167).
	const waiting = getRetryEntry(sessionId, tabId);
	if (waiting && waiting.heldItemId !== itemId) return 'not-held';
	if (!error || !scheduleRetryForError(sessionId, tabId, error)) return 'not-retried';
	erroredResends.set(cutKey(sessionId, tabId), entryId);
	return 'retried';
}

/**
 * The fate of a message the host's tab does not hold (`at` is -1): past the tail this machine
 * read, it has a history after it (`answered`); in a tail that is the whole transcript, it is gone
 * from the tab (a clear, `entry-gone`).
 */
function missingEntryFate(entries: readonly unknown[]): 'answered' | 'entry-gone' {
	return entries.length >= MIRROR_TRANSCRIPT_TAIL ? 'answered' : 'entry-gone';
}

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

/**
 * The newest message the user sent in a tab that its host has: the one its running turn answers.
 * A kept message's bubble (`keptForHost`) never reached the host, so no turn there answers it.
 */
function lastUserMessage(logs: readonly LogEntry[] | undefined): LogEntry | undefined {
	for (let i = (logs?.length ?? 0) - 1; i >= 0; i -= 1) {
		if (logs![i].source === 'user' && !logs![i].keptForHost) return logs![i];
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
/**
 * Whether a cut turn of this tab still waits for the host to say how it ended. Its kept message
 * fires from that decision (`decideCutTurn()`), never ahead of it, when the host comes back.
 */
export function cutTurnUndecided(sessionId: string, tabId: string): boolean {
	return cutTurns.has(cutKey(sessionId, tabId));
}

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

/** Where a hosted record runs: the peer and the host's id for the agent. */
type HostAgentRef = Pick<HostLink, 'peerId' | 'agentId'>;

/**
 * Whether the mirror holds the host's report as it is now (`hostReportIsCurrent()`): a tab's state
 * and the agent list decide a cut turn's fate only then, never the report from before the link was
 * lost, which the mirror keeps through a disconnect and a window reload.
 */
function hostReportCurrent(peerId: string): boolean {
	const peer = usePeerMirrorStore.getState().peers[peerId];
	return !!peer && hostReportIsCurrent(peer);
}

/** How long after the link is back a decision waits for the host's report before asking for it. */
export const HOST_REPORT_REQUEST_MS = 3_000;

/** At most one ask per peer in this long, so a host that cannot answer is not asked in a loop. */
const HOST_REPORT_REQUEST_EVERY_MS = 30_000;

/** Per peer: the ask timer waiting to fire, and when the last ask went. */
const reportRequests = new Map<
	string,
	{ timer?: ReturnType<typeof setTimeout>; askedAt?: number }
>();

/**
 * A decision waits for the host's report since the link came back (`hostReportCurrent()`). One
 * normally lands at once (a restarted host's snapshot); a link that resumed without one sends
 * none, and the decision would wait for ever. So when none came within `HOST_REPORT_REQUEST_MS`,
 * ask the host for its agent list (`requestPeerReport()`), at most once per
 * `HOST_REPORT_REQUEST_EVERY_MS` per peer.
 */
function askForHostReport(peerId: string): void {
	if (hostReportCurrent(peerId)) return;
	const request = reportRequests.get(peerId) ?? {};
	if (request.timer) return;
	if (
		request.askedAt !== undefined &&
		Date.now() - request.askedAt < HOST_REPORT_REQUEST_EVERY_MS
	) {
		return;
	}
	request.timer = setTimeout(() => {
		request.timer = undefined;
		const peer = usePeerMirrorStore.getState().peers[peerId];
		if (!peer || peer.connection !== 'connected' || hostReportIsCurrent(peer)) return;
		request.askedAt = Date.now();
		void requestPeerReport(peerId);
	}, HOST_REPORT_REQUEST_MS);
	reportRequests.set(peerId, request);
}

/**
 * The kind of host `peerId` runs: how its transcript tells a turn that ended from one it lost with
 * no end stamp (`turnFateAfter()`). Not known yet: read as a headless host's, which never sends a
 * message again for text it already wrote.
 */
function transcriptHostKind(peerId: string): TranscriptHostKind {
	return usePeerMirrorStore.getState().peers[peerId]?.hostKind === 'desktop'
		? 'desktop'
		: 'headless';
}

/**
 * Wait, at most `timeoutMs`, for the host's report as it is now. False when none came: the caller
 * keeps the message for the next try, never deciding from the old report.
 */
function awaitCurrentHostReport(peerId: string, timeoutMs: number): Promise<boolean> {
	if (hostReportCurrent(peerId)) return Promise.resolve(true);
	return new Promise((resolve) => {
		const finish = (current: boolean) => {
			clearTimeout(timer);
			unsubscribe();
			resolve(current);
		};
		const unsubscribe = usePeerMirrorStore.subscribe((state) => {
			const peer = state.peers[peerId];
			if (peer && hostReportIsCurrent(peer)) finish(true);
		});
		const timer = setTimeout(() => finish(false), timeoutMs);
	});
}

/**
 * Whether the resend of `item` must wait for the host to say how the turn it repeats ended, and if
 * so, that answer. Null: send now (not the message of a turn the host already wrote down, or the
 * host is not connected, so the send is refused and the message stays kept).
 *
 * A cut still on record decides (edited while kept: the user's own message, sent as one). With no
 * cut on record for it (the app restarted since the cut, or the user stopped the cut and now sends
 * the parked copy), the host's transcript decides (`readKeptEntryFate()`), never memory alone.
 */
export function cutTurnFate(
	sessionId: string,
	item: Pick<QueuedItem, 'tabId' | 'hostEntryId' | 'text' | 'images'> & { id?: string },
	host: HostAgentRef,
	connected: boolean
): Promise<CutTurnFate> | null {
	if (!item.hostEntryId || !connected) return null;
	const key = cutKey(sessionId, item.tabId);
	// The retry of a turn that ended on its own error there (`routeErroredTurn()`): sent now.
	if (erroredResends.get(key) === item.hostEntryId) {
		erroredResends.delete(key);
		return null;
	}
	const cut = cutTurns.get(key);
	if (!cut || cut.stopped || cut.message?.id !== item.hostEntryId) {
		return readKeptEntryFate(sessionId, host, { ...item, hostEntryId: item.hostEntryId });
	}
	// Edited while it was kept: the user's own message now, sent as one whatever the turn did.
	if (!sameAsCut(item, cut)) return null;
	const fate = new Promise<CutTurnFate>((resolve) => {
		const timer = setTimeout(() => {
			cut.waiters = cut.waiters?.filter((waiter) => waiter !== answer);
			resolve('unknown');
		}, CUT_TURN_FATE_WAIT_MS);
		const answer = (decided: CutTurnFate) => {
			clearTimeout(timer);
			resolve(decided);
		};
		(cut.waiters ??= []).push(answer);
	});
	// The last read said nothing: this resend starts one read (one per try, never a loop), and
	// its answer decides the cut.
	if (cut.awaitingRead && !cut.reading) {
		cut.awaitingRead = false;
		cut.reading = true;
		void readMirrorTranscript(host.peerId, host.agentId, cut.tabId).then(() =>
			decideCutTurn(key, host)
		);
	}
	return fate;
}

/**
 * How a kept message the host already wrote down goes on, read from the host's tab (no cut on
 * record for it). Running there now with it as its message, or its own turn answered or stopped:
 * `answered`, never sent again. Ended on its own error: `errored`, retried by that error's rule
 * (`routeErroredTurn()`; `answered` when no retry takes it). Not ended and not running: `send`.
 * The tab closed there, or the message gone from it: `tab-gone` / `entry-gone`, never sent into
 * it. The tab could not be read: `unknown`, kept for the next try.
 */
async function readKeptEntryFate(
	sessionId: string,
	host: HostAgentRef,
	item: Pick<QueuedItem, 'tabId' | 'text' | 'images'> & { hostEntryId: string; id?: string }
): Promise<CutTurnFate> {
	// After a reload the mirror can say connected while it still holds the host's report from
	// before a crash (the tab busy, or no agents yet): decided only from a report since the link.
	askForHostReport(host.peerId);
	if (!(await awaitCurrentHostReport(host.peerId, CUT_TURN_FATE_WAIT_MS))) return 'unknown';
	await readMirrorTranscript(host.peerId, host.agentId, item.tabId);
	// The link may have dropped while the read was out: the tab state held now is from before.
	if (!hostReportCurrent(host.peerId)) return 'unknown';
	const mirror = usePeerMirrorStore.getState();
	const hostTab = mirror.peers[host.peerId]?.agents
		.find((agent) => agent.id === host.agentId)
		?.aiTabs?.find((tab) => tab.id === item.tabId);
	// Closed on the host: nothing there to send it to as that entry, and it may have run.
	if (!hostTab) return 'tab-gone';
	const slot = mirror.transcripts[host.peerId]?.[liveTurnKey(host.agentId, item.tabId)];
	if (!slot?.loaded || slot.loading || slot.error || slot.stale) return 'unknown';
	const entry = {
		id: item.hostEntryId,
		text: item.text ?? '',
		...(item.images?.length ? { images: item.images } : {}),
	};
	const at = slot.entries.findIndex((candidate) => candidate.id === entry.id);
	// Past the tail read (a history after it), or gone after a clear. Never sent twice.
	if (at === -1) return missingEntryFate(slot.entries);
	// Edited while it was kept: the user's own message now, sent as one (the host gives it an entry
	// of its own, since it no longer matches the one it names).
	if (!isSameUserEntry(slot.entries[at], entry)) return 'send';
	const fate = userEntryFate(slot.entries, entry, transcriptHostKind(host.peerId));
	if (fate === 'answered' || fate === 'stopped') return 'answered';
	const newestUser = lastUserMessage(slot.entries as LogEntry[]);
	if (hostTab.state === 'busy' && newestUser?.id === entry.id) return 'answered';
	if (fate === 'errored') {
		const error = turnErrorAfter(sessionId, slot.entries, at);
		const routed = routeErroredTurn(sessionId, item.tabId, entry.id, error, item.id);
		return routed === 'retried' ? 'errored' : routed === 'not-held' ? 'unknown' : 'answered';
	}
	return 'send';
}

/**
 * A kept cut message is not owed: the host had it. Its copy leaves the queue and nothing is sent,
 * whether its retry counts down or it waits behind another message's retry (that one is left
 * alone). A copy the user edited while it was kept is their own message now: it stays, no longer
 * named as the host's entry, and goes as one.
 *
 * `tab-gone` / `entry-gone`: the host no longer has the tab or the message. Nothing is sent
 * there, and the copy stays in the queue held, no longer named as the host's entry, so the user
 * can send it again; the card says which.
 */
function settleKeptCut(
	cut: CutTurn,
	fate: 'answered' | 'tab-gone' | 'entry-gone' = 'answered'
): void {
	answerWaiters(cut, fate);
	const keptId = cut.keptItemId;
	if (!keptId) return;
	if (fate !== 'answered') {
		if (getRetryEntry(cut.sessionId, cut.tabId)?.heldItemId === keptId) {
			settleRetryOnHost(cut.sessionId, cut.tabId, fate === 'tab-gone' ? 'tab' : 'message');
		}
		updateSessionWith(cut.sessionId, (session) => ({
			...session,
			executionQueue: (session.executionQueue ?? []).map((item) =>
				item.id === keptId ? { ...item, paused: true, hostEntryId: undefined } : item
			),
		}));
		return;
	}
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

/**
 * Decide one cut turn from the host's transcript, read after the host came back. A read that says
 * nothing conclusive keeps the cut for the next one.
 */
function decideCutTurn(key: string, link: HostAgentRef): void {
	const cut = cutTurns.get(key);
	if (!cut) return;
	cut.reading = false;
	const mirror = usePeerMirrorStore.getState();
	// Read now, not when the host came back. The mirror can say connected before the host's first
	// report since the cut lands (a host that restarted answers a read before its snapshot is in).
	const agent = mirror.peers[link.peerId]?.agents.find(
		(candidate) => candidate.id === link.agentId
	);
	const hostTab = agent?.aiTabs?.find((tab) => tab.id === cut.tabId);
	// Not yet the host's report since the link was down: a busy tab is the turn as it was before,
	// and a missing one may be a list not in yet. The decision waits for that report, which starts
	// one read (`settleCutHostedTurns()`).
	if (!hostReportCurrent(link.peerId)) {
		cut.awaitingReport = true;
		askForHostReport(link.peerId);
		return;
	}
	// Closed on the host: not sent into a tab that is gone, and held for the user to send again.
	if (!hostTab) {
		cutTurns.delete(key);
		settleKeptCut(cut, 'tab-gone');
		return;
	}
	// Still running there (it draws Thinking again), stopped by the user, or no message to send:
	// nothing to settle.
	if (
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
	const messageId = cut.message.id;
	const at = slot.entries.findIndex((entry) => entry.id === messageId);
	// Gone from the tab (a clear), or past the tail read: never sent twice.
	if (at === -1) {
		settleKeptCut(cut, missingEntryFate(slot.entries));
		return;
	}
	// Its own turn ended (stamped, or an answer before the next user message on a host too old to
	// stamp, `turnFateAfter()`); an answer to a LATER message is that one's, and this turn died. A
	// desktop host's streamed text with no end stamp is a turn it lost.
	const fate = turnFateAfter(slot.entries, at, transcriptHostKind(link.peerId));
	// Ended on its own error: retried by that error's rule, as a local turn that ends on it is.
	if (fate === 'errored') {
		const routed = routeErroredTurn(
			cut.sessionId,
			cut.tabId,
			messageId,
			turnErrorAfter(cut.sessionId, slot.entries, at),
			cut.keptItemId
		);
		if (routed !== 'not-retried') {
			// Retried: the retry holds the kept copy. Not held: it waits behind another message's
			// retry, decided from the host again when its own turn comes.
			answerWaiters(cut, routed === 'retried' ? 'errored' : 'unknown');
			return;
		}
	}
	if (fate !== 'unended') {
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
	const current = hostReportCurrent(link.peerId);
	// A stopped turn the host reports idle (or no longer lists) is over: its stop is settled. Only
	// the host's report since the link was down says so.
	for (const key of current ? [...stoppedTurns.keys()] : []) {
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
		if (!current) {
			// Still the report from before the cut: nothing to decide from, and no read started. A
			// report that does not come on its own is asked for (R39).
			cut.awaitingReport = true;
			askForHostReport(link.peerId);
			continue;
		}
		if (cut.awaitingReport) {
			cut.awaitingReport = false;
		} else if (cut.awaitingRead) {
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

/**
 * Forget every cut, stop, and link error of a record that no longer runs on a host this mirror
 * holds (`hostedIds`): the agent was deleted, moved back, or its peer removed. A resend still
 * waiting on such a cut is told `unknown`, which ends its wait timer and keeps its message. Nothing
 * here is needed to decide later: a kept copy is decided from the host's transcript by its entry
 * (`cutTurnFate()`), with no cut on record.
 */
export function pruneHostedLinkLoss(hostedIds: ReadonlySet<string>): void {
	const gone = (key: string) => ![...hostedIds].some((id) => key.startsWith(`${id}:`));
	for (const [key, cut] of cutTurns) {
		if (hostedIds.has(cut.sessionId)) continue;
		cutTurns.delete(key);
		answerWaiters(cut, 'unknown');
	}
	for (const key of [...stoppedTurns.keys()]) if (gone(key)) stoppedTurns.delete(key);
	for (const key of [...erroredResends.keys()]) if (gone(key)) erroredResends.delete(key);
	for (const id of [...linkErrors.keys()]) if (!hostedIds.has(id)) linkErrors.delete(id);
	for (const id of [...endedHere.keys()]) if (!hostedIds.has(id)) endedHere.delete(id);
	if (hostedIds.size === 0) {
		for (const request of reportRequests.values()) clearTimeout(request.timer);
		reportRequests.clear();
	}
}

/** Test-only: forget every cut turn and local stop. */
export function __resetHostedLinkLossForTests(): void {
	for (const cut of cutTurns.values()) cut.waiters = undefined;
	linkErrors.clear();
	cutTurns.clear();
	stoppedTurns.clear();
	erroredResends.clear();
	for (const request of reportRequests.values()) clearTimeout(request.timer);
	reportRequests.clear();
	endedHere.clear();
}
