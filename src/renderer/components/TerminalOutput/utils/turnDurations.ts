import type { LogEntry } from '../../../types';
import { isSelfContainedCard } from '../../../utils/logEntries';

/**
 * How long the agent took on each turn, keyed by the id of the transcript row
 * that should carry the badge.
 *
 * "How long did the agent take on that?" is a property of a TURN, not of any one
 * entry: it runs from the user's message to the last thing the agent emitted
 * before the next one. Nothing on disk records it - the live `thinkingStartTime`
 * is cleared the moment a turn ends and never survives a reload - so it is
 * derived here from the timestamps the transcript already carries.
 *
 * The end mark is the last NON-user entry of the turn rather than the reply's own
 * timestamp: a response group keeps its FIRST entry's timestamp (see
 * `collapseAiResponseLogs`), and tool and thinking entries land between the send
 * and the answer. Taking the latest of them all is the closest the transcript
 * gets to "when the agent stopped working".
 *
 * The badge hangs on the LAST agent reply of the turn, so a turn broken up by
 * tool cards reports one elapsed time at the bottom instead of a climbing count
 * on every fragment.
 *
 * The branching here MIRRORS `collapseAiResponseLogs`: a response group renders
 * under its FIRST entry's id, and the kinds that stay standalone there stay
 * standalone here. Change one and this map points at rows that do not exist.
 */
export function computeTurnDurations(logs: LogEntry[]): Map<string, number> {
	const durations = new Map<string, number>();

	let turnStartedAt: number | null = null;
	let turnEndedAt = 0;
	let turnReplyId: string | null = null;
	let groupFirstId: string | null = null;

	const closeTurn = () => {
		if (turnReplyId !== null && turnStartedAt !== null && turnEndedAt >= turnStartedAt) {
			durations.set(turnReplyId, turnEndedAt - turnStartedAt);
		}
		turnReplyId = null;
	};

	// A flushed response group renders as one row under its first entry's id.
	const flushGroup = () => {
		if (groupFirstId !== null) {
			turnReplyId = groupFirstId;
			groupFirstId = null;
		}
	};

	for (const log of logs) {
		if (log.source === 'user') {
			flushGroup();
			closeTurn();
			turnStartedAt = log.timestamp;
			turnEndedAt = log.timestamp;
		} else if (
			log.source === 'tool' ||
			log.source === 'thinking' ||
			log.source === 'error' ||
			isSelfContainedCard(log)
		) {
			// Standalone rows that are not the turn's answer: they move the end mark
			// without taking the badge.
			flushGroup();
			turnEndedAt = Math.max(turnEndedAt, log.timestamp);
		} else if (log.metadata?.crossAgent) {
			// A cross-agent reply is its own attributed bubble, and it IS an answer
			// for this turn, so it can take the badge.
			flushGroup();
			turnEndedAt = Math.max(turnEndedAt, log.timestamp);
			turnReplyId = log.id;
		} else {
			// Accumulate the local agent's own response entries.
			turnEndedAt = Math.max(turnEndedAt, log.timestamp);
			if (groupFirstId === null) groupFirstId = log.id;
		}
	}

	flushGroup();
	closeTurn();

	return durations;
}
