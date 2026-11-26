/**
 * The "History Entry Added" toast a `/history` raises, the same in every agent mode.
 *
 * A local or SSH agent's `/history` raises it when its handler saves the entry
 * (`useWizardHandlers`). A hosted agent's `/history` runs on its host, which saves the entry and
 * writes the "Synopsis saved to history" line there; a headless host has no screen to raise a
 * toast on, and a desktop host raises it on its own. So the window that sent it watches the tab's
 * mirrored transcript for that line (`watchHostedHistoryCommand()`) and raises the same toast.
 */

import { liveTurnKey } from '../../shared/maestro-lib/client/live-turn';
import type { LogEntryRecord } from '../../shared/maestro-lib/store/transcript';
import { readHistoryCommandOutcome } from '../../shared/maestroBuiltinCommandText';
import { notifyToast } from '../stores/notificationStore';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { selectSessionById, useSessionStore } from '../stores/sessionStore';
import type { Session } from '../types';
import { readMirrorTranscript } from './peerMirror';

/** How long a window waits for a hosted `/history` to finish before it stops watching. */
export const HOSTED_HISTORY_WATCH_MS = 10 * 60 * 1000;

/**
 * How far a host's clock may run behind this one. Only used when the tab's transcript was not read
 * before the send, so the lines already there cannot be told apart by id.
 */
export const HOSTED_HISTORY_CLOCK_SKEW_MS = 60 * 1000;

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

/** The ids of the entries a mirrored tab holds now, or undefined when it was never read. */
export function hostedTranscriptBaseline(
	peerId: string,
	agentId: string,
	tabId: string
): ReadonlySet<string> | undefined {
	const slot = usePeerMirrorStore.getState().transcripts[peerId]?.[liveTurnKey(agentId, tabId)];
	return slot?.loaded ? new Set(slot.entries.map((entry) => entry.id)) : undefined;
}

/**
 * After a host ran `/history` for a hosted agent's tab, raise the local toast once the host's line
 * says the entry was saved. Lines in `baseline` (the tab's entries before the send) are older runs;
 * without one, lines older than the send (allowing for clock skew) are. A line that ends the run any
 * other way (nothing to report, failed, error) ends the watch with no toast, as a local run raises
 * none. Returns a function that stops watching.
 */
export function watchHostedHistoryCommand(
	sessionId: string,
	target: { peerId: string; agentId: string },
	tabId: string,
	opts: { sentAt: number; baseline?: ReadonlySet<string>; timeoutMs?: number }
): () => void {
	const key = liveTurnKey(target.agentId, tabId);
	const slotOf = () => usePeerMirrorStore.getState().transcripts[target.peerId]?.[key];
	const isNew = (entry: LogEntryRecord): boolean =>
		opts.baseline
			? !opts.baseline.has(entry.id)
			: entry.timestamp >= opts.sentAt - HOSTED_HISTORY_CLOCK_SKEW_MS;

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
			if (!slot) return;
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
