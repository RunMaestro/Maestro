/**
 * The History toasts, the same in every agent mode: the "History Entry Added" toast a `/history`
 * raises, and the "Synopsis" toast a finished turn raises once its History entry is saved.
 *
 * The "History Entry Added" toast a `/history` raises, the same in every agent mode.
 *
 * A local or SSH agent's `/history` raises it when its handler saves the entry
 * (`useWizardHandlers`). A hosted agent's `/history` runs on its host, which saves the entry and
 * writes the "Synopsis saved to history" line there; a headless host has no screen to raise a
 * toast on, and a desktop host raises it on its own. So the window that sent it watches the tab's
 * mirrored transcript for that line (`watchHostedHistoryCommand()`) and raises the same toast.
 */

import { liveTurnKey } from '../../shared/maestro-lib/client/live-turn';
import {
	MIRROR_HISTORY_PUSH_MERGE_MS,
	queueExitOf,
} from '../../shared/maestro-lib/client/peer-mirror';
import type { LogEntryRecord } from '../../shared/maestro-lib/store/transcript';
import { readHistoryCommandOutcome } from '../../shared/maestroBuiltinCommandText';
import { notifyToast } from '../stores/notificationStore';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { selectSessionById, useSessionStore } from '../stores/sessionStore';
import type { HistoryEntry, Session } from '../types';
import { readMirrorTranscript } from './peerMirror';

/** How long a window waits for a hosted `/history` to finish before it stops watching. */
export const HOSTED_HISTORY_WATCH_MS = 10 * 60 * 1000;

/** The group a History toast names: the agent's, a worktree child's parent's, else Ungrouped. */
function historyToastGroupName(session: Pick<Session, 'groupId' | 'parentSessionId'>): string {
	const state = useSessionStore.getState();
	const groupId =
		session.groupId ||
		(session.parentSessionId
			? selectSessionById(session.parentSessionId)(state)?.groupId
			: undefined);
	const group = groupId ? state.groups.find((candidate) => candidate.id === groupId) : null;
	return group?.name || 'Ungrouped';
}

/** Raise the toast a saved `/history` entry raises, for the agent's tab. */
export function notifyHistoryEntryAdded(
	session: Pick<Session, 'id' | 'name' | 'groupId' | 'parentSessionId'>,
	tab: { id: string; name?: string | null },
	summary: string
): void {
	notifyToast({
		type: 'success',
		title: 'History Entry Added',
		message: summary,
		group: historyToastGroupName(session),
		project: session.name,
		sessionId: session.id,
		tabId: tab.id,
		tabName: tab.name || undefined,
	});
}

/**
 * The ids of the entries a mirrored tab holds before a `/history` is sent: every earlier run's
 * lines, which the watch must not take for this one. This window's copy serves when it is current;
 * a copy never read, or marked stale, is read from the host first. Undefined when that read fails.
 */
export async function hostedTranscriptBaseline(
	peerId: string,
	agentId: string,
	tabId: string
): Promise<ReadonlySet<string> | undefined> {
	const slotOf = () =>
		usePeerMirrorStore.getState().transcripts[peerId]?.[liveTurnKey(agentId, tabId)];
	let slot = slotOf();
	if (!slot?.loaded || slot.stale || slot.loading) {
		await readMirrorTranscript(peerId, agentId, tabId);
		slot = slotOf();
	}
	if (!slot?.loaded || slot.stale || slot.error) return undefined;
	return new Set(slot.entries.map((entry) => entry.id));
}

/**
 * After a host ran `/history` for a hosted agent's tab, raise the local toast once the host's line
 * says the entry was saved. Lines in `baseline` (the tab's entries read before the send) are older
 * runs, so only a line outside it is this run's. A caller with no baseline (the read before the
 * send failed) does not watch: an earlier run's line could not be told from this one's, and no
 * toast is better than a wrong one. A line that ends the run any other way (nothing to report,
 * failed, error) ends the watch with no toast, as a local run raises none. Returns a function that
 * stops watching.
 */
export function watchHostedHistoryCommand(
	sessionId: string,
	target: { peerId: string; agentId: string },
	tabId: string,
	opts: { baseline: ReadonlySet<string>; timeoutMs?: number }
): () => void {
	const key = liveTurnKey(target.agentId, tabId);
	const slotOf = () => usePeerMirrorStore.getState().transcripts[target.peerId]?.[key];
	const isNew = (entry: LogEntryRecord): boolean => !opts.baseline.has(entry.id);

	let done = false;
	let unsubscribe: () => void = () => {};
	const stop = () => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		unsubscribe();
	};
	const timer = setTimeout(stop, opts.timeoutMs ?? HOSTED_HISTORY_WATCH_MS);

	// The store changes on every push of every peer; only a change to this tab's slot is news.
	let seen: ReturnType<typeof slotOf>;
	const check = () => {
		if (done) return;
		const slot = slotOf();
		if (slot && slot === seen) return;
		seen = slot;
		// A tab that is not shown is not read on its stale mark: this watch reads it.
		if (!slot || (slot.stale && !slot.loading)) {
			if (!slot?.loading) void readMirrorTranscript(target.peerId, target.agentId, tabId);
			// The read marks the slot loading at once, which runs this check again inside it: a stale
			// slot can already hold the saved line, and that inner run raised the one toast (M22).
			if (!slot || done) return;
		}
		for (const entry of slot.entries) {
			if (entry.source !== 'system' || typeof entry.text !== 'string' || !isNew(entry)) continue;
			const outcome = readHistoryCommandOutcome(entry.text);
			if (!outcome) continue;
			stop();
			if (outcome.kind !== 'saved') return;
			const session = selectSessionById(sessionId)(useSessionStore.getState());
			if (!session) return;
			const tab = session.aiTabs.find((candidate) => candidate.id === tabId);
			notifyHistoryEntryAdded(session, { id: tabId, name: tab?.name }, outcome.summary);
			return;
		}
	};
	unsubscribe = usePeerMirrorStore.subscribe(check);
	check();
	return stop;
}

/** What the "Synopsis" toast names. */
export interface SynopsisToast {
	summary: string;
	group: string;
	project: string;
	/** How long the synopsis took ("Completed in"). */
	taskDuration: number;
	sessionId: string;
	tabId?: string;
	tabName?: string;
}

/**
 * Raise the toast a finished turn raises once its History synopsis is saved (`runExitSynopsis()`
 * for a local or SSH agent, `watchHostedTurnSynopsis()` for a hosted one): one toast, the same
 * words and the same click target in every mode. The toast settings switch it off as any toast.
 */
export function notifySynopsisSaved(toast: SynopsisToast): void {
	notifyToast({
		type: 'info',
		title: 'Synopsis',
		message: toast.summary,
		group: toast.group,
		project: toast.project,
		taskDuration: toast.taskDuration,
		sessionId: toast.sessionId,
		tabId: toast.tabId,
		tabName: toast.tabName,
		skipCustomNotification: true,
	});
}

/** How often a watch looks at the tab, and reads the host's History in the first seconds idle. */
export const HOSTED_SYNOPSIS_POLL_MS = 1000;
/** A synopsis that takes longer is read for less often: one read per this many ms. */
export const HOSTED_SYNOPSIS_SLOW_POLL_MS = 5000;
/** How long after the turn ended the watch reads every `HOSTED_SYNOPSIS_POLL_MS`. */
const HOSTED_SYNOPSIS_FAST_MS = 10 * 1000;
/** How long after the turn ended a watch waits for its History entry (its synopsis runs then). */
export const HOSTED_SYNOPSIS_IDLE_MS = 60 * 1000;
/** The longest a watch lives, turn included: a turn that runs longer raises no toast. */
export const HOSTED_SYNOPSIS_WATCH_MS = 60 * 60 * 1000;
/**
 * How long after it finds the entry a watch waits for the host's own `agent.history` push before
 * it refreshes an open History panel itself: the mirror holds that push up to
 * `MIRROR_HISTORY_PUSH_MERGE_MS`, then it crosses IPC. A host that announced meanwhile is not
 * refreshed twice.
 */
export const HOSTED_HISTORY_ANNOUNCE_GRACE_MS = MIRROR_HISTORY_PUSH_MERGE_MS * 4;
/** How many of the host's newest USER entries a watch reads. */
const HOSTED_SYNOPSIS_PAGE = 20;

/** Entries a watch already raised the toast for: one turn's entry is one toast. */
const toastedSynopsisEntries = new Set<string>();
/** The live watches, so one that raised the toast ends the others it covers. */
const synopsisWatches = new Set<{
	key: string;
	covers(entry: HistoryEntry): boolean;
	stop(): void;
}>();

/** Test only: forget the watches and the entries already raised. */
export function resetHostedSynopsisWatchesForTest(): void {
	for (const watch of [...synopsisWatches]) watch.stop();
	toastedSynopsisEntries.clear();
}

/**
 * After this window sent a hosted tab a turn that saves to History, raise the "Synopsis" toast
 * once the host saved that turn's entry, as the local exit synopsis raises it here
 * (`notifySynopsisSaved()`). The host writes the entry from its own synopsis turn after the turn
 * ends; a headless host has no screen to raise the toast on, and a desktop host raises it on its
 * own. So the window that sent the turn reads the host's History while the tab runs no turn, and
 * takes the first USER entry it did not hold when it began (`baseline`, read at once: the turn
 * cannot have been summarized yet), saved after the turn started (host clock), for the tab's
 * provider session. A turn another client sent raises nothing here, as no exit synopsis of a local
 * agent runs for it here either. A host that skips the synopsis (a message waits on the tab, the
 * turn did no work) writes no entry, and the watch ends quietly when its time runs out.
 *
 * Returns a function that stops watching.
 */
export function watchHostedTurnSynopsis(
	sessionId: string,
	target: { peerId: string; agentId: string },
	tabId: string,
	opts: {
		/**
		 * The host's queue item that stands for the turn (a `queued` receipt): the watch waits for it
		 * to start. Absent (a `started` receipt): the turn the tab runs now is this one.
		 */
		queuedItemId?: string;
		pollMs?: number;
		idleMs?: number;
		maxMs?: number;
		now?: () => number;
	} = {}
): () => void {
	const now = opts.now ?? Date.now;
	const key = liveTurnKey(target.agentId, tabId);
	const startedAt = now();
	let done = false;
	let baseline: ReadonlySet<string> | undefined;
	let reading = false;
	let lastReadAt: number | undefined;
	/** When the turn started on the host (host clock), once a read saw it run. */
	let runStartedAt: number | undefined;
	/** When this window first saw the tab free after the turn (this machine's clock). */
	let idleSince: number | undefined;
	/** The tab's provider session as last seen: the entry must be this conversation's. */
	let tabSessionId: string | undefined;
	/** When a later turn of the tab started (host clock): its entry is that turn's, not this one's. */
	let laterRunStartedAt: number | undefined;

	const watch = {
		key: `${sessionId}\u0000${tabId}`,
		// Saved after this turn started. A queued turn this watch never saw run (its message left the
		// host's queue without running) has no entry: one saved now is another client's turn (U8).
		// A started turn ran from the send on, so a new entry of the tab's session is its own.
		covers: (entry: HistoryEntry) =>
			(runStartedAt !== undefined
				? entry.timestamp >= runStartedAt
				: opts.queuedItemId === undefined) &&
			(laterRunStartedAt === undefined || entry.timestamp < laterRunStartedAt),
		stop: () => {
			if (done) return;
			done = true;
			clearInterval(timer);
			synopsisWatches.delete(watch);
		},
	};
	synopsisWatches.add(watch);

	const readPage = async (): Promise<HistoryEntry[] | undefined> => {
		try {
			const page = await window.maestro.federation.historyPage(target.peerId, target.agentId, {
				types: ['USER'],
				pagination: { offset: 0, limit: HOSTED_SYNOPSIS_PAGE },
			});
			return Array.isArray(page?.entries) ? page.entries : undefined;
		} catch {
			return undefined;
		}
	};

	const hostTab = () => {
		const peer = usePeerMirrorStore.getState().peers[target.peerId];
		const agent = peer?.agents.find((candidate) => candidate.id === target.agentId);
		return {
			peer,
			tab: agent?.aiTabs?.find((candidate) => candidate.id === tabId),
			// This turn's own message still waits in the host's queue. Another message waiting there
			// is a later turn, never this one (CodeRabbit on #2166).
			waiting:
				opts.queuedItemId !== undefined &&
				(peer?.queues?.[target.agentId] ?? []).some((item) => item.itemId === opts.queuedItemId),
		};
	};

	const tick = () => {
		if (done) return;
		const at = now();
		const session = selectSessionById(sessionId)(useSessionStore.getState());
		if (!session || at - startedAt > (opts.maxMs ?? HOSTED_SYNOPSIS_WATCH_MS)) {
			watch.stop();
			return;
		}
		const { peer, tab, waiting } = hostTab();
		if (typeof tab?.agentSessionId === 'string' && tab.agentSessionId) {
			tabSessionId = tab.agentSessionId;
		}
		// Still waiting in the host's queue: the turn has not run yet, and a turn running now is the
		// one ahead of it.
		if (waiting && runStartedAt === undefined) return;
		if (opts.queuedItemId !== undefined && runStartedAt === undefined) {
			// Gone from the queue: a host that names how items leave it says whether this one started.
			// Removed, it never runs: nothing to raise. Not named yet, a turn the tab runs now is not
			// proof it is this one (another client's turn, CodeRabbit on #2166).
			const exits = peer?.queueExits?.[target.agentId];
			const exit = queueExitOf(exits, opts.queuedItemId);
			if (exit === 'removed') {
				watch.stop();
				return;
			}
			if (exits && exit !== 'started') return;
		}
		const running = tab?.state === 'busy' || !!peer?.liveTurns?.[key];
		if (running) {
			const started =
				typeof tab?.thinkingStartTime === 'number' ? tab.thinkingStartTime : undefined;
			if (runStartedAt === undefined) runStartedAt = started;
			else if (idleSince !== undefined && started !== undefined && started !== runStartedAt) {
				// The tab ran this turn, went free, and now runs another (CodeRabbit on #2166).
				laterRunStartedAt ??= started;
			}
			idleSince = undefined;
			return;
		}
		if (waiting) return;
		idleSince ??= at;
		if (at - idleSince > (opts.idleMs ?? HOSTED_SYNOPSIS_IDLE_MS)) {
			watch.stop();
			return;
		}
		if (!baseline || reading) return;
		const spacing = at - idleSince < HOSTED_SYNOPSIS_FAST_MS ? 0 : HOSTED_SYNOPSIS_SLOW_POLL_MS - 1;
		if (lastReadAt !== undefined && at - lastReadAt < spacing) return;
		lastReadAt = at;
		reading = true;
		void readPage().then((entries) => {
			reading = false;
			if (done || !entries) return;
			// Whose entry it must be: the tab's provider session, as the host or this record knows it.
			// Not known yet (the tab is not mirrored now): wait, rather than take another tab's entry.
			const agentSessionId =
				hostTab().tab?.agentSessionId ||
				tabSessionId ||
				selectSessionById(sessionId)(useSessionStore.getState())?.aiTabs.find(
					(candidate) => candidate.id === tabId
				)?.agentSessionId ||
				undefined;
			if (!agentSessionId) return;
			// Saved after the turn started (host clock): the turn's own, even if the first read already
			// held it (a turn and its synopsis that ended before that read).
			const savedSinceRun = (candidate: HistoryEntry) =>
				runStartedAt !== undefined && candidate.timestamp >= runStartedAt;
			const entry = entries.find(
				(candidate) =>
					typeof candidate.id === 'string' &&
					(!baseline!.has(candidate.id) || savedSinceRun(candidate)) &&
					!toastedSynopsisEntries.has(candidate.id) &&
					typeof candidate.summary === 'string' &&
					candidate.summary.trim() !== '' &&
					watch.covers(candidate) &&
					candidate.agentSessionId === agentSessionId
			);
			if (!entry) return;
			toastedSynopsisEntries.add(entry.id);
			// An older host never says it wrote this entry: an open History panel reads again. A host
			// that says so may be merging its push right now (its first write since the connection
			// came up): wait for it, so the panel reads once.
			setTimeout(
				() => usePeerMirrorStore.getState().noteHostHistoryEntry(target.peerId, target.agentId),
				HOSTED_HISTORY_ANNOUNCE_GRACE_MS
			);
			const current = selectSessionById(sessionId)(useSessionStore.getState());
			if (!current) return;
			const localTab = current.aiTabs.find((candidate) => candidate.id === tabId);
			notifySynopsisSaved({
				summary: entry.summary,
				group: historyToastGroupName(current),
				project: current.name,
				taskDuration: Math.max(0, now() - (idleSince ?? startedAt)),
				sessionId: current.id,
				tabId,
				tabName: localTab?.name || undefined,
			});
			// The other watches of this tab whose turn this entry covers end with it: one toast.
			for (const other of [...synopsisWatches]) {
				if (other.key === watch.key && other.covers(entry)) other.stop();
			}
		});
	};

	const timer = setInterval(tick, opts.pollMs ?? HOSTED_SYNOPSIS_POLL_MS);
	// The entries already saved before this turn could end: never taken for its own. A failed read
	// leaves no baseline, and no toast is better than a wrong one.
	void readPage().then((entries) => {
		if (done) return;
		if (!entries) {
			watch.stop();
			return;
		}
		baseline = new Set(entries.map((entry) => entry.id));
		tick();
	});
	return watch.stop;
}
