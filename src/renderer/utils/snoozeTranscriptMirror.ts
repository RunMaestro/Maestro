/**
 * Transcript preservation for snoozed tabs.
 *
 * A snooze can run for months. The conversation itself lives in the provider's
 * own directory (Claude Code's `~/.claude/projects/.../<id>.jsonl`, and the
 * equivalent elsewhere) and is subject to the provider's retention, so a tab
 * that comes back in six weeks can easily find its transcript aged out from
 * under it. Maestro therefore keeps its own copy for the duration of the snooze,
 * exactly as it does for starred sessions.
 *
 * These are thin fire-and-forget wrappers over the mirror IPC. Mirroring is
 * best-effort: it must never block or fail a snooze, a wake, or a dismiss. The
 * main process holds a mirror until every reason to keep it is released, so a
 * session that is both starred and snoozed survives losing either one.
 */

import type { AITab, Session, SnoozedTabEntry } from '../types';
import { logger } from './logger';

/**
 * Whether this tab can be mirrored at all.
 *
 * Needs a provider session (a tab that never ran has no transcript) and a
 * project root (how the provider's path is resolved). Remote/SSH sessions are
 * filtered out in the main process, whose storage layer resolves local paths
 * only, so there is nothing to check here.
 */
function mirrorTarget(
	session: Session | null | undefined,
	tab: AITab | undefined
): { agentId: string; projectPath: string; sessionId: string; sessionName?: string } | null {
	if (!session?.projectRoot) return null;
	const sessionId = tab?.agentSessionId;
	if (!sessionId) return null;
	return {
		agentId: session.toolType || 'claude-code',
		projectPath: session.projectRoot,
		sessionId,
		sessionName: tab?.name ?? undefined,
	};
}

/**
 * Preserve a tab's transcript for the length of its snooze.
 * Call when a tab is snoozed - the moment it is put away is the loss boundary.
 */
export function mirrorSnoozedTranscript(
	session: Session | null | undefined,
	tab: AITab | undefined
): void {
	const target = mirrorTarget(session, tab);
	if (!target) return;
	void window.maestro.agentSessions
		.snapshotStarredTranscript(
			target.agentId,
			target.projectPath,
			target.sessionId,
			target.sessionName,
			'snoozed'
		)
		.catch((err) => {
			logger.warn(`Failed to mirror snoozed transcript ${target.sessionId}: ${err}`);
		});
}

/**
 * Release the snooze's hold on a mirrored transcript.
 * Call when a snoozed tab wakes or is dismissed. The main process rehydrates the
 * provider file before dropping the mirror, so a transcript that aged out during
 * the snooze is restored rather than lost, and a session that is also starred
 * keeps its copy.
 */
export function releaseSnoozedTranscript(
	session: Session | null | undefined,
	entry: SnoozedTabEntry
): void {
	const target = mirrorTarget(session, entry.tab);
	if (!target) return;
	void window.maestro.agentSessions
		.releaseSnoozedTranscript(target.agentId, target.projectPath, target.sessionId)
		.catch((err) => {
			logger.warn(`Failed to release snoozed transcript ${target.sessionId}: ${err}`);
		});
}
