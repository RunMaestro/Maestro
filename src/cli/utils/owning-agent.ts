/**
 * Which agent owns a path on disk.
 *
 * Several verbs take a file rather than an agent (`open-file`, `open-graph`,
 * `image save`'s file-tree nudge) and have to answer "whose workspace is this
 * in?". The rule is one rule: every agent whose `cwd` contains the path is a
 * candidate, the deepest cwd wins (nested worktrees), and a genuine tie goes to
 * whichever of those agents was active most recently by history-file mtime.
 *
 * Written once because it had already been written twice, byte for byte, in
 * `open-file.ts` and `open-graph.ts`. Two copies of a resolution rule is two
 * answers to the same question the moment one of them is tuned.
 */

import * as path from 'path';
import type { SessionInfo } from '../../shared/types';
import { getSessionHistoryMtimeMs, readSessions } from '../services/storage';

/**
 * True if `target` is `parent` itself or lives strictly inside it. Uses a
 * trailing-separator prefix check to avoid `/foo/bar` matching `/foo/barbaz`.
 */
export function isPathInside(target: string, parent: string): boolean {
	const resolvedParent = path.resolve(parent);
	const resolvedTarget = path.resolve(target);
	if (resolvedTarget === resolvedParent) return true;
	return resolvedTarget.startsWith(resolvedParent + path.sep);
}

/**
 * Every agent whose working directory contains `absolutePath`, narrowed to the
 * deepest cwd. Sessions with shorter cwds are dropped only when a deeper one
 * also owns the path (e.g. nested worktrees).
 */
export function findOwningSessions(
	absolutePath: string,
	sessions: SessionInfo[] = readSessions()
): SessionInfo[] {
	const owners = sessions.filter((s) => s.cwd && isPathInside(absolutePath, s.cwd));
	if (owners.length <= 1) return owners;
	const maxLen = Math.max(...owners.map((s) => path.resolve(s.cwd).length));
	return owners.filter((s) => path.resolve(s.cwd).length === maxLen);
}

/** Tie-breaker: the candidate whose history file was written most recently. */
export function pickMostRecentlyActive(sessions: SessionInfo[]): SessionInfo {
	let best = sessions[0];
	let bestMtime = getSessionHistoryMtimeMs(best.id);
	for (let i = 1; i < sessions.length; i++) {
		const mtime = getSessionHistoryMtimeMs(sessions[i].id);
		if (mtime > bestMtime) {
			best = sessions[i];
			bestMtime = mtime;
		}
	}
	return best;
}

/**
 * The single agent that owns `absolutePath`, or null when nothing does.
 *
 * `others` names the candidates that lost a tie, so a caller can say which
 * agent it picked and how to override the choice. It is empty for the common
 * single-owner case, which is how a caller tells "obvious" from "a guess".
 */
export function resolveOwningAgent(
	absolutePath: string,
	sessions: SessionInfo[] = readSessions()
): { agent: SessionInfo; others: SessionInfo[] } | null {
	const owners = findOwningSessions(absolutePath, sessions);
	if (owners.length === 0) return null;
	if (owners.length === 1) return { agent: owners[0], others: [] };
	const agent = pickMostRecentlyActive(owners);
	return { agent, others: owners.filter((s) => s.id !== agent.id) };
}
