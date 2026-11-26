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

import type { TurnSendReceipt } from '../../shared/maestro-lib/client/types';
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
	const entry: LogEntry = {
		id: generateId(),
		timestamp: Date.now(),
		source: 'system',
		text:
			kind === 'handoff'
				? `Nothing was handed off to ${names}: ${why}`
				: `Nothing was asked of ${names}: ${why}`,
	};
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
	boundary?: { afterEntryId: string | undefined }
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
					...(receipt.status === 'queued' ? { queueItemId: receipt.itemId } : {}),
					...(afterEntryId ? { afterEntryId } : {}),
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
 * The one turn a hosted hand-off waits on: from the first user message the host wrote after the
 * send boundary up to the next one. A later turn that ended before the same sync is not its turn,
 * and the end of a turn that was still running at the send (before that message) is not either.
 * Empty until the host wrote the turn's message.
 */
function ownTurnEntries(logs: LogEntry[], afterEntryId: string | undefined): LogEntry[] {
	const after = entriesAfter(logs, afterEntryId);
	const start = after.findIndex((entry) => entry.source === 'user');
	if (start === -1) return [];
	const next = after.findIndex((entry, index) => index > start && entry.source === 'user');
	return after.slice(start, next === -1 ? undefined : next);
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
 * its starts (`hostStarts`), else inferred from the tab's state with the turn ahead recorded once
 * (`seen-queued`), and a turn that left the queue (`left-queue`) dropped unless its tab reads busy
 * with it within `HOST_QUEUE_START_GRACE_MS`.
 */
export function hostedHandoffStep(
	tab: Pick<AITab, 'state' | 'pendingMentionHandoff' | 'logs' | 'thinkingStartTime'>,
	hostQueueItemIds: ReadonlySet<string>,
	transcriptCurrent = false,
	hostStarts?: readonly string[],
	now = Date.now()
): 'wait' | 'running' | 'read' | 'release' | 'drop' | 'seen-queued' | 'left-queue' {
	const hostTurn = tab.pendingMentionHandoff?.hostTurn;
	if (!hostTurn) return 'wait';
	const queued = hostTurn.stage === 'sent' ? hostTurn.queueItemId : undefined;
	// The host said this item started: the turn runs (or ran) now.
	if (queued && hostStarts?.includes(queued)) return 'running';
	if (hostTurn.queueItemId && hostQueueItemIds.has(hostTurn.queueItemId)) {
		// The turn ahead is what the tab runs when it is first seen waiting, never overwritten.
		return hostTurn.seenQueued ? 'wait' : 'seen-queued';
	}
	if (queued) {
		// Named starts: gone unnamed after it was seen waiting, it was taken out of the queue.
		if (hostStarts) return hostTurn.seenQueued ? 'drop' : 'wait';
		// Inferred: it runs once the tab is busy with a turn that started at another time, soon
		// after it left the queue. Later than that it was removed: nothing it never ran is handed off.
		const goneFor = hostTurn.goneAt === undefined ? 0 : now - hostTurn.goneAt;
		if (goneFor > HOST_QUEUE_START_GRACE_MS) return 'drop';
		if (tab.state === 'busy' && tab.thinkingStartTime !== hostTurn.turnStartedAt) return 'running';
		if (!hostTurn.seenQueued) return 'wait';
		return hostTurn.goneAt === undefined ? 'left-queue' : 'wait';
	}
	if (tab.state === 'busy') return hostTurn.stage === 'sent' ? 'running' : 'wait';
	if (tab.logs.some((entry) => entry.hostLive)) return 'read';
	if (collectHandoffTurn(ownTurnEntries(tab.logs, hostTurn.afterEntryId))) return 'release';
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
	afterEntryId: string | undefined
): HandoffTurn | null {
	const fromSend = collectHandoffTurn(ownTurnEntries(logs, afterEntryId));
	if (!fromSend) return null;
	return { answer: fromSend.answer, priorLogs: collectHandoffTurn(logs)?.priorLogs ?? [] };
}

/** Release a hosted tab's armed hand-off now, with the answer its turn left after the send. */
export function releaseHostedHandoff(sessionId: string, tab: AITab): void {
	const hostTurn = tab.pendingMentionHandoff?.hostTurn;
	void releaseMentionHandoff(sessionId, tab.id, {
		failed: !!tab.agentError,
		turn: hostedHandoffTurn(tab.logs, hostTurn?.afterEntryId),
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
	transcript: {
		/** Ask for the tab's saved transcript (once; a failed read waits for a new trigger). */
		read: (tabId: string) => void;
		/** The tab's saved transcript is loaded and nothing marked it stale since. */
		isCurrent: (tabId: string) => boolean;
	} = { read: () => {}, isCurrent: () => false },
	/** The host queue items that last started, when the host names its starts. */
	hostStarts?: readonly string[],
	now = Date.now()
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
			hostStarts,
			now
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
									turnStartedAt: current.state === 'busy' ? current.thinkingStartTime : undefined,
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
