/**
 * Claude session origins: the per-session record Maestro keeps beside Claude's
 * own JSONL (origin, tab name, star, last context usage).
 *
 * Every writer goes through `setClaudeSessionOrigin()`, which MERGES. The
 * record holds several independent fields written by independent paths, so a
 * writer that replaces the record erases every field it did not name. That is
 * how `registerSessionOrigin` (called on every turn) wiped a third of all
 * saved tab names, which then vanished from "All Named" and the sessions
 * browser.
 */

import type Store from 'electron-store';
import type {
	ClaudeSessionOrigin,
	ClaudeSessionOriginInfo,
	ClaudeSessionOriginsData,
} from '../stores/types';

export type StoredClaudeSessionOrigin = ClaudeSessionOrigin | ClaudeSessionOriginInfo;

/**
 * Apply `patch` to one stored origin record, keeping every field the patch
 * leaves out. A record that carries nothing beyond its origin stays in the
 * compact legacy string form, which is what most of the store holds.
 */
export function mergeClaudeSessionOrigin(
	existing: StoredClaudeSessionOrigin | undefined,
	patch: Partial<ClaudeSessionOriginInfo>
): StoredClaudeSessionOrigin {
	const base: ClaudeSessionOriginInfo =
		typeof existing === 'string' ? { origin: existing } : (existing ?? { origin: 'user' });
	const merged: ClaudeSessionOriginInfo = { ...base, ...patch };
	const { origin, ...rest } = merged;
	return Object.values(rest).some((value) => value !== undefined) ? merged : origin;
}

/** Read-merge-write one session's origin record in the shared store. */
export function setClaudeSessionOrigin(
	store: Store<ClaudeSessionOriginsData>,
	projectPath: string,
	agentSessionId: string,
	patch: Partial<ClaudeSessionOriginInfo>
): StoredClaudeSessionOrigin {
	const origins = store.get('origins', {});
	const project = origins[projectPath] ?? {};
	const next = mergeClaudeSessionOrigin(project[agentSessionId], patch);
	origins[projectPath] = { ...project, [agentSessionId]: next };
	store.set('origins', origins);
	return next;
}

/** One recorded tab name, as history stamps it on each entry. */
export interface RecordedSessionName {
	agentSessionId?: string;
	sessionName?: string;
	timestamp: number;
}

/**
 * Whether a recorded name is only the unnamed-tab label (the id's first
 * octet, or "New Session") rather than something a person or the namer chose.
 */
function isPlaceholderName(name: string, agentSessionId: string): boolean {
	return (
		name === 'New Session' ||
		name === agentSessionId ||
		name.toUpperCase() === agentSessionId.split('-')[0].toUpperCase()
	);
}

/**
 * Restore tab names the origins store lost, from the names history recorded.
 *
 * Only sessions the store already tracks, and only records with no name, are
 * touched: a name in the store is newer or deliberate, and a session the store
 * never saw has no trustworthy project path to file it under. When history
 * holds several names for one session (a rename), the newest wins.
 *
 * @returns how many origin records received a name
 */
export function backfillClaudeSessionNames(
	store: Store<ClaudeSessionOriginsData>,
	entries: Iterable<RecordedSessionName>
): number {
	const newest = new Map<string, { name: string; timestamp: number }>();
	for (const entry of entries) {
		const { agentSessionId, sessionName, timestamp } = entry;
		if (!agentSessionId || !sessionName?.trim()) continue;
		if (isPlaceholderName(sessionName, agentSessionId)) continue;
		const seen = newest.get(agentSessionId);
		if (!seen || timestamp > seen.timestamp) {
			newest.set(agentSessionId, { name: sessionName, timestamp });
		}
	}
	if (newest.size === 0) return 0;

	const origins = store.get('origins', {});
	let restored = 0;
	for (const sessions of Object.values(origins)) {
		for (const [agentSessionId, record] of Object.entries(sessions)) {
			const recorded = newest.get(agentSessionId);
			if (!recorded) continue;
			if (typeof record === 'object' && record.sessionName) continue;
			sessions[agentSessionId] = mergeClaudeSessionOrigin(record, { sessionName: recorded.name });
			restored++;
		}
	}
	if (restored > 0) store.set('origins', origins);
	return restored;
}
