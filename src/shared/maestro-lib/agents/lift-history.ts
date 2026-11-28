/**
 * An agent's History across a Federation move. The rule: an agent's History is one list for the
 * user, wherever the agent runs.
 *
 * Nothing is copied to the host. While an agent is hosted, the entries it made before the move
 * stay in this machine's History under its local id, and its History panel lists them merged by
 * id with the entries the host writes (`withLocalHistory()`). Each entry lives in one place, so
 * no second copy can go stale on either side: a Delete or a Validate edits the one copy there is.
 *
 * What the host wrote comes home when the agent does (`bringHostHistoryHome()`):
 *
 * - A Move Back brings the host copy's own entries into this machine's History, re-filed under the
 *   local id, before that copy is removed.
 * - An offline Move Back cannot reach them: they stay on the host with the copy it left there
 *   (`leftOnHost`), and the next Move to Host, which replaces that copy, brings them home first.
 *
 * An entry already here (the same id) is never written twice, so a retry or an entry both sides
 * hold is harmless. Only the host agent's own entries move: an entry another Maestro wrote to the
 * shared History of the project stays that Maestro's.
 *
 * Pure: the CLI's file store is `diskAgentHistoryStore()` (`lift-history-disk.ts`), the desktop's
 * `desktopAgentHistoryStore()` (`src/main/federation/agent-history-store.ts`).
 */

import { clampHistoryEntry, mergeEntriesById } from '../../history';
import type { HistoryEntry } from '../../types';
import type { ReturnResult } from './lift-return';

/** One machine's History of its agents: read one agent's own entries, and add to them. */
export interface AgentHistoryStore {
	/** The agent's own entries on this machine, in any order. Empty when it has none. */
	read(agentId: string): Promise<HistoryEntry[]>;
	/** Add entries to the agent's own History, oldest first. Throws when they were not written. */
	append(agentId: string, entries: readonly HistoryEntry[]): Promise<void>;
	/** Delete one of the agent's own entries (the History panel's Delete). False: no such entry. */
	remove?(agentId: string, entryId: string): Promise<boolean>;
	/** Change one of the agent's own entries (the History panel's Validate). False: no such entry. */
	update?(agentId: string, entryId: string, updates: { validated?: boolean }): Promise<boolean>;
}

/**
 * The entries of a host's History list that come home for an agent: the ones the host agent
 * `hostAgentId` wrote itself (not another Maestro's shared entries), that this machine does not
 * hold yet, re-filed under `localAgentId`, oldest first, each id once. An entry is another
 * machine's data: one without a usable id, time, or type is left out, and each is clamped to what
 * this machine stores (`clampHistoryEntry()`) before it is written here.
 */
export function hostHistoryComingHome(
	hostEntries: readonly HistoryEntry[],
	hostAgentId: string,
	localAgentId: string,
	existing: readonly HistoryEntry[]
): HistoryEntry[] {
	const seen = new Set(existing.map((entry) => entry.id));
	const coming: HistoryEntry[] = [];
	for (const entry of hostEntries) {
		if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
		if (entry.sessionId !== hostAgentId) continue;
		if (typeof entry.timestamp !== 'number' || !Number.isFinite(entry.timestamp)) continue;
		if (typeof entry.type !== 'string' || !entry.type) continue;
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		coming.push(clampHistoryEntry({ ...entry, sessionId: localAgentId }));
	}
	return coming.sort((a, b) => a.timestamp - b.timestamp);
}

/** A host's History of one agent, as a Federation client reads it (`MaestroClient.history`). */
export interface HostHistoryReader {
	list(
		agentId: string
	): Promise<
		{ ok: true; value: HistoryEntry[] } | { ok: false; error: { code?: string; message: string } }
	>;
}

/**
 * Read the host agent's History and work out what comes home, without writing anything.
 *
 * `null`: the host does not serve an agent's History at all (a Maestro there from before it did,
 * `unsupported`). The move goes on and KEEPS the host's copy, so the History stays with it until a
 * newer host can send it. Any other failure throws, so a move does not go on and remove a copy
 * whose History it could not read.
 */
export async function planHostHistoryHome(
	history: HostHistoryReader,
	hostAgentId: string,
	localAgentId: string,
	store: Pick<AgentHistoryStore, 'read'>
): Promise<HistoryEntry[] | null> {
	const listed = await history.list(hostAgentId);
	if (!listed.ok && listed.error.code === 'unsupported') return null;
	if (!listed.ok) throw new Error(`its History could not be read: ${listed.error.message}`);
	return hostHistoryComingHome(
		listed.value,
		hostAgentId,
		localAgentId,
		await store.read(localAgentId)
	);
}

/**
 * Write the entries `planHostHistoryHome()` found, then read them back: the caller removes the
 * host's copy next, so "written here" must be true, not only reported. Throws when the write
 * failed or any entry that came is not in this machine's History after it. Returns how many came
 * home.
 */
export async function bringHostHistoryHome(
	store: Pick<AgentHistoryStore, 'append' | 'read'>,
	localAgentId: string,
	coming: readonly HistoryEntry[]
): Promise<number> {
	if (coming.length === 0) return 0;
	await store.append(localAgentId, coming);
	const here = new Set((await store.read(localAgentId)).map((entry) => entry.id));
	const missing = coming.filter((entry) => !here.has(entry.id)).length;
	if (missing > 0) {
		throw new Error(
			`${historyEntryCount(missing)} did not read back from this machine's History after the write`
		);
	}
	return coming.length;
}

/** The notice of a move whose host does not serve an agent's History (`planHostHistoryHome()` null). */
export function hostHistoryUnsupportedNotice(peer: string, copyRef: string): string {
	return `${peer} does not send an agent's History (its Maestro is older), so the History written there stays with the agent's copy there (${copyRef}), which is kept. Update Maestro on that host, then move the agent again to bring that History home.`;
}

/**
 * A hosted agent's History as one list: the host's entries and this machine's own entries of the
 * agent's local record (its History from before the move), merged by id, newest first.
 */
export function withLocalHistory(
	hostEntries: readonly HistoryEntry[],
	localEntries: readonly HistoryEntry[]
): HistoryEntry[] {
	return mergeEntriesById([...hostEntries], [...localEntries]);
}

/** How a History count reads in a plan or a result: "1 History entry", "3 History entries". */
export function historyEntryCount(count: number): string {
	return `${count} History ${count === 1 ? 'entry' : 'entries'}`;
}

/**
 * What a Move Back does or did, in one sentence: the plan a person confirms (a dry run) and the
 * result line, the same words in the desktop and `maestro-cli unlift`. Here, not in `lift-return.ts`,
 * so the window can import it without the move's file I/O.
 */
export function describeReturn(result: ReturnResult, keepHostCopy = false): string {
	const tabs = `${result.tabs} tab(s)${result.newTabs > 0 ? ` (${result.newTabs} new)` : ''}`;
	const history = historyEntryCount(result.history);
	if (result.dryRun) {
		const kept = keepHostCopy || result.hostCopyKept === true;
		const copy =
			result.hostCopyGone === true
				? 'the host no longer has its copy'
				: kept
					? 'its copy there is kept'
					: 'its copy there is removed';
		return `Moving "${result.agent.name}" back from ${result.from}: ${tabs} and ${history} come back to this machine, and ${copy}.`;
	}
	return `"${result.agent.name}" is an SSH agent again: ${tabs} and ${history} came back from ${result.from}${result.hostCopyRemoved ? ', host copy removed' : ''}.`;
}
