/**
 * @file groupchat/turn-end.ts
 * @description How a finished run-layer turn is reported to the engine (`turnEnded`).
 *
 * The desktop reports what its output buffer held; a host on the run layer reports what the turn
 * answered. The difference is where "did anything come back" and "did the session vanish" are read
 * from:
 *
 * - The reply is the turn's answer text (`CompletedTurn.answerText`), which is what the desktop's
 *   stream-json extraction yields for the same output.
 * - Session-not-found is read from the answer, and from the tails of stdout and stderr, because a
 *   provider that rejects a resume id often says so on a stream the answer never carried. The tails
 *   count as output ONLY when they say so: a participant that crashed with stderr noise and no
 *   answer is closed out silently (B2), exactly as it is when the desktop buffered nothing.
 * - The tails are read with the patterns of the provider that ran the turn (`providerId`), the
 *   same ones the router's recovery check resolves for the participant. Read with another
 *   provider's patterns a tail can say the opposite: Grok's successful remote restore ("Session
 *   <id> not found locally, restoring from remote...") reads as a lost session to Claude's.
 *   Absent, the shared default applies (the moderator, and callers that name no provider).
 */

import { detectSessionNotFoundError } from './session-recovery';
import type { GroupChatTurnEnd } from './types';

/** The parts of a completed turn this reads, so a fake can stand in for one. */
export interface FinishedTurn {
	answerText?: string;
	exit: { exitCode: number | null; stdoutText: string; stderrText: string };
}

export function turnEndOf(
	processId: string,
	turn: FinishedTurn,
	providerId?: string
): GroupChatTurnEnd {
	const text = turn.answerText ?? '';
	const tails = [turn.exit.stdoutText, turn.exit.stderrText].filter(Boolean).join('\n');
	const rawOutput = detectSessionNotFoundError(tails, providerId)
		? [text, tails].filter(Boolean).join('\n')
		: text;
	return { processId, text, rawOutput, exitCode: turn.exit.exitCode };
}
