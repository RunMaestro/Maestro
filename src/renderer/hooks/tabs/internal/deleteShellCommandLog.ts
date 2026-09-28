/**
 * Removing a command-mode card from a transcript.
 *
 * A `!command` card is the one transcript entry the user created entirely by
 * themselves - the agent never saw the command and never saw its output - so
 * "get this out of my history" has a clean answer: drop the entry, and drop the
 * command from up-arrow recall so it stops being offered back.
 *
 * Kept as a pure reducer over the sessions array rather than living inside the
 * handler, because the recall-pruning rule below is the part worth testing and
 * it needs nothing but state in and state out.
 */

import type { LogEntry, Session } from '../../../types';
import { SHELL_COMMAND_PREFIX } from '../../../utils/shellCommandInput';

export interface DeleteShellCommandLogTarget {
	sessionId: string;
	/** AI tab holding the card. */
	tabId: string;
	/** Log id of the card being removed. */
	logId: string;
	/** The command it ran, used to find its recall entry. */
	command: string;
}

/** True when `log` is a command card for `command` other than the one going away. */
function isSurvivingCardFor(log: LogEntry, command: string, deletedLogId: string): boolean {
	return log.id !== deletedLogId && log.shellCommand?.command === command;
}

/**
 * Delete one command card, and prune its recall entry when nothing else in the
 * agent still shows that command.
 *
 * The survivor check spans every AI tab, not just the one being edited, because
 * the two lists have different scopes: cards are per tab, while
 * `aiCommandHistory` is per agent and deduplicated. Pruning unconditionally
 * would mean deleting one `ls` card silently strips `ls` from recall while two
 * other `ls` cards sit on screen - the history would then disagree with the
 * transcript the user is looking at.
 */
export function deleteShellCommandLog(
	sessions: Session[],
	target: DeleteShellCommandLogTarget
): Session[] {
	const { sessionId, tabId, logId, command } = target;

	return sessions.map((session) => {
		if (session.id !== sessionId) return session;

		const aiTabs = session.aiTabs.map((tab) =>
			tab.id === tabId ? { ...tab, logs: tab.logs.filter((log) => log.id !== logId) } : tab
		);

		const stillShown = aiTabs.some((tab) =>
			tab.logs.some((log) => isSurvivingCardFor(log, command, logId))
		);

		// Recorded bang-prefixed by dispatchShellCommand, which is what tells a
		// command apart from an agent message inside aiCommandHistory.
		const historyEntry = `${SHELL_COMMAND_PREFIX}${command}`;

		return {
			...session,
			aiTabs,
			...(stillShown
				? {}
				: {
						aiCommandHistory: (session.aiCommandHistory || []).filter(
							(entry) => entry !== historyEntry
						),
					}),
		};
	});
}
