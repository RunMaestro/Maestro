/**
 * Chat steering, renderer side: hand a queued message to the turn already running
 * on its tab (a Claude maestro-p turn, or a Codex turn on the app-server
 * transport), and keep that message safe until the transcript says what the agent
 * did with it.
 *
 * A steer is answered TWICE, on different clocks (see SteeringVerdict in
 * src/shared/chatSteering.ts). The socket reply says whether the text was typed
 * (`delivered` / `refused`); the transcript-observed outcome (`absorbed` /
 * `queued` / `dropped`) arrives later, forwarded as `process:steering-verdict`.
 * The card has to leave the queue before the text is typed, or the same message
 * sends again when the turn ends - so the item is parked on the agent's
 * `pendingSteers` from the moment the steer starts until the second answer lands,
 * and put back if the agent never took it.
 *
 * The parked record lives on the SESSION rather than in module state, so it is
 * persisted: a reload between the two answers must not lose the only copy of a
 * message the user wrote. `reconcilePendingSteers()` settles records whose process
 * is no longer running once a reload or restart has brought the store back.
 *
 * Module functions rather than hook members: the stdout listener and the exit
 * listener both run outside the click that started the steer.
 */

import type { LogEntry, PendingSteer, QueuedItem, Session } from '../types';
import type {
	QueueSteerResult,
	SteerBubbleState,
	SteeringResultFrame,
} from '../../shared/chatSteering';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { notifyToast } from '../stores/notificationStore';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { resolveQueuedItemTarget } from '../utils/tabHelpers';
import { generateId } from '../utils/ids';
import { describeSteerBlocked, getSteerEligibility } from '../utils/executionQueue';

/**
 * Steers whose socket answer has not come back yet, keyed `sessionId:itemId`. The
 * item is still in the queue while the answer is outstanding (up to the socket
 * timeout), so without this a second click - or the CLI racing a click - would
 * type the same text into the turn twice.
 */
const steersInFlight = new Set<string>();

/**
 * Verdicts that arrived before their steer's socket reply, keyed
 * `processKey:steerId`. The reply and the verdict travel on different channels, so
 * nothing orders them; a verdict that beats the reply finds no parked record with
 * its id yet. Kept only while a steer on that process is still waiting.
 */
const earlyVerdicts = new Map<string, SteeringResultFrame>();
/** How many steers per process key are still waiting on their socket reply. */
const awaitingReply = new Map<string, number>();

/** Test seam: in-flight bookkeeping is module state. */
export function resetPendingSteersForTests(): void {
	steersInFlight.clear();
	earlyVerdicts.clear();
	awaitingReply.clear();
}

function noteAwaitingReply(processKey: string, delta: 1 | -1): void {
	const next = (awaitingReply.get(processKey) ?? 0) + delta;
	if (next > 0) {
		awaitingReply.set(processKey, next);
		return;
	}
	awaitingReply.delete(processKey);
	for (const key of earlyVerdicts.keys()) {
		if (key.startsWith(`${processKey}:`)) earlyVerdicts.delete(key);
	}
}

/** A placeholder steer id for a record parked before the socket has named it. */
function provisionalSteerId(): string {
	return `provisional:${generateId()}`;
}

function allPendingSteers(): Array<{ sessionId: string; pending: PendingSteer }> {
	return useSessionStore
		.getState()
		.sessions.flatMap((s) =>
			(s.pendingSteers ?? []).map((pending) => ({ sessionId: s.id, pending }))
		);
}

/** Test seam: how many delivered steers are still unsettled, across every agent. */
export function pendingSteerCount(): number {
	return allPendingSteers().length;
}

/** What the toasts call the agent: the provider, since it is the provider that takes the message. */
function agentLabel(session: Pick<Session, 'toolType'> | undefined): string {
	return session ? getAgentDisplayName(session.toolType) : 'The agent';
}

function labelFor(sessionId: string): string {
	return agentLabel(useSessionStore.getState().sessions.find((s) => s.id === sessionId));
}

/** Apply `fn` to the logs of the tab `tabId`, live or orphaned (closed mid-turn). */
function mapTabLogs(
	session: Session,
	tabId: string,
	fn: (logs: LogEntry[]) => LogEntry[]
): Session {
	const mapTabs = <T extends { id: string; logs: LogEntry[] }>(
		tabs: T[] | undefined
	): T[] | undefined => tabs?.map((t) => (t.id === tabId ? { ...t, logs: fn(t.logs) } : t));
	return {
		...session,
		aiTabs: mapTabs(session.aiTabs) ?? session.aiTabs,
		...(session.orphanedThinkingTabs && {
			orphanedThinkingTabs: mapTabs(session.orphanedThinkingTabs),
		}),
	};
}

/**
 * The user bubble for a steered message. A dispatched queue item gets one from
 * markTabRunningQueuedItem; a steered one never dispatches, so without this the
 * message would vanish from both the queue and the transcript while the agent
 * answers it.
 */
function steeredLogEntry(item: QueuedItem): LogEntry {
	return {
		id: generateId(),
		timestamp: Date.now(),
		source: 'user',
		text: item.text ?? '',
		queuedItemId: item.id,
		// Marks the bubble as a steer (see SteeredMessageHeader). It leaves with the
		// bubble if the item returns to the queue, so only a message the agent
		// actually has keeps the mark.
		steered: true,
		// Typed, not yet answered. settlePendingSteers() stamps what the agent did.
		steerState: 'pending',
		...(item.readOnlyMode && { readOnly: true }),
	};
}

/**
 * Put parked steers back at the HEAD of the queue and take their user bubbles
 * back out. The head because the user asked for them sooner than anything behind
 * them; the bubble because the item will append its own when it dispatches, and
 * leaving this one would show the message twice. Pure, so session restoration can
 * use it too.
 */
export function returnPendingSteersToQueue(
	session: Session,
	steerIds: ReadonlySet<string>,
	paused: boolean
): Session {
	const leaving = (session.pendingSteers ?? []).filter((p) => steerIds.has(p.steerId));
	if (leaving.length === 0) return session;
	let next: Session = {
		...session,
		pendingSteers: (session.pendingSteers ?? []).filter((p) => !steerIds.has(p.steerId)),
	};
	const restored: QueuedItem[] = [];
	for (const p of leaving) {
		if (p.logEntryId) {
			next = mapTabLogs(next, p.tabId, (logs) => logs.filter((l) => l.id !== p.logEntryId));
		}
		if (!next.executionQueue.some((i) => i.id === p.item.id)) {
			restored.push({ ...p.item, paused: paused || undefined });
		}
	}
	return { ...next, executionQueue: [...restored, ...next.executionQueue] };
}

/**
 * Close parked steers the agent took: drop their records and stamp each bubble
 * with what the agent did with the message, so the transcript keeps saying it
 * after the toast is gone. The counterpart of returnPendingSteersToQueue, which
 * closes the steers the agent did NOT take.
 */
export function settlePendingSteers(
	session: Session,
	steerIds: ReadonlySet<string>,
	state: Exclude<SteerBubbleState, 'pending'>
): Session {
	const settling = (session.pendingSteers ?? []).filter((p) => steerIds.has(p.steerId));
	if (settling.length === 0) return session;
	let next: Session = {
		...session,
		pendingSteers: (session.pendingSteers ?? []).filter((p) => !steerIds.has(p.steerId)),
	};
	for (const p of settling) {
		if (!p.logEntryId) continue;
		next = mapTabLogs(next, p.tabId, (logs) =>
			logs.map((l) => (l.id === p.logEntryId ? { ...l, steerState: state } : l))
		);
	}
	return next;
}

function notifyUnconfirmed(sessionId: string, tabId: string): void {
	notifyToast({
		color: 'orange',
		title: 'Steering result unconfirmed',
		message: `${labelFor(sessionId)} may or may not have received the message, so it has been paused rather than sent twice. Resume it if the agent never answered it.`,
		dismissible: true,
		sessionId,
		tabId,
	});
}

/**
 * Steer one queued message into the turn running on its tab. Never loses the
 * message and never sends it twice: it leaves the queue before it is typed, and
 * comes back if the socket refuses it or the transcript shows the agent never
 * took it.
 *
 * The one implementation behind both the Steer button and `maestro-cli queue
 * steer`, so it reports what it did rather than leaving the caller to infer it
 * from the queue.
 */
export async function steerQueuedItem(
	sessionId: string,
	itemId: string
): Promise<QueueSteerResult> {
	// Checked first: while a steer waits, its item is parked off the queue, so the
	// lookup below would call it not-found.
	const flightKey = `${sessionId}:${itemId}`;
	if (steersInFlight.has(flightKey)) {
		return {
			outcome: 'not-steerable',
			blockedReason: 'steer-in-flight',
			detail: 'a steer for this message is already waiting for an answer',
		};
	}

	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const item = session?.executionQueue?.find((i) => i.id === itemId);
	if (!session || !item) {
		return { outcome: 'not-found', detail: `no queued item ${itemId} for agent ${sessionId}` };
	}

	const steer = window.maestro?.process?.steer;
	if (!steer) {
		// Web renderer, or a build without the bridge. Say so rather than leaving
		// the click silent.
		notifyToast({
			color: 'yellow',
			title: 'Steering unavailable',
			message: 'This client cannot steer a running turn.',
		});
		return { outcome: 'unavailable', detail: 'this client cannot steer a running turn' };
	}

	// Guarded by getSteerEligibility before the button renders; re-checked against
	// the LIVE item because the card can be stale by the click (a consult hold
	// landed, the turn ended), and this is reachable from surfaces that never
	// asked. Re-checking with the same predicate keeps the two from disagreeing.
	const eligibility = getSteerEligibility(session, item);
	const target = resolveQueuedItemTarget(session, item);
	const text = item.text?.trim();
	if (!eligibility.canSteer || !target || !text) {
		return {
			outcome: 'not-steerable',
			blockedReason: eligibility.blockedReason ?? 'no-target-tab',
			detail: 'the message stays queued and sends when the current turn ends',
		};
	}
	const processKey = `${sessionId}-ai-${target.tabId}`;
	const name = agentLabel(session);

	// Take the item out of the queue BEFORE typing it. While the socket answer is
	// outstanding the turn can end, and a queue drain that still saw the item would
	// dispatch it as a new turn on top of the text already typed into the old one.
	// Parked with a provisional id: an exit during the wait finds it by process key
	// and puts it back paused, and every answer below either names it or returns it.
	const provisionalId = provisionalSteerId();
	const logEntry = steeredLogEntry(item);
	let parked = false;
	updateSessionWith(sessionId, (s) => {
		if (!s.executionQueue.some((i) => i.id === itemId)) return s;
		parked = true;
		const record: PendingSteer = {
			steerId: provisionalId,
			processKey,
			tabId: target.tabId,
			item,
			logEntryId: logEntry.id,
		};
		return {
			...mapTabLogs(s, target.tabId, (logs) => [...logs, logEntry]),
			executionQueue: s.executionQueue.filter((i) => i.id !== itemId),
			pendingSteers: [...(s.pendingSteers ?? []), record],
		};
	});
	if (!parked) {
		return { outcome: 'not-found', detail: `no queued item ${itemId} for agent ${sessionId}` };
	}

	let result: SteeringResultFrame;
	steersInFlight.add(flightKey);
	noteAwaitingReply(processKey, 1);
	try {
		result = await steer(processKey, text);
	} catch (error) {
		// The bridge itself failed. Main may or may not have typed the text before it
		// did, which is exactly the `unknown` case below.
		result = {
			type: 'steering',
			id: '',
			verdict: 'unknown',
			detail: error instanceof Error ? error.message : String(error),
		};
	} finally {
		steersInFlight.delete(flightKey);
	}

	// The record is gone when the process exited during the wait: the exit put the
	// item back paused, which already settled it.
	const stillParked = () =>
		(useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.pendingSteers ?? []).some(
			(p) => p.steerId === provisionalId
		);
	const provisional = new Set([provisionalId]);

	try {
		if (result.verdict === 'delivered') {
			// The agent has the text. Name the record with the socket's id so the
			// transcript verdict can settle it.
			if (!stillParked()) return { outcome: 'delivered', verdict: result.verdict };
			const steerId = result.id;
			updateSessionWith(sessionId, (s) => ({
				...s,
				pendingSteers: (s.pendingSteers ?? []).map((p) =>
					p.steerId === provisionalId ? { ...p, steerId } : p
				),
			}));
			notifyToast({
				color: 'green',
				title: 'Sent to the running turn',
				message: `${name} has your message. If it never takes it, it goes back in the queue.`,
				sessionId,
				tabId: target.tabId,
			});
			const early = earlyVerdicts.get(`${processKey}:${steerId}`);
			if (early) {
				earlyVerdicts.delete(`${processKey}:${steerId}`);
				applySteeringVerdict(processKey, early);
			}
			return { outcome: 'delivered', verdict: result.verdict };
		}

		if (result.verdict === 'absorbed' || result.verdict === 'queued') {
			// Already settled; nothing left to wait for. The bubble stays.
			const settled = result.verdict;
			updateSessionWith(sessionId, (s) => settlePendingSteers(s, provisional, settled));
			return { outcome: 'settled', verdict: result.verdict };
		}

		// Refused: nothing was typed, so the message is still ours. Back at the head
		// of the queue, live, and it sends normally when the turn ends.
		if (result.verdict === 'refused') {
			updateSessionWith(sessionId, (s) => returnPendingSteersToQueue(s, provisional, false));
			notifyToast({
				color: 'yellow',
				title: 'Could not steer this turn',
				message: `${result.detail ?? `${name} could not take the message right now.`} It stays queued.`,
				sessionId,
				tabId: target.tabId,
			});
			return {
				outcome: 'refused',
				verdict: result.verdict,
				refusal: result.refusal,
				detail: result.detail,
			};
		}

		// Unknown (or a `dropped` on the socket): the text MAY have been typed and we
		// never got confirmation. Dropping the item can lose a message the user wrote,
		// and leaving it queued sends it a second time without asking. So PAUSE it:
		// kept, nothing sends behind the user's back, and the card's own play button is
		// the one-click resolution.
		if (stillParked()) {
			updateSessionWith(sessionId, (s) => returnPendingSteersToQueue(s, provisional, true));
			notifyUnconfirmed(sessionId, target.tabId);
		}
		return { outcome: 'unconfirmed', verdict: result.verdict, detail: result.detail };
	} finally {
		noteAwaitingReply(processKey, -1);
	}
}

/**
 * Window event that runs Steer Running Turn. The composer owns the behavior (it
 * holds the draft and `processInput`, see `runSteerSend` in useInputKeyDown), so
 * the window keyboard handler and the command palette ask for it by name rather
 * than each deciding what an empty draft means.
 */
export const STEER_SEND_EVENT = 'maestro:steerSend';

/** Ask the composer to run Steer Running Turn on the active tab. */
export function requestSteerSend(): void {
	window.dispatchEvent(new CustomEvent(STEER_SEND_EVENT));
}

/**
 * Say why a steer nobody clicked a button for did nothing. The Steer button is
 * hidden or dimmed with its reason as a tooltip, so it never needs this; a chord
 * has no control to hide and would otherwise look dead.
 */
function notifySteerBlocked(sessionId: string, tabId: string | undefined, reason?: string): void {
	// A message with a steer already in flight is parked, not queued.
	const stays = reason === 'steer-in-flight' ? '' : ' The message stays queued.';
	notifyToast({
		color: 'yellow',
		title: 'Could not steer this turn',
		message: `${describeSteerBlocked(reason)}${stays}`,
		sessionId,
		tabId,
	});
}

/**
 * {@link steerQueuedItem} for a caller with no Steer button in front of it: the
 * same steer, plus the reason when the message cannot be steered.
 */
export async function steerQueuedItemOrExplain(
	sessionId: string,
	itemId: string
): Promise<QueueSteerResult> {
	const tabId = useSessionStore
		.getState()
		.sessions.find((s) => s.id === sessionId)
		?.executionQueue?.find((i) => i.id === itemId)?.tabId;
	const result = await steerQueuedItem(sessionId, itemId);
	if (result.outcome === 'not-steerable') {
		notifySteerBlocked(sessionId, tabId, result.blockedReason);
	}
	return result;
}

/**
 * Steer the newest steerable message queued on `tabId`: what Steer Running Turn
 * does on an empty draft, and the keyboard equivalent of clicking that card's
 * Steer button. Newest first, like the Force Send chord, because the message the
 * user just queued is the one they are reaching for.
 *
 * Commands are skipped for the same reason the card offers them no Steer button:
 * a slash command is a prompt template Maestro expands, not text to type.
 */
export async function steerNewestQueuedMessage(
	sessionId: string,
	tabId: string
): Promise<QueueSteerResult> {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const queued = (session?.executionQueue ?? []).filter(
		(item) => item.tabId === tabId && item.type !== 'command'
	);
	if (!session || queued.length === 0) {
		notifyCenterFlash({ message: 'Nothing queued to steer on this tab', color: 'yellow' });
		return { outcome: 'not-found', detail: `no queued message on tab ${tabId}` };
	}
	const steerable = [...queued]
		.reverse()
		.find((item) => getSteerEligibility(session, item).canSteer);
	if (steerable) return steerQueuedItemOrExplain(sessionId, steerable.id);

	// Nothing here can be steered. Report the newest message's reason: it is the
	// one the chord would have picked.
	const blockedReason = getSteerEligibility(session, queued[queued.length - 1]).blockedReason;
	notifySteerBlocked(sessionId, tabId, blockedReason);
	return {
		outcome: 'not-steerable',
		blockedReason,
		detail: 'the message stays queued and sends when the current turn ends',
	};
}

/**
 * Settle a delivered steer from its transcript verdict. A verdict for a steer
 * that is not parked on any agent (another window's, a refusal already handled,
 * a repeat) is ignored: only the record proves the item left the queue.
 */
export function applySteeringVerdict(processKey: string, verdict: SteeringResultFrame): void {
	const found = allPendingSteers().find(
		({ pending }) => pending.steerId === verdict.id && pending.processKey === processKey
	);
	if (!found) {
		// Possibly ahead of its own socket reply; held until that reply names the record.
		if (awaitingReply.has(processKey) && verdict.id) {
			earlyVerdicts.set(`${processKey}:${verdict.id}`, verdict);
		}
		return;
	}
	const { sessionId, pending } = found;
	const ids = new Set([pending.steerId]);
	const name = labelFor(sessionId);

	switch (verdict.verdict) {
		case 'absorbed':
			// The running turn changed course. The success toast already went out.
			updateSessionWith(sessionId, (s) => settlePendingSteers(s, ids, 'absorbed'));
			return;
		case 'queued':
			updateSessionWith(sessionId, (s) => settlePendingSteers(s, ids, 'queued'));
			notifyToast({
				color: 'theme',
				title: 'Steer runs after this turn',
				message: `${name} could not fold it into the running turn, so it answers it as a follow-up.`,
				sessionId,
				tabId: pending.tabId,
			});
			return;
		case 'dropped':
			// The agent never took it and the run is over. Put it back, live: the
			// turn has ended, so the queue sends it normally - which is the re-send
			// the verdict asks the caller for.
			updateSessionWith(sessionId, (s) => returnPendingSteersToQueue(s, ids, false));
			notifyToast({
				color: 'yellow',
				title: 'Steer returned to the queue',
				message: `The turn ended before ${name} took your message, so it will send next.`,
				sessionId,
				tabId: pending.tabId,
			});
			return;
		default:
			// `delivered` repeated on stdout carries no new information; `refused` /
			// `unknown` never follow a delivery.
			return;
	}
}

/**
 * The process behind `processKey` exited. Both transports report every unsettled
 * steer as `dropped` before the exit, so anything still parked means that report
 * never arrived (a crash, a kill). Nobody knows whether the agent answered it, so
 * it comes back PAUSED - kept, never sent twice without asking.
 */
export function settlePendingSteersOnExit(processKey: string): void {
	const bySession = new Map<string, PendingSteer[]>();
	for (const { sessionId, pending } of allPendingSteers()) {
		if (pending.processKey !== processKey) continue;
		bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), pending]);
	}
	for (const [sessionId, parked] of bySession) {
		const ids = new Set(parked.map((p) => p.steerId));
		updateSessionWith(sessionId, (s) => returnPendingSteersToQueue(s, ids, true));
		for (const p of parked) notifyUnconfirmed(sessionId, p.tabId);
	}
}

/**
 * Settle every parked steer whose process is no longer running. Run once the
 * store has been loaded: a reload or restart can swallow the verdict or the exit
 * a record was waiting for, and a record with nothing left to answer it would
 * hold its message out of the queue forever. A process that is still running
 * (main outlived a web-desktop reload) keeps its records; its verdict or exit
 * settles them normally.
 */
export async function reconcilePendingSteers(
	isOwned: (processKey: string) => boolean = () => true
): Promise<void> {
	const keys = new Set(
		allPendingSteers()
			.map(({ pending }) => pending.processKey)
			.filter(isOwned)
	);
	if (keys.size === 0) return;
	const getActive = window.maestro?.process?.getActiveProcesses;
	if (!getActive) return;
	let active: Awaited<ReturnType<typeof getActive>>;
	try {
		active = await getActive();
	} catch {
		// Cannot tell what is running; leaving the records parked is the safe
		// answer, since an exit or verdict can still settle them.
		return;
	}
	const running = new Set(active.map((p) => p.sessionId));
	for (const key of keys) {
		if (!running.has(key)) settlePendingSteersOnExit(key);
	}
}
